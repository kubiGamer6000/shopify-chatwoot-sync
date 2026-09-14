# Refund to label reconciliation (Shopify refunds vs Chatwoot `refund-*` labels)

This guide is for the agent building the support/refund analytics dashboard. It explains how to check whether refunds issued in Shopify by the **support agent** were recorded in Chatwoot with the matching action label (`refund-30`, `refund-50`, `refund-70`, `refund-full`), and how to compute a **label compliance rate**.

Everything was checked against the live systems on 2026-09-14 with read-only calls (Shopify GraphQL queries and REST GETs, Chatwoot GETs). The reference implementation is `src/scripts/analytics/refundLabelReconciliation.ts`.

Related guides: `shopify-refunds.md` (refund amounts, percentages), `refund-attribution.md` (who issued a refund), `labels-and-actions.md` (label events).

---

## 1. Summary of findings (last 7 full Helsinki days, 2026-09-07..2026-09-13)

| | Value |
|---|---|
| Support-agent money refunds (Ruth, user 135220658524) | **79 refunds, 3,544.41 EUR** |
| ...with a label of the correct bucket | 38 (**48.1 %**) |
| ...with any `refund-*` label | 40 (**50.6 %**) |
| ...with any label, counting only refunds where a Chatwoot ticket of that customer was active near the refund | 40 / 54 (**74.1 %**) |
| Bucket accuracy (correct bucket among labelled refunds) | 38 / 40 (**95 %**) |
| `refund-*` label events added in the window | 41 (refund-full 22, refund-30 12, refund-50 7, refund-70 0) |
| ...that pair with a support-agent refund | **40 / 41** (the remaining 1 is a second label for a refund that was already paired, see section 6) |
| ...that pair with a call-support or Chargeflow refund, or with no refund at all | **0** |
| Time between refund and label, for matched pairs | median **3 s**, 63/65 within 60 s, 65/65 within 1 h |

What this means:

1. **Labels are reliable in one direction.** Every refund label added in the week belongs to a real refund by the support agent. The labels never describe refunds by the Jan's call-support account or by Chargeflow. A label without a refund did not occur.
2. **Labels are missing for about half of the support agent's refunds.** Almost all of the gap comes from refunds whose Shopify refund note is `remote` or `hk`. These refunds usually have no Chatwoot conversation at all:

   | Support refunds by refund note | Refunds | EUR | Correct label | Any label | Any label where a ticket was near |
   |---|---|---|---|---|---|
   | note `remote` or `hk` | 36 | 1,715.69 | 2.8 % | 2.8 % | 9.1 % |
   | any other note (`cust request`, `eu withdrawal`, free text, none) | 43 | 1,828.72 | **86.0 %** | **90.7 %** | 90.7 % |

   For ticket-driven refunds, labelling works about 90 % of the time. `remote`/`hk` refunds look like a separate workflow. They come in batches (2026-09-07 about 12:50-13:50 UTC, 2026-09-10 about 01:14 UTC), mostly go to Skio subscription orders months old, and often cover several orders of the same customer within one minute. What `remote` and `hk` mean is **UNVERIFIED** (ask the owner).
3. **The agent labels the moment she refunds.** A median gap of 3 seconds means the ±48 h tolerance is generous. The tolerance matters only for rare, late labels. Nothing in this repository adds `refund-*` labels (checked with grep), so the labels are added by hand or by a tool outside this repo. **UNVERIFIED** which one.

The last full day (2026-09-13): 8 support refunds / 440.10 EUR. 4 matched, 1 missed label (#29405, an 18.1 % shipping-only refund that fits no label bucket), 3 with no conversation (all note `remote`). Correct label 50 %, and 80 % for refunds with other notes. 5 label events: 4 matched, 1 duplicate.

---

## 2. Definitions

All days are **Europe/Helsinki** calendar days (UTC+3 now, UTC+2 from 2026-10-25; compute the offset per date). `--days=N` means the N complete local days that end at local midnight today, so `--days=1` on 2026-09-14 is 2026-09-13. `--include-today` extends the end to "now".

| Term | Definition |
|---|---|
| **Money refund** | A Shopify `Refund` with `totalRefundedSet.shopMoney.amount > 0`. This drops zero-amount Skio line removals and refunds whose only transaction failed. See `shopify-refunds.md`. |
| **Refund in window** | `refund.createdAt` falls inside the window. The order date does not matter. |
| **Refund %** | `refund.totalRefundedSet.presentmentMoney / order.totalReceivedSet.presentmentMoney * 100`. The base is the amount actually captured, in the customer's currency. Do not use `totalPriceSet`: it does not go down after Skio line removals, so it understates refunds. |
| **Cumulative %** | The sum of this order's money refunds up to and including this one, divided by the same base. |
| **Refund bucket** | `full` if cumulative % >= 99.5. Otherwise `30`, `50` or `70` if the refund % is within **±5 pp** of the target. Otherwise `other` (for example shipping-only refunds of 12-23 %). Observed partial values: 30.0, 27.8, 45.5, 50.0, 40.5, 23.2, 18.1. |
| **Label bucket** | `refund-30` -> 30, `refund-50` -> 50, `refund-70` -> 70, `refund-full` -> full. |
| **Actor** | REST `GET /orders/{id}/refunds.json`: `refund.user_id` 135220658524 = **support agent (Ruth)**. 135617184092 = Jan (call support, confirmed by the owner). `user_id` null with `transactions[].source_name` 4704285 = Chargeflow app. Known Chargeflow collaborator ids or an Ethoca/CDRN note = Chargeflow. See `refund-attribution.md`. |
| **Label event** | A Chatwoot activity message (`message_type` 2) with content `Scandi Gum added refund-30[, other labels]`, dated by the message `created_at`. Chatwoot logs a label only the **first** time it is added to a conversation. |
| **Tolerance** | A label event may come up to **48 h** before or after the refund (`--tolerance-hours`). |

Attribution is reliable enough to reconcile the support agent's refunds alone. Her staff user id is stable, and it matched the actor name "Ruth ..." on every `refund_created` event (`refund-attribution.md`). The script also reports **all staff refunds** (support + call support + other staff, no apps) and each actor separately, so the dashboard can show both views.

---

## 3. Data sources and API calls

All calls are read-only.

### 3.1 Shopify

1. **Refunds with customer identity** (GraphQL, 50 per page):

   ```graphql
   query O($q: String!, $after: String) {
     orders(first: 50, after: $after, query: $q, sortKey: UPDATED_AT) {
       pageInfo { hasNextPage endCursor }
       nodes {
         legacyResourceId name email test
         customer { legacyResourceId email }
         totalReceivedSet { presentmentMoney { amount currencyCode } }
         refunds(first: 20) {
           id createdAt
           totalRefundedSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
         }
       }
     }
   }
   ```

   Use `$q = "updated_at:>='<windowStart - tolerance>' AND (financial_status:refunded OR financial_status:partially_refunded)"`. **Keep the parentheses.** Without them the OR binds to the date term and about a third of the orders are lost. A refund bumps `order.updatedAt`, so refunds on old orders are included. Keep refunds with `createdAt` in `[windowStart - tolerance, min(windowEnd + tolerance, now))`. The tolerance margin lets labels near the window edges pair up.

2. **Actor per refund** (REST, one call per order): `GET /admin/api/2026-01/orders/{orderId}/refunds.json`. Read `refunds[].id` (it equals the numeric tail of the GraphQL Refund gid), `user_id`, `note`, and `transactions[].source_name`. The response also holds `payment_details` (cardholder data). Never store it.

3. **Label with no refund nearby** (diagnostic only): `orders(first: 50, query: "email:\"<conversation sender email>\"")` with the same refund fields. It finds the customer's closest money refund at any time and sorts the label into `refund_outside_tolerance` or `no_refund_found`. None were needed in the sample week.

### 3.2 Chatwoot (account API, header `api_access_token`)

1. **Conversations active since `windowStart - tolerance`**: `GET /conversations?status=all&assignee_type=all&sort_by=last_activity_at_desc&page=N`. Stop when the last row on a page is older than the cutoff, then re-page from page 1 until you reach the pull start time, because the list shifts while you page. This returned 1,848 conversations for 9 days (7-day window plus 48 h). Each row has `labels[]`, `created_at`, `last_activity_at` and `meta.sender`, with:
   - `email`
   - `custom_attributes.shopify_customer_id`, set by the Shopify -> Chatwoot contact sync. It was present on 19 of 25 rows on one page and is the **best join key**: 51 of 57 identity matches for support refunds used it.
   - `custom_attributes.shopify_email_link`, an override email set when the customer writes from a different address.

2. **Label events**: `GET /conversations/{id}/messages[?before=<smallest id>]`, 20 per page. Fetch these only for conversations whose **current** labels include a `refund-*` label (73 conversations for the 7-day run). Labels are basically never removed (0 removals in the window), so current labels are a superset of labels added in the window. Stop paging when a page has fewer than 20 messages or its oldest message is older than `windowStart - 2 x tolerance`.

3. **Fallback A, contact search**: `GET /contacts/search?q=<order email>` (compare emails exactly, since the search is fuzzy), then `GET /contacts/{contactId}/conversations`. This search is **slow** (5-14 s) and sometimes answers **422 "request took too long"**. Retry it twice and treat a third failure as "not found". Almost every Shopify customer already has a Chatwoot contact because of the sync (38 of 38 lookups found one), so **"contact exists" does not mean "customer contacted support"**. Only 7 of the 38 contacts had any conversation.

4. **Fallback B, order-number mention**: `GET /search/messages?q=<order number without #>` returns `payload.messages[]` with `conversation_id`, `content`, `message_type` and `private`, in about 2 s. Filter with a digit-boundary regex (`(?<!\d)44776(?!\d)`). For order numbers under 5 digits, require a `#` in front. Recall check: for 12 of 12 already-matched refunds, the search returned the matched conversation (private notes and AI drafts usually quote the order number). In the sample week it found **no** extra conversations for the unmatched refunds. That confirms those refunds really have no ticket.

Do not use label filtering (`labels[]` list filter or `POST /conversations/filter`). It times out, and POST is off-limits for this read-only work anyway.

Call volume: `--days=7` needed 4 GraphQL, 157 REST and about 294 Chatwoot calls and took about 200 s. `--days=1` needed 2 / 50 / 97 calls and took about 80 s.

---

## 4. Matching algorithm

```
refunds   = Shopify money refunds created in [W.start - T, min(W.end + T, now))   (T = 48 h)
convs     = Chatwoot conversations with last_activity_at >= W.start - T
index     = identity key -> conversation ids, keys:
              c:<shopify_customer_id>, e:<sender email>, e:<shopify_email_link>   (emails lower-cased)

for each refund R:
   keys(R) = c:<order.customer.legacyResourceId>, e:<order.email>, e:<order.customer.email>
   cand(R) = union of index[k] for k in keys(R)                       (matchedVia = shopify_customer_id | email)
   if cand(R) is empty and R is a staff refund in the window:
        contact search by email -> contact conversations               (matchedVia = contact_search)
        if still empty: /search/messages?q=<order number>              (matchedVia = order_mention)

events    = refund-* "added" events on every conversation that currently has a refund-* label
            (one event per label; an event "added refund-30, refund-full" becomes two events)

pairs     = (R, E) with E.conversation in cand(R), OR E's conversation identity keys hit R,
            OR a message in E's conversation mentions R's order number;
            and |E.ts - R.ts| <= T
sort pairs by: bucket equal first, then actor (support < call support < other staff < unknown < apps),
               then |E.ts - R.ts|
greedy one-to-one: take a pair if neither R nor E is used yet
```

**Refund categories** (support agent refunds, and each actor separately):

| Category | Rule |
|---|---|
| `matched` | Paired with a label event of the **same** bucket. |
| `matched_shared_label` | Not paired, but a conversation of the customer that was active within ±T of the refund already carries the label of the right bucket, added no later than refund + T. Chatwoot logs a label only once per conversation, so a second refund in the same ticket, or several orders refunded in one ticket, cannot produce a new event. 0 in the sample. |
| `bucket_mismatch` | Paired with a label event of a **different** bucket, or the refund bucket is `other`. |
| `missed_label` | No label, but the customer has a conversation that was active near the refund: `created_at <= R + T` and `last_activity_at >= R - T`. |
| `no_ticket_near_refund` | The customer has conversations, but none was active within ±T. |
| `no_conversation` | No conversation found by customer id, email, contact search or order-number mention. |

**Label-event categories** (events added inside the window):

| Category | Rule |
|---|---|
| `matched_support_refund` / `bucket_mismatch_support_refund` | Paired with a support-agent refund. |
| `matched_call_support_refund` / `matched_other_staff_refund` / `matched_chargeflow_refund` / `matched_unknown_actor_refund` | Paired with a refund by another actor, which suggests someone else did the refund the ticket asked for. |
| `duplicate_label_refund_already_matched` | A refund was possible for this event, but that refund already paired with an equal-or-better event, typically the same label on the customer's second conversation. |
| `refund_outside_tolerance` | The customer (by sender email) has a money refund, but more than T away. The row reports the nearest order and the gap in hours. |
| `no_refund_found` | The sender email has no money refunds at all. The refund may have been done under another email, or not processed. |
| `unidentified_customer` | The conversation has no email and no order-number mention matched. Typical for the Facebook inbox. |

**Compliance rates** (all in %):

- `correctLabelPct` = (matched + matched_shared_label) / all refunds
- `anyLabelPct` = (matched + shared + bucket_mismatch) / all refunds
- `anyLabelPctWhereTicketNearRefund` = (matched + shared + mismatch) / (matched + shared + mismatch + missed_label). It excludes refunds that had no ticket to label.
- `bucketAccuracyPct` = (matched + shared) / (matched + shared + mismatch)

Recommended headline for the dashboard: `anyLabelPctWhereTicketNearRefund` for the support agent, with `correctLabelPct` next to it, plus the note-group split from section 1 until the owner explains `remote`/`hk`.

---

## 5. Real example numbers

Generated 2026-09-14 about 11:35 UTC. Output files: `/home/dolan/support-analytics/refund-label-reconciliation_{1d,7d}_2026-09-13.{json,md}` (outside the repo, no emails or names).

### 5.1 Last 7 full days, 2026-09-07..2026-09-13

Support agent refunds by bucket: full 56 (3,082.63 EUR), 30: 11 (171.91), 50: 8 (226.78), 70: 0, other 4 (63.09).

| Actor | Refunds | EUR | matched | shared | mismatch | missed_label | no ticket near | no conversation | any label % |
|---|---|---|---|---|---|---|---|---|---|
| support_agent | 79 | 3,544.41 | 38 | 0 | 2 | 14 | 3 | 22 | 50.6 |
| call_support (Jan) | 24 | 967.69 | 0 | 0 | 0 | 11 | 4 | 9 | 0 |
| chargeflow (not staff, for context) | 18 | 1,172.60 | 0 | 0 | 0 | 5 | 2 | 11 | 0 |
| **all staff** (support + call support) | 103 | 4,512.10 | 38 | 0 | 2 | 25 | 7 | 31 | 38.8 |

How support refunds were linked: Shopify customer id 51, email 3, contact search 3, none 22.

Refund note codes by category (support agent): matched = `cust request` 12, `eu withdrawal` 3, `remote` 1, none 2, other free text 20. missed_label = `remote` 5, `hk` 5, other 4. no_ticket_near_refund = `remote` 3. no_conversation = `remote` 14, `hk` 8.

By day (support agent):

| Date | Refunds | EUR | matched | mismatch | missed | no ticket | no conv. | correct % | label events | labels -> support refund |
|---|---|---|---|---|---|---|---|---|---|---|
| 09-07 | 29 | 1,257.62 | 5 | 2 | 7 | 3 | 12 | 17.2 | 7 | 7 |
| 09-08 | 8 | 542.05 | 8 | 0 | 0 | 0 | 0 | 100 | 8 | 8 |
| 09-09 | 12 | 524.48 | 10 | 0 | 2 | 0 | 0 | 83.3 | 10 | 10 |
| 09-10 | 10 | 364.58 | 3 | 0 | 0 | 0 | 7 | 30 | 3 | 3 |
| 09-11 | 5 | 149.73 | 2 | 0 | 3 | 0 | 0 | 40 | 2 | 2 |
| 09-12 | 7 | 265.85 | 6 | 0 | 1 | 0 | 0 | 85.7 | 6 | 6 |
| 09-13 | 8 | 440.10 | 4 | 0 | 1 | 0 | 3 | 50 | 5 | 4 |

The low days (09-07, 09-10) are the `remote`/`hk` batch days.

Example ids (order number -> conversation):

- **matched**: #35615 (50 %) -> conv 8739, label 2 s after the refund. #44413 (30 %) -> conv 10886. #26589 (full) -> conv 8695. #37354 (full) -> conv 11573. #16990 (full) -> conv 10681, linked by email only.
- **bucket_mismatch**: #37920, refund 45.5 % (bucket 50) but labelled `refund-30` on conv 10873. #36057, refund 40.5 % (bucket other) labelled `refund-30` on conv 10515.
- **missed_label**: #16764 and #28687 (both full, same minute) on conv 7943, which has no refund label. #24240 and #18125 on conv 6183. #43973 (full) on conv 11169. #29405 (18.1 % shipping refund, no suitable label) on conv 7842.
- **no_ticket_near_refund**: #4268, #7707, #1659 (note `remote`, one customer, old subscription orders).
- **no_conversation**: #16705, #21832, #16761, #21958 (2026-09-07 12:53-12:56 UTC, note `remote`). #42821, #30056, #21586, #16291 (one customer, 4 orders refunded at 2026-09-10 01:14 UTC).
- **duplicate label**: conv 10255 got `refund-full` on 09-13 19:09 UTC for #35722. That refund was already paired with the label on the same customer's other conversation, 10516, on 09-12.

### 5.2 Last full day, 2026-09-13

8 support refunds / 440.10 EUR: matched 4, missed_label 1 (#29405), no_conversation 3 (all `remote`: #31604, #44811, #10324). Correct label 50 %; any label where a ticket was near 80 %; other-note refunds 80 %. Label events 5 (`refund-full` 3, `refund-30` 1, `refund-50` 1): 4 matched to support refunds, 1 duplicate (conv 10255). No refunds by call support or Chargeflow on that day.

### 5.3 Independent cross-check

Re-derived on 2026-09-14 about 12:00 UTC with separate code: REST-only Shopify refunds (no GraphQL order search), a fresh Chatwoot conversation scan (1,850 conversations active since 2026-09-04T21:00Z), and label events read from the 73 conversations currently carrying a `refund-*` label. The matching was simpler: identity by `shopify_customer_id` / email / `shopify_email_link` only, no contact-search or order-mention fallback, and no one-to-one pairing. Results for the 7 days: 79 support refunds / 3,544.41 EUR, the same buckets (full 56, 30: 11, 50: 8, other 4), 41 label events (refund-full 22, refund-30 12, refund-50 7), matched 38, bucket_mismatch 2 (#37920, #36057, on the same conversations), missed_label 14. The script's 3 `no_ticket_near_refund` refunds (#4268, #7707, #1659) were linked only through contact search, so the simpler method counted them as no conversation (25 instead of 22). All 41 label events had a support-agent refund of the same customer within 48 h, and none had a call-support or Chargeflow refund nearby. The median label delay was 3 s.

---

## 6. Edge cases

- **One label, several refunds.** Chatwoot logs a label only once per conversation. A customer who gets two refunds in one ticket, or several orders refunded together, can show only one `refund-full` event. The greedy pairing gives the event to one refund. The rest become `matched_shared_label` if the label is present, otherwise `missed_label`. In the sample, multi-order refunds in one ticket (#16764/#28687 on conv 7943) had **no** label at all, so they are real misses.
- **One refund, labels on two conversations.** Customers often have 2-4 conversations (for example a subscription cancellation and a refund request). The second label becomes `duplicate_label_refund_already_matched`, not a false "label without refund".
- **Shipping-only and odd partial refunds** (12-23 %, 40.5 %) have no label bucket. They are always mismatches or misses. Consider showing them separately, or ask the owner whether they should be labelled.
- **Buckets drift.** The bucket tolerance is ±5 pp (45.5 % counts as 50). With the ±3 pp used in `shopify-refunds.md`, #37920 would be `other`. Either way it is a mismatch against `refund-30`.
- **Cumulative full.** A partial refund that completes an earlier refund is `full`, so it matches `refund-full`.
- **Failed refunds** (totalRefunded 0) are excluded. They cannot be labelled as money refunds.
- **Facebook inbox** senders have no email and often no `shopify_customer_id`. Only the order-mention fallback can link them.
- **Identity drift.** A customer writing from another address matches only if `shopify_email_link` or `shopify_customer_id` is set on the contact, or the order number appears in the conversation.
- **Window edges.** Refunds are fetched with ±T around the window, and label events with 2T before it, so late or early labels still pair. A label for a refund late on the last day may arrive after the run. Re-running later can change past numbers slightly.
- **Chatwoot contact search 422.** It is retried twice, then counted as `contactSearchFailed` in `inputs.fallback`. 0 failures in the sample runs.
- **Conversation list shifts while paging.** A second pass from page 1 picks up conversations that moved to the top.
- **Privacy.** Emails live only in memory. Refund notes are reduced to an allowlist of codes (`remote`, `hk`, `cust request`, `eu withdrawal`, `lost parcel`, `refunded by chargeflow`, `alert_ref`, `none`, `other_text`). The output holds only order numbers, conversation ids, refund ids, amounts and categories.

---

## 7. Script usage and output

```
npx tsx src/scripts/analytics/refundLabelReconciliation.ts --days=7 [--tz=Europe/Helsinki] \
    [--out=/home/dolan/support-analytics] [--include-today] [--tolerance-hours=48]
```

It writes `<out>/refund-label-reconciliation_<days>d[_incl-today]_<endDate>.json` and `.md`, and prints the markdown to stdout. JSON keys:

- `window`, `config` (actor ids, bucket tolerance, % base), `inputs` (counts, fallback statistics, API calls)
- `supportAgent`, `allStaff`, `byActor[actor]`, `supportByNoteGroup.{remote_or_hk, other_notes}`. Each holds `{refunds, eur, byBucket, categories, rates}`.
- `supportMatchedVia`, `supportMismatches` (for example `"refund 50 -> label 30": 1`), `supportNoteCodesByCategory`, `matchTiming`
- `labels.{events, byLabel, byCategory}`, `byDay[]`
- `refundRows[]`: refundId, orderName, localDate, createdAtUtc, actor, amountEur, presentment, pct, cumPct, bucket, category, matchedVia, conversationId, labelBucket, labelMinusRefundHours, candidateConversations, conversationsNearRefund, otherRefundLabelOnNearConversation, contactExistsInChatwoot, noteCode
- `labelRows[]`: conversationId, label, localDate, addedAtUtc, category, plus refundId, orderName, refundActor, refundBucket, refundPct, labelMinusRefundHours and matchedVia when paired, or the nearest-refund fields otherwise

For a dashboard: run it daily with `--days=1` (or keep `refundRows`/`labelRows` per day and aggregate). Re-run the previous 2 days as well so that late labels are picked up.

---

## 8. Unverified or not possible

- **UNVERIFIED:** what the refund notes `remote` and `hk` mean, and whether those refunds are *expected* to have no ticket or label. They explain 35 of the 39 unlabelled support refunds in the sample week (missed_label 10, no_ticket_near_refund 3, no_conversation 22).
- **UNVERIFIED:** how the `refund-*` labels are applied. They land a median 3 s after the Shopify refund, which suggests a tool rather than a manual second step, but no code in this repository adds them.
- User 135617184092 is Jan, the call-support agent (confirmed by the owner 2026-09-14). None of his 24 refunds carried a label, although 11 of those customers had an active ticket; refund labels are Ruth's responsibility, so his refunds are reported but excluded from label compliance.
- **NOT OBSERVED:** `refund-70` labels, `matched_shared_label`, `refund_outside_tolerance`, `no_refund_found`, `unidentified_customer` and order-mention fallback hits. The rules exist but were not exercised by real data.
- **NOT POSSIBLE from Chatwoot:** telling who added a label. Every event reads "Scandi Gum added ...". The pairing assumes the label belongs to the refund closest in time.
- **Limitation:** multiple refunds on different orders of one customer within 48 h can pair in the "wrong" order when buckets are equal. Totals are unaffected, but the order number shown on a row can be swapped.
- **Limitation:** contact search is fuzzy and slow. Customers with no conversation cannot be told apart from customers who wrote from an unlinked email and never quoted the order number.

## 9. Open questions for the owner

1. What are `remote` and `hk` refunds, and should they count toward label compliance?
2. Should shipping-only or other partial refunds (not 30/50/70/full) get a label? Should a `refund-other` label exist?
3. Is the Jan's call-support account expected to label refunds in Chatwoot?
4. Should a second refund in the same ticket be recorded somehow (for example a private note)? Label events cannot show it.

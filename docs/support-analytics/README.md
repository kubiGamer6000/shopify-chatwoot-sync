# Support and refund analytics: start here

This folder is the specification for a support and refund analytics dashboard for Scandi Gum (Shopify store, Skio subscriptions, Chatwoot support, an AI AgentBot). It is written for the coding agent that will build the dashboard. **Read this file first.** It says which definition wins where the detailed guides differ, which script reproduces each number, how to store and sync the data, and which decisions the owner still has to make.

Everything was verified with read-only calls against the live systems on 2026-09-14 (Chatwoot GETs, Shopify GraphQL queries and REST GETs, Skio GraphQL queries, Firestore reads). Anything that could not be verified is marked **UNVERIFIED**. The scripts never write to any external system.

| Guide | Owner requirement | What it covers |
|---|---|---|
| [ticket-volume-and-sla.md](ticket-volume-and-sla.md) | 1 | Tickets needing handling, resolved, resolved late, reopened, first response, backlog now and per day |
| [chatwoot-reports-api.md](chatwoot-reports-api.md) | 1, 2 | Every Chatwoot reporting endpoint: what it means, what to use it for, what not to trust |
| [labels-and-actions.md](labels-and-actions.md) | 2, 5 | Intent labels, combinations, action labels (refund-%, reshipped, cancellations) per day |
| [shopify-refunds.md](shopify-refunds.md) | 3 | Refund counts, EUR, currencies, % of order and policy buckets |
| [refund-attribution.md](refund-attribution.md) | 3 | Who initiated each refund (Ruth, call support, Chargeflow, others) |
| [refund-label-reconciliation.md](refund-label-reconciliation.md) | 4 | Do Ruth's Shopify refunds carry the matching Chatwoot label? |
| [ai-agent-metrics.md](ai-agent-metrics.md) | 5 | AgentBot outcomes, AI-handled share, bot messages, AI cancellations, guard events, token cost |
| [examples/](examples/) | 6 | PII-free sample outputs of every script (full JSON structure, rows trimmed) |

The owner requirements, as numbered in this folder:

1. Tickets: how many needed handling, how many were resolved (on time / late), reopened, backlog and oldest open ticket, per day.
2. What tickets are about: intent labels and label combinations per day.
3. Refunds: count, amount, partial-refund buckets, and who initiated them.
4. Label compliance: do refunds carry the correct Chatwoot label?
5. The AI agent: what it handled, what it did (answers, cancellations), what it cost.
6. For every metric: "last day" and "last 7 days" views.

---

## 1. Conventions (these override the individual guides)

### 1.1 Time windows

| Name | Definition (Europe/Helsinki calendar days) | Example on 2026-09-14 |
|---|---|---|
| **Today** | Local midnight today until now. Always marked partial and provisional. | 2026-09-14 00:00 .. now |
| **Last day** | Yesterday, the complete local day | 2026-09-13 = [2026-09-12T21:00Z, 2026-09-13T21:00Z) |
| **Last 7 days** | The 7 complete local days ending yesterday. **Today is not included.** | 2026-09-07 .. 2026-09-13 = [2026-09-06T21:00Z, 2026-09-13T21:00Z) |
| Rolling 7 days (optional live tile) | 6 complete local days plus today so far, aligned to local midnight | 2026-09-08 00:00 .. now |

- Compute local midnights with a timezone-aware function (`Intl.DateTimeFormat` with `timeZone: 'Europe/Helsinki'`, or a tz library), never a fixed +3. Helsinki is UTC+3 until 2026-10-25 04:00 local, then UTC+2. `src/scripts/analytics/lib/refundRules.ts` exports `localDay()` and `localMidnightUtc()`.
- Store every window as half-open `[startUtc, endUtc)` next to the numbers.
- Do **not** use rolling N×24 h windows that are not aligned to local midnight (`aiAgentMetrics.ts` still prints one as "rolling 168h" for reference; ignore it on the dashboard).
- Shopify's shop timezone is Europe/Stockholm (one hour behind Helsinki). Bucket refunds by Helsinki day from the UTC timestamp; do not use Shopify's date filters as day boundaries.

How each script reproduces "last day" and "last 7 days":

| Script | Last 7 days | Last day | Today |
|---|---|---|---|
| `ticketVolume.ts` | `--days=7`: rows 09-07..09-13, `totals.completeDays` | row for yesterday (same run, or `--days=1`) | row with `partial: true` |
| `labelsAndActions.ts` | `--days=7` | `--days=1` or the yesterday column | the `*` column |
| `chatwootReports.ts` | `--days=7 --complete-days` | `--days=1 --complete-days` | `--days=1` (today to now) |
| `shopifyRefunds.ts` | `--days=7`, `windows.complete` | rows with `localDay` = yesterday | rows with `localDay` = today (`windows.rolling` is the rolling tile) |
| `refundAttribution.ts` | `--days=7` | `--days=1` | `--days=1 --include-today` minus yesterday |
| `refundLabelReconciliation.ts` | `--days=7` (`byDay` holds each day) | `--days=1` | `--include-today` |
| `skioCancellations.ts` | `--days=7` (`byDay` holds each day) | `--days=1` | `--include-today` |
| `aiAgentMetrics.ts` | `--days=7`, window `complete 7d` | `perDay[yesterday]` | window `today so far` |

Output file stamps differ between scripts (`_2026-09-14` = run date for ticket volume, chatwoot reports and refunds; `_2026-09-13` = last complete day for labels, attribution, reconciliation and Skio). The dashboard does not read these files; they are examples only.

### 1.2 Timezone rule for Chatwoot v2 reports (verified live)

Pass `timezone_offset` = the Helsinki offset **in effect at request time** (3 now) for the whole range, and never split a range at a DST change. Test on 2026-09-14 with `metric=conversations_count&group_by=day`:

| Range | `timezone_offset=3` | `timezone_offset=2` |
|---|---|---|
| 2026-03-26..04-01 (across the 2026-03-29 change) | buckets at 22:00Z before and 21:00Z after the change = Helsinki midnight on both sides, sum 163 | buckets at 23:00Z / 22:00Z = CET/CEST midnight, one hour off, sum 163 |
| 2025-10-23..10-29 (across the 2025-10-26 change) | 21:00Z before, 22:00Z after = Helsinki midnight | 22:00Z / 23:00Z = one hour off |

Chatwoot resolves the number to a DST-aware zone using the offset that is current when the request is made. Which number gives Helsinki buckets in winter (after 2026-10-25) is **UNVERIFIED** (probably 2). Every Chatwoot bucket timestamp must therefore be asserted to equal a Helsinki local midnight; `ticketVolume.ts` records failures in `v2BucketAssertionFailures`, `labelsAndActions.ts` and `aiAgentMetrics.ts` print a warning. `/reports/summary` and `summary_reports/*` ignore the parameter. This replaces the "split at DST" advice that earlier versions of ticket-volume-and-sla.md, labels-and-actions.md and ai-agent-metrics.md gave.

### 1.3 Attribution facts

- Chatwoot has one agent user, "Scandi Gum" (id 165591). Ruth, the AgentBot and the dashboard app all act through it, so Chatwoot never tells you who did something. Labels, message timing, reply signatures and Firestore records are the attribution signals.
- Shopify: REST `refund.user_id` and GraphQL `Refund.staffMember` identify the staff account; `transactions[].source_name` identifies the app. **`read_users` is now granted**: the access token issued on 2026-09-14 12:16Z lists it, and `Refund.staffMember { id accountType }` returned the same id as REST `user_id` for 123 of 123 refunds in the last 7 days (the rest of this folder was written when it was still missing).
- Skio exposes no "cancelled by" field. Cancellation source comes from Chatwoot labels, joined by customer email (section 2, requirement 5).

---

## 2. Canonical metric definitions

Where two guides define the same thing differently, this table wins. The guide links go to the full definition and caveats.

### Requirement 1: tickets

| Metric | Canonical definition | Source and endpoints | Guide | Script / output field |
|---|---|---|---|---|
| **Tickets needing handling** (headline) | Distinct conversations with at least 1 human customer message (`message_type 0`, not private, `autoReplySignal() === null`) on local day D. Summing days gives conversation-days. | v1 `GET /conversations` (list by `last_activity_at_desc`) + `GET /conversations/{id}/messages` | ticket-volume 2.3 | `ticketVolume.ts` `daily[].needing` |
| New / came back | `new` = the conversation was created on D; `cameBack` = created earlier | same | ticket-volume 2.3 | `daily[].new`, `cameBack` |
| Conversations created (secondary) | `created_at` on D. Equals v2 `conversations_count`. Includes outbound outreach threads. | v2 `GET /reports?metric=conversations_count&group_by=day` | chatwoot-reports 2.1 | `daily[].created` |
| Ticket cycles started (secondary, SLA unit) | A cycle starts at a human customer message when no cycle is open and ends at the next resolve | messages | ticket-volume 2.5 | `sla.byStartDay[D].cycles` |
| **Resolved** | Resolve events on D (`Conversation was marked resolved` activity). Equals v2 `resolutions_count`. Also show distinct conversations resolved. | messages; v2 `resolutions_count` | ticket-volume 2.4 | `daily[].resolveEvents`, `resolvedDistinctConversations` |
| **Resolved late** | Among resolve events on D that close a ticket cycle: `late24h` = resolve − cycle start > 24 h, `late48h` > 48 h. Also `firstResponseLate24h` (no bot or human reply within 24 h of the cycle start) and `firstHumanReplyLate24h`. Per inbox. | messages | ticket-volume 2.4a | `daily[].resolvedLate` |
| **Reopened** | `reopenedFromResolved`: conversations whose last status event before their first human customer message on D is a resolve (distinct conversations). | messages | ticket-volume 2.3, 2.4b | `daily[].reopenedFromResolved` |
| Chatwoot "reopens" (reference only) | Reporting events `conversation_opened` with `value > 0`. Reproduced exactly by the status replay (348 = 348 over 7 days, every day equal) but counts status changes, not customer comebacks, and cannot be joined to conversations. Never the headline. | v1 `GET /reporting_events?name=conversation_opened` | ticket-volume 2.4b | `daily[].reopenReconciliation` |
| **First response SLA** (headline) | First **human** reply per ticket cycle: p50 / p90 and the share of cycles with no human reply within 24 h and 48 h (cycles resolved within T without a human reply are excluded). 24/7 wall clock. Bot-or-human first response is the secondary series; holding acknowledgements never count. | messages + Firestore `sentReplies` | ticket-volume 2.5 | `sla.*.firstHumanReply`, `noHumanReplyWithin24h` |
| **Backlog now** | Open conversations (`status=open`, the human queue); overdue = open conversations whose first unanswered human message is older than 24 h / 48 h (holding acks ignored); oldest waiting = the oldest such message | v1 list `status=open` + messages, or v2 `live_reports/conversation_metrics` for the count | ticket-volume 2.6 | `backlog.open.messageBased` |
| **Backlog per day** | The same state at the end of each local day (00:00 of D+1), reconstructed by replaying status and wait episodes from messages. Going forward, store a snapshot every 15 min instead. | messages | ticket-volume 2.6a | `endOfDayBacklog.days[]` |
| Pending with a waiting customer (alert) | Pending conversations with an unanswered human customer message. They are invisible in the open queue. | list `status=pending` | ticket-volume 2.6 | `endOfDayBacklog.days[].pendingWaiting` |

**Do not use** for requirement 1: `outgoing_messages_count` (includes private notes), v2 `avg_first_response_time` / `avg_resolution_time` as headlines (means of a bimodal distribution, credited to the reply day), `first_reply_created_at`, `waiting_since` after 2026-09-14 08:00Z (holding acks reset them), the "Conversation was reopened" activity text (mostly bot handoffs), `reports/conversations` pending (always 0), bot_* metrics (always 0).

**The 01:00 spike is real tickets.** 124 of 1,140 conversations in the last 7 days (38 on 09-13) were created 01:00-02:00 Helsinki. That is when Skio's renewal billing run creates the recurring orders: Shopify showed 245 orders created 01:00-02:00 on 2026-09-13, 239 of them tagged `Subscription Recurring Order`, against 3-24 orders in every other hour. Customers answer the order-confirmation email right away ("RE: Order #… confirmed", cancellation and refund requests). Of the 124 conversations, 123 start with a customer message, 0 were flagged by `autoReplySignal`, and 120 are in the Support inbox. **Do not exclude them.**

### Requirement 2: labels

| Metric | Canonical definition | Guide | Script / output field |
|---|---|---|---|
| **Tickets per intent** (headline) | Metric A: conversations created on D that currently carry intent label L (equals v2 `type=label&id=<id>&metric=conversations_count`). A snapshot: store it at the daily close. | labels-and-actions 3 | `labelsAndActions.ts` `createdByDay[D].intents` |
| Intents added per day | Metric B: distinct conversations that got L for the first time on D (activity `Scandi Gum added …`) | labels-and-actions 3 | `addedByDay[D]` |
| **Intent combinations per day** | Created basis: sorted current intents of conversations created on D (`createdByDay[D].combos`). Added basis: sorted intents first added to a conversation on D (`addedIntentCombosByDay[D]`). | labels-and-actions 3, 8.3 | both fields |
| **Actions per day** | Metric B for action labels, by label-added day. Never by created day. | labels-and-actions 3 | `addedByDay[D]`, `actionByCurrentIntentByDay[D]` |
| Label groups (config) | intent: sub-cancel, refund, order-status, other, not-delivered, business, change-address, missing-packs, product-defect, change-contact, no-country, discount-issue. action (human): refund-30, refund-50, refund-70, refund-full, reshipped, sub-cancelled, changed-contact, tp-free-pack. action (AI): sub-cancelled-ai. bot: ai-response, ai-reply. legacy (hide from filters by default, show under "Legacy"): ai-resolved, escalated, product-not-received, cancel-order. | labels-and-actions 2 | — |

Legacy labels are not in the Chatwoot label catalogue and were not **added** to any conversation in the window, but old conversations still **carry** them: on 2026-09-14, 62 of the 130 pending conversations had `ai-resolved` and 22 had `escalated`. A label filter will meet them.

### Requirement 3: refunds

| Metric | Canonical definition | Guide | Script / output field |
|---|---|---|---|
| **Money refund** | A Shopify `Refund` with a successful refund transaction (`totalRefundedSet.shopMoney.amount > 0`). Zero-amount edit refunds and failed refunds are excluded; show failed attempts separately. Bucketed by the Helsinki day of `refund.createdAt`. | shopify-refunds 2 | `shopifyRefunds.ts` `rows[]` |
| **Refund count / EUR** | Count of money refunds; sum of `totalRefundedSet.shopMoney` (EUR). Also distinct orders and per currency (`presentmentMoney`). | shopify-refunds 2 | `windows.complete.agg` |
| **Refund %** | `refund presentment amount / order.totalReceivedSet.presentmentMoney × 100`; cumulative % over all money refunds on the order | shopify-refunds 2.1 | `rows[].pct`, `cumPct` |
| **Bucket** | `bucketRefund()` in `lib/refundRules.ts`, in order: `full` (pct ≥ 99.5, or cumulative ≥ 99.5, or the order is fully refunded by this refund); `shipping-only`; `30` / `50` / `70` (within **±5 pp**); `other`. One function for the refund page and the compliance page. | this file | `rows[].bucket` |
| **Initiator** | `classifyActor()` in `lib/refundRules.ts` on REST `user_id` / `source_name` / note (or GraphQL `staffMember.id`, which is identical). Classes: `support_agent` (Ruth), `call_support`, `chargeflow_app`, `chargeflow_collaborator`, `other_staff`, `unknown_staff`, `other_app`, `unknown`. Dashboard groups: Ruth / Call support / Chargeflow (app + collaborators) / Other staff / Other. The `refund_success` event actor is **not** an attribution signal. | refund-attribution 2.1 | `rows[].actor`, `actorGroup` |

The earlier ±3 pp tolerance, the separate `full (cumulative)` bucket and the "refund_success within ±5 s" actor rule in shopify-refunds.md are retired. Staff ids, Chargeflow collaborator ids and the app source map are dashboard **config** (editable), with an alert for unmapped staff ids.

### Requirement 4: label compliance

| Metric | Canonical definition | Guide | Script / output field |
|---|---|---|---|
| **Label compliance, where a ticket existed** (headline) | For Ruth's money refunds: refunds with any `refund-*` label paired within ±48 h / refunds that had a customer conversation active within ±48 h | refund-label-reconciliation 4 | `supportAgent.rates.anyLabelPctWhereTicketNearRefund` |
| Correct-bucket rate | Refunds paired with a label of the same bucket / all of Ruth's refunds | same | `rates.correctLabelPct` |
| Compliance excluding `remote` / `hk` refunds | The same rates for refunds whose note is not `remote` or `hk`. Show next to the headline until the owner says what those refunds are. | same | `supportByNoteGroup.other_notes.rates` |
| Bucket accuracy | Correct bucket among labelled refunds | same | `rates.bucketAccuracyPct` |

### Requirement 5: AI agent

| Metric | Canonical definition | Guide | Script / output field |
|---|---|---|---|
| **AI fully handled share** | Customer tickets created on D whose latest AgentBot decision is `responded` or `closed`, now resolved, with no dashboard reply and no human action label / customer tickets created on D | ai-agent-metrics 2.7 | `aiAgentMetrics.ts` `tickets.perDay` |
| Handed to human | Latest decision `escalated` / `handed-off` / `failed` / `swept-open` | same | same |
| **Bot replies per day** | From 2026-09-14 08:00Z: Firestore `sentReplies` rows with `source = agent-bot` (answers) and `agent-bot-holding` (acknowledgements). Before: the message heuristic "bot replies (heuristic)" from `ticketVolume.ts` (label rule + timing rule). One series on the dashboard, with a marker at the switch. | ai-agent-metrics 2.2, ticket-volume 2.2 | `sentReplies`; `daily[].publicReplies.bot` |
| **AI vs human subscription cancellations** | Label-added events `sub-cancelled-ai` (AI) and `sub-cancelled` (human) per day, verified against Skio: 36 of 36 AI labels and 194 of 194 human labels in the last 7 days have a Skio cancellation of the same customer email, median gap 1 s | labels-and-actions 3, this file | `labelsAndActions.ts` `addedByDay`; `skioCancellations.ts` |
| All Skio cancellations (context) | Skio subscriptions with `cancelledAt` on D, split into dunning (payment failure), AI label, human label, customer had a support conversation but no cancel label, no support contact | this file | `skioCancellations.ts` `byDay` |
| AgentBot outcomes | Post-launch route buckets from `agentBotDecisions` (latest decision per conversation). Must be snapshotted daily; pre-launch days are a different metric family. | ai-agent-metrics 2.1 | `windows`, `perDay` |
| AI tokens and calls | `aiUsage` rows per kind and model, tooling kinds excluded | ai-agent-metrics 2.6 | `aiUsage` |
| AI cost (USD) | **UNVERIFIED** estimate: assumed list prices, cache tokens not recorded, some rows under-record output. Not a headline tile until compared with the Anthropic invoice. | ai-agent-metrics 2.6 | `estCostUsd` |

---

## 3. Data sources, authentication and environment

| System | Access used | Auth | Env vars (`src/config/env.ts`) |
|---|---|---|---|
| Chatwoot v1 (account API) | `GET /api/v1/accounts/{account}/conversations`, `/conversations/{id}/messages`, `/reporting_events`, `/labels`, `/inboxes`, `/contacts/search`, `/search/messages` | header `api_access_token` (administrator user token) | `CHATWOOT_BASE_URL`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_API_TOKEN` |
| Chatwoot v2 reports | `GET /api/v2/accounts/{account}/reports`, `/reports/summary`, `/summary_reports/{label,inbox,agent,channel}`, `/live_reports/conversation_metrics` | same header | same |
| Shopify Admin API 2026-01 | GraphQL `POST /admin/api/2026-01/graphql.json` (queries only), REST `GET /orders/{id}/refunds.json` | header `X-Shopify-Access-Token` from `getAccessToken()` (`src/services/shopifyAuth.ts`, client credentials, token cached ~23 h) | `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` |
| Skio | GraphQL `POST https://graphql.skio.com/v1/graphql` (queries only) | header `authorization: API <key>` | `SKIO_API_KEY` |
| Firestore (project shared with production) | Reads of `agentBotDecisions`, `sentReplies`, `aiUsage`, `responderGuardEvents`, `classifications` via `getDb()` (`src/services/firestore.ts`) | service account | `FIREBASE_BASE64_SERVICE_ACCOUNT` |

Shopify scopes on the token (2026-09-14 12:16Z): `read_all_orders, read_analytics, write_assigned_fulfillment_orders, write_customers, read_discounts, read_draft_orders, read_fulfillments, read_locations, write_merchant_managed_fulfillment_orders, read_orders, read_product_listings, read_products, read_reports, read_shipping, read_shopify_payments_accounts, read_shopify_payments_payouts, read_content, read_themes, read_users`. `read_users` was missing earlier the same day and is now present (`currentAppInstallation.accessScopes` confirms it). Still missing: `read_returns` (selecting `Refund.return` fails the whole query) and `read_shopify_payments_disputes` (REST disputes 403; GraphQL disputes work without it). The dashboard only needs read scopes; the write scopes belong to the existing sync app.

Chatwoot reference ids: inboxes Support 99613 (email, AgentBot attached), Hey 107519 (email), Scandi 128017 (Facebook). Label ids come from `GET /labels` (for example refund 29686, sub-cancel 29684).

Privacy: customer names, emails, phone numbers, addresses, message text, refund notes and Skio emails are used in memory only (identity joins, classification). The dashboard store holds ids, order numbers, amounts, counts and derived codes.

---

## 4. Dashboard layout

Every tile shows **Today** (partial), **Last day** and **Last 7 days** with the window boundaries in a tooltip; every chart has one bar or point per local day with today visibly marked partial.

| Page | Tile / chart | Metrics (section 2) |
|---|---|---|
| Overview | KPI row: tickets needing handling, resolved (late share), reopened, open now, overdue >24 h, oldest waiting, refunds EUR, AI fully handled % | req. 1, 3, 5 headlines |
| Tickets | Stacked bar per day: needing = new + came back (reopened highlighted) | needing, new, cameBack, reopenedFromResolved |
| Tickets | Bar per day: resolve events split on time / late >24 h / late >48 h, with a per-inbox selector | resolvedLate |
| Tickets | Line per day: end-of-day open, open overdue >24 h / >48 h; secondary axis oldest waiting (h) | endOfDayBacklog, backlog snapshots |
| Tickets | Histogram: first human reply buckets (<1 h, 1-24 h, 24-48 h, >48 h, none) per cycle-start day; bot replies as a separate series | sla |
| Tickets | Alert: pending conversations with a waiting customer (count + oldest) | pendingWaiting |
| Intents | Stacked bar per day: tickets per intent (created basis); table of top 10 combinations per day (toggle created / added basis) | Metric A, combos |
| Actions | Grouped bar per day: refund-30/50/70/full, reshipped, sub-cancelled (human) vs sub-cancelled-ai (AI); action × intent table | Metric B |
| Refunds | KPI: count, orders, EUR; stacked bar per day by initiator group; bucket donut (count and EUR); currency table | refunds, buckets, initiator |
| Refunds | Table: unmapped staff ids and failed refund attempts (alerts) | attribution checks |
| Compliance | KPI: label compliance where a ticket existed (Ruth), correct-bucket rate, both with and without `remote`/`hk`; bar per day matched / mismatch / missed / no ticket | reconciliation |
| AI agent | Stacked bar per day: AI fully handled / handed to human / not bot inbox; bot answers vs acknowledgements vs human dashboard sends; AI vs human cancellations (Skio-verified badge); tokens and calls by pipeline; USD only as a labelled estimate | req. 5 |
| Data health | Last sync per source, API calls per sync, v2 cross-check diffs (must be 0), bucket timestamp assertion, Firestore quota errors | sync metadata |

---

## 5. Ingestion architecture

### 5.1 Principles

- **One shared Chatwoot ingestion layer.** Running the example scripts back to back fetches the same conversation messages three to four times (ticketVolume 1,783 calls, labelsAndActions 1,652, skioCancellations 471, reconciliation 300 for 7 days). A dashboard pulls the conversation list and messages **once** into a cache and derives every Chatwoot metric from it.
- **Message cache keyed by conversation id and `last_activity_at`.** Every message, label change and status change bumps `last_activity_at`, so a conversation needs refetching only when that value changed. Refetch newest-first and stop at the first message id already cached.
- **Idempotent upserts** keyed by natural ids: Chatwoot message id, conversation id + local day, Shopify refund id, Skio subscription id, Firestore document id.
- **Past days are recomputed, not frozen**, for the windows where late changes happen (see 5.3). Everything is stored with `computed_at`.
- **Firestore is read incrementally** with a `ts` cursor per collection. Never re-read 7 days on a page view: the production app shares the daily read quota, and it was exhausted twice on 2026-09-14 (still `RESOURCE_EXHAUSTED` at 12:05Z).

### 5.2 Storage schema (proposal)

```sql
-- Raw caches (PII-free projections)
cw_conversations(id PK, inbox_id, status, labels text[], created_at, last_activity_at, waiting_since,
                 contact_key_hash, fetched_at)                      -- contact_key_hash = sha256(lower(email)) for joins, never the email
cw_messages(id PK, conversation_id, message_type, private, created_at, kind,   -- kind: human|machine|bot|holding|human_dashboard|human_other|activity
            activity_kind, labels_added text[], signature_class, fetched_at) -- activity_kind: resolve|reopen_text|marked_open|label_add|label_remove|assign|other
shop_refunds(refund_id PK, order_id, order_name, created_at, local_day, state, eur, presentment_amount, currency,
             pct, cum_pct, bucket, shipping_only, actor_class, actor_group, staff_user_id, source_name, note_code,
             order_has_dispute, dispute_before_refund, fetched_at)
skio_cancellations(subscription_id PK, cancelled_at, local_day, dunning bool, contact_key_hash, category, matched_conversation_id)
fs_sent_replies(doc_id PK, conversation_id, source, ts)
fs_ai_usage(doc_id PK, kind, model, input_tokens, output_tokens, conversation_id, ts)
fs_guard_events(doc_id PK, conversation_id, outcome, source, violations text[], ts)

-- Daily aggregates (one row per local day and dimension; recomputed for open days)
daily_aggregates(local_day, metric, dimension, dimension_value, value numeric, window_start_utc, window_end_utc,
                 computed_at, final bool, PRIMARY KEY(local_day, metric, dimension, dimension_value))
   -- e.g. ('2026-09-13','needing','inbox','Support',207), ('2026-09-13','resolved_late_24h','all','all',301),
   --      ('2026-09-13','refund_eur','actor_group','Ruth (support)',440.10)

-- Snapshots (state that has no history API)
backlog_snapshots(taken_at PK, open, pending, open_waiting, open_overdue_24h, open_overdue_48h,
                  oldest_waiting_conversation_id, oldest_waiting_hours, pending_waiting, by_inbox jsonb)  -- every 15 min
label_snapshots(local_day, label, created_count, PRIMARY KEY(local_day,label), taken_at)                  -- Metric A, at the daily close
agentbot_decision_snapshots(snapshot_day, conversation_id, action, route, intents text[], ts,
                            PRIMARY KEY(snapshot_day, conversation_id))                               -- daily
label_events(conversation_id, label, op, added_at, local_day, PRIMARY KEY(conversation_id,label,op,local_day))
refund_label_matches(refund_id PK, category, conversation_id, label, label_minus_refund_hours, matched_via, computed_at)

-- Config (editable in the dashboard)
config_staff(user_id PK, label, actor_class, verified bool, note)
config_chargeflow_collaborators(user_id PK)
config_app_sources(source_name PK, app, actor_class)
config_label_groups(label PK, grp)   -- intent | action_human | action_ai | bot | legacy
config_sla(name PK, hours)           -- overdue_1 = 24, overdue_2 = 48
sync_runs(source, started_at, finished_at, api_calls, errors, cursor)
```

### 5.3 Sync jobs and cadence

| Job | Cadence | Work | Approx. calls per run |
|---|---|---|---|
| Chatwoot incremental | every 15 min | List `status=all&sort_by=last_activity_at_desc` until `last_activity_at < cursor - 5 min`, re-read page 1; for changed conversations fetch messages newest-first until a cached id | 2-4 list + 20-60 message calls |
| Backlog snapshot | every 15 min, plus 23:59:30 Helsinki | `live_reports/conversation_metrics` (1 call) + open/pending lists (~14 calls) + messages from cache | ~15 |
| Shopify refunds incremental | hourly | GraphQL `orders(query: "updated_at:>='<cursor>' AND (financial_status:refunded OR financial_status:partially_refunded)")` + REST `refunds.json` for new refunds (or `staffMember` in the same query) | 1-3 GraphQL + new orders |
| Firestore incremental | every 15 min | `where('ts','>',cursor)` per collection; `agentBotDecisions` upsert | ~1,300 reads per day in total |
| **Daily close** | 03:00 Helsinki | Recompute `daily_aggregates` for D-1, D-2, D-3 from the caches; v2 cross-check for D-1 (12 calls, diffs must be 0); `reporting_events` opened check (~7 calls per day); label snapshot (1 `summary_reports/label` + per-label series); AgentBot decision snapshot; Skio cancellations for D-3..D-1 (2 calls) and join; refund-label reconciliation for D-3..D-1; mark D-4 `final` | ~100 Chatwoot + Shopify per refunded order |
| Weekly audit | Sunday 04:00 | Broad Shopify `updated_at` scan without the financial-status filter (catches money refunds in other statuses); unmapped staff ids; label catalogue diff | ~2,000 orders per day scanned |
| Backfill | once | 7-30 days with the example scripts' logic (7 days: ~1,800 Chatwoot calls in ~4 min with 5 workers) | |

Why re-run 3 days: a Shopify refund can fail about 18 h after its success event (#31683), refund labels can arrive up to 48 h after the refund, customer replies make recent SLA cycles right-censored for 48 h, and Metric A label counts change when labels are added later.

### 5.4 Rate limits and retries

- **Chatwoot Cloud** answered `429 Retry later` (text/plain, **no `Retry-After` header**) after roughly 300 requests within a minute when several scripts ran back to back; 5 parallel workers inside one run never hit it. Rule: at most 5 concurrent requests and 200 requests per minute across all jobs, and on 429 / 5xx / network errors retry with a **linear 15 s backoff, up to 8 attempts** (`skioCancellations.ts` `cwGet()` implements this). The shared `chatwootClient` only retries 4 times (2-16 s) when no `Retry-After` is sent, which is not enough for a backfill. Both earlier statements were true for the conditions they described; this rule covers both.
- List pages take 1-1.5 s; message calls p50 ~200 ms. Label filters (`labels[]`, `POST /conversations/filter`) and `contacts/search` can time out with 422: filter on the client.
- **Shopify Plus**: REST leaky bucket 400 (`X-Shopify-Shop-Api-Call-Limit`), retry 429 with `Retry-After`; GraphQL retry on `THROTTLED` using `extensions.cost.throttleStatus`.
- **Skio**: no limit observed; 2 queries (500 rows each) cover 7 days.
- **Firestore**: every returned document is a billed read on a quota shared with production; `count()` aggregations are cheap but still failed under exhaustion.

---

## 6. Today and last 7 days at a glance

Real numbers from the scripts, pulled 2026-09-14 between 10:30Z and 12:30Z (Helsinki 13:30-15:30). Last day = 2026-09-13, last 7 days = 2026-09-07..09-13, today = 2026-09-14 until the run time shown. Aggregates only.

### Requirement 1: tickets (`ticketVolume.ts --days=7`, run 12:12Z)

| Metric | Today (to 15:12) | Last day 09-13 | Last 7 days |
|---|---:|---:|---:|
| Tickets needing handling (conversation-days) | 176 | **221** | **1,463** |
| new / came back | 112 / 64 | 160 / 61 | 1,120 / 343 |
| Reopened from resolved (canonical) | 63 | **60** | **314** |
| Chatwoot `conversation_opened` value > 0 (reference) | 58 | 67 | 348 |
| Conversations created (= v2) | 112 | 163 | 1,140 |
| Ticket cycles started | 185 | 233 | 1,566 |
| Public customer messages (= v2) | 202 | 257 | 1,716 |
| Resolve events (= v2) / distinct conversations | 273 / 256 | **378** / 356 | **1,511** / 1,398 conversation-days |
| Resolves closing a cycle: late > 24 h | 165 of 272 (60.7 %) | **301 of 366 (82.2 %)** | **979 of 1,485 (65.9 %)** |
| late > 48 h | 20 (7.4 %) | 274 (74.9 %) | 773 (52.1 %) |
| First human reply p50 / p90 (cycles started that day) | 7.1 / 8.3 h (n 10, provisional) | 25.4 / 30.4 h (n 88, provisional) | 51.9 / 72.9 h (n 822) |
| No human reply within 24 h (excluded variant) | n/a | 76 of 137 no response (55.5 %) | 971 of 1,039 (93.5 %) |
| Replies: bot (heuristic) / holding ack / human | 35 / 24 / 195 | 59 / 0 / 249 | 433 / 0 / 881 |
| Resolves with a bot signal | 45 | 60 | 436 |

Backlog (message-based, holding acks ignored):

| State at end of day | 09-07 | 09-08 | 09-09 | 09-10 | 09-11 | 09-12 | 09-13 | now (12:12Z) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Open | 288 | 338 | 333 | 425 | 458 | 418 | 288 | 202 |
| Open overdue > 24 h | 176 | 135 | 174 | 248 | 308 | 304 | 114 | 29 |
| Open overdue > 48 h | 84 | 25 | 12 | 95 | 138 | 164 | 20 | 4 |
| Oldest waiting (h) | 313.7 | 337.7 | 361.7 | 385.7 | 409.7 | 322.9 | 105.8 | 97.2 (conv 11409) |
| Pending with a waiting customer | 38 | 38 | 38 | 38 | 38 | 38 | 38 | 38 |

The "now" column of the reconstruction equals the live snapshot taken 3 minutes later (overdue 29 / 4 in both; open 202 vs 203 because one conversation changed in between; 0 status mismatches over 1,570 replayed conversations). Pending: 130 conversations, 38 with a customer waiting (37 of them for more than 48 h).

### Requirement 2: labels (`labelsAndActions.ts --days=7`, run 12:24Z)

| Metric | Today (to 15:24) | Last day 09-13 | Last 7 days |
|---|---:|---:|---:|
| Conversations created | 116 | 163 | 1,140 |
| Top intents, created basis (Metric A) | refund 70, sub-cancel 65, other 9, order-status 8 | sub-cancel 96, refund 83, order-status 14, other 9, not-delivered 7 | sub-cancel 581, refund 519, order-status 130, other 95, not-delivered 54 |
| Top intents, added basis (Metric B) | — | sub-cancel 103, refund 89, order-status 13, other 10 | sub-cancel 592, refund 529, order-status 134, other 96 |
| Top combinations, created basis | refund+sub-cancel 40, refund 29, sub-cancel 22 | sub-cancel 44, refund+sub-cancel 43, refund 30 | sub-cancel 305, refund 229, refund+sub-cancel 222, order-status 90, other 76 |
| Top combinations, added basis | refund+sub-cancel 40, refund 30, sub-cancel 25 | sub-cancel 53, refund+sub-cancel 43, refund 37 | sub-cancel 339, refund 272, refund+sub-cancel 204, order-status 101 |
| Conversations with no intent | 0 | 2 | 6 |

Metric A drifts: two hours earlier the same run gave sub-cancel 94 for 09-13 and 579 for the week, because labels were added to those conversations in between. Store Metric A at the daily close.

Per-day top-10 combination tables on both bases are in [labels-and-actions.md 8.3](labels-and-actions.md).

### Requirement 5 (actions): human vs AI

| Metric | Today (to 15:24) | Last day 09-13 | Last 7 days |
|---|---:|---:|---:|
| `sub-cancelled` (human) conversations | 46 | **71** | **194** |
| `sub-cancelled-ai` (AI) conversations | 4 | **5** | **36** |
| … confirmed by a Skio cancellation of the same email (±30 min) | — | 71 / 71 and 5 / 5 | 194 / 194 and 36 / 36 (37 subscriptions) |
| All Skio cancellations (dunning) | — | 175 (12) | 919 (79) |
| Non-dunning Skio cancellations with no cancel label: support conversation near / no support contact | — | 35 / 52 | 224 / 385 |
| refund-30 / refund-50 / refund-70 / refund-full labels | 4 / 1 / 0 / 7 | 1 / 1 / 0 / 3 | 12 / 7 / 0 / 22 |
| reshipped | 3 | 5 | 19 |
| `ai-response` (first bot reply in a conversation) | 28 | 46 | 341 |

### Requirement 3: refunds (`shopifyRefunds.ts --days=7`, run 12:16Z; shared rules)

| Metric | Today (to 15:16) | Last day 09-13 | Last 7 days |
|---|---:|---:|---:|
| Money refunds / orders | 18 / 18 | **8** / 8 | **121** / 120 |
| EUR | 1,011.20 | **440.10** | **5,684.70** |
| Ruth (support_agent) | 13 / 665.38 | 8 / 440.10 | 79 / 3,544.41 (62.3 %) |
| Jan (call support) | 2 / 93.03 | 0 | 24 / 967.69 (17.0 %), + 2 failed attempts (125.36) |
| Chargeflow (app + collaborators) | 3 / 252.79 | 0 | 18 / 1,172.60 (20.6 %), collaborators 0 |
| Bucket full | 13 / 884.58 | 5 / 403.71 | 89 / 4,890.33 |
| Bucket 30 / 50 / 70 | 4 / 1 / 0 | 1 / 1 / 0 | 15 (279.58) / 9 (244.70) / 0 |
| shipping-only / other | 0 / 0 | 1 (6.14) / 0 | 3 (18.12) / 5 (251.97) |
| tenderTransactions check | — | diff 0 | diff 0 except 09-07 (+125.36 failed attempts) |

### Requirement 4: label compliance (`refundLabelReconciliation.ts --days=7`)

| Metric (Ruth's refunds) | Last day 09-13 | Last 7 days |
|---|---:|---:|
| Refunds / EUR | 8 / 440.10 | 79 / 3,544.41 |
| Matched / bucket mismatch / missed / no ticket near / no conversation | 4 / 0 / 1 / 0 / 3 | 38 / 2 / 14 / 3 / 22 |
| **Any label where a ticket existed** | **80 %** (4 of 5) | **74.1 %** (40 of 54) |
| Correct label, all refunds | 50 % | 48.1 % |
| Any label, refunds without `remote`/`hk` note | 80 % | 90.7 % (43 refunds) |
| Bucket accuracy | 100 % | 95 % |
| `refund-*` label events / paired with Ruth's refund | 5 / 4 (+1 duplicate) | 41 / 40 (+1 duplicate); 0 labels without a refund |

### Requirement 5: AI agent (`aiAgentMetrics.ts`, Firestore snapshot 10:32Z)

| Metric | Today (to 13:32) | Last day 09-13 | Last 7 days (from 09-07 03:00 local, see note) |
|---|---:|---:|---:|
| Customer tickets created | 105 | 161 | 1,121 |
| **AI fully handled** | 23 (21.9 %) | **44 (27.3 %)** | **296 (26.4 %)** |
| Handed to human | 77 (73.3 %) | 105 (65.2 %) | 677 (60.4 %) |
| Not in the bot inbox (Hey, Facebook) | 3 | 10 | 133 |
| Bot answers / acknowledgements (`sentReplies`, from 08:00Z) | 5 / 14 | not tracked; heuristic 59 bot replies | not tracked; heuristic 433 |
| Human dashboard sends | 188 | 242 | 830 |
| AI calls / tokens in / out | 691 / 3.19 M / 141 k | 926 / 4.61 M / 162 k | 5,619 / 27.0 M / 965 k |
| Est. USD (**UNVERIFIED**) | 9.51 | 12.92 | 73.79 |

Note: the 7-day AI figures come from a Firestore export that starts at 2026-09-07T00:00Z, three hours after the Helsinki day began (142 instead of 155 conversations created on 09-07, 1,127 instead of 1,140 for the week). Live Firestore was quota-exhausted when the rerun was attempted (12:05Z). Rerun `aiAgentMetrics.ts --days=7` after the quota resets. Post-launch (since 07:55Z) there are only 2 h 37 min of data: 26 decisions, 5 answers, 14 acknowledgements; rerun `--days=1` after 2026-09-15T07:55Z for the first full post-launch day.

---

## 7. Verification status

### Verified

- Raw Chatwoot counts equal v2 reports on every day (created, public incoming, resolve events, per inbox).
- Status replay reproduces Chatwoot's `conversation_opened value > 0` event count exactly on all 8 days; the reconstructed backlog "now" equals the live snapshot.
- v2 `timezone_offset` behaviour across both DST directions (section 1.2).
- The 01:00 spike = Skio renewal billing run (Shopify orders per hour).
- Every `sub-cancelled` and `sub-cancelled-ai` label event in 7 days has a real Skio cancellation (230 of 230, median 1 s).
- Refund totals agree across three scripts and an independent REST-only recount (121 / 5,684.70 EUR); REST `user_id` = GraphQL `staffMember.id` for 123 / 123 refunds; `read_users` present.
- Staff account 135220658524 is a regular staff account whose first name starts with "Ruth" (`staffMember`); the five known Chargeflow collaborator ids are `COLLABORATOR_TEAM_MEMBER` accounts.
- Every `refund-*` label in 7 days belongs to a refund by Ruth's account (41 of 41, median 3 s).
- Bot/human reply heuristic on 2026-09-13: 0 false positives in 59 bot replies, 1 missed bot reply in 249 human replies (signature audit, all 728 active conversations).

### Not verified


- What refund notes `remote` and `hk` mean, and how `refund-*` labels are added (a tool, given the 3 s median; nothing in this repo writes them).
- Whether Ruth is the only person using her Shopify login and the Chatwoot token.
- Bot vs human reply heuristic error rate on days other than 2026-09-13. On 09-13 it was audited against reply sign-offs (bot replies end with the team sign-off, human replies with a personal sign-off name): 59 of 59 heuristic bot replies had the bot sign-off (0 false positives), 1 of 249 heuristic human replies had it (1 missed bot reply), and no resolve without a bot signal followed a bot-signed reply (ticket-volume-and-sla.md 2.2).
- AI USD cost against the Anthropic invoice.
- Which `timezone_offset` gives Helsinki buckets in winter.
- Facebook inbox machine messages (12 cycles in 7 days).
- 7-day AI numbers for the three missing hours; post-launch AgentBot rates (too little data).
- Refund-label reconciliation categories never seen in real data: `matched_shared_label`, `refund_outside_tolerance`, `no_refund_found`, `unidentified_customer`, order-number-mention hits, and the `refund-70` label. These are **untested code paths**; build unit tests with synthetic fixtures for them.

---

## 8. Owner decisions (with the defaults the dashboard uses until answered)

| # | Decision | Default |
|---|---|---|
| 1 | Headline ticket unit | Tickets needing handling (distinct conversations with a human customer message per day); created and cycles as secondary |
| 2 | First response SLA: human only or including the bot? | Headline = first human reply; bot-or-human first response as a second series; holding acks never count |
| 3 | Business hours or 24/7? | 24/7 wall clock. Ruth's dashboard sends on 2026-09-14 were all between 21:00Z and 05:56Z (overnight shifts), so business-hours SLA would need her real schedule. |
| 4 | Overdue thresholds | 24 h and 48 h for all inboxes (config) |
| 5 | Exclude outreach threads and the 01:00 spike? | Keep the spike (real customers). Outreach threads have no human customer message and never enter "needing". |
| 6 | Pending conversations with a waiting customer (38) | Separate alert tile, not in the open queue count |
| 7 | Staff mapping | **Confirmed 2026-09-14:** Ruth = 135220658524 (support), Jan = 135617184092 (call support; his Shopify account is named by its email). Roles of 127271076188, 125029613916 (shop owner), 129970569564 still open; shown as "Other staff" |
| 8 | Chargeflow app and Chargeflow, Inc. collaborators together? | One "Chargeflow" group, classes kept in the data |
| 9 | Are `remote` / `hk` refunds expected to have a label? | Show compliance both with and without them; headline = where a ticket existed |
| 10 | Should shipping-only / other partial refunds get a label (a `refund-other`)? | Counted as "no label bucket" (always a mismatch or miss) |
| 11 | Do silent AI closes count as "AI handled"? | Yes, shown as a separate segment |
| 12 | USD cost on the dashboard | Tokens and calls only; USD hidden behind "estimate, unverified" until compared with the invoice for one day |
| 13 | Logging improvements (append-only AgentBot run log, cancellation log with source, staff uid on dashboard sends, separate AgentBot Chatwoot token) | Recommended in ai-agent-metrics.md section 8; the dashboard works without them using the heuristics above |
| 14 | Chatwoot shared login | Human and bot share user 165591. A separate AgentBot token would make Chatwoot's own bot metrics work. |

---

## 9. Scripts

All scripts are read-only, load `.env` through `dotenv/config`, write to `/home/dolan/support-analytics` by default (outside the repo; raw files there may contain ids only, never customer PII) and print markdown to stdout. Run from the repository root.

```bash
# Requirement 1
npx tsx src/scripts/analytics/ticketVolume.ts --days=7 [--no-firestore] [--no-reports]      # ~1,800 Chatwoot calls, ~4 min
npx tsx src/scripts/analytics/chatwootReports.ts --days=7 --complete-days [--no-events]       # ~220 calls, 20 s
# Requirement 2 and actions
npx tsx src/scripts/analytics/labelsAndActions.ts --days=7 [--no-firestore] [--no-v2]         # ~1,650 calls, 2.5 min
# Requirement 3
npx tsx src/scripts/analytics/shopifyRefunds.ts --days=7 [--no-rest] [--no-reconcile]         # 40 s
npx tsx src/scripts/analytics/refundAttribution.ts --days=7 [--include-today] [--enumerate=events|orders]  # 30 s
# Requirement 4
npx tsx src/scripts/analytics/refundLabelReconciliation.ts --days=7 [--include-today] [--tolerance-hours=48]  # ~4 min
# Requirement 5
npx tsx src/scripts/analytics/aiAgentMetrics.ts --days=7 [--complete-days] [--no-chatwoot] [--firestore-snapshot=<file>]
npx tsx src/scripts/analytics/skioCancellations.ts --days=7 [--include-today] [--match-minutes=30]   # 2 Skio + ~470 Chatwoot calls, 3 min
# Type check
npx tsc --noEmit
```

Shared module: `src/scripts/analytics/lib/refundRules.ts` exports `classifyActor()`, `bucketRefund()`, `localDay()`, `localMidnightUtc()` and the staff / Chargeflow / app config. The three refund scripts import it. The dashboard should port these functions once.

Common flags: `--tz=Europe/Helsinki`, `--out=<dir>`. Do not run the Chatwoot-heavy scripts in parallel (rate limit, section 5.4).

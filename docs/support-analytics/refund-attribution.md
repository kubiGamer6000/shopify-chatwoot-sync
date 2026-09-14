# Shopify refund attribution: who initiated each refund

This guide is for the agent building the support/refund analytics dashboard. It explains how to tell, for every Shopify refund, **who** created it: the support agent (Ruth), the call-support agent, the Chargeflow app, Chargeflow staff, another app, or other staff. The app has **no `read_users` scope**, so the direct GraphQL fields are unavailable.

Everything below was checked against the live store on 2026-09-14 with read-only calls (GraphQL queries and REST GETs only). The reference implementation is `src/scripts/analytics/refundAttribution.ts`. The companion guide `docs/support-analytics/shopify-refunds.md` covers amounts, currencies and partial-refund percentage buckets. Both scripts produce the same totals for the same window (7 days: 121 refunds on 120 orders, EUR 5,684.70).

---

## 1. Summary

| Question | Answer |
|---|---|
| Can we read the staff member directly? | **No.** `Refund.staffMember`, `OrderTransaction.user`, `staffMembers` and `currentStaffMember` return ACCESS_DENIED. REST `/users.json` returns 404. |
| What identifies a person? | REST `refund.user_id` (also `transactions[].user_id`, always equal). It is a stable numeric staff id, and `null` when an app made the refund. |
| What identifies an app? | REST `transactions[].source_name` = the API client id. `1830279` = Shopify admin web (a person logged in to the admin). `4704285` = Chargeflow. |
| How do we get a name for a user id? | Join the id with the order timeline event `refund_created`, whose message starts with the actor's display name (`"<Name> refunded 2 items."`). Events are kept for about **90 days** only, so keep a mapping table `user_id -> person/role`. |
| Is it reliable? | Yes for the classes seen in the data. The user ids of Ruth and the Jan's call-support account must be confirmed by the owner (section 8). |
| Upgrade path | The store is **Shopify Plus**, so `read_users` can be requested (section 7). |

### Store facts

| Fact | Value |
|---|---|
| Plan | Shopify Plus (`shop.plan.displayName`) |
| Shop currency | EUR |
| Shop timezone | Europe/Stockholm. REST timestamps carry `+02:00`, GraphQL timestamps are UTC. |
| Dashboard timezone | Europe/Helsinki (UTC+3 in summer) |
| Admin API version | `2026-01` |
| Gateway on all refunds seen | `shopify_payments` |

---

## 2. Metric definitions

| Term | Definition |
|---|---|
| **Refund** (the unit of count) | A Shopify `Refund` object created in the window (`refund.created_at`, bucketed by Europe/Helsinki local day) that has **at least one `kind='refund'` transaction with `status='success'`**. Count one per Refund id, never per transaction or per event. |
| **Failed refund** | A Refund whose refund transactions all have `status='failure'`. Not counted and no money. Report it separately. |
| **Pending refund** | A Refund whose refund transactions are all `pending` (async methods such as Klarna). Not counted until success. |
| **Zero-amount refund** | A Refund with **no** refund transaction. These come from order edits: Aftersell upsell edits (`user_id` null), staff edits, and Skio subscription edits. They have `refund_line_items` and `restock=true` but move no money. **Exclude them.** In one 14-day scan there were 69 of these against 211 real refunds, 13 of them under Ruth's user id. Counting Refund objects or refund line items without the transaction rule credits Ruth with refunds that moved no money. |
| **Amount (EUR)** | Sum over the Refund's successful refund transactions of GraphQL `OrderTransaction.amountSet.shopMoney.amount`. A Refund can have several transactions (e.g. order #10628: 3 transactions against different parent payments), so always sum. |
| **Presentment amount** | Sum of REST `transactions[].amount` (currency `transactions[].currency`) for successful transactions. |
| **Actor class** | One of the classes in section 2.1, decided per Refund. Never per order: order #38262 has refunds from two different actors. |
| **Actor** | The individual inside a class: a staff `user_id` or an app `source_name`. |
| **Dispute overlay** | `orderHasDispute`: the order has a Shopify Payments dispute. `disputeBeforeRefund`: the dispute was initiated at or before the refund's `created_at`. A dispute on the order does not make every refund on it dispute-related, so use the second flag for "refund caused by a dispute". |

### 2.1 Actor classes

| Class | Meaning | Identifying fields (evidence) |
|---|---|---|
| `support_agent` | Ruth, in the Shopify admin | `user_id = 135220658524`, `source_name = 1830279`. Event message `"Ruth ... refunded ..."`, `appTitle = "Shopify Web"`, `attributeToUser = true`. 142 of 211 refunds in 14 days. |
| `call_support` | Jan, the call-support agent (confirmed by the owner) | `user_id = 135617184092`, `source_name = 1830279`. The display name on events is an email address. Active since Aug 2026. Notes are full sentences ("Lost shipment"). It also handles refunds on disputed orders. The owner must confirm this is the call-support agent. |
| `chargeflow_app` | Automatic refunds by the Chargeflow app | `source_name = 4704285`, `user_id = null`. Event `appTitle = "Chargeflow"`, `attributeToUser = false`, message `"Chargeflow refunded 0 items."`. The message says 0 items even for full refunds. Note is `null` or `"Refunded by ChargeFlow"`. Never has refund line items. |
| `chargeflow_collaborator` | Chargeflow, Inc. employees who log in to the admin with collaborator accounts and refund manually | `source_name = 1830279`, non-null `user_id` (one per Chargeflow employee). The GraphQL event message starts with `"Chargeflow, Inc. refunded ..."`. The REST `events.json` `author` shows the individual. The refund note holds an alert reference such as `"Ethoca Alert <uuid>"`, `"ethoca <uuid>"` or `"CDRN <uuid>"`. Ids seen: 134634242396, 134269862236, 134897140060, 134886326620, 136891072860. |
| `other_staff` | A known staff id with another role | Mapped ids: 127271076188 (Velislav), 125029613916 (Elias), 129970569564 (Sophia). No refunds from them in the last 14 days. Roles are UNVERIFIED. |
| `unknown_staff` | Non-null `user_id` not in the map | Surface the id and the event actor name so the owner can add it. |
| `other_app` | `user_id = null` and `source_name` not `1830279` or `4704285` | Use the event `appTitle` as the name. None observed. |
| `unknown` | `user_id = null` and `source_name = 1830279` (or missing) | Not observed. Fallback only. |

Chargeflow refunds in the window are **pre-dispute alert refunds** (Ethoca/CDRN), not refunds of existing disputes. None of the 33 Chargeflow-refunded orders in 14 days had a `ShopifyPaymentsDispute`. For the app refunds this is inferred, because they carry no alert reference (UNVERIFIED). The collaborator refunds do carry one in the note.

Things that are **not** attribution signals:

- **Order tags.** Only Skio/AfterSell tags exist. Chargeflow adds none.
- **The `refund_success` event actor.** For async methods and many card refunds, `refund_success` is authored by "Shopify" (`attributeToUser=false`, e.g. `"kr996.00 SEK was refunded to Klarna."`). Over 90 days, about 530 of 909 `refund_success` events had `attributeToUser=false`. Failed refunds also emit a staff-attributed `refund_success` first and a `refund_failure` about 18 h later. Take the actor from REST `user_id`/`source_name` or from `refund_created`.

---

## 3. API calls

All requests use the header `X-Shopify-Access-Token: <token>`. Get the token from `getAccessToken()` in `src/services/shopifyAuth.ts` (client credentials, cached). Base: `https://${env.shopifyStoreDomain}/admin/api/2026-01`.

```ts
import 'dotenv/config';
import axios from 'axios';
import { env } from '../../config/env.js';
import { getAccessToken } from '../../services/shopifyAuth.js';

const base = `https://${env.shopifyStoreDomain}/admin/api/2026-01`;

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = await getAccessToken();
  const res = await axios.post(`${base}/graphql.json`, { query, variables }, {
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  });
  if (res.data.errors?.length) throw new Error(JSON.stringify(res.data.errors)); // retry on THROTTLED
  return res.data.data as T;
}

async function restGet<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const res = await axios.get(`${base}${path}`, { headers: { 'X-Shopify-Access-Token': token } });
  return res.data as T; // retry on 429 using Retry-After
}
```

### 3.1 Enumerate refunds: GraphQL root `events` (windows within ~90 days)

`POST /graphql.json`

```graphql
query RefundEvents($q: String!, $after: String) {
  events(first: 250, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      createdAt action appTitle attributeToUser message
      ... on BasicEvent {
        arguments
        subject { ... on Order { legacyResourceId name } }
      }
    }
  }
}
```

Variable `q`: `action:refund_created AND created_at:>='2026-09-06T20:50:00.000Z' AND created_at:<'2026-09-13T21:10:00.000Z'`. Use UTC ISO bounds with a ~10-minute margin, then filter on the REST refund time. Run the query separately for `refund_success`, `refund_pending` and `refund_failure` if you need the transaction-id join.

| Field | Use |
|---|---|
| `action` | `refund_created`: exactly one per Refund with money (211/211 in 14 days). Zero-amount edit refunds have none. |
| `subject.legacyResourceId` / `name` | Order id / order number (`#44776`) |
| `message` | `refund_created`: `"<Actor> refunded N items."` or `"<Actor> refunded shipping."`. Keep only the text before `" refunded "`. **Do not store the full message.** Other actions contain card digits, and `mail_sent` contains customer emails. |
| `appTitle` | `"Shopify Web"` (person in the admin) or the app name (`"Chargeflow"`) |
| `attributeToUser` | `true` for staff and collaborator accounts, `false` for apps and for "Shopify"-authored success events |
| `arguments` (refund_success / pending / failure) | `[txId, refundAmountShop, shopCurrency, 'order_price', orderPricePresentment, presentmentCurrency, 'current_subtotal_before_taxes', subtotal, currency, 'api_client_id', clientId]`. `arguments[0]` is the REST transaction id (exact join). `arguments[1]` is the refund amount in EUR. **`arguments[4]` is the order price, not the refund amount.** It differed from the refund amount on 68 of 211 refunds. |

Pitfalls verified:

- REST shop-level `GET /events.json?filter=Order&verb=refund_success` returns `[]`. It cannot be used for enumeration.
- Events older than ~90 days are gone. On 2026-09-14 the oldest event was 2026-06-16T10:47Z, and `created_at:<2026-06-16` returned `[]`.

### 3.2 Fallback enumeration beyond 90 days: orders search

```graphql
query O($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { legacyResourceId refunds(first: 20) { createdAt } }
  }
}
```

`q = "updated_at:>='<startUtcIso>' AND (financial_status:partially_refunded OR financial_status:refunded)"`.

The parentheses are required. Without them (`... financial_status:partially_refunded OR updated_at:... financial_status:refunded`), 67 of 210 orders were missed. With them, 208 of 210 were found. The 2 misses are orders whose only refunds failed, so no money is lost. Keep orders that have a refund with `createdAt` in the window. The script's `--enumerate=orders` run over 14 days gave the same 194 successful refunds / EUR 9,266.09 as the events run. Without the financial_status filter (`updated_at` only) the scan finds everything but reads about 13,000 orders per 14 days.

Beyond 90 days, no event names or appTitles exist. Attribution then relies on `user_id`, `source_name` and the mapping table alone. New Chargeflow collaborator ids can only be recognised by the note regex.

### 3.3 Attribution: REST refunds per order

`GET /orders/{order_id}/refunds.json`

```ts
interface RestRefund {
  id: number;
  order_id: number;
  created_at: string;            // shop tz, e.g. "2026-09-14T10:27:36+02:00"
  note: string | null;           // may contain free text: classify, do not store
  user_id: number | null;        // staff id; null = app
  refund_line_items: unknown[];
  transactions: {
    id: number;
    kind: string;                // 'refund' (ignore other kinds)
    status: string;              // 'success' | 'failure' | 'pending'
    gateway: string;             // 'shopify_payments'
    amount: string;              // presentment currency
    currency: string;
    user_id: number | null;      // equals refund.user_id (211/211)
    source_name: string | null;  // '1830279' admin web, '4704285' Chargeflow
    parent_id: number | null;
    // payment_details / receipt contain cardholder data: never persist
  }[];
}
const { refunds } = await restGet<{ refunds: RestRefund[] }>(`/orders/${orderId}/refunds.json`);
```

Real examples (redacted):

| Order | refund.user_id | tx.source_name | tx.status | Event (refund_created) | Note |
|---|---|---|---|---|---|
| #43438 | null | 4704285 | success | `Chargeflow refunded 0 items.` appTitle Chargeflow | null |
| #44776 | 135220658524 | 1830279 | success | `Ruth ... refunded ...` appTitle Shopify Web | text |
| #42947 | 134886326620 | 1830279 | success | `Chargeflow, Inc. refunded ...` (REST author: individual) | `ethoca <uuid>` |
| #44327 | 135617184092 | 1830279 | **failure** | refund_success first, refund_failure `Unable to refund £39.00 GBP.` ~18 h later | text |
| #35035 (Klarna) | 135220658524 | 1830279 | success | refund_created/pending by Ruth. refund_success authored by "Shopify". | - |

### 3.4 EUR amounts: GraphQL order transactions (works at any age)

```graphql
query Orders($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order {
      legacyResourceId name
      totalReceivedSet { presentmentMoney { amount currencyCode } }
      originalTotalPriceSet { presentmentMoney { amount currencyCode } }
      transactions(first: 100) { id kind status amountSet { shopMoney { amount currencyCode } } }
    }
  }
}
```

Join `legacyId(transaction.id)` (the number after the last `/` in `gid://shopify/OrderTransaction/14558064345436`) to REST `transactions[].id`. `shopMoney` equalled `refund_success.arguments[1]` in 211/211 cases. Batch 25 order ids per call. **Do not select** `Refund.staffMember` or `OrderTransaction.user`: the whole response gets ACCESS_DENIED errors.

### 3.5 Dispute overlay: GraphQL Shopify Payments disputes

```graphql
query D($q: String!, $after: String) {
  shopifyPaymentsAccount {
    disputes(first: 100, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes { id type status initiatedAt reasonDetails { reason } order { legacyResourceId } }
    }
  }
}
```

`q = "initiated_at:>='<window start minus 180 days>'"`. The default order is newest-first, and `reverse:true` gives oldest-first. Filter and page fully either way. REST `GET /shopify_payments/disputes.json` returns **403** (`requires merchant approval for read_shopify_payments_disputes scope`). The GraphQL connection works with the current `read_shopify_payments_accounts` scope. Since 2026-07-01 there were 42 disputes: CHARGEBACK LOST 31, CHARGEBACK NEEDS_RESPONSE 4, INQUIRY NEEDS_RESPONSE 1, INQUIRY WON 3, CHARGEBACK UNDER_REVIEW 2, CHARGEBACK WON 1.

### 3.6 Optional: individual name for collaborator accounts

`GET /orders/{order_id}/events.json?limit=250` returns `author` (e.g. the Chargeflow employee's personal name, while the GraphQL message shows `Chargeflow, Inc.`), `verb`, `arguments`, and `path` `/admin/orders/{id}/transactions/{txId}`. It has the same 90-day retention. It is not needed for the classification.

---

## 4. Computation recipe

1. **Window.** Take the local calendar dates in Europe/Helsinki. `start` = local midnight N days before today, `end` = local midnight today (exclusive). Convert both to UTC instants with an Intl-based offset (DST-safe; see `localMidnightUtc` in the script). "Last 1 day" on 2026-09-14 = `[2026-09-12T21:00Z, 2026-09-13T21:00Z)`.
2. **Enumerate orders.** If `start` is within ~85 days, page `events` with `action:refund_created` (section 3.1) and collect distinct order ids. Otherwise use the orders search (section 3.2).
3. **Fetch REST refunds** for each order (section 3.3). Keep refunds with `Date.parse(created_at)` in `[start, end)`. `Date.parse` handles the `+02:00` offset.
4. **Filter and state.** Let `refundTx = transactions.filter(t => t.kind === 'refund')`.
   - `refundTx.length === 0` means a zero-amount edit refund. Exclude it and count it for diagnostics.
   - Any `status === 'success'` means `success`. All `pending` means `pending`. Otherwise `failed`.
5. **Classify** (first matching rule wins):

   ```ts
   if (userId === null && APP_SOURCES[sourceName])      -> APP_SOURCES[sourceName].cls   // '4704285' -> chargeflow_app
   if (userId === null && event.appTitle === 'Chargeflow') -> chargeflow_app
   if (userId !== null) {
     if (STAFF[userId])                                   -> STAFF[userId].cls            // owner-maintained map
     if (CHARGEFLOW_COLLABORATOR_IDS.has(userId))         -> chargeflow_collaborator
     if (/^Chargeflow, Inc\./.test(eventActorName))       -> chargeflow_collaborator
     if (/\b(ethoca|cdrn|verifi|rdr)\b/i.test(note))      -> chargeflow_collaborator
                                                           -> unknown_staff (show id + event actor)
   }
   if (sourceName && sourceName !== '1830279')            -> other_app (name = event appTitle)
                                                           -> unknown
   ```

   The staff map is checked before the Chargeflow note regex on purpose. If Ruth processes an alert refund and writes "Ethoca" in the note, the refund is still hers.
6. **Event join (display names, discovery).** For each REST refund, take the `refund_created` event on the same order closest in time within ±120 s that has not been used yet. This matched 209 of 211 uniquely. The 2 ambiguous cases resolved by nearest time. For an exact join use `refund_pending`/`refund_success` events where `arguments[0] == tx.id` and `attributeToUser` is true or `appTitle` is not "Shopify Web". Store only the actor prefix: the first name for staff, `<email-named account>` if it contains `@`, and the full string for `Chargeflow...`.
7. **Money.** Sum the `shopMoney` of successful refund transactions (section 3.4). Fall back to `refund_success.arguments[1]` if a transaction is missing from GraphQL. Never count `refund_success` events as refunds or money: failed refunds emit one too.
8. **Dispute flags** (section 3.5). Set `orderHasDispute` and `disputeBeforeRefund = dispute.initiatedAt <= refund.created_at`.
9. **Aggregate.** Per class and per actor: count successful refunds and sum EUR. Report failed/pending separately with the attempted EUR. Per Helsinki day: `localDate(refund.created_at)`.
10. **Surface drift.** List unmapped staff ids, any new `source_name`, and `refund_created` events that did not match a REST refund. Show them on the dashboard so the owner can update the mapping.

### Edge cases

| Case | Handling |
|---|---|
| Several transactions in one Refund | Sum them. Count the Refund once. |
| Failed refund (#44327, #31683 on 2026-09-07) | `state='failed'`. Excluded from counts and EUR. Shown separately. |
| Klarna and other async methods | `refund_success` authored by "Shopify". Take the actor from REST `user_id`. |
| Two actors on one order (#38262) | Attribution is per Refund. |
| Chargeflow message "refunded 0 items" | Do not use line-item counts to judge full vs partial for Chargeflow. Use amounts. |
| Collaborator account seen for the first time | Within 90 days, it is caught by the `Chargeflow, Inc.` prefix. Beyond that, only by the note regex. Add new ids to the set. |
| Refunds at window edges | Filter on the REST `created_at`. The event query uses a margin only to find the event. |
| Zero-amount edit refunds | Excluded by the "has a refund transaction" rule. |

---

## 5. Performance and rate limits

| Call | Volume (7 days) | Notes |
|---|---|---|
| GraphQL `events` | 4 queries (1 page each per action) | 250 per page. Cheap. |
| REST `refunds.json` | 1 per order, **122** for 7 days, 195 for 14 days | Leaky bucket (header `X-Shopify-Shop-Api-Call-Limit`, e.g. `12/400` on Plus). The script runs 2 concurrent requests, sleeps 1 s when the bucket is over 70% full, and retries 429 with `Retry-After`. |
| GraphQL `nodes` (orders) | 1 per 25 orders | Watch `extensions.cost.throttleStatus.currentlyAvailable`. Retry on `THROTTLED`. |
| GraphQL disputes | 1-2 | |

A 7-day run takes about 30 s. For a dashboard, cache per-refund rows by Refund id. A refund's `user_id`, `source_name` and transactions do not change after creation, except a pending status that later becomes success or failure. So re-fetch only new orders, plus refunds that are pending or created within the last 48 h (a refund can fail about 18 h after its success event).

---

## 6. Caveats, unverified, impossible

**Impossible without `read_users`**

- Resolving `user_id` to a name or email via API. `Refund.staffMember`, `OrderTransaction.user`, `staffMembers` and `currentStaffMember` are denied. The error is: *"Access denied for staffMember field. Required access: `read_users` access scope. Also: The app must be a finance embedded app or installed on a Shopify Plus or Advanced store. Contact Shopify Support to enable this scope for your app."* REST `/users.json` returns 404.
- Names for refunds older than ~90 days. Events are gone, so only the mapping table can name them.

**Unverified**


- The roles of 127271076188 (Velislav), 125029613916 (Elias) and 129970569564 (Sophia).
- The full list of Chargeflow collaborator ids. 5 were seen, and new ones will appear.
- That Chargeflow app refunds are Ethoca/Verifi/RDR alert refunds. This is inferred from the absence of disputes. The app refunds carry no alert id.
- The exact event retention rule (a rolling ~90 days was observed).
- Refunds from Shopify POS, the mobile app or other apps. None were observed. They would show a different `source_name`/`appTitle` and fall into `other_app` or `unknown`.

**Other caveats**

- `user_id` identifies a Shopify **account**, not a person. If two people share a login, they cannot be separated.
- Refund notes and event messages can contain customer data. Classify them in memory and store only the derived flags (`noteKind`, actor prefix).
- `pctOfOrderTotal` in the script uses `totalReceivedSet` as the base, same as the companion guide. See that guide for buckets.

---

## 7. Upgrade path: `read_users`

`GET /shop.json` shows `plan_name: "shopify_plus"`, so the plan requirement is already met. To get staff identities directly:

1. Add `read_users` to the app's access scopes (app configuration in the Partner/Dev Dashboard) and release a new app version.
2. Have the merchant approve the new scope. The error text also says *"Contact Shopify Support to enable this scope for your app"*, so Shopify Support may need to enable it for this custom app.
3. Then query `order { refunds { id createdAt staffMember { id name email } } transactions { id user { id name } } }`. This returns the person directly, with no 90-day limit and no mapping table (apps still show as `null` staff, identified by the app channel).

Optionally request `read_shopify_payments_disputes` for the REST disputes endpoint. It is not needed, because GraphQL disputes already work.

---

## 8. Mapping table and what the owner must provide

The script keeps the mapping in one place (`STAFF`, `CHARGEFLOW_COLLABORATOR_IDS`, `APP_SOURCES` at the top of `refundAttribution.ts`). A dashboard should store it as editable config:

| user_id / source | Discovered display name (event) | Proposed class | Owner action |
|---|---|---|---|
| 135220658524 | Ruth ... (Jul-Sep) | support_agent | Confirm this is Ruth's only account |
| 135617184092 | an email address (Aug-Sep) | call_support | **Confirm it is the call-support agent.** Optionally set a person name in Shopify admin so events show it. |
| 127271076188 | Velislav ... (Apr-Aug) | other_staff | Provide role (owner?) |
| 125029613916 | Elias ... (Apr-Aug) | other_staff | Provide role |
| 129970569564 | Sophia ss (May-Jul) | other_staff | Provide role (former support?) |
| 134634242396, 134269862236, 134897140060, 134886326620, 136891072860 | Chargeflow, Inc. | chargeflow_collaborator | Decide: report together with Chargeflow app as "Chargeflow", or separately |
| source 4704285 | Chargeflow (app) | chargeflow_app | none |

How to discover new ids automatically: for each refund with an unmapped `user_id` inside the 90-day window, record the `refund_created` actor prefix. The script prints these under "Unmapped staff user ids". Group by `user_id` and show the owner the name to classify.

Other owner questions: are there other people or apps that may refund (Skio, a returns app, POS)? Should `read_users` be requested (section 7)?

---

## 9. Running the script

```bash
cd /home/dolan/Documents/scandi/scandi-chatwoot/shopify-chatwoot-sync
npx tsx src/scripts/analytics/refundAttribution.ts --days=7
# flags: --days=N (complete local days ending at local midnight today, default 7)
#        --tz=Europe/Helsinki  --out=/home/dolan/support-analytics
#        --include-today (window end = now)  --enumerate=events|orders
```

Outputs: `<out>/refund-attribution_<N>d_<lastLocalDate>.json` (window, shop facts, config, totals, `byClass`, `byActor`, `byDay`, one row per refund) and a `.md` summary. Rows contain refund/order ids, order numbers, amounts, user ids, staff first names and flags. They contain no customer data, notes or event messages.

Row shape:

```json
{
  "refundId": "1161000616284", "orderId": "12968298086748", "orderName": "#37811",
  "createdAtUtc": "2026-09-07T11:01:27.000Z", "localDate": "2026-09-07", "state": "success",
  "userId": "135617184092", "sourceName": "1830279",
  "actorClass": "call_support", "actorLabel": "email-named account", "rule": "user_id map (135617184092)",
  "eventActor": "<email-named account>", "eventAppTitle": "Shopify Web",
  "txCount": 1, "amountShop": 24.3, "attemptedShop": 24.3, "presentmentAmount": 271, "presentmentCurrency": "SEK",
  "pctOfOrderTotal": 100, "lineItemsRefunded": 1, "noteKind": "text",
  "orderHasDispute": false, "disputeBeforeRefund": false, "disputeSummary": null
}
```

---

## 10. Real example (script output, run 2026-09-14 about 11:00 UTC)

Counts are Refunds with at least one successful refund transaction. EUR is the shop-currency transaction amount. Days are Europe/Helsinki.

### Last 1 local day: 2026-09-13 (`[2026-09-12T21:00Z, 2026-09-13T21:00Z)`)

| Actor class | Refunds | EUR | Share | Failed/pending |
|---|---:|---:|---:|---:|
| support_agent (Ruth, 135220658524) | 8 | 440.10 | 100.0% | 0 |
| **Total** | **8** | **440.10** | | 0 |

8 orders. No Chargeflow or call-support refunds, no disputed orders, no unmapped ids. API calls: REST 8, GraphQL 7.

### Last 7 local days: 2026-09-07 .. 2026-09-13 (`[2026-09-06T21:00Z, 2026-09-13T21:00Z)`)

| Actor class | Actor | Refunds | EUR | Share | Failed/pending (attempted EUR) |
|---|---|---:|---:|---:|---:|
| support_agent | Ruth (135220658524) | 79 | 3,544.41 | 62.3% | 0 |
| call_support (Jan) | Jan (135617184092) | 24 | 967.69 | 17.0% | 2 (125.36) |
| chargeflow_app | Chargeflow (source 4704285) | 18 | 1,172.60 | 20.6% | 0 |
| chargeflow_collaborator | - | 0 | 0.00 | 0% | 0 |
| **Total** | | **121** | **5,684.70** | 100% | 2 |

By day (refunds / EUR):

| Date | Total | support_agent | call_support | chargeflow_app |
|---|---:|---:|---:|---:|
| 2026-09-07 | 36 / 1,492.98 | 29 / 1,257.62 | 6 / 208.39 | 1 / 26.97 |
| 2026-09-08 | 15 / 821.66 | 8 / 542.05 | 3 / 108.76 | 4 / 170.85 |
| 2026-09-09 | 20 / 1,003.85 | 12 / 524.48 | 1 / 23.81 | 7 / 455.56 |
| 2026-09-10 | 15 / 568.70 | 10 / 364.58 | 4 / 168.15 | 1 / 35.97 |
| 2026-09-11 | 14 / 824.50 | 5 / 149.73 | 5 / 290.43 | 4 / 384.34 |
| 2026-09-12 | 13 / 532.91 | 7 / 265.85 | 5 / 168.15 | 1 / 98.91 |
| 2026-09-13 | 8 / 440.10 | 8 / 440.10 | 0 / 0.00 | 0 / 0.00 |

Checks: 120 distinct orders. 2 failed refunds (#44327, #31683; Jan's call-support account, both on CHARGEBACK LOST PRODUCT_NOT_RECEIVED orders). 3 counted refunds on disputed orders, all by the Jan's call-support account and all after the dispute was opened (#31474 and #41867 ×2, INQUIRY WON UNRECOGNIZED). 0 unmapped staff ids. 0 unmatched `refund_created` events. All 123 refunds had exactly one refund transaction. API calls: REST 122, GraphQL 11.

### Cross-check (14 local days, 2026-08-31 .. 2026-09-13)

Events enumeration and orders-search enumeration gave identical successful totals: 194 refunds / EUR 9,266.09. Ruth 129 / 5,602.69, Jan's call-support account 34 / 1,685.23 (+2 failed), Chargeflow app 29 / 1,890.14, Chargeflow, Inc. collaborators 2 / 88.03 (users 134886326620 EUR 81.83 and 136891072860 EUR 6.20, both with Ethoca notes). The orders search did not see the 2 failed-only orders, as expected. An independent REST-only recount (a scan of all 13,419 orders updated since 2026-08-30T20:00Z with no financial-status filter, classified by `refund.user_id` / `source_name`, with EUR summed from `OrderTransaction.amountSet.shopMoney`) gave the same result: 194 successful refunds / EUR 9,266.09 with the same per-actor split, 2 failed refunds (attempted EUR 79.94 + 45.42 = 125.36), and 68 zero-amount edit refunds.

Longer-range context from the research pass (`refund_created` event actors per UTC month, 2026-06-16..2026-09-14):

| Month | Chargeflow app | Chargeflow, Inc. | Ruth | Jan (call support) | Sophia | Velislav | Elias |
|---|---:|---:|---:|---:|---:|---:|---:|
| Jun (from 16th) | 14 | 1 | 0 | 0 | 68 | 7 | 0 |
| Jul | 33 | 9 | 83 | 0 | 69 | 55 | 6 |
| Aug | 37 | 8 | 264 | 22 | 0 | 2 | 7 |
| Sep 1-14 | 30 | 2 | 137 | 30 | 0 | 0 | 0 |

Over those 90 days every `refund_success` event had `api_client_id` 1830279 (795) or 4704285 (114). No other app refunded.

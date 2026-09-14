# Shopify refunds: counts, amounts, partial percentages, actors

This guide is for the agent building the support/refund analytics dashboard. It explains how to list every Shopify refund created in a time window and how to compute:

- refund counts and EUR sums,
- sums per customer currency,
- partial-refund percentages and the policy buckets (full / ~30 / ~50 / ~70 / shipping-only / other),
- who issued each refund (support staff, a second staff account, or the Chargeflow app).

Everything here was checked against the live store on 2026-09-14 with read-only calls. The reference implementation is `src/scripts/analytics/shopifyRefunds.ts`.

---

## 1. Store facts that matter

| Fact | Value | Why it matters |
|---|---|---|
| Shop currency | **EUR** | `shopMoney` is always EUR |
| Shop timezone | **Europe/Stockholm** (not Helsinki) | Shopify reports, REST `created_at` offsets and the `tenderTransactions` date filter use Stockholm. The dashboard uses **Europe/Helsinki** days (one hour ahead). |
| Plan | Shopify Plus | REST bucket 400 requests, GraphQL cost bucket is large |
| Prices | Tax-inclusive (`taxesIncluded=true`) | |
| Presentment currencies | About 28 (EUR, GBP, SEK, DKK, HKD, USD, THB, HUF, ...) | Customers pay and are refunded in their own currency |
| Admin API version | `2026-01` | |
| Payment gateway on refunds | `shopify_payments` only (in the data seen so far) | |
| Subscriptions | Skio edits recurring orders, which creates many **zero-amount** refunds | These must be excluded |

Auth: `getAccessToken()` from `src/services/shopifyAuth.ts` (client credentials, cached about 23 h). Send it as the header `X-Shopify-Access-Token`.

---

## 2. Metric definitions

All windows use **Europe/Helsinki local days**. A refund belongs to the day of `refund.createdAt` (which equalled `processedAt` in all data), **not** the order date.

| Metric | Definition |
|---|---|
| **Money refund** | A `Refund` object with `totalRefundedSet.shopMoney.amount > 0`. This excludes zero-amount refunds (line-item removals and restock-only refunds, mostly Skio edits) and refunds whose only transaction FAILED. |
| **Refund count** | The number of money refunds created in the window. An order with two refunds counts twice. |
| **Refunded orders** | The number of distinct orders with at least one money refund in the window. |
| **EUR amount** | `refund.totalRefundedSet.shopMoney.amount`. Shopify converts it at refund time. Sum these for the EUR total. |
| **Currency amount** | `refund.totalRefundedSet.presentmentMoney` (amount + currencyCode). Sum per currency. **Do not convert these yourself.** Use shopMoney for EUR. |
| **Refund %** | `refund.presentmentMoney / order.totalReceivedSet.presentmentMoney * 100` |
| **Cumulative %** | The sum of presentment amounts of all money refunds on the order up to and including this one, divided by the same base |
| **Bucket** | See 2.2 |
| **Actor** | `staff:<user_id>` or `app:<appTitle>` (see section 5) |

### 2.1 Why this percentage base

The policy is to refund roughly 30 / 50 / 70 % or in full. We tested three bases on 185 real money refunds:

| Base | Result |
|---|---|
| **`totalReceivedSet.presentmentMoney`** (money actually captured, incl. shipping and tax) | Partial refunds land on exactly 30.00 / 50.00, and every full refund is exactly 100.00. **Use this.** |
| `totalPriceSet.presentmentMoney` | Wrong on edited orders. `totalPriceSet` does **not** go down when Skio removes a line with a zero-amount CANCEL refund. Example: #35722 was refunded in full but shows as 67.05 %; #28360 was refunded in full but shows as 79.03 %. Shipping-only refunds come out too low as well (13.72 % instead of 23.23 %). |
| Subtotal (excl. shipping) | Values scatter (32, 33, 36 ...). Only 24 of the refunds were within 3 pp of a policy value, compared with 42 for the total base. |
| Any base in **shopMoney** | Distorted for non-EUR orders, because the order and the refund are converted at different FX rates. A full SEK refund shows as 99.4 %, a HUF one as 100.2 %. |

`totalReceivedSet` equalled `originalTotalPriceSet` on all 167 refunded orders checked. Fall back to `originalTotalPriceSet` if `totalReceivedSet` is 0.

### 2.2 Buckets (apply in this order)

| Bucket | Rule |
|---|---|
| `full` | pct >= 99.5 |
| `full (cumulative)` | cumPct >= 99.5, **or** this is the order's latest money refund, the order is now `displayFinancialStatus = REFUNDED`, and either the cumulative amount >= base - 0.01 or `currentTotalPriceSet = 0`. This catches, for example, a 95 % refund followed by a 5 % refund. |
| `shipping-only` | `refundLineItems` is empty **and** `refundShippingLines` is not empty (and the refund is not full). These are typically 18-23 %. |
| `~30` / `~50` / `~70` | abs(pct - target) <= **3 pp** |
| `other` | everything else |

Real values seen inside the tolerance: 27.78, 30.00, 30.03, 49.93, 50.00, 50.01, 50.04, 50.51. Real `other` values: 36.9, 37.9, 40.54, 43.53, 45.46, 95.23 (the first half of a split full refund). `~70` had zero refunds in the last 7 days once the correct base was used.

Do **not** use `refundLineItems` to decide whether a refund is partial. Amount-based partial refunds show up as `orderAdjustments` (reason `REFUND_DISCREPANCY`) with no line items. Many money-refunded orders also carry older zero-amount CANCEL refunds.

---

## 3. API calls

### 3.1 Primary: GraphQL orders -> refunds

There is **no root `refunds` query** (`Field 'refunds' doesn't exist on type 'QueryRoot'`). Refunds are only reachable through orders; `refund(id)` looks up a single refund.

```
POST https://${SHOPIFY_STORE_DOMAIN}/admin/api/2026-01/graphql.json
Headers: X-Shopify-Access-Token: <token>, Content-Type: application/json
```

Search filter:

```
updated_at:>=<windowStartUTC> AND (financial_status:refunded OR financial_status:partially_refunded)
```

- Every refund bumps `order.updatedAt`, so refunds on old orders are included. Order age at refund time was p10 1.7 d, median 16.7 d, p90 86 d, max 193 d, so **never filter on `created_at`**.
- The financial-status filter makes the query about 50 times cheaper than a plain `updated_at` scan. The orders it leaves out only had zero-amount refunds. Two independent broad scans (9.5 days with 12,251 orders, and 1.6 days with 3,492 orders) found **0** money refunds outside the filter.

```ts
import axios from 'axios';
import { env } from '../../config/env.js';
import { getAccessToken } from '../../services/shopifyAuth.js';

const MONEY = 'shopMoney{amount currencyCode} presentmentMoney{amount currencyCode}';

// Never add Refund.return (needs read_returns: the WHOLE query fails with ACCESS_DENIED)
// or Refund.staffMember (needs read_users). Never select event `message` (customer PII).
const ORDERS_QUERY = `
query RefundOrders($q: String!, $after: String) {
  orders(first: 50, after: $after, sortKey: UPDATED_AT, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyResourceId name createdAt updatedAt cancelledAt test
      displayFinancialStatus presentmentCurrencyCode tags
      totalReceivedSet { ${MONEY} }
      originalTotalPriceSet { ${MONEY} }
      currentTotalPriceSet { ${MONEY} }
      totalRefundedSet { ${MONEY} }
      disputes { status initiatedAs }
      refunds(first: 20) {
        id legacyResourceId createdAt
        totalRefundedSet { ${MONEY} }
        refundLineItems(first: 50) { nodes { quantity restockType } }
        refundShippingLines(first: 5) { nodes { subtotalAmountSet { ${MONEY} } } }
        orderAdjustments(first: 10) { nodes { reason amountSet { ${MONEY} } } }
        transactions(first: 10) { nodes { kind status test gateway amountSet { ${MONEY} } } }
      }
      events(first: 100, sortKey: CREATED_AT, reverse: true) {
        nodes { createdAt ... on BasicEvent { action appTitle attributeToApp attributeToUser } }
      }
    }
  }
}`;

export async function fetchRefundedOrders(sinceUtcIso: string) {
  const q = `updated_at:>=${sinceUtcIso} AND (financial_status:refunded OR financial_status:partially_refunded)`;
  const orders: any[] = [];
  let after: string | null = null;
  do {
    const res = await axios.post(
      `https://${env.shopifyStoreDomain}/admin/api/2026-01/graphql.json`,
      { query: ORDERS_QUERY, variables: { q, after } },
      { headers: { 'X-Shopify-Access-Token': await getAccessToken() } },
    );
    if (res.data.errors) throw new Error(JSON.stringify(res.data.errors)); // retry on extensions.code === 'THROTTLED'
    const page = res.data.data.orders;
    orders.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return orders;
}
```

Key response fields:

| Field | Meaning |
|---|---|
| `order.refunds[]` | **Every refund ever made** on the order, including ones from before the window. Filter by `createdAt` yourself. Not paginated (it is a list); `first: 20` is plenty (the maximum seen was 2 money refunds per order). |
| `refund.totalRefundedSet` | shopMoney (EUR) and presentmentMoney (customer currency). Equals the sum of SUCCESS REFUND transactions in 100 % of cases. |
| `refund.transactions[].status` | `SUCCESS` or `FAILURE`. A failed refund still creates a refund object, with amount 0. |
| `order.totalReceivedSet` | The percentage base |
| `order.displayFinancialStatus` | `REFUNDED` or `PARTIALLY_REFUNDED` (current state, not state at refund time) |
| `order.disputes[]` | `{status: LOST/WON/..., initiatedAs: CHARGEBACK/INQUIRY}` |
| `events[]` BasicEvent `action = 'refund_success'` | Actor: `attributeToUser = true` means staff (appTitle `Shopify Web`); otherwise `appTitle` names the app (for example `Chargeflow`) |

### 3.2 Actor ids: REST refunds.json (recommended enrichment)

```
GET https://${SHOPIFY_STORE_DOMAIN}/admin/api/2026-01/orders/{orderLegacyId}/refunds.json?fields=id,user_id,transactions
Header: X-Shopify-Access-Token
```

```ts
const { data } = await axios.get(
  `https://${env.shopifyStoreDomain}/admin/api/2026-01/orders/${orderId}/refunds.json?fields=id,user_id,transactions`,
  { headers: { 'X-Shopify-Access-Token': await getAccessToken() } },
);
// data.refunds[].id === GraphQL refund.legacyResourceId
// data.refunds[].user_id -> staff user id (null for apps)
// data.refunds[].transactions[].source_name -> '4704285' Chargeflow, '1830279' Shopify admin web
```

- One call per order that has a money refund in the window (135 calls for 8 days, well within the 400-request bucket).
- REST `transactions[].amount` is in **presentment** currency, and `created_at` uses the shop timezone offset (+02:00 Stockholm).

### 3.3 Reconciliation: tenderTransactions

```graphql
query($q:String!,$after:String){
  tenderTransactions(first:250, after:$after, query:$q){
    pageInfo{hasNextPage endCursor}
    nodes{ processedAt test amount{amount currencyCode} }
  }
}
# $q = "processed_at:>=YYYY-MM-DD"   (use one day earlier than needed)
```

- Refunds appear as **negative** amounts in EUR.
- The `processed_at` filter truncates to a **date in the shop timezone (Stockholm)**. For example, `>=2026-09-12T21:00:00Z` returned rows from 2026-09-11T22:02Z. Always filter precisely on the client.
- It **includes failed refund attempts** and has no status field, so on days with failures it is higher than the real refunds.
- In the data, the sum of negatives per Helsinki day equalled the money-refund EUR sum on every day, except 2026-09-07, which also contained the 2 failed attempts (79.94 + 45.42 = 125.36 EUR).

### 3.4 REST alternative for the order list (not needed)

`GET /orders.json?status=any&updated_at_min=<ISO>&financial_status=refunded&limit=250` (then a second call with `financial_status=partially_refunded`; only one value is allowed per call), paginated with the `Link: rel="next"` header, followed by `/orders/{id}/refunds.json` for each order. This works, but it is N+1 and REST is legacy. Prefer GraphQL.

### 3.5 ShopifyQL: do not use for refund money

`shopifyqlQuery(query:"FROM sales SHOW returns SINCE 2026-09-07 UNTIL 2026-09-14 TIMESERIES day WITH TIMEZONE 'Europe/Helsinki'"){ tableData{columns{name dataType} rows} parseErrors }` works (read_reports), but `returns` is **not** refunded money: 09-13 gives -516.52 against 440.10 real, and 09-14 gives -833.51 against 852.22. It follows sales-report accounting. Use it only for context such as `net_sales` (for example, refunds as a % of sales). Without `WITH TIMEZONE` it uses Stockholm days.

---

## 4. Computation recipe

1. **Windows (Europe/Helsinki).** Local day D runs from local midnight to the next local midnight. Convert to UTC with a timezone-aware function, not a fixed +3 (DST ends 2026-10-25). The script uses `Intl.DateTimeFormat`, so no library is needed. Two useful definitions:
   - *complete*: the N full local days before today (stable numbers),
   - *rolling*: the previous N-1 full days plus today so far (live view).
2. **Fetch** with the filtered GraphQL query from the earliest window start. Page until `hasNextPage = false`. Skip `order.test = true`.
3. **Explode refunds.** For each order, sort `refunds` by `createdAt`, keep only money refunds (`shopMoney.amount > 0`), and accumulate presentment amounts (for cumPct) over **all** money refunds. Emit only those with `windowStart <= createdAt < windowEnd`. (Refunds from before the window come back too.)
4. **Amounts.** EUR = shopMoney, currency = presentmentMoney.
5. **Percentage and bucket** as in section 2. Also flag `shippingOnly`, `orderHasDispute`, and `subscriptionOrder` (tag contains "subscription").
6. **Actor.** Pick the `refund_success` event within ±5 s of `refund.createdAt` (closest wins); `attributeToUser` gives `staff`, otherwise `app:<appTitle>`. Then override it with REST `user_id` (`staff:<id>`) when that is present. Only do this for refunds that already passed the money filter, because `refund_success` is also emitted for refunds that later **fail**.
7. **Aggregate** per window: count, distinct orders, EUR sum, buckets (count and EUR), actors, currencies (count, presentment sum, EUR sum), per local day.
8. **Reconcile** (optional): negative tenderTransactions per local day against the EUR sum per day. A difference usually means a failed refund attempt.
9. **Dedup.** Key on `refund.legacyResourceId`. The same order can appear in several fetches if you run incremental syncs.
10. **Recompute recent days.** A refund can fail **after** it is created. #31683 got `refund_success` at creation and `refund_failure` about 18 h later. Recompute at least the last 2-3 days on every sync instead of freezing them.

### Edge cases

| Case | Handling |
|---|---|
| Zero-amount refunds (Skio line removals, restock-only) | Excluded by amount > 0. They are common, but mostly old: of about 12,250 orders updated in 9.5 days (from 2026-09-04T23:00Z), 191 carry a zero-amount refund of any age, while only 49 zero-amount refunds were **created** in those 9.5 days (69 in the 14 days to 2026-09-14, against 211 money refunds). |
| Failed refunds (e.g. on lost chargebacks) | Amount 0, order stays PAID, and the fast filter does not return them. They are not money. If you want to show them, you need a broad scan or tenderTransactions. |
| Several refunds on one order | Rare (1 order in 7 days). Handled by cumPct and `full (cumulative)`. |
| Shipping-only refunds | Own bucket. The order stays PARTIALLY_REFUNDED at 18-23 %. |
| Edited orders (Skio) | Use the `totalReceivedSet` base, not `totalPriceSet`. |
| Cancelled orders | None seen with money refunds. Treat them like any other refund. |
| Chargebacks / disputes | A separate money flow. A lost chargeback does **not** create a successful refund. Report through `Order.disputes` if needed. |
| Chargeflow refunds | Automatic pre-dispute alert refunds (notes like `ethoca <id>`, `Refunded by ChargeFlow`, often empty). Always 100 %. Consider showing them separately from support refunds. |
| Refund notes | Free text (`remote`, `cust request`, `hk`, `eu withdrawal`, ...). Unreliable for classification, and they may contain personal data. Do not store them. |
| `payments_refund` payout events | They bump `order.updatedAt` days after a refund. This is harmless and only inflates broad scans. |

---

## 5. Actors

Chargeflow is an app, so its refunds have no staff user.

| Actor key | How identified | Notes |
|---|---|---|
| `staff:135220658524` | REST `user_id`, event `attributeToUser = true`, source_name 1830279 | The support agent (Ruth). The identity comes from the event message and is **UNVERIFIED**; the id is stable. |
| `staff:135617184092` | REST `user_id` | A second staff account whose display name is an email address. Jan, the call-support agent (confirmed by the owner 2026-09-14). |
| `app:Chargeflow` | `user_id = null`, source_name 4704285, event `appTitle = 'Chargeflow'` | Automatic dispute and alert refunds |

Every money refund in the last 8 days matched exactly one refund_success event, and REST attribution agreed with the events. Unknown actors: 0. Map staff ids to display names in dashboard config; do not hardcode names from event messages.

---

## 6. Performance and rate limits

| Operation | Cost / time (measured) |
|---|---|
| Filtered orders query, 50 per page | Requested cost about 296 per page, actual about 71. 167 orders (8 days) in 4 pages, about 5 s. |
| REST refunds.json | 1 call per refunded order. 135 calls took about 30 s sequentially; the bucket shows 1/400. |
| tenderTransactions | A few pages of 250 per week |
| Full `--days=7` script run | **36 s** (`--days=1`: 8.5 s). `--no-rest` removes most of the time. |
| Broad `updated_at` scan (validation only) | About 2,000+ orders per day, 12k orders took 2 min 10 s. Run it as a periodic audit, not on every sync. |

Retry on GraphQL `extensions.code = THROTTLED` and on REST 429 (`Retry-After`).

---

## 7. Impossible or unverified

- **IMPOSSIBLE (scopes):** `Refund.staffMember` needs `read_users`. `Refund.return` and order returns need `read_returns`, and selecting them fails the whole query. Workaround: events plus REST `user_id`.
- Staff ids confirmed by the owner (2026-09-14): 135220658524 = Ruth Mae De Guzman (support), 135617184092 = Jan (call support).
- **UNVERIFIED:** that the ±5 s event match is always one-to-one (two refunds on the same order within 5 s could swap actors; REST `user_id` avoids this).
- **UNVERIFIED:** whether a refund that later fails ever showed `totalRefundedSet > 0` first (its transaction may have been PENDING).
- **UNVERIFIED:** the exact semantics of the tenderTransactions `processed_at` filter and of ShopifyQL `returns`.
- **NOT OBSERVED:** refunds through gateways other than shopify_payments (PayPal etc.), test refund transactions, money refunds on cancelled orders, refunds by Skio or other apps, and orders with money refunds in a financial status other than refunded or partially_refunded (e.g. PARTIALLY_PAID). The fast filter would miss that last case, so run a periodic broad-scan audit.

### Open questions for the owner

1. Confirm the % base: the order total incl. shipping and tax, in the customer's currency (the data shows the policy is applied exactly on this base).
2. Should Chargeflow refunds count as support refunds, or be shown as a separate category? They were 20.6 % of refunded EUR in the 7 complete days 2026-09-07..09-13 (1172.60 of 5684.70), and 26.4 % in the rolling window 09-08 00:00..09-14 13:49 (1332.47 of 5043.94).
3. Who is staff account 135617184092?
4. Should "last 1 day" mean today so far or yesterday? Should "last 7 days" include today? (Both are computed below.)
5. Should failed refund attempts and lost chargebacks be shown?
6. Is it worth granting `read_users` / `read_returns`?

---

## 8. Running the script

```bash
npx tsx src/scripts/analytics/shopifyRefunds.ts --days=7 --tz=Europe/Helsinki --out=/home/dolan/support-analytics
# flags: --no-rest (skip REST actor ids), --no-reconcile (skip tenderTransactions)
```

Output:
- stdout: tables for the *complete* and *rolling* windows.
- `<out>/shopify-refunds-<N>d-<YYYY-MM-DD>.json`: definitions, both windows' aggregates, and refund-level rows. The rows contain order number, ids, amounts, pct, bucket and actor only; no customer data or notes.
- `<out>/shopify-refunds-<N>d-<YYYY-MM-DD>.md`: the same tables in markdown.

JSON shape (abridged):

```json
{
  "generatedAt": "2026-09-14T10:49:...Z", "timezone": "Europe/Helsinki", "days": 7,
  "windows": {
    "complete": { "from": "...Z", "to": "...Z", "agg": {
      "refunds": 121, "orders": 120, "eur": 5684.7,
      "buckets": { "full": {"count": 88, "eur": 4884.21}, "~30": {"count": 15, "eur": 279.58}, "...": {} },
      "actors": { "staff:135220658524": {"count": 79, "eur": 3544.41, "label": "..."} },
      "currencies": { "HKD": {"count": 20, "presentment": 8927.4, "eur": 979.37} },
      "byDay": { "2026-09-07": {"count": 36, "eur": 1492.98, "tenderTxCount": 38, "tenderTxEur": 1618.34} },
      "shippingOnly": 4, "onDisputedOrders": 3, "onSubscriptionOrders": 116, "medianOrderAgeDays": 17.09 } },
    "rolling": { "...": "same shape" }
  },
  "rows": [ { "refundId": "...", "orderName": "#41867", "refundCreatedAt": "...", "localDay": "2026-09-11",
              "eur": 6.12, "presentmentAmount": 6.12, "currency": "EUR", "pct": 4.77, "cumPct": 100,
              "bucket": "full (cumulative)", "shippingOnly": false, "actor": "staff:135617184092", "...": "..." } ]
}
```

---

## 9. Real example (script output, 2026-09-14 about 10:49 UTC / 13:49 Helsinki)

Money refunds only; days are Europe/Helsinki; EUR = shopMoney.

### Last 1 local day

| | Yesterday 2026-09-13 (complete) | Today 2026-09-14 00:00-13:48 (partial) |
|---|---:|---:|
| Refunds / orders | 8 / 8 | 15 / 15 |
| EUR | **440.10** | **852.22** |
| full | 5 / 403.71 | 10 / 725.60 |
| ~30 | 1 / 10.80 | 4 / 92.79 |
| ~50 | 1 / 19.45 | 1 / 33.83 |
| ~70 | 0 | 0 |
| shipping-only | 1 / 6.14 (18.08 %) | 0 |
| other | 0 | 0 |
| staff:135220658524 | 8 / 440.10 | 13 / 665.38 |
| app:Chargeflow | 0 | 2 / 186.84 |
| tenderTransactions check | 8 / 440.10 (diff 0) | 15 / 852.22 (diff 0) |

Currencies, yesterday (count, presentment, EUR): XCD 2, 656.44, 210.58; SEK 1, 1063, 94.47; GBP 1, 58, 67.67; EUR 2, 41.79, 41.79; HUF 1, 7075, 19.45; MYR 1, 29, 6.14.
Currencies, today: DKK 3, 1715.16, 229.45; EUR 4, 195.47, 195.47; THB 1, 3738, 97.44; GBP 3, 83, 96.86; SEK 1, 1063, 94.40; ILS 1, 315, 89.40; ISK 1, 3804, 27.24; HUF 1, 7983.36, 21.96.

### Last 7 local days

| | Complete: 2026-09-07 .. 09-13 | Rolling: 2026-09-08 00:00 .. 09-14 13:49 |
|---|---:|---:|
| Refunds / orders | 121 / 120 | 100 / 99 |
| EUR | **5684.70** | **5043.94** |
| full | 88 / 4884.21 | 69 / 4331.16 |
| full (cumulative) | 1 / 6.12 | 1 / 6.12 |
| ~30 | 15 / 279.58 | 16 / 292.94 |
| ~50 | 8 / 214.73 | 8 / 208.60 |
| ~70 | 0 / 0.00 | 0 / 0.00 |
| shipping-only | 3 / 18.12 (23.23, 23.23, 18.08 %) | 3 / 18.12 |
| other | 6 / 281.94 (43.53, 40.54, 45.46, 37.9, 95.23, 36.9 %) | 3 / 187.00 (37.9, 95.23, 36.9 %) |
| staff:135220658524 (support agent) | 79 / 3544.41 | 63 / 2952.17 |
| staff:135617184092 (second staff) | 24 / 967.69 | 18 / 759.30 |
| app:Chargeflow | 18 / 1172.60 | 19 / 1332.47 |
| Refunds flagged shipping-only (any bucket) | 4 | 4 |
| On orders with disputes | 3 | 3 |
| On subscription-tagged orders | 116 | 96 |
| Median order age at refund | 17.1 d | 11.4 d |

Per local day (refunds / EUR / tenderTransactions EUR):

| Day | Refunds | EUR | TenderTx EUR | Diff |
|---|---:|---:|---:|---:|
| 2026-09-07 | 36 | 1492.98 | 1618.34 | 125.36 (2 failed refund attempts on lost chargebacks) |
| 2026-09-08 | 15 | 821.66 | 821.66 | 0 |
| 2026-09-09 | 20 | 1003.85 | 1003.85 | 0 |
| 2026-09-10 | 15 | 568.70 | 568.70 | 0 |
| 2026-09-11 | 14 | 824.50 | 824.50 | 0 |
| 2026-09-12 | 13 | 532.91 | 532.91 | 0 |
| 2026-09-13 | 8 | 440.10 | 440.10 | 0 |
| 2026-09-14 (partial) | 15 | 852.22 | 852.22 | 0 |

Currencies, complete 7 days (count, presentment, EUR):

| Currency | Count | Presentment | EUR |
|---|---:|---:|---:|
| EUR | 33 | 1472.53 | 1472.53 |
| HKD | 20 | 8927.40 | 979.37 |
| GBP | 14 | 546.34 | 636.53 |
| SEK | 9 | 3968.54 | 354.45 |
| USD | 10 | 410.30 | 352.89 |
| THB | 4 | 12174.64 | 317.22 |
| AUD | 3 | 380.00 | 235.01 |
| XCD | 2 | 656.44 | 210.58 |
| TWD | 5 | 7316.00 | 199.56 |
| MYR | 4 | 618.44 | 131.07 |
| QAR | 1 | 546.00 | 128.69 |
| PHP | 2 | 9256.00 | 127.32 |
| HUF | 3 | 45905.00 | 126.20 |
| ISK | 1 | 14100.00 | 100.42 |
| DKK | 3 | 623.40 | 83.40 |
| DZD | 1 | 12500.00 | 80.74 |
| CHF | 2 | 70.20 | 74.18 |
| CAD | 1 | 63.00 | 39.32 |
| ILS | 2 | 86.30 | 24.49 |
| EGP | 1 | 635.10 | 10.73 |

Exact partial percentages in the complete 7 days: `~30`: 30.00 (x12), 30.03 (x2), 27.78 (x1); `~50`: 50.00 (x5), 50.01, 50.04, 50.51. Every `full` refund is exactly 100.00 % on the received-total base.

Independent cross-check (2026-09-14 about 11:40-12:10 UTC): a REST-only recomputation (a `GET /orders.json?status=any&updated_at_min=` scan of all 12,059 orders updated since 2026-09-06T20:00Z **without** the financial-status filter, success refund transactions from `refunds[]`, the % base as the sum of successful sale/capture transactions from `/orders/{id}/transactions.json`, and EUR from `OrderTransaction.amountSet.shopMoney`) reproduced every row above: 136 of 136 refunds with identical EUR, presentment amount, pct, bucket and actor, and no extra money refunds outside the filter. The 1-day, today, complete-7-day and rolling-7-day totals, buckets, actors, per-day sums and top currencies all match.

Note: earlier research that used `totalPriceSet` as the base reported "~70: 1 (37.01 EUR)" and an "other" value of 79.03 %. Both are full refunds on Skio-edited orders and are classified correctly above.

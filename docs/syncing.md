# Shopify → Chatwoot Syncing

How Shopify customer/order data lands on the Chatwoot contact, plus the matching and (incremental) sync behaviour.

## What gets synced

When a customer is synced (via webhook or bulk sync) the server:

1. Fetches all of the customer's orders from Shopify (paginated, all statuses).
2. Looks up the customer in Chatwoot — first by Shopify ID (`identifier`), then by email.
3. Creates or updates the Chatwoot contact.

### Built-in Chatwoot fields

| Field | Source |
|-------|--------|
| `name` | Shopify first + last name |
| `email` | Shopify email |
| `phone_number` | Shopify phone (normalized to E.164) |
| `identifier` | Shopify customer ID (links the two systems) |

### Custom attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| `shopify_customer_id` | Text | Shopify customer ID (also used by the AI draft flow to look up orders) |
| `shopify_url` | Link | Direct link to the customer in Shopify Admin |
| `total_orders` | Number | Lifetime order count |
| `total_spent` | Text | Lifetime spend with currency (e.g. `"149.97 EUR"`) |
| `subscription_orders` | Number | Count of orders tagged as subscription |
| `last_order_name` | Text | Most recent order name (e.g. `"#2457"`) |
| `last_order_status` | Text | Payment and fulfillment status |
| `last_order_date` | Text | Date of most recent order |
| `last_order_tracking_url` | Link | Tracking URL from the latest fulfillment |
| `default_address` | Text | Formatted default address (full country name) |
| `recent_orders` | Text | Summary of up to 10 recent orders |
| `shopify_email_link` | Text | Optional override email. When set, **all** Shopify lookups use this address instead of the contact's own email. See [ai-drafts.md](ai-drafts.md#unmatched-contact-matching). |

## Contact matching logic

1. **Filter by `identifier`** (Shopify customer ID) — fast path for already-linked contacts.
2. **Filter by `email`** — catches contacts created before this integration; sets their `identifier` on match.
3. **Create new contact** — if no match and `CHATWOOT_INBOX_ID` is set.

All lookups use Chatwoot's `/contacts/filter` (exact match), not fuzzy search. A create that fails 422 (duplicate) retries as an email lookup + update; a 422 caused by an invalid phone retries without the phone field.

## Periodic sync (incremental)

The periodic sync ([`src/services/sync.ts`](../src/services/sync.ts)) is a lightweight safety net, not a full re-sync. It runs on a `setInterval` timer configured by `SYNC_INTERVAL_HOURS` (`0` disables it).

- Contacts with Shopify data already populated → skipped.
- Contacts that exist but lack Shopify data → orders fetched, contact updated.
- Contacts missing from Chatwoot → created with full data.

### Sync state / watermark

Sync progress is persisted in Firestore (cache namespace `syncState`, doc key `customers`) so runs are **incremental and resumable**:

- `lastCompletedWatermark` — after a clean run, only customers with `updated_at` newer than this (minus a small overlap) are scanned next time.
- `resumeCursor` — if a run is interrupted, the next run resumes from the saved page cursor instead of starting over.

A manual trigger (`POST /sync/customers`) forces a **full** scan (`runFullSync({ full: true })`). See [caching-and-storage.md](caching-and-storage.md) for the storage details.

### Throttling

500ms between individual customers, 1s between pages. Shopify 429s are retried using `Retry-After`.

# Shopify Sync

Two mechanisms keep Chatwoot contacts in sync with Shopify customer data.

## Real-Time Webhooks

Shopify sends webhooks whenever a customer or order is created/updated. The server processes these immediately.

### Customer Webhooks (`POST /webhooks/customers`)

Triggered by `customers/create` and `customers/update`. The handler:

1. Fetches all orders for the customer from Shopify (paginated, all statuses).
2. Builds custom attributes (order count, spend, latest order info, etc.).
3. Upserts the contact in Chatwoot.

### Order Webhooks (`POST /webhooks/orders`)

Triggered by `orders/create`, `orders/updated`, `orders/fulfilled`, `orders/partially_fulfilled`. The handler:

1. Extracts the customer from the order payload.
2. Runs the same customer sync as above.
3. Extracts tracking numbers from fulfillments and registers them with 17track (fire-and-forget, non-blocking).

All Shopify webhooks are verified via HMAC-SHA256 using the app's client secret.

## Periodic Background Sync

A safety net that catches anything webhooks might miss. Runs on a `setInterval` timer (configurable via `SYNC_INTERVAL_HOURS`, default disabled).

### Behavior

The sync paginates through **all** Shopify customers (250 per page) and for each one:

| Scenario | Action |
|----------|--------|
| Contact exists in Chatwoot with `shopify_customer_id` populated | **Skip** — no API calls beyond the filter lookup |
| Contact exists but has no Shopify data | Fetch orders from Shopify, build attributes, update contact |
| Contact doesn't exist in Chatwoot | Fetch orders, create contact (requires `CHATWOOT_INBOX_ID`) |
| Customer has no email | **Skip** |

This means the first run does the heavy lifting. Subsequent runs are fast — they only process genuinely new or unlinked customers.

### Timing

- First run starts 30 seconds after server boot.
- Subsequent runs fire every `SYNC_INTERVAL_HOURS` hours.
- 500ms delay between individual customers, 1s delay between pages.
- Only one sync can run at a time (guarded by an in-memory flag).

### Manual Trigger

`POST /sync/customers` starts a sync immediately. Returns 409 if one is already running. Protected by `SYNC_API_KEY` bearer auth when set.

## Contact Matching Logic

The server uses a multi-step approach to find or create the right Chatwoot contact:

```
1. Filter by identifier (Shopify customer ID)
   └─ Found? → Update it
   └─ Not found? ↓

2. Filter by email
   └─ Found? → Update it (also sets identifier for faster future lookups)
   └─ Not found? ↓

3. Create new contact (requires CHATWOOT_INBOX_ID)
   └─ Success? → Done
   └─ 422 error (duplicate)?
       └─ Retry email lookup → Update if found
       └─ Still not found? → Retry create without phone number
```

All lookups use Chatwoot's `/contacts/filter` endpoint with exact matching, **not** the fuzzy `/contacts/search`.

### Phone Number Handling

Phone numbers are normalized to E.164 format (`+` followed by 7-15 digits). If a create or update fails with HTTP 422 and the payload includes a phone number, the server retries without the phone field — this handles cases where the phone format is rejected by Chatwoot.

## What Gets Synced

### Built-in Chatwoot Fields

| Field | Source |
|-------|--------|
| `name` | Shopify first + last name |
| `email` | Shopify email |
| `phone_number` | Shopify phone (E.164 normalized), falls back to default address phone |
| `identifier` | Shopify customer ID (links the two systems) |

### Custom Attributes

These must be created manually in Chatwoot under **Settings → Custom Attributes** (Contact type):

| Attribute | Type | Description |
|-----------|------|-------------|
| `shopify_customer_id` | Text | Shopify customer ID |
| `shopify_url` | Link | Direct link to customer in Shopify Admin |
| `total_orders` | Number | Lifetime order count |
| `total_spent` | Text | Lifetime spend with currency (e.g. `"149.97 EUR"`) |
| `subscription_orders` | Number | Count of orders tagged as subscription |
| `last_order_name` | Text | Most recent order name (e.g. `"#2457"`) |
| `last_order_status` | Text | Payment and fulfillment status (e.g. `"paid / fulfilled"`) |
| `last_order_date` | Text | Date of most recent order |
| `last_order_tracking_url` | Link | Tracking URL from the latest fulfillment |
| `default_address` | Text | Formatted default address |
| `recent_orders` | Text | Summary of up to 10 recent orders |

### Subscription Detection

Orders tagged with `subscription first order` or `subscription recurring order` (case-insensitive) are counted as subscription orders.

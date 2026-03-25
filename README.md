# Shopify → Chatwoot Customer Sync

A Node.js/TypeScript server that syncs Shopify customer and order data into Chatwoot, giving support agents instant visibility into a customer's order history, tracking info, subscription status, and more.

## How It Works

```
Shopify ──webhooks──▶ Express Server ──API──▶ Chatwoot
                           │
                     Periodic sync
                     (fills gaps)
```

**Two sync mechanisms run in parallel:**

1. **Real-time webhooks** — Shopify sends events (customer created/updated, order created/updated/fulfilled) to the server, which immediately updates the corresponding Chatwoot contact.
2. **Periodic background sync** — A configurable timer walks through all Shopify customers, finds anyone not yet in Chatwoot (or missing Shopify data), and creates/populates them. Already-synced contacts are skipped to keep it lightweight.

---

## Authentication

### Shopify

The server uses **OAuth2 client credentials** to obtain short-lived access tokens from the Shopify Admin API. Tokens are cached in memory and refreshed automatically 1 hour before expiry (they last ~24h). Every outgoing Shopify request goes through an Axios interceptor that injects a fresh token.

The **client secret** also serves as the HMAC signing key for verifying incoming webhook requests.

### Chatwoot

A static `api_access_token` is used for all Chatwoot API calls. Rate limiting (429) is handled automatically with exponential backoff and retry.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Health check (returns `{ status: "ok" }`) |
| `POST` | `/webhooks/customers` | HMAC | Shopify `customers/create` and `customers/update` events |
| `POST` | `/webhooks/orders` | HMAC | Shopify `orders/create`, `orders/updated`, `orders/fulfilled`, `orders/partially_fulfilled` events |
| `POST` | `/sync/customers` | Bearer token | Triggers a manual full sync of all Shopify customers |

---

## What Gets Synced

When a customer is synced (via webhook or bulk sync), the server:

1. Fetches all of the customer's orders from Shopify (paginated, all statuses).
2. Looks up the customer in Chatwoot — first by Shopify ID (`identifier`), then by email as a fallback for pre-existing contacts.
3. Creates or updates the Chatwoot contact with the following data:

### Built-in Chatwoot Fields

| Field | Source |
|-------|--------|
| `name` | Shopify first + last name |
| `email` | Shopify email |
| `phone_number` | Shopify phone (normalized to E.164) |
| `identifier` | Shopify customer ID (links the two systems) |

### Custom Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| `shopify_customer_id` | Text | Shopify customer ID |
| `shopify_url` | Link | Direct link to the customer in Shopify Admin |
| `total_orders` | Number | Lifetime order count |
| `total_spent` | Text | Lifetime spend with currency (e.g. `"149.97 EUR"`) |
| `subscription_orders` | Number | Count of orders tagged as subscription (first or recurring) |
| `last_order_name` | Text | Most recent order name (e.g. `"#2457"`) |
| `last_order_status` | Text | Payment and fulfillment status (e.g. `"paid / fulfilled"`) |
| `last_order_date` | Text | Date of most recent order |
| `last_order_tracking_url` | Link | Tracking URL from the latest fulfillment |
| `default_address` | Text | Formatted default address |
| `recent_orders` | Text | Summary of up to 10 recent orders with dates, amounts, statuses, and tracking links |

---

## Contact Matching Logic

The server uses a smart multi-step approach to avoid duplicates:

1. **Filter by `identifier`** (Shopify customer ID) — fast path for contacts already linked by a previous sync.
2. **Filter by `email`** — catches pre-existing Chatwoot contacts who were created before this integration (e.g. they emailed support). When matched, their `identifier` is set to the Shopify ID for faster future lookups.
3. **Create new contact** — if no match is found and `CHATWOOT_INBOX_ID` is configured.

All lookups use Chatwoot's `/contacts/filter` endpoint (exact matching), not the fuzzy search endpoint.

If a create fails with HTTP 422 (duplicate), the server retries the email lookup and updates instead. If the 422 is caused by an invalid phone number format, it retries without the phone field.

---

## Periodic Sync Behavior

The periodic sync is designed to be a lightweight safety net, not a full re-sync:

- **Contacts with Shopify data already populated** → skipped (no API calls beyond the filter lookup).
- **Contacts that exist but lack Shopify data** → orders are fetched and the contact is updated.
- **Contacts that don't exist in Chatwoot** → created with full Shopify data.

This means the first run does the heavy lifting, and subsequent runs are fast — only processing genuinely new customers.

The sync runs on a `setInterval` timer inside the Node.js process. Configurable via `SYNC_INTERVAL_HOURS` (set to `0` to disable).

---

## Rate Limiting

Both Shopify and Chatwoot API clients handle rate limiting automatically:

- **Shopify**: Retries on 429 using the `Retry-After` header, up to 3 attempts.
- **Chatwoot**: Axios response interceptor with exponential backoff (2s → 4s → 8s → 16s), up to 4 retries.
- **Sync throttling**: 500ms delay between individual customers, 1s delay between pages.

---

## Project Structure

```
src/
├── config/
│   └── env.ts              # Environment variable validation and typed config
├── middleware/
│   ├── verifyShopifyWebhook.ts  # HMAC-SHA256 webhook verification
│   ├── syncAuth.ts              # Bearer token auth for /sync routes
│   └── errorHandler.ts          # Global error handler
├── routes/
│   ├── webhooks.ts          # Shopify webhook handlers (customers, orders)
│   └── sync.ts              # Manual sync trigger endpoint
├── services/
│   ├── shopifyAuth.ts       # OAuth client_credentials token management
│   ├── shopify.ts           # Shopify REST API client (customers, orders)
│   ├── chatwoot.ts          # Chatwoot API client (filter, create, update, upsert)
│   └── sync.ts              # Full sync logic and periodic scheduler
├── types/
│   └── index.ts             # TypeScript interfaces for Shopify and Chatwoot payloads
├── utils/
│   ├── formatters.ts        # Order formatting, phone normalization, attribute building
│   └── logger.ts            # Structured console logger
├── app.ts                   # Express app configuration and middleware wiring
└── server.ts                # Entry point, starts server and periodic sync
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPIFY_STORE_DOMAIN` | Yes | Your `.myshopify.com` domain |
| `SHOPIFY_CLIENT_ID` | Yes | App client ID from Shopify Admin |
| `SHOPIFY_CLIENT_SECRET` | Yes | App client secret (also used for webhook HMAC verification) |
| `CHATWOOT_BASE_URL` | Yes | Chatwoot instance URL (e.g. `https://app.chatwoot.com`) |
| `CHATWOOT_API_TOKEN` | Yes | Chatwoot API access token |
| `CHATWOOT_ACCOUNT_ID` | Yes | Chatwoot account ID |
| `CHATWOOT_INBOX_ID` | No | Inbox ID for new contact creation (required to create contacts) |
| `SYNC_API_KEY` | No | Bearer token to protect the `/sync` endpoint |
| `SYNC_INTERVAL_HOURS` | No | Periodic sync interval in hours (default: `0` = disabled) |
| `PORT` | No | Server port (default: `8080`) |

---

## Deployment (DigitalOcean App Platform)

The repo includes a `.do/app.yaml` spec for DigitalOcean App Platform:

- **Runtime**: Node.js 22
- **Build**: `npm run build` (TypeScript → `dist/`)
- **Start**: `npm start` (`node dist/server.js`)
- **Health check**: `GET /health`
- **Port**: 8080

All environment variables should be set as secrets in the DO dashboard or app spec.

---

## Shopify Webhook Registration

Webhooks are registered programmatically using the Shopify Admin API. The following topics should point to your server:

| Topic | Endpoint |
|-------|----------|
| `customers/create` | `https://<your-domain>/webhooks/customers` |
| `customers/update` | `https://<your-domain>/webhooks/customers` |
| `orders/create` | `https://<your-domain>/webhooks/orders` |
| `orders/updated` | `https://<your-domain>/webhooks/orders` |
| `orders/fulfilled` | `https://<your-domain>/webhooks/orders` |
| `orders/partially_fulfilled` | `https://<your-domain>/webhooks/orders` |

---

## Chatwoot Setup

1. Create the custom attributes listed above in **Settings → Custom Attributes** (Contact type).
2. Note your **Inbox ID** from Settings → Inboxes (the number in the URL) and set it as `CHATWOOT_INBOX_ID`.
3. Generate an API access token from your profile and set it as `CHATWOOT_API_TOKEN`.

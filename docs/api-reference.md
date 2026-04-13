# API Reference

## Endpoints

### `GET /health`

Health check used by DigitalOcean App Platform.

**Auth:** None

**Response:**
```json
{ "status": "ok", "timestamp": "2026-04-13T10:00:00.000Z" }
```

---

### `POST /webhooks/customers`

Receives Shopify `customers/create` and `customers/update` webhook events.

**Auth:** HMAC-SHA256 (`X-Shopify-Hmac-Sha256` header verified against client secret)

**Body:** Raw Shopify customer JSON (parsed from `express.raw`)

**Behavior:** Fetches the customer's orders from Shopify and upserts the contact in Chatwoot with full order data.

**Response:** `200 OK` or `500 Error`

---

### `POST /webhooks/orders`

Receives Shopify order webhook events: `orders/create`, `orders/updated`, `orders/fulfilled`, `orders/partially_fulfilled`.

**Auth:** HMAC-SHA256

**Body:** Raw Shopify order JSON

**Behavior:**
1. Extracts the customer from the order payload.
2. Syncs the customer to Chatwoot (same as customer webhook).
3. Registers any tracking numbers from fulfillments with 17track (async, non-blocking).

**Response:** `200 OK`, `200 No customer, skipped`, or `500 Error`

---

### `POST /sync/customers`

Triggers a full background sync of all Shopify customers to Chatwoot.

**Auth:** Bearer token (`Authorization: Bearer <SYNC_API_KEY>`). If `SYNC_API_KEY` is not set, the endpoint is unprotected.

**Response:**
- `202 Accepted` — Sync started in the background
- `409 Conflict` — A sync is already running

---

### `POST /chatwoot`

Receives Chatwoot webhook events (regular webhooks or Agent Bot events) and runs the AI support pipeline.

**Auth:** Optional query-string secret: `POST /chatwoot?secret=<CHATWOOT_WEBHOOK_SECRET>`. If the env var is set, requests without a matching secret are rejected (silently, after returning 200).

**Body:** Chatwoot webhook JSON payload (up to 5MB limit)

**Behavior:**
1. Returns `200` immediately.
2. If `AI_MODE=off`, stops.
3. Filters to `message_created` (incoming, non-private) and `conversation_created` events.
4. Runs the AI pipeline asynchronously:
   - Checks hard rules (14+ day unfulfilled orders)
   - Classifies intent via Claude structured output
   - Routes to responder (AI-solvable) or template handoff
   - In **shadow mode**: posts all results as a single private note
   - In **live mode**: sends customer reply, posts private note, applies labels, changes status

**Response:** Always `200 { "received": true }` (processing is async)

## Shopify Webhook Registration

Register these webhooks in your Shopify app to point to your server:

| Topic | Endpoint |
|-------|----------|
| `customers/create` | `https://<your-domain>/webhooks/customers` |
| `customers/update` | `https://<your-domain>/webhooks/customers` |
| `orders/create` | `https://<your-domain>/webhooks/orders` |
| `orders/updated` | `https://<your-domain>/webhooks/orders` |
| `orders/fulfilled` | `https://<your-domain>/webhooks/orders` |
| `orders/partially_fulfilled` | `https://<your-domain>/webhooks/orders` |

## Chatwoot Webhook Registration

In your Chatwoot instance under **Settings → Integrations → Webhooks**:

- **URL:** `https://<your-domain>/chatwoot?secret=<CHATWOOT_WEBHOOK_SECRET>`
- **Events:** `message_created`

## External APIs Used

### Shopify Admin REST API

- **Version:** `2026-01`
- **Base URL:** `https://<store>.myshopify.com/admin/api/2026-01`
- **Auth:** `X-Shopify-Access-Token` header (OAuth2 client_credentials)
- **Endpoints used:**
  - `GET /customers/{id}/orders.json` — Fetch all orders for a customer
  - `GET /orders/{id}.json` — Fetch a single order
  - `GET /customers.json` — Paginate all customers (cursor-based via Link header)
  - `GET /customers/search.json?query=email:{email}` — Search customer by email

### Chatwoot API

- **Base URL:** `{CHATWOOT_BASE_URL}/api/v1/accounts/{CHATWOOT_ACCOUNT_ID}`
- **Auth:** `api_access_token` header
- **Endpoints used:**
  - `POST /contacts/filter` — Exact-match contact lookup
  - `POST /contacts` — Create a new contact
  - `PUT /contacts/{id}` — Update a contact
  - `GET /conversations/{id}/messages` — Get conversation messages
  - `GET /conversations/{id}` — Get conversation details
  - `GET /contacts/{id}/conversations` — Get all conversations for a contact
  - `POST /conversations/{id}/messages` — Post a message (used for private notes)

### 17track API

- **Version:** v2.2
- **Base URL:** `https://api.17track.net/track/v2.2`
- **Auth:** `17token` header
- **Endpoints used:**
  - `POST /register` — Register tracking numbers for monitoring
  - `POST /gettrackinfo` — Get current tracking status for registered numbers

### Anthropic Messages API

- **Auth:** API key via SDK
- **Model:** Configurable, default `claude-sonnet-4-20250514`
- **Max tokens:** 2048

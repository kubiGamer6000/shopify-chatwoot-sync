# Scandi → Chatwoot Customer Sync + AI Draft Replies

A Node.js/TypeScript server that:

1. **Syncs Shopify customer and order data into Chatwoot**, giving support agents instant visibility into a customer's order history, tracking info, subscription status, and more.
2. **Generates AI draft replies** using Claude whenever a customer messages support — drafts are posted as **private notes** in the Chatwoot conversation so agents can review/edit them before sending.

## How It Works

```
                                   ┌────────────────────┐
Shopify ──webhooks──▶ Express ────▶│  Chatwoot Contact  │
                          │        │  (synced fields)   │
                  Periodic sync    └────────────────────┘
                  (fills gaps)              ▲
                                            │ private note
Customer message ──▶ Chatwoot ─webhook─▶ Express ─▶ Claude
                                            ▲
                                            │ context: orders,
                                            │ tracking, history
                                       Shopify + 17track
```

Three independent flows run side-by-side:

1. **Real-time Shopify webhooks** — Shopify sends events (customer created/updated, order created/updated/fulfilled) to the server, which immediately updates the corresponding Chatwoot contact and registers any new tracking numbers with 17track.
2. **Periodic background sync** — A configurable timer walks through all Shopify customers, finds anyone not yet in Chatwoot (or missing Shopify data), and creates/populates them. Already-synced contacts are skipped to keep it lightweight.
3. **AI draft replies** — When a customer sends a new message, Chatwoot fires a webhook to the server. The server gathers full context (Shopify orders, live shipping status from 17track, previous conversations) and asks Claude to draft a reply, which is posted to the conversation as a **private note** for the human agent to review.

---

## Authentication

### Shopify

OAuth2 client credentials are used to obtain short-lived access tokens from the Shopify Admin API. Tokens are cached in memory and refreshed automatically 1 hour before expiry (they last ~24h). Every outgoing Shopify request goes through an Axios interceptor that injects a fresh token.

The **client secret** also serves as the HMAC signing key for verifying incoming Shopify webhook requests.

### Chatwoot

A static `api_access_token` is used for all outgoing Chatwoot API calls. Rate limiting (429) is handled automatically with exponential backoff and retry.

For incoming Chatwoot webhooks (the AI draft trigger), an optional shared secret is checked via the `?secret=` query parameter on the webhook URL — see [AI Draft Auto-Reply](#ai-draft-auto-reply) below.

### Anthropic (Claude)

A standard `ANTHROPIC_API_KEY` is used to call the Claude Messages API.

### 17track

A `17token` API key is sent on every request to `https://api.17track.net/track/v2.2`. New tracking numbers are auto-registered the first time the AI draft flow encounters them (with a 3s wait before re-querying for status).

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`  | `/health` | None | Health check (returns `{ status: "ok" }`) |
| `POST` | `/webhooks/customers` | HMAC | Shopify `customers/create` and `customers/update` events |
| `POST` | `/webhooks/orders` | HMAC | Shopify `orders/create`, `orders/updated`, `orders/fulfilled`, `orders/partially_fulfilled` events |
| `POST` | `/sync/customers` | Bearer token | Triggers a manual full sync of all Shopify customers |
| `POST` | `/chatwoot` | Optional `?secret=` | Chatwoot webhook → triggers AI draft generation |

---

## What Gets Synced (Shopify → Chatwoot)

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
| `shopify_customer_id` | Text | Shopify customer ID (also used by the AI draft flow to look up orders) |
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

## AI Draft Auto-Reply

When a customer sends a message into a Chatwoot inbox, the server receives a `message_created` webhook, gathers a complete context bundle, asks Claude for a reply draft, and posts it back into the same conversation as a **private note**. The draft is invisible to the customer; only agents can see it. The agent can copy/edit/send it as the public reply.

### Trigger Filter

The `/chatwoot` route ignores any payload that is not a fresh customer message. It only proceeds when **all** of these are true:

- `event === "message_created"`
- `message_type === "incoming"` (the message was sent by the customer, not an agent)
- `private !== true` (the agent didn't post a private note)

The handler responds `200` to Chatwoot **immediately** (before doing any work) so that Chatwoot's webhook does not time out, and then performs the rest of the work asynchronously.

### Optional Webhook Secret

If `CHATWOOT_WEBHOOK_SECRET` is set, the webhook URL must include it as a query string:

```
https://<your-domain>/chatwoot?secret=<your_secret>
```

Requests without the matching secret are silently dropped (a 200 is still returned to avoid leaking the existence of the secret). If `CHATWOOT_WEBHOOK_SECRET` is empty, no check is performed.

### Pipeline (per incoming message)

The full pipeline is in [`src/services/aiDraft.ts`](src/services/aiDraft.ts):

1. **Fetch Chatwoot context** in parallel:
   - `GET /conversations/:id/messages` — full message thread of the current conversation.
   - `GET /conversations/:id` — conversation details, including the contact's custom attributes (this is how we read `shopify_customer_id`).
   - `GET /contacts/:contact_id/conversations` — the contact's previous conversations (for historical context).
2. **Resolve the Shopify customer**:
   - First try the `shopify_customer_id` custom attribute on the Chatwoot contact (set by the sync flow).
   - If that fails or returns no orders, fall back to `GET /customers/search.json?query=email:...` on the Shopify Admin API.
3. **Fetch live tracking** from 17track for the **last 2 fulfilled orders' tracking numbers**:
   - Calls `POST /track/v2.2/gettrackinfo`.
   - Any tracking numbers rejected as "not registered" are auto-registered via `POST /track/v2.2/register` and re-queried after a 3s delay.
4. **Build the user prompt** ([`src/utils/promptBuilder.ts`](src/utils/promptBuilder.ts)) with these clearly-labelled sections:
   - Customer summary (name, email, total orders, subscription count, lifetime value, default shipping address, conversation type)
   - `--- ORDER HISTORY ---` (every order, sorted newest first, with line items)
   - `--- TRACKING (Last 2 Orders) ---` (status, last event, location, ETA, full event timeline up to 10 events)
   - `--- CURRENT CONVERSATION ---` (all visible, non-private messages, oldest → newest)
   - `--- PREVIOUS CONVERSATIONS ---` (up to 5 prior conversations, each with up to 10 visible messages)
5. **Call Claude** with `system = CLAUDE_SYSTEM_PROMPT` (or the contents of `src/config/systemPrompt.txt` if the env var is empty), `model = CLAUDE_MODEL` (default `claude-sonnet-4-20250514`), `max_tokens = 2048`.
6. **Post the draft as a private note** via `POST /conversations/:id/messages` with `{ message_type: "outgoing", private: true, content_type: "text" }`.

### System Prompt

The default system prompt lives in [`src/config/systemPrompt.txt`](src/config/systemPrompt.txt) and is loaded at startup if `CLAUDE_SYSTEM_PROMPT` is not set in the environment. It encodes:

- Brand voice ("Andrew" from Scandi support, warm/concise, signs off as `Best regards, Andrew, Scandi Support`).
- Brand context about Scandi gum (ingredients, positioning, product variants).
- Specific instructions for common cases:
  - Subscription cancellation → confirm without resistance (real agents do the actual cancel).
  - Shipping delays → reassure, frame as already shipped, soft excuse about high volume.
  - 3+ days unfulfilled → apologize and offer the discount code `SMILE5`.
  - Tracking links → always wrapped in `https://scandigum.com/en-eu/apps/17TRACK?nums=...`.
- Rule: **match the customer's language** (Swedish in → Swedish out, etc.).

To customize, either edit the file or set `CLAUDE_SYSTEM_PROMPT` to override it (the env var takes precedence).

### Debug Mode

Set `DEBUG=1` in the environment and the server will, in addition to posting the draft, post a separate private note containing the **full system prompt + user prompt** that was sent to Claude. Useful for verifying that the right context is being assembled. Turn this off in production.

### Failure Handling

The AI draft flow is best-effort and never blocks the webhook 200 response:

- A failure to fetch Shopify data, tracking data, or generate a draft is logged but does not crash the request.
- If `CLAUDE_SYSTEM_PROMPT` (and `systemPrompt.txt`) are both empty, the flow logs a warning and skips — no private note is posted.
- If Claude returns no text content, a warning is logged and no note is posted.

---

## Rate Limiting

All API clients handle rate limiting automatically:

- **Shopify**: Retries on 429 using the `Retry-After` header, up to 3 attempts.
- **Chatwoot**: Axios response interceptor with exponential backoff (2s → 4s → 8s → 16s), up to 4 retries.
- **17track**: One retry after registering missing numbers; failures are logged and the AI draft proceeds without tracking data.
- **Sync throttling**: 500ms delay between individual customers, 1s delay between pages.

---

## Project Structure

```
src/
├── config/
│   ├── env.ts              # Environment variable validation and typed config
│   └── systemPrompt.txt    # Default Claude system prompt (Scandi brand voice + rules)
├── middleware/
│   ├── verifyShopifyWebhook.ts  # HMAC-SHA256 webhook verification
│   ├── syncAuth.ts              # Bearer token auth for /sync routes
│   └── errorHandler.ts          # Global error handler
├── routes/
│   ├── webhooks.ts          # Shopify webhook handlers (customers, orders)
│   ├── sync.ts              # Manual sync trigger endpoint
│   └── chatwootWebhook.ts   # Chatwoot webhook → triggers AI draft
├── services/
│   ├── shopifyAuth.ts            # OAuth client_credentials token management
│   ├── shopify.ts                # Shopify REST API client (customers, orders, search-by-email)
│   ├── chatwoot.ts               # Chatwoot API client (filter, create, update, upsert)
│   ├── chatwootConversation.ts   # Conversation/message reads + private note writes
│   ├── tracking.ts               # 17track register + gettrackinfo client
│   ├── claude.ts                 # Anthropic Messages API wrapper
│   ├── aiDraft.ts                # Orchestrator: webhook → context → Claude → private note
│   └── sync.ts                   # Full sync logic and periodic scheduler
├── types/
│   ├── index.ts             # Shopify + Chatwoot REST types
│   ├── chatwoot.ts          # Chatwoot webhook + conversation types
│   └── tracking.ts          # 17track types
├── utils/
│   ├── formatters.ts        # Order formatting, phone normalization, attribute building
│   ├── promptBuilder.ts     # Builds the structured user prompt for Claude
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
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `SEVENTEENTRACK_API_KEY` | Yes | 17track API key (header `17token`) |
| `CHATWOOT_INBOX_ID` | No | Inbox ID for new contact creation (required to create contacts) |
| `SYNC_API_KEY` | No | Bearer token to protect the `/sync` endpoint |
| `SYNC_INTERVAL_HOURS` | No | Periodic sync interval in hours (default: `0` = disabled) |
| `PORT` | No | Server port (default: `8080`) |
| `CLAUDE_SYSTEM_PROMPT` | No | Inline override for the system prompt. If unset, falls back to `src/config/systemPrompt.txt` |
| `CLAUDE_MODEL` | No | Anthropic model id (default: `claude-sonnet-4-20250514`) |
| `CHATWOOT_WEBHOOK_SECRET` | No | If set, the Chatwoot webhook URL must include `?secret=<value>` |
| `DEBUG` | No | If truthy, posts the full Claude prompt as an additional private note (do not use in prod) |

---

## Setup

### 1. Local install

```bash
cp .env.example .env
# fill in the values from the sections below
npm install
npm run dev    # tsx watch mode
```

### 2. Shopify

1. In your Shopify dev dashboard, create an app and grab `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`.
2. Required scopes: `read_customers`, `read_orders`.
3. Register the following webhook topics, each pointing at your deployed server:

| Topic | Endpoint |
|-------|----------|
| `customers/create` | `https://<your-domain>/webhooks/customers` |
| `customers/update` | `https://<your-domain>/webhooks/customers` |
| `orders/create` | `https://<your-domain>/webhooks/orders` |
| `orders/updated` | `https://<your-domain>/webhooks/orders` |
| `orders/fulfilled` | `https://<your-domain>/webhooks/orders` |
| `orders/partially_fulfilled` | `https://<your-domain>/webhooks/orders` |

HMAC verification is performed using `SHOPIFY_CLIENT_SECRET`.

### 3. Chatwoot

#### a) Create custom attributes

In **Settings → Custom Attributes**, create the contact-level attributes listed under [Custom Attributes](#custom-attributes). The most important one for the AI draft flow is **`shopify_customer_id`** — this is how the AI looks up orders for an incoming message.

#### b) Get an API token + IDs

- Generate an API access token from your profile (top-right avatar → Profile Settings → API Access Token) → set as `CHATWOOT_API_TOKEN`.
- Note your account ID from any URL like `https://app.chatwoot.com/app/accounts/<id>/...` → set as `CHATWOOT_ACCOUNT_ID`.
- Note the inbox ID where contacts should be created → set as `CHATWOOT_INBOX_ID`.

#### c) Register the AI draft webhook

This is the new piece. In Chatwoot:

1. Go to **Settings → Integrations → Webhooks → Add new webhook**.
2. Set the URL to:
   - `https://<your-domain>/chatwoot` — if you don't want a secret, or
   - `https://<your-domain>/chatwoot?secret=<CHATWOOT_WEBHOOK_SECRET>` — if you set the env var.
3. Subscribe to the **`Message Created`** event (the only event the handler reacts to).
4. Save.

That's it. The handler ignores anything that isn't an inbound, non-private customer message, so subscribing to extra events is harmless but not required.

You can verify it's working by sending a test customer message into the inbox — within a few seconds a private note should appear in the conversation, signed `Andrew, Scandi Support`.

### 4. Anthropic

1. Create an API key at https://console.anthropic.com → set as `ANTHROPIC_API_KEY`.
2. Optionally pin a specific model via `CLAUDE_MODEL` (default `claude-sonnet-4-20250514`).
3. Optionally override the system prompt via `CLAUDE_SYSTEM_PROMPT`. If left blank, the file at `src/config/systemPrompt.txt` is used. Edit that file to change brand voice / rules without redeploying env vars.

### 5. 17track

1. Sign up at https://api.17track.net and create an API key → set as `SEVENTEENTRACK_API_KEY`.
2. No further setup needed. Tracking numbers are auto-registered by the order webhook (in the background) and again by the AI draft flow if any are still unknown at draft time.

---

## Deployment (DigitalOcean App Platform)

The repo includes a `.do/app.yaml` spec for DigitalOcean App Platform:

- **Runtime**: Node.js 22
- **Build**: `npm run build` (TypeScript → `dist/`)
- **Start**: `npm start` (`node dist/server.js`)
- **Health check**: `GET /health`
- **Port**: 8080

All environment variables should be set as secrets in the DO dashboard or app spec. `src/config/systemPrompt.txt` is bundled in the repo and read at runtime, so no extra build step is required to ship system-prompt changes.

---

## Quick Verification Checklist

After deploying, run through this:

- [ ] `GET /health` returns `{ "status": "ok" }`.
- [ ] Trigger a test order in Shopify → check logs for `Received order webhook` and `Updating Chatwoot contact`. The Chatwoot contact's custom attributes should populate.
- [ ] `POST /sync/customers` (with `Authorization: Bearer $SYNC_API_KEY`) → logs show paged customer fetches and upserts.
- [ ] Send a test customer email/chat into the configured Chatwoot inbox → within ~5–15s a **private note** appears in the conversation, written by "Andrew", with content tailored to that customer's actual orders.
- [ ] (Optional) Set `DEBUG=1` once and confirm the full prompt also appears as a private note. Then unset.

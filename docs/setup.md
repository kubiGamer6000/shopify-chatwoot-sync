# Setup & Deployment

## Prerequisites

- Node.js 22.x
- A Shopify custom app with Admin API access
- A Chatwoot instance with API access
- An Anthropic API key
- A 17track API key

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

### Required

| Variable | Description |
|----------|-------------|
| `SHOPIFY_STORE_DOMAIN` | Your `.myshopify.com` domain (e.g. `mystore.myshopify.com`) |
| `SHOPIFY_CLIENT_ID` | App client ID from the Shopify Partners dashboard |
| `SHOPIFY_CLIENT_SECRET` | App client secret (also used for HMAC webhook verification) |
| `CHATWOOT_BASE_URL` | Chatwoot instance URL (e.g. `https://app.chatwoot.com`) |
| `CHATWOOT_API_TOKEN` | Chatwoot API access token (generate from your Chatwoot profile) |
| `CHATWOOT_ACCOUNT_ID` | Chatwoot account ID (number from the URL) |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `SEVENTEENTRACK_API_KEY` | 17track API key |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_MODE` | `shadow` | AI pipeline mode: `shadow` (private notes only), `live` (full Agent Bot), `off` (disabled) |
| `CHATWOOT_INBOX_ID` | — | Inbox ID for new contact creation. Required to create contacts that don't exist yet in Chatwoot. Find it in Settings → Inboxes (number in the URL). |
| `CHATWOOT_BOT_TOKEN` | — | Agent Bot access token. If set, bot messages are attributed to the bot in the Chatwoot UI. |
| `SYNC_API_KEY` | — | Bearer token to protect `POST /sync/customers`. If unset, the endpoint is open. |
| `SYNC_INTERVAL_HOURS` | `0` (disabled) | How often to run the periodic background sync. Set to `6` for every 6 hours. |
| `PORT` | `8080` | Server port |
| `CLAUDE_MODEL` | `claude-sonnet-4-6-20260320` | Anthropic model to use for both classification and response |
| `CLASSIFIER_PROMPT` | contents of `src/config/prompts/classifier.txt` | Override the classifier system prompt via env var |
| `RESPONDER_PROMPT` | contents of `src/config/prompts/responder.txt` | Override the responder system prompt via env var |
| `CHATWOOT_WEBHOOK_SECRET` | — | Secret for the Chatwoot webhook URL query string. If set, requests to `POST /chatwoot` must include `?secret=<value>`. |
| `DEBUG` | — | Set to any value to enable debug logging |

## Local Development

```bash
npm install
npm run dev    # starts tsx in watch mode, auto-reloads on changes
```

The dev server runs on `http://localhost:8080` by default.

To test Shopify webhooks locally, use a tunnel like [ngrok](https://ngrok.com/) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) and point your Shopify webhooks to the tunnel URL.

## Chatwoot Setup

### 1. Create Custom Attributes

Go to **Settings → Custom Attributes** and create these as **Contact** type attributes:

| Display Name | Key | Type |
|-------------|-----|------|
| Shopify Customer ID | `shopify_customer_id` | Text |
| Shopify URL | `shopify_url` | Link |
| Total Orders | `total_orders` | Number |
| Total Spent | `total_spent` | Text |
| Subscription Orders | `subscription_orders` | Number |
| Last Order Name | `last_order_name` | Text |
| Last Order Status | `last_order_status` | Text |
| Last Order Date | `last_order_date` | Text |
| Last Order Tracking URL | `last_order_tracking_url` | Link |
| Default Address | `default_address` | Text |
| Recent Orders | `recent_orders` | Text |

### 2. Get Your API Token

Go to your Chatwoot profile → Access Token. Copy it to `CHATWOOT_API_TOKEN`.

### 3. Note Your Account and Inbox IDs

- **Account ID**: The number in your Chatwoot URL (e.g. `app.chatwoot.com/app/accounts/1/...` → `1`)
- **Inbox ID**: Go to Settings → Inboxes, click an inbox, the ID is in the URL

### 4. Configure the Chatwoot Webhook

**For shadow mode** (default, recommended first step):

Go to **Settings → Integrations → Webhooks** and add:

- **URL:** `https://<your-server>/chatwoot?secret=<CHATWOOT_WEBHOOK_SECRET>`
- **Events:** Check `message_created`

This is a regular webhook — conversations flow to agents normally, and AI results appear as private notes.

### 5. Create Labels (for live mode)

Go to **Settings → Labels** and create:

| Label | Color suggestion |
|-------|-----------------|
| `order-status` | Blue |
| `subscription` | Blue |
| `refund` | Blue |
| `change-address` | Blue |
| `product-issue` | Blue |
| `other` | Blue |
| `ai-resolved` | Green |
| `escalated` | Orange |
| `urgent` | Red |

### 6. Set Up Agent Bot (for live mode only)

When ready to switch from shadow to live mode:

1. Go to **Settings → Integrations → Agent Bots** (or create via API)
2. Set `outgoing_url` to `https://<your-server>/chatwoot?secret=<CHATWOOT_WEBHOOK_SECRET>`
3. Assign bot to your email inbox under **Settings → Inboxes → [Inbox] → Collaborators → Agent Bots**
4. Set `AI_MODE=live` in your environment
5. New conversations will now start as `pending` (invisible to agents until the bot hands off)

## Shopify Setup

### 1. Create a Custom App

In your Shopify Admin, go to **Settings → Apps and sales channels → Develop apps**. Create an app with these Admin API scopes:

- `read_customers`
- `read_orders`

### 2. Register Webhooks

Point these webhook topics to your server:

| Topic | URL |
|-------|-----|
| `customers/create` | `https://<your-server>/webhooks/customers` |
| `customers/update` | `https://<your-server>/webhooks/customers` |
| `orders/create` | `https://<your-server>/webhooks/orders` |
| `orders/updated` | `https://<your-server>/webhooks/orders` |
| `orders/fulfilled` | `https://<your-server>/webhooks/orders` |
| `orders/partially_fulfilled` | `https://<your-server>/webhooks/orders` |

### 3. Note Your Credentials

From the app's API credentials page, copy:
- **Client ID** → `SHOPIFY_CLIENT_ID`
- **Client Secret** → `SHOPIFY_CLIENT_SECRET`

The client secret is also used to verify incoming webhook signatures.

## Production Build

```bash
npm run build    # compiles TypeScript to dist/
npm start        # runs node dist/server.js
```

## DigitalOcean App Platform

The repo includes `.do/app.yaml` for DigitalOcean App Platform deployment:

- **Runtime:** Node.js (auto-detected)
- **Build:** `npm run build`
- **Start:** `npm start`
- **Health check:** `GET /health` (10s initial delay, 30s interval)
- **Instance:** `apps-s-1vcpu-0.5gb`

All environment variables should be configured as **secrets** in the DigitalOcean dashboard or app spec. The `.do/app.yaml` includes the Shopify and Chatwoot vars but **not** the AI/tracking vars (`ANTHROPIC_API_KEY`, `SEVENTEENTRACK_API_KEY`, `CHATWOOT_WEBHOOK_SECRET`, `CLAUDE_MODEL`, `CLAUDE_SYSTEM_PROMPT`). Add those manually in the dashboard.

**Important:** The system prompt file (`src/config/systemPrompt.txt`) is read at runtime relative to the project root. If your deployment copies `src/` alongside `dist/`, it will work automatically. Otherwise, set `CLAUDE_SYSTEM_PROMPT` as an environment variable.

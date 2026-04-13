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

The webhook URL is the same for both shadow and live mode:

```
https://<your-server>/chatwoot?secret=<YOUR_CHATWOOT_WEBHOOK_SECRET>
```

For example, if your server is at `https://shopify-chatwoot-sync-abc123.ondigitalocean.app` and your secret is `mysecret123`:

```
https://shopify-chatwoot-sync-abc123.ondigitalocean.app/chatwoot?secret=mysecret123
```

**The difference is *where* in Chatwoot you put this URL** — and that depends on which mode you're running.

---

#### Step A: Shadow Mode (start here)

Shadow mode uses a **regular Chatwoot webhook**. Conversations flow to agents as normal. The AI pipeline runs in the background and posts its results as private notes only — agents can review what the AI would have done.

1. In Chatwoot, go to **Settings → Integrations → Webhooks**
2. Click **Add New Webhook**
3. Enter the URL: `https://<your-server>/chatwoot?secret=<YOUR_SECRET>`
4. Check the **`message_created`** event
5. Save

That's it. Set `AI_MODE=shadow` in your server environment (this is the default). Deploy and every incoming customer message will get a private note showing the AI's classification and proposed response.

**Nothing changes for agents or customers.** Agents see the private notes inline in conversations. Customers see nothing different.

---

#### Step B: Live Mode (after shadow validation)

Live mode uses a **Chatwoot Agent Bot** instead of a regular webhook. The Agent Bot framework makes new conversations start as `pending` (hidden from agents), giving the bot control over which conversations humans see.

**Before switching:** Review shadow mode results for 1-2 weeks. Check that classification accuracy and response quality are good.

**To switch:**

1. **Remove the regular webhook** you created in Step A (Settings → Integrations → Webhooks → delete it). Otherwise you'll get duplicate processing.

2. **Create an Agent Bot:**
   - Go to **Settings → Integrations → Agent Bots** (some Chatwoot versions: Settings → Applications → Agent Bots)
   - Click **Add Agent Bot**
   - Name: `Scandi AI` (or whatever you prefer)
   - **Outgoing URL**: same URL as before — `https://<your-server>/chatwoot?secret=<YOUR_SECRET>`
   - Save — Chatwoot will generate an **access token** for the bot (copy it if you want messages attributed to the bot)

3. **Assign the bot to your inbox:**
   - Go to **Settings → Inboxes**
   - Click on your email inbox
   - Go to the **Collaborators** tab
   - Under **Agent Bot**, select the bot you just created
   - Save

4. **Set environment variables** on your server:
   ```
   AI_MODE=live
   CHATWOOT_BOT_TOKEN=<the access token from step 2, optional>
   ```

5. **Redeploy** (or restart the server)

Now new conversations will start as `pending`. The bot classifies, auto-responds to easy queries, and flips status to `open` for anything that needs a human. Agents only see conversations that are escalated to them.

---

#### Summary: What goes where

| Mode | Where to configure the URL | Chatwoot location | `AI_MODE` |
|------|---|---|---|
| Shadow | Regular webhook | Settings → Integrations → Webhooks | `shadow` |
| Live | Agent Bot outgoing URL | Settings → Integrations → Agent Bots | `live` |

The URL itself (`https://<server>/chatwoot?secret=...`) is **identical** in both cases. The server code handles both regular webhook payloads and Agent Bot event payloads on the same endpoint.

**Important:** Don't have both a regular webhook AND an Agent Bot pointing to the same URL at the same time — you'll get double-processing.

### 5. Create Labels

Go to **Settings → Labels** and create these. Required for live mode (labels are applied automatically). Optional but useful for shadow mode (for manual tagging during review).

| Label | Color | Group |
|-------|-------|-------|
| `order-status` | Blue | Topic |
| `subscription` | Blue | Topic |
| `refund` | Blue | Topic |
| `change-address` | Blue | Topic |
| `product-not-received` | Blue | Topic |
| `product-defect` | Blue | Topic |
| `other` | Blue | Topic |
| `ai-resolved` | Green | Handling |
| `escalated` | Orange | Handling |
| `urgent` | Red | Handling |

**Sidebar visibility** (what agents see for quick filtering):
- Show: `escalated`, `urgent`, `refund`, `product-issue`
- Hide from sidebar (reporting only): `order-status`, `subscription`, `change-address`, `other`, `ai-resolved`

### 6. Set Up Automation Rules (recommended for live mode)

Go to **Settings → Automations** and create:

| When | Condition | Action |
|------|-----------|--------|
| Conversation label added | `escalated` | Assign to team: [your support team] |
| Conversation label added | `urgent` | Assign to team: [your support team], Send notification |

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

All environment variables should be configured as **secrets** in the DigitalOcean dashboard or app spec. The `.do/app.yaml` includes the Shopify and Chatwoot vars but **not** the AI/tracking vars (`ANTHROPIC_API_KEY`, `SEVENTEENTRACK_API_KEY`, `CHATWOOT_WEBHOOK_SECRET`, `AI_MODE`, `CLAUDE_MODEL`). Add those manually in the dashboard.

**Important:** The prompt files (`src/config/prompts/classifier.txt` and `responder.txt`) are read at runtime relative to the project root. If your deployment copies `src/` alongside `dist/`, they load automatically. Otherwise, set `CLASSIFIER_PROMPT` and `RESPONDER_PROMPT` as environment variables with the full prompt text.

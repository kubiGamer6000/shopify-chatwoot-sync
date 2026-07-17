# Setup & Deployment

## Local install

```bash
cp .env.example .env      # fill in values (see configuration.md)
npm install
npm run dev               # tsx watch mode (server)
```

The two SPAs live in [`web/`](../web/) and [`admin-web/`](../admin-web/) with their own dependencies. `npm run build` (and the DO deploy) builds both automatically. For local SPA work: `cd web && npm install && npm run dev` (or `cd admin-web && ...`).

## Service setup

### Shopify
1. Create an app; grab `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`.
2. Scopes: `read_customers`, `read_orders` (and `read_all_orders` to see orders older than 60 days).
3. Register webhooks (each pointing at your server):

| Topic | Endpoint |
|-------|----------|
| `customers/create`, `customers/update` | `https://<domain>/webhooks/customers` |
| `orders/create`, `orders/updated`, `orders/fulfilled`, `orders/partially_fulfilled` | `https://<domain>/webhooks/orders` |

HMAC verification uses `SHOPIFY_CLIENT_SECRET`.

### Chatwoot
1. Create the contact custom attributes from [syncing.md](syncing.md) (most importantly `shopify_customer_id`).
2. Get an API token, account ID, and inbox ID.
3. Register the AI draft webhook (**Settings → Integrations → Webhooks**) at `https://<domain>/chatwoot` (or with `?secret=`), subscribed to **Message Created**.
4. For the autonomous bot, follow [agent-bot.md](agent-bot.md#manual-chatwoot-setup).

### Anthropic
Create an API key → `ANTHROPIC_API_KEY`. Optionally pin models / override prompts (see [configuration.md](configuration.md)).

### 17track
Sign up, create a key → `SEVENTEENTRACK_API_KEY`. Tracking numbers auto-register.

### Skio
Generate an API key → `SKIO_API_KEY`.

### Firestore (optional but recommended)
Provide a Firebase service account, base64-encode it, set `FIREBASE_BASE64_SERVICE_ACCOUNT`. Enables caching, summaries, drafts, audit logs, and the admin dashboard's config/users. See [caching-and-storage.md](caching-and-storage.md).

### Dashboard App
Set `DASHBOARD_APP_TOKEN`, deploy, then register in Chatwoot with `https://<domain>/app?token=<DASHBOARD_APP_TOKEN>` ([dashboard-app.md](dashboard-app.md)).

### Admin Control Dashboard
Set `ADMIN_BOOTSTRAP_EMAILS` and the `VITE_FIREBASE_*` build vars, enable Google sign-in in the Firebase console. See [admin-dashboard.md](admin-dashboard.md).

## DigitalOcean App Platform

The repo includes [`.do/app.yaml`](../.do/app.yaml):

- **Runtime**: Node.js 22
- **Build**: `npm run build` — builds `web/` and `admin-web/` SPAs, then compiles the server (`tsc` → `dist/`)
- **Start**: `npm start` (`node dist/server.js`)
- **Health check**: `GET /health`
- **Port**: 8080

Set all environment variables as secrets in the DO dashboard or app spec. The prompt `.txt` files are bundled and read at runtime, so shipping prompt-default changes needs no extra build step.

## Quick verification checklist

- [ ] `GET /health` returns `{ "status": "ok" }`.
- [ ] A test Shopify order populates the Chatwoot contact's custom attributes.
- [ ] `POST /sync/customers` (with `Authorization: Bearer $SYNC_API_KEY`) pages through customers.
- [ ] A test customer message produces a private-note draft within ~5-15s.
- [ ] `/app?token=…` loads the Customer 360 panel inside Chatwoot.
- [ ] `/admin` prompts Google sign-in; a bootstrap-email account reaches the dashboard, a non-admin sees the pending screen.

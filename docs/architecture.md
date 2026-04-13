# Architecture

## Overview

The server is an Express application (TypeScript, Node 22) that acts as a middleware between three external systems:

- **Shopify** (source of truth for customers, orders, fulfillments)
- **Chatwoot** (customer support platform where agents work)
- **Claude AI** (generates draft replies for agents)
- **17track** (package tracking aggregation)

## Data Flow

### Flow 1: Shopify → Chatwoot (Real-time)

```
Shopify webhook (customer/order event)
  → HMAC verification (middleware)
  → Parse customer from payload
  → Fetch all customer orders from Shopify API
  → Build custom attributes (order summary, tracking, spend, etc.)
  → Upsert contact in Chatwoot (identifier → email → create)
  → If order webhook: register tracking numbers with 17track
```

### Flow 2: Shopify → Chatwoot (Periodic Sync)

```
Timer fires (every SYNC_INTERVAL_HOURS)
  → Paginate through ALL Shopify customers (250/page)
  → For each customer:
      → Check if Chatwoot contact exists AND has Shopify data
      → If yes: skip (no API calls)
      → If no: fetch orders, build attributes, upsert contact
  → 500ms delay between customers, 1s between pages
```

### Flow 3: Chatwoot Message → AI Draft

```
Customer sends message in Chatwoot
  → Chatwoot webhook fires to POST /chatwoot
  → Server responds 200 immediately
  → Async processing begins:
      1. Fetch conversation messages, details, contact history (parallel)
      2. Look up Shopify customer (by ID from custom attributes, or by email)
      3. Fetch order history from Shopify
      4. Fetch tracking status from 17track (last 2 fulfilled orders)
      5. Build structured prompt with all context
      6. Send to Claude (system prompt + user prompt)
      7. Post Claude's response as a private note in the conversation
```

## Authentication

### Shopify API

OAuth2 **client_credentials** grant. The server requests a token from Shopify's `/admin/oauth/access_token` endpoint using the app's client ID and secret. Tokens are cached in memory and refreshed 1 hour before their ~24h expiry. An Axios request interceptor injects the token into every outgoing Shopify API call.

### Shopify Webhooks

Incoming webhooks are verified using HMAC-SHA256. The `X-Shopify-Hmac-Sha256` header is compared (timing-safe) against a hash computed from the raw request body using the client secret as the key.

### Chatwoot API

A static `api_access_token` is sent in every request header. The Axios client includes a response interceptor that retries on 429 with exponential backoff (2s base, up to 4 retries).

### Chatwoot Webhook

Optional query-string secret: `POST /chatwoot?secret=<CHATWOOT_WEBHOOK_SECRET>`. If `CHATWOOT_WEBHOOK_SECRET` is set, requests without the matching `?secret=` param are rejected.

### Sync Endpoint

Bearer token auth via `Authorization: Bearer <SYNC_API_KEY>`. If `SYNC_API_KEY` is not set, the endpoint is unprotected (a warning is logged).

## Rate Limiting

| Service | Strategy |
|---------|----------|
| Shopify API | Retries on 429 using `Retry-After` header, up to 3 attempts |
| Chatwoot API | Axios interceptor with exponential backoff (2s → 4s → 8s → 16s), up to 4 retries |
| Sync throttling | 500ms delay between customers, 1s delay between pages |

## Key Design Decisions

- **Filter, not search** — Chatwoot contact lookups use `/contacts/filter` (exact match) instead of `/contacts/search` (fuzzy). This prevents false matches.
- **Immediate 200 on Chatwoot webhook** — The AI draft flow is async. The webhook returns 200 before any processing to avoid Chatwoot timeouts.
- **Private notes, not replies** — Claude drafts are posted as private notes so agents can review and edit before sending.
- **Tracking on webhook, not on prompt** — Tracking numbers are registered with 17track when order webhooks arrive, so data is available by the time a customer asks about it.
- **Skip-if-populated sync** — The periodic sync only processes customers that are missing Shopify data in Chatwoot, keeping subsequent runs fast.

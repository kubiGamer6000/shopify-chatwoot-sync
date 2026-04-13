# Architecture

## Overview

The server is an Express application (TypeScript, Node 22) that acts as middleware between four external systems:

- **Shopify** (source of truth for customers, orders, fulfillments)
- **Chatwoot** (customer support platform where agents work)
- **Claude AI** (classifies intent and generates draft replies via structured output)
- **17track** (package tracking aggregation)

## Data Flows

### Flow 1: Shopify → Chatwoot Sync (Real-time + Periodic)

Shopify webhooks fire on customer/order events. The server fetches all orders, builds custom attributes, and upserts the Chatwoot contact. A periodic background sync fills gaps. See [Shopify Sync](shopify-sync.md) for details.

### Flow 2: AI Support Pipeline (Two-Call Architecture)

When a customer sends a message in Chatwoot:

```
Message arrives
  → Hard rules check (14+ day unfulfilled → immediate human handoff)
  → Fetch context (Chatwoot + Shopify + 17track, parallel)
  → Call 1: Classifier (Sonnet 4.6, structured output)
      → Returns: intent, sentiment, confidence, customer_wants_human, involves_refund
  → Route based on classification:
      AI-solvable (order_status, subscription_cancel, subscription_change)
        → Call 2: Responder (Sonnet 4.6, structured output)
        → Returns: customer_reply + private_note + resolved + discount_applied
      Handoff-only (all others, low confidence, hostile, wants human)
        → Template message + status → open
  → Execute actions (send reply, post note, apply labels, change status)
```

See [AI Pipeline](ai-pipeline.md) for the full specification.

### Flow 3: Tracking Registration

When Shopify order webhooks arrive with fulfillment data, tracking numbers are registered with 17track. The AI pipeline queries 17track later when building context for order status inquiries.

## Operating Modes

Controlled by the `AI_MODE` environment variable:

| Mode | Behavior |
|------|----------|
| `shadow` (default) | Full pipeline runs, all output posted as private notes only. No customer replies, no status changes, no labels. |
| `live` | Full Agent Bot mode with customer-facing replies, status management, and labels. |
| `off` | Pipeline disabled entirely. |

## Authentication

### Shopify API

OAuth2 **client_credentials** grant. Tokens cached in memory, refreshed 1 hour before ~24h expiry. Axios interceptor injects the token into every request.

### Shopify Webhooks

HMAC-SHA256 verification using the client secret. Timing-safe comparison.

### Chatwoot API

Static `api_access_token` header. Response interceptor retries on 429 with exponential backoff (2s base, up to 4 retries).

### Chatwoot Webhook

Optional query-string secret: `POST /chatwoot?secret=<CHATWOOT_WEBHOOK_SECRET>`.

### Claude API

API key via Anthropic SDK. Auto-retries on 429/5xx (3 attempts).

## Rate Limiting

| Service | Strategy |
|---------|----------|
| Shopify API | Retries on 429 using `Retry-After` header, up to 3 attempts |
| Chatwoot API | Exponential backoff (2s → 4s → 8s → 16s), up to 4 retries |
| Claude API | SDK auto-retry, 3 attempts |
| Sync throttling | 500ms between customers, 1s between pages |

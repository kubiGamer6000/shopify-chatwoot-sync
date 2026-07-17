# Architecture Overview

A Node.js/TypeScript (Express) server that connects a Shopify store to a Chatwoot support desk and layers AI on top. It runs as a single service on DigitalOcean App Platform and serves two React SPAs from the same process.

## What it does

1. **Syncs Shopify customer + order data into Chatwoot** so agents see order history, tracking, subscriptions, and lifetime value on the contact.
2. **Generates AI draft replies** (Claude) as private notes whenever a customer messages support.
3. **Runs an autonomous AgentBot** that classifies/labels conversations, auto-responds to the cases it can safely handle, and escalates the rest to a human.
4. **Serves a Chatwoot Dashboard App** (Customer 360) embedded in the agent's conversation view.
5. **Serves an Admin Control Dashboard** (standalone, Firebase-Auth gated) to manage AI prompts/models/settings and test prompt changes. See [admin-dashboard.md](admin-dashboard.md).

## The flows

```
                                   ┌────────────────────┐
Shopify ──webhooks──▶ Express ────▶│  Chatwoot Contact  │
                          │        │  (synced fields)   │
                  Periodic sync    └────────────────────┘
                  (fills gaps)              ▲
                                            │ private note (draft)
Customer message ──▶ Chatwoot ─webhook─▶ Express ─▶ Claude
                                            ▲
                                            │ context: orders,
                                            │ tracking, history, images
                                    Shopify + 17track + Skio
```

Independent flows run side by side:

1. **Real-time Shopify webhooks** — customer/order events immediately update the Chatwoot contact and register tracking numbers with 17track.
2. **Periodic background sync** — a configurable timer fills gaps for customers not yet in Chatwoot (now incremental; see [syncing.md](syncing.md)).
3. **AI draft replies** — an incoming customer message triggers a full context gather + Claude draft, posted as a private note ([ai-drafts.md](ai-drafts.md)).
4. **Autonomous AgentBot** — for `pending` conversations, classify → auto-respond or escalate ([agent-bot.md](agent-bot.md)).

## Request routing (Express)

| Mount | Auth | Purpose |
|-------|------|---------|
| `GET /health` | none | DO health probe |
| `/webhooks/*` | Shopify HMAC | Shopify customer/order events |
| `/sync/*` | `SYNC_API_KEY` bearer | Manual sync trigger |
| `/chatwoot/agent-bot` | optional `?secret=` | AgentBot responder (pending convos) |
| `/chatwoot` | optional `?secret=` | AI draft for open convos + classify |
| `/app`, `/app/api/*` | `DASHBOARD_APP_TOKEN` | Customer 360 dashboard ([dashboard-app.md](dashboard-app.md)) |
| `/admin`, `/admin/api/*` | Firebase Auth (admin role) | Admin Control Dashboard ([admin-dashboard.md](admin-dashboard.md)) |

Wiring lives in [`src/app.ts`](../src/app.ts); the entry point is [`src/server.ts`](../src/server.ts).

## External services

- **Shopify Admin API** — customers, orders (OAuth client-credentials tokens).
- **Chatwoot API** — contacts, conversations, messages, labels.
- **Anthropic Claude** — drafts, classification, autonomous responses, summaries, multimodal image understanding.
- **17track** — live delivery status.
- **Skio** — subscriptions (GraphQL).
- **Google Firestore** — caching, idempotency, AI summaries/drafts, audit logs, and admin config/users ([caching-and-storage.md](caching-and-storage.md)). Optional; the server degrades gracefully without it.

## Project layout

```
src/
├── config/        env.ts, systemPrompt.txt, responderPrompt.txt
├── middleware/    HMAC, sync auth, dashboard app auth, admin auth, errors
├── routes/        webhooks, sync, chatwoot webhooks, dashboardApp, adminApi
├── services/      shopify, chatwoot, tracking, skio, claude, aiDraft,
│                  classifier, aiResponder, customerResolver, customerProfile,
│                  customerSummary, draftStore, cache, aiAudit, appConfig,
│                  users, firebaseAuth, aiReplay, firestore, sync
├── types/         Shopify/Chatwoot/tracking/skio/summary/draft/config types
├── utils/         formatters, promptBuilder, responderFormat, logger
├── app.ts         Express wiring
└── server.ts      entry point + periodic sync

web/               Customer 360 Dashboard App (embedded in Chatwoot)
admin-web/         Admin Control Dashboard (standalone, Firebase Auth)
docs/              this documentation set
```

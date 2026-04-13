# Scandi Chatwoot Integration

A Node.js/TypeScript server that bridges Shopify, Chatwoot, and Claude AI to power automated customer support with intelligent human handoff.

```
                 ┌──────────────┐
                 │   Shopify    │
                 └──────┬───────┘
        webhooks (HMAC) │          periodic sync
                        ▼               │
┌────────────┐   ┌─────────────┐        │    ┌──────────┐
│  Chatwoot   │──▶│   Express   │◀───────┘    │  Claude  │
│  (webhook)  │   │   Server    │────────────▶│ Sonnet   │
└────────────┘   └──────┬──────┘  classify +  │  4.6     │
                        │         respond     └──────────┘
              ┌─────────┼─────────┐
              ▼         ▼         ▼
         Chatwoot    17track   Chatwoot
         (contacts)  (tracking) (replies + notes)
```

**What it does:**

1. **Shopify → Chatwoot sync** — Customer and order data flows into Chatwoot contacts via webhooks and periodic sync.
2. **AI support pipeline** — Two-call Claude architecture: classifies intent, then auto-responds to easy queries (order status, subscriptions) or performs warm human handoff with full context for everything else.
3. **Shadow mode** — Run the full AI pipeline as private notes only, so agents can validate before going live.

## Quick Start

```bash
cp .env.example .env     # fill in all required values
npm install
npm run dev              # starts with hot-reload via tsx
```

Set `AI_MODE=shadow` (default) to test the AI pipeline without customer impact.

## Documentation

| Document | What it covers |
|----------|---------------|
| [Architecture](docs/architecture.md) | System design, two-call pipeline, data flows, authentication |
| [AI Pipeline](docs/ai-pipeline.md) | Classification, response generation, routing, playbooks, shadow mode |
| [Shopify Sync](docs/shopify-sync.md) | Webhook handling, periodic sync, contact matching logic |
| [API Reference](docs/api-reference.md) | All endpoints, authentication, webhook payloads |
| [Setup & Deployment](docs/setup.md) | Environment variables, Chatwoot/Shopify config, deployment |
| [Project Structure](docs/project-structure.md) | File-by-file guide to the codebase |

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
2. **AI support pipeline** — Three-call Claude architecture: classifies intent, auto-responds to easy queries (order status, subscriptions), or silently hands off with a draft reply suggestion for the agent.
3. **Handoff drafts** — On every human escalation, the AI also posts a suggested reply as a private note, which the agent can copy/edit/send.
4. **Shadow mode** — Run the full AI pipeline as private notes only, so agents can validate before going live.
5. **Bulk draft tool** — One-off script (`npm run bulk-draft`) to generate draft replies for every open conversation with a customer message waiting — useful for catching up on backlog.

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
| [Architecture](docs/architecture.md) | System design, pipeline flow, data flows, authentication |
| [AI Pipeline](docs/ai-pipeline.md) | Classification, response generation, routing, playbooks, handoff drafts, shadow mode |
| [Scripts](docs/scripts.md) | Bulk draft generator and other CLI tools |
| [Shopify Sync](docs/shopify-sync.md) | Webhook handling, periodic sync, contact matching logic |
| [API Reference](docs/api-reference.md) | All endpoints, authentication, webhook payloads |
| [Setup & Deployment](docs/setup.md) | Environment variables, Chatwoot/Shopify config, deployment |
| [Project Structure](docs/project-structure.md) | File-by-file guide to the codebase |

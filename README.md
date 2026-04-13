# Scandi Chatwoot Integration

A Node.js/TypeScript server that bridges Shopify, Chatwoot, and Claude AI to give support agents instant customer context and AI-drafted replies.

```
                 ┌──────────────┐
                 │   Shopify    │
                 └──────┬───────┘
        webhooks (HMAC) │          periodic sync
                        ▼               │
┌────────────┐   ┌─────────────┐        │    ┌──────────┐
│  Chatwoot   │──▶│   Express   │◀───────┘    │  Claude  │
│  (webhook)  │   │   Server    │────────────▶│   AI     │
└────────────┘   └──────┬──────┘              └──────────┘
                        │
              ┌─────────┼─────────┐
              ▼         ▼         ▼
         Chatwoot    17track   Chatwoot
         (contacts)  (tracking) (notes)
```

**Three things happen:**

1. **Shopify → Chatwoot sync** — Customer and order data flows into Chatwoot contacts via real-time webhooks and a periodic background sync.
2. **Tracking registration** — When orders are fulfilled, tracking numbers are registered with 17track for status lookups.
3. **AI draft replies** — When a customer sends a message in Chatwoot, the server gathers their full context (orders, tracking, conversation history) and asks Claude to draft a reply, posted as a private note for agents to review.

## Quick Start

```bash
cp .env.example .env     # fill in all required values
npm install
npm run dev              # starts with hot-reload via tsx
```

## Documentation

| Document | What it covers |
|----------|---------------|
| [Architecture](docs/architecture.md) | System design, data flow diagrams, how services connect |
| [AI Draft System](docs/ai-draft.md) | Claude integration, prompt building, context assembly |
| [Shopify Sync](docs/shopify-sync.md) | Webhook handling, periodic sync, contact matching logic |
| [API Reference](docs/api-reference.md) | All endpoints, authentication, webhook payloads |
| [Setup & Deployment](docs/setup.md) | Environment variables, Chatwoot config, Shopify webhooks, DigitalOcean |
| [Project Structure](docs/project-structure.md) | File-by-file guide to the codebase |

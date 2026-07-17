# Scandi ↔ Chatwoot: Sync + AI Support Platform

A Node.js/TypeScript (Express) service that connects a Shopify store to a Chatwoot support desk and layers Claude-powered AI on top. It:

1. **Syncs Shopify customer + order data into Chatwoot** — agents see order history, tracking, subscriptions, and lifetime value on each contact.
2. **Generates AI draft replies** as private notes on every incoming customer message (with live order/tracking context and image understanding).
3. **Runs an autonomous AgentBot** that classifies + labels conversations, auto-responds to the cases it can safely handle, and escalates the rest to a human.
4. **Serves a Customer 360 Dashboard App** embedded in Chatwoot.
5. **Serves an Admin Control Dashboard** (standalone, Firebase-Auth gated) to manage AI prompts/models/settings and test prompt changes.

It runs as a single DigitalOcean app and uses Shopify, Chatwoot, Anthropic, 17track, Skio, and (optionally) Firestore.

## Documentation

| Doc | What's inside |
|-----|---------------|
| [docs/architecture.md](docs/architecture.md) | High-level design, request routing, external services, project layout |
| [docs/syncing.md](docs/syncing.md) | Shopify → Chatwoot sync, contact matching, incremental sync watermark |
| [docs/ai-drafts.md](docs/ai-drafts.md) | AI draft pipeline, three-field output, image understanding, unmatched matching |
| [docs/agent-bot.md](docs/agent-bot.md) | Autonomous responder, classification, routing/escalation, backfill |
| [docs/dashboard-app.md](docs/dashboard-app.md) | Customer 360 embedded dashboard |
| [docs/admin-dashboard.md](docs/admin-dashboard.md) | Admin Control Dashboard: config management, prompt tester, auth |
| [docs/caching-and-storage.md](docs/caching-and-storage.md) | Firestore caches, idempotency, collections, audit logs |
| [docs/configuration.md](docs/configuration.md) | Environment variables + AI prompt/model/behaviour config |
| [docs/deployment.md](docs/deployment.md) | Service setup + DigitalOcean deployment + verification checklist |

## Quick start

```bash
cp .env.example .env      # fill in values — see docs/configuration.md
npm install
npm run dev               # server in tsx watch mode
```

Build everything (both SPAs + server) and run production:

```bash
npm run build && npm start
```

See [docs/deployment.md](docs/deployment.md) for the full setup and deployment guide.

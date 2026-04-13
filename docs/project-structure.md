# Project Structure

```
src/
├── config/
│   ├── env.ts                    # Environment config
│   └── systemPrompt.txt          # Default Claude system prompt
├── middleware/
│   ├── verifyShopifyWebhook.ts   # HMAC verification
│   ├── syncAuth.ts               # Bearer token auth
│   └── errorHandler.ts           # Global error handler
├── routes/
│   ├── webhooks.ts               # Shopify webhook handlers
│   ├── sync.ts                   # Manual sync trigger
│   └── chatwootWebhook.ts        # Chatwoot webhook → AI draft
├── services/
│   ├── shopifyAuth.ts            # OAuth token management
│   ├── shopify.ts                # Shopify REST API client
│   ├── chatwoot.ts               # Chatwoot API client (contacts)
│   ├── chatwootConversation.ts   # Chatwoot API client (conversations)
│   ├── sync.ts                   # Full sync logic and scheduler
│   ├── tracking.ts               # 17track API client
│   ├── claude.ts                 # Anthropic SDK wrapper
│   └── aiDraft.ts                # AI draft orchestrator
├── types/
│   ├── index.ts                  # Shopify + Chatwoot contact types
│   ├── chatwoot.ts               # Chatwoot webhook + REST API types
│   └── tracking.ts               # 17track API types
├── utils/
│   ├── formatters.ts             # Data formatting utilities
│   ├── promptBuilder.ts          # Claude prompt assembly
│   └── logger.ts                 # Structured console logger
├── app.ts                        # Express app setup and routing
└── server.ts                     # Entry point
```

## File Details

### Entry Points

**`src/server.ts`** — Starts the Express server, kicks off the periodic sync scheduler, handles graceful shutdown on SIGTERM/SIGINT.

**`src/app.ts`** — Configures Express middleware and mounts route groups. Key detail: `/webhooks` uses `express.raw()` for HMAC verification, `/chatwoot` uses `express.json({ limit: '5mb' })` for large webhook payloads, and everything else uses standard `express.json()`.

### Config

**`src/config/env.ts`** — Validates required environment variables at startup (throws if missing), exports a typed `env` object. Loads the system prompt from file or env var.

**`src/config/systemPrompt.txt`** — Default Claude system prompt defining the "Andrew" persona, brand context, and behavioral rules. Loaded at startup by `env.ts`. Can be overridden entirely via `CLAUDE_SYSTEM_PROMPT` env var.

### Middleware

**`src/middleware/verifyShopifyWebhook.ts`** — Computes HMAC-SHA256 of the raw request body using the Shopify client secret and compares it (timing-safe) against the `X-Shopify-Hmac-Sha256` header. Rejects requests that don't match.

**`src/middleware/syncAuth.ts`** — Checks `Authorization: Bearer <token>` against `SYNC_API_KEY`. Passes through with a warning if the key isn't configured.

**`src/middleware/errorHandler.ts`** — Catches unhandled errors, logs them, returns 500 JSON.

### Routes

**`src/routes/webhooks.ts`** — Handles Shopify customer and order webhooks. Parses the raw Buffer body, syncs the customer to Chatwoot, and registers tracking numbers with 17track on order events.

**`src/routes/sync.ts`** — Single endpoint `POST /customers` that triggers a full background sync. Returns 409 if already running, 202 otherwise.

**`src/routes/chatwootWebhook.ts`** — Receives Chatwoot `message_created` webhooks. Responds 200 immediately, then filters for incoming customer messages and delegates to the AI draft pipeline.

### Services

**`src/services/shopifyAuth.ts`** — Manages OAuth2 client_credentials tokens for the Shopify Admin API. Caches the token in memory and refreshes it 1 hour before expiry.

**`src/services/shopify.ts`** — Shopify REST API client built on Axios. Handles cursor-based pagination (Link header parsing), 429 retries, and provides functions to fetch orders, customers, and search by email. Uses API version `2026-01`.

**`src/services/chatwoot.ts`** — Chatwoot REST API client for contact operations. Includes a 429 retry interceptor with exponential backoff. Exports the core `upsertContact` function with the multi-step matching logic (identifier → email → create → 422 retry). Also exports `chatwootClient` for use by `chatwootConversation.ts`.

**`src/services/chatwootConversation.ts`** — Chatwoot REST API functions for conversation data: fetching messages, conversation details, contact conversations, and posting private notes. Uses the shared `chatwootClient` from `chatwoot.ts`.

**`src/services/sync.ts`** — Full sync logic: paginates all Shopify customers, skips those already populated in Chatwoot, upserts the rest. Includes the periodic scheduler (`setInterval` + initial `setTimeout`).

**`src/services/tracking.ts`** — 17track API client. Registers tracking numbers and fetches their status. If a number isn't registered yet, it auto-registers, waits 3 seconds, and retries the status fetch.

**`src/services/claude.ts`** — Thin wrapper around the Anthropic SDK. Takes a system prompt and user prompt, calls `messages.create`, returns the first text block content or null. Logs token usage.

**`src/services/aiDraft.ts`** — The AI draft orchestrator. Coordinates all 5 phases: fetch Chatwoot context, look up Shopify customer, get tracking status, build the prompt, call Claude, and post the result as a private note.

### Types

**`src/types/index.ts`** — TypeScript interfaces for Shopify entities (Customer, Order, Address, Fulfillment, LineItem) and Chatwoot contact types (Contact, ContactPayload, CustomAttributes, SearchResponse).

**`src/types/chatwoot.ts`** — Two sets of types: webhook payload types (string message_type, ISO dates) and REST API types (integer message_type, Unix timestamps). Also includes conversation, message, and contact meta types.

**`src/types/tracking.ts`** — 17track API response shapes: TrackInfo, TrackEvent, TrackProvider, accepted/rejected items, and the simplified TrackingSummary used internally.

### Utils

**`src/utils/formatters.ts`** — Data formatting: E.164 phone normalization, subscription order counting (by tag), address formatting, order line summaries, and `buildCustomAttributes` which assembles the full set of Chatwoot custom attributes from a customer and their orders.

**`src/utils/promptBuilder.ts`** — Assembles the Claude user prompt from all available context. Builds sections for: current date, customer info, order history with line items, tracking status with event timelines, current conversation thread, and up to 5 previous conversations.

**`src/utils/logger.ts`** — Structured console logger with ISO timestamps. Supports `info`, `warn`, `error`, and `debug` (debug only logs when `DEBUG` env var is set).

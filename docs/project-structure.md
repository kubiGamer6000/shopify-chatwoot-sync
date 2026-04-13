# Project Structure

```
src/
├── config/
│   ├── env.ts                    # Environment config and validation
│   ├── templates.ts              # Handoff template messages per intent
│   └── prompts/
│       ├── classifier.txt        # Classifier system prompt (intent definitions)
│       └── responder.txt         # Responder system prompt (playbooks)
├── middleware/
│   ├── verifyShopifyWebhook.ts   # HMAC verification
│   ├── syncAuth.ts               # Bearer token auth
│   └── errorHandler.ts           # Global error handler
├── routes/
│   ├── webhooks.ts               # Shopify webhook handlers
│   ├── sync.ts                   # Manual sync trigger
│   └── chatwootWebhook.ts        # Chatwoot webhook → AI pipeline
├── services/
│   ├── shopifyAuth.ts            # OAuth token management
│   ├── shopify.ts                # Shopify REST API client
│   ├── chatwoot.ts               # Chatwoot API client (contacts)
│   ├── chatwootConversation.ts   # Chatwoot API client (conversations, messages, labels, status)
│   ├── sync.ts                   # Full sync logic and scheduler
│   ├── tracking.ts               # 17track API client
│   ├── claude.ts                 # Claude structured output call
│   ├── classifier.ts             # Call 1: intent classification
│   ├── responder.ts              # Call 2: response generation
│   ├── pipeline.ts               # Main AI orchestrator
│   └── hardRules.ts              # Pre-AI rule checks
├── types/
│   ├── index.ts                  # Shopify + Chatwoot contact types
│   ├── chatwoot.ts               # Chatwoot webhook + REST API types
│   ├── tracking.ts               # 17track API types
│   └── ai.ts                     # Classification + Response Zod schemas
├── utils/
│   ├── formatters.ts             # Data formatting utilities
│   ├── promptBuilder.ts          # Context assembly for classifier and responder
│   └── logger.ts                 # Structured console logger
├── app.ts                        # Express app setup and routing
└── server.ts                     # Entry point
```

## File Details

### Entry Points

**`src/server.ts`** — Starts the Express server, kicks off the periodic sync scheduler, handles graceful shutdown on SIGTERM/SIGINT.

**`src/app.ts`** — Configures Express middleware and mounts route groups. `/webhooks` uses `express.raw()` for HMAC verification, `/chatwoot` uses `express.json({ limit: '5mb' })` for large webhook payloads.

### Config

**`src/config/env.ts`** — Validates required environment variables at startup, exports a typed `env` object. Key additions: `AI_MODE` (shadow/live/off), `chatwootBotToken`, `classifierPrompt`, `responderPrompt`.

**`src/config/templates.ts`** — Handoff template messages keyed by intent. Also maps intents to Chatwoot topic labels. No AI generation needed for these — they're static templates.

**`src/config/prompts/classifier.txt`** — System prompt for the classification call. Defines all 9 intents with descriptions and examples, confidence scoring rules, and the `other` label hard rule.

**`src/config/prompts/responder.txt`** — System prompt for the response generation call. Contains the "Andrew" persona, brand voice rules, and playbooks for order_status, subscription_cancel, and subscription_change.

### Services (AI Pipeline)

**`src/services/pipeline.ts`** — The main orchestrator. Handles the full lifecycle: hard rules check → context fetch → classify → route → respond/handoff → post results. Branches on `AI_MODE` at the action stage — shadow mode posts a combined private note, live mode sends real replies. Includes the in-memory turn counter.

**`src/services/classifier.ts`** — Assembles the classifier prompt with conversation context and calls Claude via structured output. Returns a typed `Classification` object.

**`src/services/responder.ts`** — Assembles the responder prompt with full context (including classifier output) and calls Claude via structured output. Returns a typed `AiResponse` object with both customer reply and private note.

**`src/services/claude.ts`** — Generic `structuredCall<T>()` function. Takes a system prompt, user prompt, and Zod schema, calls Claude with `output_config.format` using the SDK's `zodOutputFormat` helper. Validates the response against the schema before returning.

**`src/services/hardRules.ts`** — Pre-AI code checks. Currently checks for unfulfilled orders older than 14 days, which trigger immediate human handoff without any AI call.

### Services (Shopify + Chatwoot)

**`src/services/shopifyAuth.ts`** — OAuth2 client_credentials token management. Cached in memory, refreshed 1 hour before expiry.

**`src/services/shopify.ts`** — Shopify REST API client. Handles cursor-based pagination, 429 retries. API version `2026-01`.

**`src/services/chatwoot.ts`** — Chatwoot REST API client for contact operations (filter, create, update, upsert). Includes 429 retry interceptor.

**`src/services/chatwootConversation.ts`** — Chatwoot conversation operations: fetch messages, conversation details, contact conversations, post private notes, send outgoing messages, toggle status, and apply labels.

**`src/services/sync.ts`** — Full customer sync: paginates all Shopify customers, skips those already populated, upserts the rest. Periodic scheduler.

**`src/services/tracking.ts`** — 17track API client. Register and fetch tracking status, with auto-register-and-retry for unregistered numbers.

### Types

**`src/types/ai.ts`** — Zod schemas for `ClassificationSchema` and `ResponseSchema`, plus derived TypeScript types. Also defines intent constants, AI-solvable vs. handoff intent sets, and pipeline thresholds.

**`src/types/index.ts`** — Shopify entities and Chatwoot contact types.

**`src/types/chatwoot.ts`** — Chatwoot webhook payload types (handles both regular webhooks and Agent Bot events) and REST API types.

**`src/types/tracking.ts`** — 17track API response shapes.

### Utils

**`src/utils/promptBuilder.ts`** — Builds context strings for the classifier and responder. `buildClassifierContext()` provides a lighter context (customer info, orders, current conversation). `buildResponderContext()` adds classification result, tracking data, and previous conversations.

**`src/utils/formatters.ts`** — Data formatting: E.164 phone normalization, subscription counting, address formatting, order summaries, `buildCustomAttributes` for Chatwoot sync.

**`src/utils/logger.ts`** — Structured console logger with ISO timestamps. Debug level gated by `DEBUG` env var.

### Routes

**`src/routes/chatwootWebhook.ts`** — Receives Chatwoot webhooks (both regular and Agent Bot). Filters to incoming customer messages, delegates to `pipeline.ts`. Responds 200 immediately, processing is async.

**`src/routes/webhooks.ts`** — Shopify customer and order webhooks. Syncs customer to Chatwoot, registers tracking numbers with 17track.

**`src/routes/sync.ts`** — Manual full sync trigger. Returns 409 if already running.

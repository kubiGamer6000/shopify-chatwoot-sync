# Caching & Storage (Firestore)

All persistent state lives in Google Cloud Firestore. It is **optional**: [`src/services/firestore.ts`](../src/services/firestore.ts) lazily initializes `firebase-admin` from the base64 service account in `FIREBASE_BASE64_SERVICE_ACCOUNT` and returns `null` if it's missing/invalid. Every caller checks for `null` and degrades gracefully (caches fall through to the live source; audit writes become no-ops) — the server never crashes when Firestore is absent.

`db.settings({ ignoreUndefinedProperties: true })` is set so cached payloads with optional `undefined` fields write cleanly.

## Generic cache helper ([`src/services/cache.ts`](../src/services/cache.ts))

A single `cache` collection backs all TTL and idempotency data. Doc id scheme: `{namespace}::{encodeURIComponent(key)}`.

| Function | Behaviour |
|----------|-----------|
| `cached(ns, key, ttlMs, producer)` | Read-through: return a fresh entry if present/unexpired, else run `producer`, best-effort store, return value. Falls back to `producer` when Firestore is null or a read fails. Producer errors are not cached. |
| `cacheGet(ns, key)` | Returns the value or `undefined` (miss/expired/disabled). |
| `cacheSet(ns, key, value, ttlMs?)` | Best-effort write. |
| `cacheDelete(ns, key)` | Explicit invalidation. |
| `claimOnce(ns, key, ttlMs)` | Idempotency: `true` the first time, `false` on a duplicate within the TTL. Fail-open (`true`) when Firestore is unavailable. |

### Cache namespaces

| Namespace | Key | TTL | Purpose |
|-----------|-----|-----|---------|
| `syncState` | `customers` | none | Incremental sync watermark + resume cursor ([syncing.md](syncing.md)) |
| `shopifyOrders` | customer id | 10 min | Cached orders |
| `shopifyCustomer` | customer id | 10 min | Cached customer |
| `shopifyCustomerByEmail` | lowercased email | 10 min | Cached email lookup |
| `skioSubs` | lowercased email | 5 min | Cached subscriptions |
| `tracking` | tracking number | 1h–30d (state-based) | 17track summaries |
| `shopifyMatchNeg` | `contactId:sha1(message)` | 12h | Negative Shopify-match cache ([ai-drafts.md](ai-drafts.md#unmatched-contact-matching)) |
| `wh-shopify` | Shopify webhook id | 24h | Webhook idempotency |
| `wh-draft` | Chatwoot message id | 24h | Draft webhook idempotency |
| `wh-agentbot` | Chatwoot message id | 24h | AgentBot webhook idempotency |

### Cache invalidation

Shopify webhooks call `invalidateCustomerCache` (orders + customer + email) and Skio subscription cancellation calls `invalidateSubscriptionsCache`, so a mutation is reflected immediately rather than after the TTL.

### Webhook idempotency

Shopify (`X-Shopify-Webhook-Id`) and Chatwoot (message id) deliveries are de-duplicated with `claimOnce`, so a redelivered webhook doesn't double-generate drafts or double-run the AgentBot.

## Authoritative collections

| Collection | Doc id | Written by | Shape |
|------------|--------|-----------|-------|
| `customerSummaries` | contact id | `customerSummary.ts` | `{ contactId, email, shopifyCustomerId, conversationId, overview, history[], model, generatedAt }` |
| `aiDrafts` | conversation id | `draftStore.ts` | `AiDraft` (latest) |
| `aiDrafts/{id}/versions` | auto | `draftStore.ts` | `{ ...AiDraft, recordedAt }` — full draft history |
| `systemConfig` (doc `ai`) | `ai` | `appConfig.ts` | AI config overrides ([admin-dashboard.md](admin-dashboard.md)) |
| `systemConfig/ai/versions` | auto | `appConfig.ts` | Config change history (`updatedBy`, `recordedAt`) |
| `users` | Firebase uid | `users.ts` | `{ email, displayName, role, approvedBy, createdAt }` ([admin-dashboard.md](admin-dashboard.md)) |

`AiDraft` = `{ conversationId, contactId, response, noteToAgent, customerMessageTranslation, model, generatedAt, source: 'auto'|'manual' }`.

## Audit / observability logs ([`src/services/aiAudit.ts`](../src/services/aiAudit.ts))

Best-effort, fire-and-forget writes (never throw):

| Collection | Doc id | Purpose |
|------------|--------|---------|
| `aiUsage` | auto | Per-call token usage: `{ kind, model, inputTokens, outputTokens, conversationId?, contactId?, at, ts }`. `kind` ∈ draft, draft-manual, structured, completion, summary, classify, responder, resolver, holding, … |
| `classifications` | conversation id | Latest classifier decision `{ labels, reasoning, model }` |
| `agentBotDecisions` | conversation id | Latest routing decision `{ classified, routingLabels, action }` (dry-run `would-*` outcomes are not recorded) |
| `sentReplies` | auto | Replies actually sent from the dashboard `{ conversationId, message, source }` |
| `responderGuardEvents` | auto | Every time the AgentBot [reply safety guard](agent-bot.md#reply-safety-guard) intervened `{ conversationId, outcome, source, violations, blockedText? }`. `outcome` ∈ blocked, preamble-stripped, missing-send-reply-tool, holding-fallback |

These power future reporting (e.g. the planned AI Usage Reports in the [Admin Control Dashboard](admin-dashboard.md)).

## Setup

Provide a Firebase service account with Firestore access, base64-encode the JSON, and set it as `FIREBASE_BASE64_SERVICE_ACCOUNT`:

```bash
base64 -w0 service-account.json   # Linux
```

No client-side Firestore security rules are needed: the browser never talks to Firestore directly (all reads/writes go through the server APIs). Firebase Auth is used only for admin sign-in ([admin-dashboard.md](admin-dashboard.md)).

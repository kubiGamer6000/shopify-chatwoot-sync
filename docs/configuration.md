# Configuration

## Environment variables

Validated/typed in [`src/config/env.ts`](../src/config/env.ts).

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPIFY_STORE_DOMAIN` | Yes | Your `.myshopify.com` domain |
| `SHOPIFY_CLIENT_ID` | Yes | App client ID |
| `SHOPIFY_CLIENT_SECRET` | Yes | App client secret (also webhook HMAC key) |
| `CHATWOOT_BASE_URL` | Yes | Chatwoot instance URL |
| `CHATWOOT_API_TOKEN` | Yes | Chatwoot API access token |
| `CHATWOOT_ACCOUNT_ID` | Yes | Chatwoot account ID |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `SEVENTEENTRACK_API_KEY` | Yes | 17track API key |
| `SKIO_API_KEY` | Yes | Skio API key |
| `FIREBASE_BASE64_SERVICE_ACCOUNT` | No | Base64 Firebase service-account JSON. Enables Firestore (caching, summaries, drafts, audit, admin config/users). If unset, the server degrades gracefully |
| `CHATWOOT_INBOX_ID` | No | Inbox ID for new contact creation |
| `SYNC_API_KEY` | No | Bearer token protecting `/sync` |
| `SYNC_INTERVAL_HOURS` | No | Periodic sync interval (default `0` = disabled) |
| `PORT` | No | Server port (default `8080`) |
| `CLAUDE_SYSTEM_PROMPT` | No | Override for the draft system prompt. Falls back to `src/config/systemPrompt.txt` |
| `CLAUDE_MODEL` | No | Model for drafts + responder agent (default `claude-sonnet-4-20250514`) |
| `CLAUDE_CLASSIFIER_MODEL` | No | Cheaper model for classifier + holding replies (default `claude-haiku-4-5`) |
| `CLAUDE_RESPONDER_PROMPT` | No | Override for the AgentBot responder prompt. Falls back to `src/config/responderPrompt.txt` |
| `CHATWOOT_WEBHOOK_SECRET` | No | If set, the draft webhook URL must include `?secret=<value>` |
| `CHATWOOT_AGENT_BOT_SECRET` | No | If set, the AgentBot webhook URL must include `?secret=<value>` |
| `AGENT_BOT_HOLDING_REPLY` | No | `true`/`false` (default `true`). When `false`, escalations send no holding reply |
| `DASHBOARD_APP_TOKEN` | No | Gates `/app` and `/app/api/*` |
| `ADMIN_BOOTSTRAP_EMAILS` | No | Comma-separated Google account emails that are always admins in the [Admin Dashboard](admin-dashboard.md) (bootstrap) |
| `DEBUG` | No | If truthy, posts the full Claude prompt as an extra private note (dev only) |

### Admin dashboard build-time vars (`admin-web/`)

The Firebase Web config is public (safe to bake into the bundle). Set as build-time env for the `admin-web/` build:

`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`.

## AI prompts, models & behaviour

Two layers, evaluated in order (see [admin-dashboard.md](admin-dashboard.md)):

1. **Firestore overrides** (`systemConfig/ai`) — live-editable from the Admin Control Dashboard. Applied within ~30s (short in-memory cache) or immediately on save.
2. **Defaults** — the env vars / prompt files / hardcoded constants above. Used for any field not overridden, or whenever Firestore is unavailable.

This means you can change any system prompt, per-task model, the auto-respond/escalate routing labels, the holding-reply toggle, and numeric knobs (max tokens / iterations) without a redeploy, while a missing/broken override always falls back to the shipped default.

Prompt/model surface managed this way:

| Task | Default prompt | Default model |
|------|----------------|---------------|
| Draft generator | `systemPrompt.txt` / `CLAUDE_SYSTEM_PROMPT` | `CLAUDE_MODEL` |
| AgentBot responder | `responderPrompt.txt` / `CLAUDE_RESPONDER_PROMPT` | `CLAUDE_MODEL` |
| Classifier | hardcoded in `classifier.ts` | `CLAUDE_CLASSIFIER_MODEL` |
| Customer summary | hardcoded in `customerSummary.ts` | `claude-haiku-4-5` |
| Shopify matcher | hardcoded in `customerResolver.ts` (template) | `CLAUDE_MODEL` |
| Holding reply | hardcoded in `aiResponder.ts` | `CLAUDE_CLASSIFIER_MODEL` |

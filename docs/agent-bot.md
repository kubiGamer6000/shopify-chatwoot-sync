# AI AgentBot Responder

An autonomous Chatwoot AgentBot that takes first ownership of conversations: it classifies + labels them, **auto-responds** to the cases it can safely handle (subscription cancellation, order status), and **escalates everything else to a human**. Enabled by attaching the bot to an inbox; disabled by detaching it. Orchestration: [`src/services/aiResponder.ts`](../src/services/aiResponder.ts).

## Two webhooks, routed by status

Both webhooks receive every `message_created` event but act on disjoint statuses so they never double-handle a message:

| Webhook | Endpoint | Handles | Behaviour |
|---------|----------|---------|-----------|
| AgentBot | `POST /chatwoot/agent-bot` | `pending` (AI-owned) | classify → auto-respond or escalate |
| Draft | `POST /chatwoot` | `open` (human-owned) | AI draft as a private note ([ai-drafts.md](ai-drafts.md)) |

When the AgentBot is attached, new/reopened conversations start in `pending`. Both routes ack `200` immediately and do all LLM work asynchronously (Chatwoot flips to `open` if a bot webhook takes >~5s).

## Classification ([`src/services/classifier.ts`](../src/services/classifier.ts))

Every inbound message is classified by a cheap model (default `claude-haiku-4-5`) using structured output. It assigns one or more **classification labels**:

`business`, `change-address`, `change-contact`, `sub-cancel`, `refund`, `discount-issue`, `missing-packs`, `no-country`, `not-delivered`, `order-status`, `product-defect`, `other`.

Labels are **add-only** (read current → union → write). **Action labels** (`refund-30/50/70/full`, `reshipped`, `changed-address`, `sub-cancelled`, `sub-cancelled-ai`, `ai-response`) are reserved for agents/tools and never AI-assignable. Classification decisions are recorded to Firestore for observability ([caching-and-storage.md](caching-and-storage.md)).

## Routing & escalation

For a `pending` conversation the AgentBot:

1. Builds full context and runs the same Shopify [matcher](ai-drafts.md#unmatched-contact-matching).
2. Classifies + merges labels.
3. **Hard-escalates** (no responder call) if classification fails, or if any merged label falls outside the auto-respond set `{ sub-cancel, order-status, other }`. **Refund always escalates.**
4. Otherwise runs the **responder agent** (Sonnet, Anthropic Tool Runner) with the prompt in [`src/config/responderPrompt.txt`](../src/config/responderPrompt.txt). Its replies go **directly to the customer** (after the [safety guard](#reply-safety-guard)), then the conversation is **resolved**.

> The auto-respond label sets and the holding-reply toggle are live-editable from the [Admin Control Dashboard](admin-dashboard.md); defaults fall back to the values above.

### Responder tools

- **`send_reply(message)`** — always available. The only sanctioned way to answer a customer: `message` carries the reply body, and everything else the agent writes is discarded. The message is sent after the tool loop finishes, so a run can never produce two outbound messages.
- **`escalate_to_human(reason, holding_reply)`** — always available. Sends a short, context-aware holding reply, sets the conversation `open`, and triggers an escalation draft for the human.
- **`cancel_subscription()`** — injected only when `sub-cancel` is present. Cancels the customer's active Skio subscription(s) by their linked email and adds `sub-cancelled-ai`. Used only when the customer insists we cancel for them.

### Reply safety guard

Because responder replies reach the customer with no human review, every model-authored message is vetted by [`src/utils/responderFormat.ts`](../src/utils/responderFormat.ts) before it is sent. Prompt rules alone are not enough: in conversation #7775 the agent narrated its reasoning ("order status is Case 2… so I send the self-service link only") above an otherwise correct reply, and the whole thing was delivered.

The guard is deterministic and applies to the responder reply, the agent's `holding_reply`, and the hard-escalation holding reply:

1. **Preamble strip** — if internal commentary appears before a real greeting line, everything above the greeting is dropped.
2. **Marker scan** — what remains must be free of reasoning, playbook references (`Case 1`, `Step 2`), pipeline vocabulary (label/tool names, "escalate"), agent notes, prompt scaffolding (`--- ORDER HISTORY ---`), and AI self-disclosure.
3. **Fail closed** — a reply that still trips a marker is **never sent**: the conversation is hard-escalated to a human instead. A rejected *holding* reply is swapped for the fixed fallback (it is already being handed off).

The guard is intentionally broad, since a false positive costs one escalation while a false negative is a leak. Every intervention is logged and recorded to `responderGuardEvents` ([caching-and-storage.md](caching-and-storage.md)) — a rising count there means the responder prompt is drifting.

```bash
npx tsx src/scripts/verifyResponderGuard.ts   # replays the #7775 leak + regression cases (no credentials)
```

The [prompt tester](admin-dashboard.md) shows the guard verdict alongside the exact text that would be sent.

### Contextual holding reply

Controlled by `AGENT_BOT_HOLDING_REPLY` (default `true`):

- **`true`** — a brief, lightly-tailored holding reply is sent on escalation (tool escalations: the agent writes it; hard-filter escalations: a small Haiku call crafts it, with a fixed fallback).
- **`false`** — nothing is sent on escalation; the bot silently hands off and generates the human draft.

Whenever the bot escalates, it calls the draft generator with an `escalationContext` flag (adds a `--- JUST ESCALATED ---` block) so the human gets a ready next reply.

## One-time backfill

For a backlog of `open` conversations from before the AgentBot existed:

```bash
npm run backfill -- --test --dry-run   # preview the latest 10 (no changes)
npm run backfill -- --test             # process the latest 10 for real
npm run backfill -- --limit=50         # process the latest 50 for real
npm run backfill                       # process ALL open (prompts to confirm)
npm run backfill -- --yes              # process ALL open, skip confirmation
```

Backfill is stricter: it only auto-responds to conversations whose labels are a non-empty subset of `{sub-cancel, order-status}` (excludes `other`), and it **never escalates or drafts** — everything else is skipped and left untouched. Only `open` conversations are touched.

## Manual Chatwoot setup

1. Create the `sub-cancelled-ai` and `ai-response` labels (and, for filtering, the classification labels).
2. **Settings → Bots → Add Agent Bot** with Outgoing URL `https://<domain>/chatwoot/agent-bot?secret=<CHATWOOT_AGENT_BOT_SECRET>` (omit `?secret=` if unset).
3. Connect the bot to your support inbox.
4. Keep the existing `message_created` webhook (`/chatwoot`) connected — it still drafts for `open` conversations.

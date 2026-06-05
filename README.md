# Scandi → Chatwoot Customer Sync + AI Draft Replies

A Node.js/TypeScript server that:

1. **Syncs Shopify customer and order data into Chatwoot**, giving support agents instant visibility into a customer's order history, tracking info, subscription status, and more.
2. **Generates AI draft replies** using Claude whenever a customer messages support — drafts are posted as **private notes** in the Chatwoot conversation so agents can review/edit them before sending.
3. **Serves a Chatwoot Dashboard App** (a "Customer 360" view) — an embedded React app that shows the customer's Shopify orders and live delivery status alongside their Skio subscriptions, and lets agents cancel a subscription in one click. See [Dashboard App (Customer 360)](#dashboard-app-customer-360).

## How It Works

```
                                   ┌────────────────────┐
Shopify ──webhooks──▶ Express ────▶│  Chatwoot Contact  │
                          │        │  (synced fields)   │
                  Periodic sync    └────────────────────┘
                  (fills gaps)              ▲
                                            │ private note
Customer message ──▶ Chatwoot ─webhook─▶ Express ─▶ Claude
                                            ▲
                                            │ context: orders,
                                            │ tracking, history
                                       Shopify + 17track
```

Three independent flows run side-by-side:

1. **Real-time Shopify webhooks** — Shopify sends events (customer created/updated, order created/updated/fulfilled) to the server, which immediately updates the corresponding Chatwoot contact and registers any new tracking numbers with 17track.
2. **Periodic background sync** — A configurable timer walks through all Shopify customers, finds anyone not yet in Chatwoot (or missing Shopify data), and creates/populates them. Already-synced contacts are skipped to keep it lightweight.
3. **AI draft replies** — When a customer sends a new message, Chatwoot fires a webhook to the server. The server gathers full context (Shopify orders, live shipping status from 17track, previous conversations) and asks Claude to draft a reply, which is posted to the conversation as a **private note** for the human agent to review.

---

## Authentication

### Shopify

OAuth2 client credentials are used to obtain short-lived access tokens from the Shopify Admin API. Tokens are cached in memory and refreshed automatically 1 hour before expiry (they last ~24h). Every outgoing Shopify request goes through an Axios interceptor that injects a fresh token.

The **client secret** also serves as the HMAC signing key for verifying incoming Shopify webhook requests.

### Chatwoot

A static `api_access_token` is used for all outgoing Chatwoot API calls. Rate limiting (429) is handled automatically with exponential backoff and retry.

For incoming Chatwoot webhooks (the AI draft trigger), an optional shared secret is checked via the `?secret=` query parameter on the webhook URL — see [AI Draft Auto-Reply](#ai-draft-auto-reply) below.

### Anthropic (Claude)

A standard `ANTHROPIC_API_KEY` is used to call the Claude Messages API.

### 17track

A `17token` API key is sent on every request to `https://api.17track.net/track/v2.2`. New tracking numbers are auto-registered the first time the AI draft flow encounters them (with a 3s wait before re-querying for status).

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`  | `/health` | None | Health check (returns `{ status: "ok" }`) |
| `POST` | `/webhooks/customers` | HMAC | Shopify `customers/create` and `customers/update` events |
| `POST` | `/webhooks/orders` | HMAC | Shopify `orders/create`, `orders/updated`, `orders/fulfilled`, `orders/partially_fulfilled` events |
| `POST` | `/sync/customers` | Bearer token | Triggers a manual full sync of all Shopify customers |
| `POST` | `/chatwoot` | Optional `?secret=` | Chatwoot webhook → AI draft generation for **open** conversations (+ label classification) |
| `POST` | `/chatwoot/agent-bot` | Optional `?secret=` | Chatwoot **AgentBot** webhook → autonomous responder for **pending** conversations |
| `GET`  | `/app` | None (static) | Serves the embedded Dashboard App SPA (Customer 360) |
| `GET`  | `/app/api/customer` | `x-app-token` | Aggregated customer profile (Shopify orders + Skio subscriptions + stored AI summary) |
| `POST` | `/app/api/subscriptions/:id/cancel` | `x-app-token` | Cancels a Skio subscription |
| `GET`  | `/app/api/summary` | `x-app-token` | Reads the stored AI customer summary (`?contactId=`) |
| `POST` | `/app/api/summary/refresh` | `x-app-token` | Regenerates the AI customer summary on demand |
| `GET`  | `/app/api/draft` | `x-app-token` | Reads the latest stored AI draft (`?conversationId=`) |
| `POST` | `/app/api/draft/generate` | `x-app-token` | Generates/regenerates a reply (instruction or correction) |
| `POST` | `/app/api/draft/send` | `x-app-token` | Sends a reply to the customer and resolves the conversation (`resolve` defaults to true) |

---

## What Gets Synced (Shopify → Chatwoot)

When a customer is synced (via webhook or bulk sync), the server:

1. Fetches all of the customer's orders from Shopify (paginated, all statuses).
2. Looks up the customer in Chatwoot — first by Shopify ID (`identifier`), then by email as a fallback for pre-existing contacts.
3. Creates or updates the Chatwoot contact with the following data:

### Built-in Chatwoot Fields

| Field | Source |
|-------|--------|
| `name` | Shopify first + last name |
| `email` | Shopify email |
| `phone_number` | Shopify phone (normalized to E.164) |
| `identifier` | Shopify customer ID (links the two systems) |

### Custom Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| `shopify_customer_id` | Text | Shopify customer ID (also used by the AI draft flow to look up orders) |
| `shopify_url` | Link | Direct link to the customer in Shopify Admin |
| `total_orders` | Number | Lifetime order count |
| `total_spent` | Text | Lifetime spend with currency (e.g. `"149.97 EUR"`) |
| `subscription_orders` | Number | Count of orders tagged as subscription (first or recurring) |
| `last_order_name` | Text | Most recent order name (e.g. `"#2457"`) |
| `last_order_status` | Text | Payment and fulfillment status (e.g. `"paid / fulfilled"`) |
| `last_order_date` | Text | Date of most recent order |
| `last_order_tracking_url` | Link | Tracking URL from the latest fulfillment |
| `default_address` | Text | Formatted default address |
| `recent_orders` | Text | Summary of up to 10 recent orders with dates, amounts, statuses, and tracking links |
| `shopify_email_link` | Text | Optional override email. When set, **all** Shopify lookups (AI drafts, summaries, dashboard quick panel) use this address instead of the contact's own email. Set manually by an agent or automatically by the AI matcher (see [Unmatched-Contact Matching](#unmatched-contact-matching)). Leave empty by default. |

---

## Contact Matching Logic

The server uses a smart multi-step approach to avoid duplicates:

1. **Filter by `identifier`** (Shopify customer ID) — fast path for contacts already linked by a previous sync.
2. **Filter by `email`** — catches pre-existing Chatwoot contacts who were created before this integration (e.g. they emailed support). When matched, their `identifier` is set to the Shopify ID for faster future lookups.
3. **Create new contact** — if no match is found and `CHATWOOT_INBOX_ID` is configured.

All lookups use Chatwoot's `/contacts/filter` endpoint (exact matching), not the fuzzy search endpoint.

If a create fails with HTTP 422 (duplicate), the server retries the email lookup and updates instead. If the 422 is caused by an invalid phone number format, it retries without the phone field.

---

## Periodic Sync Behavior

The periodic sync is designed to be a lightweight safety net, not a full re-sync:

- **Contacts with Shopify data already populated** → skipped (no API calls beyond the filter lookup).
- **Contacts that exist but lack Shopify data** → orders are fetched and the contact is updated.
- **Contacts that don't exist in Chatwoot** → created with full Shopify data.

This means the first run does the heavy lifting, and subsequent runs are fast — only processing genuinely new customers.

The sync runs on a `setInterval` timer inside the Node.js process. Configurable via `SYNC_INTERVAL_HOURS` (set to `0` to disable).

---

## AI Draft Auto-Reply

When a customer sends a message into a Chatwoot inbox, the server receives a `message_created` webhook, gathers a complete context bundle, asks Claude for a reply draft, and posts it back into the same conversation as a **private note**. The draft is invisible to the customer; only agents can see it. The agent can copy/edit/send it as the public reply.

### Trigger Filter

The `/chatwoot` route ignores any payload that is not a fresh customer message. It only proceeds when **all** of these are true:

- `event === "message_created"`
- `message_type === "incoming"` (the message was sent by the customer, not an agent)
- `private !== true` (the agent didn't post a private note)

The handler responds `200` to Chatwoot **immediately** (before doing any work) so that Chatwoot's webhook does not time out, and then performs the rest of the work asynchronously.

### Optional Webhook Secret

If `CHATWOOT_WEBHOOK_SECRET` is set, the webhook URL must include it as a query string:

```
https://<your-domain>/chatwoot?secret=<your_secret>
```

Requests without the matching secret are silently dropped (a 200 is still returned to avoid leaking the existence of the secret). If `CHATWOOT_WEBHOOK_SECRET` is empty, no check is performed.

### Pipeline (per incoming message)

The full pipeline is in [`src/services/aiDraft.ts`](src/services/aiDraft.ts):

1. **Fetch Chatwoot context** in parallel:
   - `GET /conversations/:id/messages` — full message thread of the current conversation.
   - `GET /conversations/:id` — conversation details, including the contact's custom attributes (this is how we read `shopify_customer_id`).
   - `GET /contacts/:contact_id/conversations` — the contact's previous conversations (for historical context).
2. **Resolve the Shopify customer** (precedence: `shopify_email_link` override → `shopify_customer_id` → contact email):
   - If the contact has a `shopify_email_link` custom attribute, that address is used for the lookup instead of the contact's own email.
   - Otherwise try the `shopify_customer_id` custom attribute on the Chatwoot contact (set by the sync flow).
   - If that fails or returns no orders, fall back to `GET /customers/search.json?query=email:...` on the Shopify Admin API.
   - **If the contact still has no orders** and isn't already linked, the [Unmatched-Contact Matching](#unmatched-contact-matching) agent runs before the draft is written.
3. **Fetch live tracking** from 17track for the **last 2 fulfilled orders' tracking numbers**:
   - Calls `POST /track/v2.2/gettrackinfo`.
   - Any tracking numbers rejected as "not registered" are auto-registered via `POST /track/v2.2/register` and re-queried after a 3s delay.
4. **Build the user prompt** ([`src/utils/promptBuilder.ts`](src/utils/promptBuilder.ts)) with these clearly-labelled sections:
   - Customer summary (name, email, total orders, subscription count, lifetime value, default shipping address, conversation type)
   - `--- ORDER HISTORY ---` (every order, sorted newest first, with line items)
   - `--- TRACKING (Last 2 Orders) ---` (status, last event, location, ETA, full event timeline up to 10 events)
   - `--- CURRENT CONVERSATION ---` (all visible, non-private messages, oldest → newest)
   - `--- PREVIOUS CONVERSATIONS ---` (up to 5 prior conversations, each with up to 10 visible messages)
5. **Call Claude** with `system = CLAUDE_SYSTEM_PROMPT` (or the contents of `src/config/systemPrompt.txt` if the env var is empty), `model = CLAUDE_MODEL` (default `claude-sonnet-4-20250514`), `max_tokens = 2048`.
6. **Post the draft as a private note** via `POST /conversations/:id/messages` with `{ message_type: "outgoing", private: true, content_type: "text" }`.

### System Prompt

The default system prompt lives in [`src/config/systemPrompt.txt`](src/config/systemPrompt.txt) and is loaded at startup if `CLAUDE_SYSTEM_PROMPT` is not set in the environment. It encodes:

- Brand voice ("Andrew" from Scandi support, warm/concise, signs off as `Best regards, Andrew, Scandi Support`).
- Brand context about Scandi gum (ingredients, positioning, product variants).
- Specific instructions for common cases:
  - Subscription cancellation → confirm without resistance (real agents do the actual cancel).
  - Shipping delays → reassure, frame as already shipped, soft excuse about high volume.
  - 3+ days unfulfilled → apologize and offer the discount code `SMILE5`.
  - Tracking links → always wrapped in `https://scandigum.com/en-eu/apps/17TRACK?nums=...`.
- Rule: **match the customer's language** (Swedish in → Swedish out, etc.).

To customize, either edit the file or set `CLAUDE_SYSTEM_PROMPT` to override it (the env var takes precedence).

### Debug Mode

Set `DEBUG=1` in the environment and the server will, in addition to posting the draft, post a separate private note containing the **full system prompt + user prompt** that was sent to Claude. Useful for verifying that the right context is being assembled. Turn this off in production.

### Failure Handling

The AI draft flow is best-effort and never blocks the webhook 200 response:

- A failure to fetch Shopify data, tracking data, or generate a draft is logged but does not crash the request.
- If `CLAUDE_SYSTEM_PROMPT` (and `systemPrompt.txt`) are both empty, the flow logs a warning and skips — no private note is posted.
- If Claude returns no text content, a warning is logged and no note is posted.

### Unmatched-Contact Matching

Customers often email from a different address than the one on their Shopify account (e.g. they ordered with `john@gmail.com` but write in from `john@icloud.com`). When that happens the contact has no synced data, the dashboard panel is empty, and the AI draft has no order context to work with. But the customer frequently *tells us* what we need — "where is my order #11696?" or "I ordered with john@gmail.com".

To recover that, the AI draft flow runs a small **tool-using agent** ([`src/services/customerResolver.ts`](src/services/customerResolver.ts)) built on the Anthropic SDK's [Tool Runner](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner). It only runs when **both** are true:

- The contact is **not matched** — no Shopify account, or an account with **zero orders** (a 0-order account counts as unmatched).
- The contact is **not already linked** — `shopify_email_link` is empty (once linked, the tools are never offered again for that contact).

The agent (Claude Sonnet, `CLAUDE_MODEL`) is given the customer's message and two client tools:

| Tool | Purpose |
|------|---------|
| `search_customer_by_email` | Looks up a Shopify customer by an alternate email the customer provided, returns their orders. |
| `search_customer_by_order_number` | Looks up an order by number (`#11696`), resolves the owning customer, returns their orders. |

The agent calls a tool **only** when the message clearly contains a usable alternate email or order number; otherwise it does nothing. On a successful match (a customer with ≥1 order) the tool:

1. **Writes `shopify_email_link`** back to the Chatwoot contact (`PUT /contacts/:id`), so every future lookup — AI drafts, summaries, and the dashboard quick panel — resolves the right customer automatically.
2. Returns the customer + orders so the draft is then **regenerated with full context** (orders, tracking, etc.).

If no match is found (no usable info in the message), the prompt gains a `--- CUSTOMER NOT MATCHED ---` block instructing the AI to politely ask for an order number / original email **only when the request actually needs order data** (business/product enquiries are answered normally). The final output is always the same structured draft (customer reply + optional note to agent).

> A human agent can also set `shopify_email_link` by hand from the Chatwoot contact sidebar to force the correct match at any time.

---

## AI AgentBot Responder

On top of the AI-draft system, an autonomous **Chatwoot AgentBot** can take first ownership of conversations: it classifies and labels them, **auto-responds** to the cases it can safely handle (subscription cancellation, order status), and **escalates everything else to a human**. It is enabled simply by attaching the bot to an inbox in Chatwoot (no feature flag), and disabled by detaching it.

### Two webhooks, routed by status

Both webhooks receive every `message_created` event, but each acts on a disjoint conversation status so they never double-handle a message:

| Webhook | Endpoint | Handles | Behaviour |
|---------|----------|---------|-----------|
| AgentBot (new) | `POST /chatwoot/agent-bot` | `pending` (AI-owned) | classify → auto-respond or escalate |
| Draft (existing) | `POST /chatwoot` | `open` (human-owned) | AI draft as a private note (+ maintains labels); **skips `pending`** |

When the AgentBot is attached, Chatwoot starts new conversations in **`pending`**. When a customer replies to a **resolved** conversation, Chatwoot reopens it back to **`pending`**, so it re-enters the AgentBot flow and is re-classified/re-routed on every message.

> **5-second timeout:** AgentBot webhooks must reply within ~5s or Chatwoot flips the conversation to `open` and posts a bot-error activity. Both routes ack `200` immediately and do all LLM work asynchronously.

### Classification ([`src/services/classifier.ts`](src/services/classifier.ts))

Every inbound message (on both paths) is classified by a cheap model (`CLAUDE_CLASSIFIER_MODEL`, default `claude-haiku-4-5`) using structured output. It assigns one or more of these **classification labels** only:

`business`, `change-address`, `change-contact`, `sub-cancel`, `refund`, `discount-issue`, `missing-packs`, `no-country`, `not-delivered`, `order-status`, `product-defect`, `other`.

Labels are **add-only**: the classifier merges new labels into the conversation via `POST /conversations/{id}/labels` (read current → union → write) and never removes any. **Action labels** (e.g. `refund-30/50/70/full`, `reshipped`, `changed-address`, `sub-cancelled`, `sub-cancelled-ai`, `ai-response`) are reserved for agents/tools and are never AI-assignable.

### Routing & escalation ([`src/services/aiResponder.ts`](src/services/aiResponder.ts))

For a `pending` conversation the AgentBot:

1. Builds full context and runs the same Shopify [matcher](#unmatched-contact-matching).
2. Classifies + merges labels.
3. **Hard-escalates** (no responder call) if classification fails, or if any merged classification label falls outside `{ sub-cancel, order-status, other }`. **Refund always escalates**, even combined with sub-cancel or order-status.
4. Otherwise runs the **responder agent** (`CLAUDE_MODEL`, Sonnet, via the Anthropic SDK Tool Runner) with the autonomous system prompt [`src/config/responderPrompt.txt`](src/config/responderPrompt.txt). Its replies are sent **directly to the customer**, then the conversation is **resolved**.

The responder agent has two tools:

- **`escalate_to_human(reason, holding_reply)`** — always available. The agent writes a short, **context-aware** `holding_reply`; the tool sends it to the customer, sets the conversation to **`open`**, and triggers an **escalation draft** for the human agent.
- **`cancel_subscription()`** — injected only when the `sub-cancel` label is present. Cancels the customer's active Skio subscription(s) by their linked email (`cancelActiveSubscriptionsByEmail`) and adds the **`sub-cancelled-ai`** label. The agent only uses it when the customer insists we cancel for them (or can't self-serve); by default it sends the self-service link instead.

#### Contextual holding reply (optional)

On escalation, the bot can send the customer a brief holding message before handing off. This is controlled by **`AGENT_BOT_HOLDING_REPLY`** (default `true`):

- **`true`** — a contextual holding reply is sent. It is not a fixed string; it is lightly tailored to the conversation while keeping the same intent ("we need a bit of extra help; a team member will be in touch shortly"):
  - **Tool escalations:** the responder agent writes `holding_reply` directly.
  - **Hard-filter escalations** (no agent call): a small dedicated Haiku call crafts a brief contextual holding reply, with a fixed sentence as a fallback if it fails.
- **`false`** — the bot sends **nothing** to the customer on escalation. It silently sets the conversation to `open` and generates the human draft (see below). Use this when you'd rather a human send the first reply with no automated holding message.

#### Escalation also drafts for the human

Whenever the bot escalates (hard filter or tool), it calls the draft generator with an `escalationContext` flag, adding a `--- JUST ESCALATED ---` block to the prompt so the human gets a ready substantive next reply as a private note. ([`postAiDraft`](src/services/aiDraft.ts) is shared by the draft webhook and the escalation path.)

### Manual Chatwoot setup

1. Create the **`sub-cancelled-ai`** and **`ai-response`** labels (Settings → Labels). The classification labels above are also worth creating as labels for filtering. `ai-response` is added whenever the bot sends a successful auto-reply (not an escalation).
2. **Settings → Bots → Add Agent Bot**, with **Outgoing URL** `https://<your-domain>/chatwoot/agent-bot?secret=<CHATWOOT_AGENT_BOT_SECRET>` (omit `?secret=` if you didn't set the secret).
3. Connect the bot to your support inbox (Inbox → Settings → Bot). New/reopened conversations now start in `pending`.
4. **Keep the existing `message_created` webhook** (`/chatwoot`) connected — it still drafts for human-owned (`open`) conversations.

---

## Dashboard App (Customer 360)

A [Chatwoot Dashboard App](https://www.chatwoot.com/docs/product/others/dashboard-apps/) is a web app embedded as an iframe in the agent's conversation view. This repo ships one — a **Customer 360** panel — built with React + Vite + Tailwind + shadcn/ui and served by the same Express server at **`/app`**.

### What it shows

- **Customer header** — name, email, phone, default address, and a link to the Shopify Admin customer page.
- **Summary** — total orders, lifetime value, subscription-order count, active subscription count.
- **AI Summary** — a collapsible, AI-generated recap of the customer (see [Customer AI Summary](#customer-ai-summary) below). Collapsed to the short overview; expands to the full support history.
- **Response Composer** — an AI reply generator (see [Response Composer](#response-composer) below). Prefills the latest suggested draft, accepts free-form instructions to (re)generate, lets the agent edit, and sends the reply to the customer.
- **Orders tab** — every order (newest first) with a derived delivery status badge (`Unfulfilled` / `In transit` / `Out for delivery` / `Delivered` / etc.), financial status, subscription tag (First / Recurring), line items, and a link to the order in Shopify Admin. Each order with tracking has a **collapsible** "Tracking" section (collapsed by default) showing carrier info and, when available, the live 17track status + recent events.
- **Subscriptions tab** — Skio subscriptions with status, billing interval, products, and next billing date. Active subscriptions have a **Cancel** button (with a confirmation dialog) that calls the Skio API.

### Customer AI Summary

Every time the server generates an AI draft reply (i.e. on each incoming customer message), it also generates a concise customer summary and stores it in **Firestore** (collection `customerSummaries`, keyed by the Chatwoot contact ID). The summary has two parts:

1. **Overview** — 2-4 sentences: who the customer is, total orders, lifetime value, subscription status, and the status of recent orders.
2. **Conversation history** — a structured, per-conversation recap (one entry per support thread, each with its conversation id, date, status, and a detailed summary of problems raised, requests, actions taken, promises made, and resolution). Internal private notes / AI drafts are ignored — only real customer messages and sent agent replies are summarized. The dashboard renders each conversation as its own clean block.

It is generated by [`src/services/customerSummary.ts`](src/services/customerSummary.ts), which gathers the full message thread of each of the contact's conversations, builds a prompt, and asks Claude (via native JSON structured outputs) to return `{ overview: string, history: Array<{ conversationId, date, status, summary }> }`. Older summaries stored as a single history string are still rendered for backward compatibility.

In the dashboard, the summary shows right below the customer stats, collapsed to the overview with a "Show full history" toggle. A refresh button regenerates it on demand (`POST /app/api/summary/refresh`), which is useful when there's no stored summary yet (e.g. the customer hasn't messaged since the feature was deployed).

**Storage** is optional: set `FIREBASE_BASE64_SERVICE_ACCOUNT` (base64 of a Firebase service-account JSON) to persist summaries. Without it, summaries are still generated on demand but not saved between requests. The stored summaries also serve as context for future AI features.

### Response Composer

A compact, non-chat composer for writing the reply to the customer, powered by the same model, context, and playbook as the auto-draft (`CLAUDE_MODEL`, `claude-sonnet-4-6`).

**Structured drafts.** The draft generator now uses Claude's native JSON structured outputs (`client.messages.parse` + `zodOutputFormat`) to split every draft into two fields:

- `response` — the clean, customer-facing reply (safe to send).
- `noteToAgent` — an optional agent-only note (refund/cancellation actions to take, legal-threat flags, edge cases). Only included when warranted, and **never** sent to the customer.

On every incoming message the auto-draft is still posted as a Chatwoot private note (response + `[NOTE TO AGENT]` when present) and is now also stored in **Firestore** (collection `aiDrafts`, keyed by conversation ID).

In the dashboard the composer:

1. Prefills the editable reply box with the latest stored draft for the open conversation.
2. Takes a free-form instruction (e.g. "apologize for the delay and offer a partial refund") and **Generate**s a reply via `POST /app/api/draft/generate`.
3. Lets you iterate: type a correction (e.g. "don't say you give a refund, just offer one") and **Regenerate** — the backend sends your prior reply plus the correction as a follow-up turn and replaces the text in place (the UI never becomes a chat thread).
4. Shows any `noteToAgent` in a separate "not sent" box.
5. **Send message & resolve** posts the (optionally edited) reply to the customer as a public outgoing message and marks the conversation as resolved via `POST /app/api/draft/send` (which sends the reply, then calls Chatwoot's `toggle_status` with `status: resolved`). Sending is the critical step — if the resolve call fails the message is still delivered.

Generation/storage are implemented in [`src/services/aiDraft.ts`](src/services/aiDraft.ts) (`gatherDraftContext`, `generateResponse`) and [`src/services/draftStore.ts`](src/services/draftStore.ts). Like the summary, persistence requires `FIREBASE_BASE64_SERVICE_ACCOUNT`; without it the composer still generates on demand but won't prefill a stored suggestion.

### How it gets context

Chatwoot pushes the active conversation/contact to the iframe via `window.postMessage` (`appContext` event). The SPA:

1. On mount, posts `chatwoot-dashboard-app:fetch-info` to the parent window to request the current context.
2. Listens for `message` events (validating `event.source === window.parent`), parses the `appContext` payload, and extracts the customer identity.
3. Reacts to **conversation switching** — Chatwoot keeps the iframe alive and just pushes a new `appContext`, so the panel clears and refetches automatically when the agent opens a different conversation.

Customer resolution mirrors the AI draft flow: a **`shopify_email_link`** override (if set) wins, then the **`shopify_customer_id`** custom attribute (set by the sync flow), then the contact's **email**. See [Unmatched-Contact Matching](#unmatched-contact-matching) for how the override gets set.

### Data flow

```
Chatwoot iframe ──postMessage(appContext)──▶ Dashboard SPA (/app)
                                                   │ GET /app/api/customer  (x-app-token)
                                                   ▼
                                      Express ─▶ Shopify (orders + delivery status)
                                              ─▶ Skio    (subscriptions)
                                              ─▶ 17track (optional live tracking)
```

The backend aggregator is [`src/services/customerProfile.ts`](src/services/customerProfile.ts). Delivery status is derived from Shopify itself (`fulfillment_status` + each fulfillment's `shipment_status`); 17track is used only to enrich the collapsible tracking detail.

### Auth

Access is gated by a shared secret in **`DASHBOARD_APP_TOKEN`** (server env on DigitalOcean). The token is **not** baked into the JavaScript bundle.

1. **Page load** — Chatwoot must load the iframe with the token in the URL:
   ```
   https://<your-domain>/app?token=<DASHBOARD_APP_TOKEN>
   ```
   Without a valid `?token=`, the server returns **401** and does not serve the SPA.

2. **API calls** — The SPA reads `?token=` from the iframe URL and sends it on every request as the `x-app-token` header. `/app/api/*` rejects requests without a matching token.

This is stronger than embedding the secret in JS (anyone who opened `/app` could extract it from the bundle before). The token still appears in the Chatwoot dashboard config and browser history, so treat it as an internal-tool gate, not per-agent identity. If `DASHBOARD_APP_TOKEN` is unset, both the page and API are left open (with a warning in logs).

The `/app` routes also send `Content-Security-Policy: frame-ancestors` so only Chatwoot can embed the app in an iframe.

### Local development

The SPA lives in [`web/`](web/) as its own Vite project:

```bash
cd web
npm install
npm run dev      # Vite dev server (postMessage features only work inside Chatwoot)
```

For production it is built to `web/dist` and served by Express — the root `npm run build` runs the web build first, then compiles the server (see [Setup](#setup)).

### Register it in Chatwoot

1. Go to **Settings → Integrations → Dashboard Apps → Configure → Add a new dashboard app**.
2. Name it (e.g. "Customer 360") and set the URL to:
   ```
   https://<your-domain>/app?token=<DASHBOARD_APP_TOKEN>
   ```
   Use the same value as the `DASHBOARD_APP_TOKEN` env var on your server.
3. Save. A new tab appears in the conversation view; open it to see the panel.

---

## Rate Limiting

All API clients handle rate limiting automatically:

- **Shopify**: Retries on 429 using the `Retry-After` header, up to 3 attempts.
- **Chatwoot**: Axios response interceptor with exponential backoff (2s → 4s → 8s → 16s), up to 4 retries.
- **17track**: One retry after registering missing numbers; failures are logged and the AI draft proceeds without tracking data.
- **Sync throttling**: 500ms delay between individual customers, 1s delay between pages.

---

## Project Structure

```
src/
├── config/
│   ├── env.ts              # Environment variable validation and typed config
│   ├── systemPrompt.txt    # Default Claude system prompt (Scandi brand voice + rules)
│   └── responderPrompt.txt # Autonomous AgentBot responder system prompt
├── middleware/
│   ├── verifyShopifyWebhook.ts  # HMAC-SHA256 webhook verification
│   ├── syncAuth.ts              # Bearer token auth for /sync routes
│   └── errorHandler.ts          # Global error handler
├── routes/
│   ├── webhooks.ts          # Shopify webhook handlers (customers, orders)
│   ├── sync.ts              # Manual sync trigger endpoint
│   ├── chatwootWebhook.ts   # Chatwoot webhook → AI draft for open convos (+ classify)
│   ├── agentBotWebhook.ts   # Chatwoot AgentBot webhook → autonomous responder (pending)
│   └── dashboardApp.ts      # Dashboard App API (customer profile, cancel subscription)
├── middleware/
│   └── appAuth.ts           # Shared-token auth for the Dashboard App API
├── services/
│   ├── shopifyAuth.ts            # OAuth client_credentials token management
│   ├── shopify.ts                # Shopify REST API client (customers, orders, search by email/order number)
│   ├── chatwoot.ts               # Chatwoot API client (filter, create, update, upsert)
│   ├── chatwootConversation.ts   # Conversation/message reads + private note writes
│   ├── tracking.ts               # 17track register + gettrackinfo client
│   ├── claude.ts                 # Anthropic Messages API wrapper
│   ├── aiDraft.ts                # Orchestrator: webhook → context → Claude → private note (postAiDraft)
│   ├── classifier.ts             # Haiku structured conversation classifier (labels)
│   ├── aiResponder.ts            # AgentBot orchestrator: classify → respond (tools) or escalate
│   ├── customerResolver.ts       # Tool-using agent that matches unmatched contacts via email/order#
│   ├── skio.ts                   # Skio GraphQL client (subscriptions + cancel, cancel-by-email)
│   ├── customerProfile.ts        # Dashboard App aggregator: Shopify orders + Skio subs
│   ├── firestore.ts              # Lazy firebase-admin init (AI summary + draft storage)
│   ├── customerSummary.ts        # Generates + stores/reads the AI customer summary
│   ├── draftStore.ts             # Stores/reads AI drafts in Firestore (aiDrafts)
│   └── sync.ts                   # Full sync logic and periodic scheduler
├── types/
│   ├── index.ts             # Shopify + Chatwoot REST types
│   ├── chatwoot.ts          # Chatwoot webhook + conversation types
│   ├── tracking.ts          # 17track types
│   ├── skio.ts              # Skio subscription types
│   ├── summary.ts           # AI customer summary type
│   └── draft.ts             # AI draft type
├── utils/
│   ├── formatters.ts        # Order formatting, phone normalization, attribute building
│   ├── promptBuilder.ts     # Builds the structured user prompt for Claude
│   └── logger.ts            # Structured console logger
├── app.ts                   # Express app configuration and middleware wiring
└── server.ts                # Entry point, starts server and periodic sync

web/                         # Chatwoot Dashboard App (Vite + React + Tailwind + shadcn)
├── src/
│   ├── lib/
│   │   ├── chatwoot.ts      # postMessage bridge (appContext listener + fetch-info)
│   │   ├── api.ts           # Calls /app/api/* with x-app-token
│   │   ├── types.ts         # DTO + appContext interfaces
│   │   └── format.ts        # Money/date/status formatting helpers
│   ├── components/          # ProfileHeader, SummaryRow, CustomerSummary, ResponseComposer, OrdersList, SubscriptionsPanel, ui/
│   └── App.tsx              # Orchestrator (context → fetch → tabs)
└── (built to web/dist, served by Express at /app)
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPIFY_STORE_DOMAIN` | Yes | Your `.myshopify.com` domain |
| `SHOPIFY_CLIENT_ID` | Yes | App client ID from Shopify Admin |
| `SHOPIFY_CLIENT_SECRET` | Yes | App client secret (also used for webhook HMAC verification) |
| `CHATWOOT_BASE_URL` | Yes | Chatwoot instance URL (e.g. `https://app.chatwoot.com`) |
| `CHATWOOT_API_TOKEN` | Yes | Chatwoot API access token |
| `CHATWOOT_ACCOUNT_ID` | Yes | Chatwoot account ID |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `SEVENTEENTRACK_API_KEY` | Yes | 17track API key (header `17token`) |
| `SKIO_API_KEY` | Yes | Skio API key (sent as `Authorization: API <key>`) for subscriptions + cancel |
| `FIREBASE_BASE64_SERVICE_ACCOUNT` | No | Base64 of a Firebase service-account JSON. Enables storing AI customer summaries in Firestore. If unset, summaries are generated but not persisted |
| `CHATWOOT_INBOX_ID` | No | Inbox ID for new contact creation (required to create contacts) |
| `SYNC_API_KEY` | No | Bearer token to protect the `/sync` endpoint |
| `SYNC_INTERVAL_HOURS` | No | Periodic sync interval in hours (default: `0` = disabled) |
| `PORT` | No | Server port (default: `8080`) |
| `CLAUDE_SYSTEM_PROMPT` | No | Inline override for the system prompt. If unset, falls back to `src/config/systemPrompt.txt` |
| `CLAUDE_MODEL` | No | Anthropic model id for drafts + responder agent (default: `claude-sonnet-4-20250514`) |
| `CLAUDE_CLASSIFIER_MODEL` | No | Cheaper model for the conversation classifier + holding replies (default: `claude-haiku-4-5`) |
| `CLAUDE_RESPONDER_PROMPT` | No | Inline override for the AgentBot responder prompt. If unset, falls back to `src/config/responderPrompt.txt` |
| `CHATWOOT_WEBHOOK_SECRET` | No | If set, the Chatwoot webhook URL must include `?secret=<value>` |
| `CHATWOOT_AGENT_BOT_SECRET` | No | If set, the AgentBot webhook URL must include `?secret=<value>` |
| `AGENT_BOT_HOLDING_REPLY` | No | `true`/`false` (default `true`). When `false`, escalations send no holding reply — the bot silently hands off to a human and generates a draft |
| `DASHBOARD_APP_TOKEN` | No | Gates `/app` and `/app/api/*`. Pass as `?token=` in the Chatwoot Dashboard App URL. If unset, both are unprotected |
| `DEBUG` | No | If truthy, posts the full Claude prompt as an additional private note (do not use in prod) |

---

## Setup

### 1. Local install

```bash
cp .env.example .env
# fill in the values from the sections below
npm install
npm run dev    # tsx watch mode (server)
```

The Dashboard App SPA lives in [`web/`](web/) and has its own dependencies. `npm run build` (and the DO deploy) builds it automatically; for local SPA work run `cd web && npm install && npm run dev`. See [Dashboard App (Customer 360)](#dashboard-app-customer-360).

### 2. Shopify

1. In your Shopify dev dashboard, create an app and grab `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`.
2. Required scopes: `read_customers`, `read_orders`.
3. Register the following webhook topics, each pointing at your deployed server:

| Topic | Endpoint |
|-------|----------|
| `customers/create` | `https://<your-domain>/webhooks/customers` |
| `customers/update` | `https://<your-domain>/webhooks/customers` |
| `orders/create` | `https://<your-domain>/webhooks/orders` |
| `orders/updated` | `https://<your-domain>/webhooks/orders` |
| `orders/fulfilled` | `https://<your-domain>/webhooks/orders` |
| `orders/partially_fulfilled` | `https://<your-domain>/webhooks/orders` |

HMAC verification is performed using `SHOPIFY_CLIENT_SECRET`.

### 3. Chatwoot

#### a) Create custom attributes

In **Settings → Custom Attributes**, create the contact-level attributes listed under [Custom Attributes](#custom-attributes). The most important one for the AI draft flow is **`shopify_customer_id`** — this is how the AI looks up orders for an incoming message.

#### b) Get an API token + IDs

- Generate an API access token from your profile (top-right avatar → Profile Settings → API Access Token) → set as `CHATWOOT_API_TOKEN`.
- Note your account ID from any URL like `https://app.chatwoot.com/app/accounts/<id>/...` → set as `CHATWOOT_ACCOUNT_ID`.
- Note the inbox ID where contacts should be created → set as `CHATWOOT_INBOX_ID`.

#### c) Register the AI draft webhook

This is the new piece. In Chatwoot:

1. Go to **Settings → Integrations → Webhooks → Add new webhook**.
2. Set the URL to:
   - `https://<your-domain>/chatwoot` — if you don't want a secret, or
   - `https://<your-domain>/chatwoot?secret=<CHATWOOT_WEBHOOK_SECRET>` — if you set the env var.
3. Subscribe to the **`Message Created`** event (the only event the handler reacts to).
4. Save.

That's it. The handler ignores anything that isn't an inbound, non-private customer message, so subscribing to extra events is harmless but not required.

You can verify it's working by sending a test customer message into the inbox — within a few seconds a private note should appear in the conversation, signed `Andrew, Scandi Support`.

### 4. Anthropic

1. Create an API key at https://console.anthropic.com → set as `ANTHROPIC_API_KEY`.
2. Optionally pin a specific model via `CLAUDE_MODEL` (default `claude-sonnet-4-20250514`).
3. Optionally override the system prompt via `CLAUDE_SYSTEM_PROMPT`. If left blank, the file at `src/config/systemPrompt.txt` is used. Edit that file to change brand voice / rules without redeploying env vars.

### 5. 17track

1. Sign up at https://api.17track.net and create an API key → set as `SEVENTEENTRACK_API_KEY`.
2. No further setup needed. Tracking numbers are auto-registered by the order webhook (in the background) and again by the AI draft flow if any are still unknown at draft time.

### 6. Skio

1. In your Skio dashboard, open the **API** section and generate an API key → set as `SKIO_API_KEY`.
2. It is sent as the `Authorization: API <key>` header to `https://graphql.skio.com/v1/graphql`. Used by the Dashboard App to read subscriptions and cancel them.

### 7. Dashboard App

1. Generate a random secret → set as `DASHBOARD_APP_TOKEN` on DigitalOcean (runtime only; no build-time copy needed).
2. Deploy, then register the app in Chatwoot with URL `https://<your-domain>/app?token=<DASHBOARD_APP_TOKEN>`. Full details in [Dashboard App (Customer 360)](#dashboard-app-customer-360).

---

## Deployment (DigitalOcean App Platform)

The repo includes a `.do/app.yaml` spec for DigitalOcean App Platform:

- **Runtime**: Node.js 22
- **Build**: `npm run build` — builds the Dashboard App SPA (`web/` → `web/dist/`) then compiles the server (TypeScript → `dist/`)
- **Start**: `npm start` (`node dist/server.js`)
- **Health check**: `GET /health`
- **Port**: 8080

All environment variables should be set as secrets in the DO dashboard or app spec. `src/config/systemPrompt.txt` is bundled in the repo and read at runtime, so no extra build step is required to ship system-prompt changes.

---

## Quick Verification Checklist

After deploying, run through this:

- [ ] `GET /health` returns `{ "status": "ok" }`.
- [ ] Trigger a test order in Shopify → check logs for `Received order webhook` and `Updating Chatwoot contact`. The Chatwoot contact's custom attributes should populate.
- [ ] `POST /sync/customers` (with `Authorization: Bearer $SYNC_API_KEY`) → logs show paged customer fetches and upserts.
- [ ] Send a test customer email/chat into the configured Chatwoot inbox → within ~5–15s a **private note** appears in the conversation, written by "Andrew", with content tailored to that customer's actual orders.
- [ ] (Optional) Set `DEBUG=1` once and confirm the full prompt also appears as a private note. Then unset.

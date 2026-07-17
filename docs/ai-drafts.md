# AI Draft Auto-Reply

When a customer messages a Chatwoot inbox, the server gathers a full context bundle, asks Claude for a reply, and posts it back into the conversation as a **private note** for an agent to review/edit/send. Orchestration lives in [`src/services/aiDraft.ts`](../src/services/aiDraft.ts).

## Trigger filter (`POST /chatwoot`)

The route ignores anything that is not a fresh customer message. It proceeds only when all of:

- `event === "message_created"`
- `message_type === "incoming"` (sent by the customer)
- `private !== true`

It replies `200` to Chatwoot immediately and does the work asynchronously. If `CHATWOOT_WEBHOOK_SECRET` is set, the URL must include `?secret=<value>`.

The draft webhook handles **open** (human-owned) conversations and **skips `pending`** ones (those belong to the AgentBot — see [agent-bot.md](agent-bot.md)).

## Pipeline (per incoming message)

1. **Fetch Chatwoot context** in parallel: current conversation messages, conversation details (custom attributes, subject), and the contact's previous conversations.
2. **Resolve the Shopify customer** (precedence: `shopify_email_link` override → `shopify_customer_id` → contact email). If still unmatched, the [matcher agent](#unmatched-contact-matching) runs.
3. **Fetch live tracking** (17track) for the last 2 fulfilled orders' tracking numbers.
4. **Gather customer images** (see [Image understanding](#image-understanding)).
5. **Build the user prompt** ([`src/utils/promptBuilder.ts`](../src/utils/promptBuilder.ts)) with labelled sections: customer summary, `--- ORDER HISTORY ---`, `--- TRACKING ---`, `--- CURRENT CONVERSATION ---`, `--- PREVIOUS CONVERSATIONS ---`.
6. **Call Claude** with the draft system prompt and model (see [configuration.md](configuration.md)); `max_tokens = 2048`; native JSON structured output.
7. **Post the draft** as a private note and store it in Firestore (`aiDrafts`, keyed by conversation id, with version history).

## Structured output (three fields)

The draft generator uses Claude's native JSON structured outputs (`client.messages.parse` + `zodOutputFormat`) and splits every draft into **three** fields:

- `response` — the clean, customer-facing reply (safe to send).
- `noteToAgent` — an optional agent-only note (actions to take, legal flags, edge cases). Never sent to the customer.
- `customerMessageTranslation` — an English translation of the customer's message, populated **only** when they wrote in another language. Kept strictly separate from `response` so a translation can never leak into the sent reply.

In the private note, the translation (when present) is shown **above** the reply under `[CUSTOMER MESSAGE — TRANSLATED]`, and the note stays below under `[NOTE TO AGENT]`. The dashboard composer renders the translation in its own read-only "not sent" block ([dashboard-app.md](dashboard-app.md#response-composer)).

## Image understanding

Customers frequently attach photos (a product defect, a delivered parcel). [`src/services/attachments.ts`](../src/services/attachments.ts) collects images from the customer's messages and passes them to Claude as multimodal image blocks (base64), so the model actually sees them.

Two sources are handled:

- **Chatwoot attachments** — messages with `attachments[].file_type === 'image'`.
- **Inline email images** — email-channel customers embed photos inline in the HTML body rather than as attachments. Chatwoot rewrites those into same-host `/rails/active_storage/` blob URLs; the gatherer extracts those `<img>` URLs from `content_attributes.email.html_content.full`, while skipping external-host images (signature logos, tracking pixels).

Guardrails: max 6 images, 10 MB each, supported types only (jpeg/png/gif/webp). Best-effort — any image that can't be fetched is skipped and never blocks the draft.

## System prompt

The default draft prompt lives in [`src/config/systemPrompt.txt`](../src/config/systemPrompt.txt) (brand voice "Andrew", playbook for common cases, output format). It can be overridden by the `CLAUDE_SYSTEM_PROMPT` env var, or — preferred — live-edited from the [Admin Control Dashboard](admin-dashboard.md) (Firestore override with fallback to env/file).

## Unmatched-contact matching

Customers often write in from a different address than the one on their Shopify account. When a contact has no order data (and isn't already linked), a small tool-using agent ([`src/services/customerResolver.ts`](../src/services/customerResolver.ts)) runs with two tools:

| Tool | Purpose |
|------|---------|
| `search_customer_by_email` | Look up a Shopify customer by an alternate email the customer provided. |
| `search_customer_by_order_number` | Look up an order by number (`#11696`) and resolve the owning customer. |

It calls a tool only when the message clearly contains a usable email/order number. On a successful match (≥1 order) it writes `shopify_email_link` back to the contact and the draft is regenerated with full context. If nothing usable is found, a `--- CUSTOMER NOT MATCHED ---` block instructs the AI to ask for an order number / original email **only when the request needs order data**.

A **negative-match cache** (Firestore, keyed by contact + message hash, 12h TTL) prevents re-running this expensive loop for redeliveries/regenerations of the same message ([caching-and-storage.md](caching-and-storage.md)).

## Debug mode & failure handling

- Set `DEBUG=1` to also post the full system + user prompt as a separate private note (do not use in prod).
- The flow is best-effort and never blocks the webhook 200. Failures to fetch data or generate a draft are logged, not thrown. If the system prompt is empty, or Claude returns no text, no note is posted.

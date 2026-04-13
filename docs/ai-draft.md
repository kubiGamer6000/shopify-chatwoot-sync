# AI Draft System

When a customer sends a message in Chatwoot, the server automatically generates a draft reply using Claude and posts it as a private note for agents to review.

## Trigger

The Chatwoot instance is configured with a webhook URL pointing to `POST /chatwoot?secret=<secret>`. Chatwoot fires this on every `message_created` event.

The server only processes messages that are:
- Event type `message_created`
- Message type `incoming` (from a customer, not an agent)
- Not a private note

Everything else is ignored.

## Context Assembly Pipeline

The AI draft system assembles a rich context before calling Claude. This happens in 5 phases:

### Phase 1: Chatwoot Context (parallel)

Three API calls fire in parallel:

| Call | Purpose |
|------|---------|
| `getConversationMessages(conversationId)` | Full message history of the current conversation |
| `getConversationDetails(conversationId)` | Conversation metadata including contact custom attributes |
| `getContactConversations(contactId)` | All conversations this contact has ever had |

### Phase 2: Shopify Customer Lookup

The server tries to find the customer in Shopify:

1. Check if the Chatwoot contact has a `shopify_customer_id` custom attribute (set by the sync). If so, fetch orders by that ID.
2. If no orders found (or no ID), search Shopify by the customer's email address.
3. If a Shopify customer is found, fetch their full order history.

### Phase 3: Tracking Status

For the **last 2 fulfilled orders**, the server extracts tracking numbers from Shopify fulfillment data and queries 17track for live tracking status. This includes:
- Current status (InTransit, Delivered, etc.)
- Latest event description and location
- Estimated delivery date window
- Full event timeline (up to 10 events)

If a tracking number isn't registered with 17track yet, the server registers it, waits 3 seconds, and retries.

### Phase 4: Prompt Building

The `buildPrompt` function (`src/utils/promptBuilder.ts`) assembles a structured user prompt with these sections:

```
Today is Monday, April 13, 2026.

Customer: John Doe (john@example.com)
Conversation: This is a new conversation (conversation #1234).
Total orders: 5, of which 2 are subscription orders.
Lifetime value: 149.97 EUR
Shipping address: 123 Main St, Stockholm, SE

--- ORDER HISTORY ---
Order #2457 | 2026-04-01 | 29.99 EUR | paid / fulfilled
  Items: Scandi Whitening Gum x2 (14.99 EUR)
---
...

--- TRACKING (Last 2 Orders) ---
#2457 | Tracking: LY123456789SE
  Status: InTransit (In transit to destination)
  Last event: Departed facility - Stockholm
  Last update: 2026-04-10T14:30:00Z
  Est. delivery: 2026-04-14 to 2026-04-16
  Event timeline:
    2026-04-10T14:30:00Z | Departed facility (Stockholm)
    2026-04-09T09:00:00Z | Arrived at sorting center (Malmö)
---

--- CURRENT CONVERSATION ---
[2026-04-13T10:00:00Z] CUSTOMER: Where is my order?

--- PREVIOUS CONVERSATIONS ---
Conversation #1200 | 2026-03-01 | Status: resolved
  CUSTOMER: Can I change my address?
  AGENT: Sure! What's the new address?
---
```

### Phase 5: Claude API Call

The prompt is sent to Claude via the Anthropic SDK:

- **Model**: Configurable via `CLAUDE_MODEL` (default: `claude-sonnet-4-20250514`)
- **Max tokens**: 2048
- **System prompt**: Loaded from `CLAUDE_SYSTEM_PROMPT` env var, or from `src/config/systemPrompt.txt`
- **User prompt**: The assembled context from Phase 4

The response is posted as a **private outgoing note** in the Chatwoot conversation.

## System Prompt

The default system prompt (`src/config/systemPrompt.txt`) defines the AI as "Andrew" from Scandi Support with specific behavioral rules:

- Warm, concise replies (2-5 sentences)
- Match the customer's language (multilingual)
- Reference actual tracking data from context
- Handle subscription cancellations gracefully (no pressure)
- For shipping delays: reassure and offer `SMILE5` discount code for 3+ day unfulfilled orders
- Tracking links use the Scandi website format: `https://scandigum.com/en-eu/apps/17TRACK?nums=TRACKINGNUMBER`
- Never fabricate data not present in the context

You can override this entirely via the `CLAUDE_SYSTEM_PROMPT` environment variable.

## Debug Mode

Set `DEBUG=1` to have the server post the full prompt (system + user) as an additional private note before the AI draft. Useful for inspecting exactly what Claude sees.

## Inbox Filtering (Optional)

There's a commented-out section in `src/routes/chatwootWebhook.ts` to restrict AI drafts to specific Chatwoot inboxes. Uncomment and set `AI_INBOX_IDS` as a comma-separated list of inbox IDs to enable this.

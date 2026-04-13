# AI Support Pipeline

The server uses a two-call Claude architecture with structured output to classify customer intent and generate responses. Easy queries are answered automatically; everything else gets a warm handoff to human agents.

## Two-Call Architecture

### Call 1: Classifier

Runs on every incoming message. Uses Claude Sonnet 4.6 with native `output_config.format` (JSON schema) for guaranteed structured output.

**Input:** System prompt (`src/config/prompts/classifier.txt`) + customer context (conversation thread, order history)

**Output (structured):**

| Field | Type | Purpose |
|-------|------|---------|
| `intents` | array of enums (9 values) | All detected customer intents — messages can have multiple |
| `primary_intent` | enum (9 values) | The single most important intent, drives routing |
| `sentiment` | enum (positive/neutral/negative/hostile) | Customer's emotional state |
| `confidence` | number (0-1) | How certain the classification is |
| `customer_wants_human` | boolean | Explicit request to talk to a person |
| `involves_refund` | boolean | Whether money back is mentioned |
| `reasoning` | string | Brief explanation for auditing |

If any detected intent requires handoff, the `primary_intent` should be the handoff intent (e.g. "cancel sub + refund" → `primary_intent: refund_request`).

### Call 2: Responder

Only runs for AI-solvable intents. Uses the same model with a different system prompt containing playbooks.

**Input:** System prompt (`src/config/prompts/responder.txt`) + full context including classification result, orders, tracking, conversation history

**Output (structured):**

| Field | Type | Purpose |
|-------|------|---------|
| `customer_reply` | string | The message to send to the customer |
| `private_note` | string | Internal note for agents |
| `resolved` | boolean | Whether the issue appears resolved |
| `discount_applied` | boolean | Whether discount code SMILE5 was offered |

## Intent Categories

9 intents, mapped to two groups:

### AI-Solvable (Call 2 runs)

| Intent | Description |
|--------|-------------|
| `order_status` | Where's my order, tracking, delivery timing |
| `subscription_cancel` | Cancel future recurring orders (no refund) |
| `subscription_change` | Change frequency, product, pause |

### Handoff-Only (silent escalation to human)

Most handoffs are **silent** — no customer message is sent, just a private note + labels + status change. This avoids sending canned bot replies to business conversations, refund requests, etc.

| Intent | Description | Customer message? |
|--------|-------------|-------------------|
| `subscription_cancel_and_refund` | Cancel + wants money back | No |
| `refund_request` | Wants refund (not subscription-related) | No |
| `change_address` | Update delivery address | Yes |
| `product_not_received` | Claims non-delivery | No |
| `product_defect` | Damaged/wrong product | No |
| `business` | Partnerships, collabs, wholesale, press | No |
| `other` | Doesn't match any category | No |

Only `change_address` sends a customer message on handoff (acknowledging the request). Two special reasons also send a message: `customer_wants_human` ("Let me connect you…") and `force_handoff` (max turn ceiling reached).

## Routing Logic

The pipeline checks these conditions in order:

1. **Hard rule: unfulfilled order > 14 days** → Skip AI, urgent human handoff
2. **`customer_wants_human = true`** → Immediate handoff regardless of intent
3. **`sentiment = hostile`** → Immediate handoff
4. **`confidence < 0.5`** → Treat as `other`, handoff
5. **AI turn count >= 3** → Force handoff (3-response ceiling)
6. **Handoff-only intent** → Silent handoff (no customer message, except `change_address`)
7. **AI-solvable intent** → Run responder, send reply

## Playbooks

The responder system prompt contains specific playbooks for each AI-solvable intent.

### Order Status Playbook

| Customer Situation | Response |
|---|---|
| No Shopify data found | Generic reassurance, ask for order number |
| Order fulfilled with tracking | Share tracking link (scandigum.com format) |
| Order unfulfilled, ≤ 3 days | Reassurance about processing times |
| Order unfulfilled, 4-13 days | Apology + 5% discount code SMILE5 |
| Order unfulfilled, 14+ days | Blocked by hard rule (never reaches AI) |

### Subscription Cancel Playbook

1. Send self-service link: `https://scandigum.com/a/account/login`
2. If customer refuses self-service → handoff to specialist

### Subscription Change Playbook

Same self-service link as cancel. If customer can't/won't use it → handoff.

## Labels

Applied programmatically by the pipeline. **All detected intents** get their labels applied (not just the primary), so a message classified as `[subscription_cancel, refund_request]` gets both `subscription` and `refund` labels.

**Topic labels** (from classifier): `order-status`, `subscription`, `refund`, `change-address`, `product-not-received`, `product-defect`, `business`, `other`

**Handling labels** (from pipeline): `ai-resolved`, `escalated`, `urgent`

## Turn Tracking

In-memory counter per conversation. After 3 bot replies without resolution, the system forces a human handoff. Counter resets when the conversation resolves.

## Shadow Mode

When `AI_MODE=shadow`, the full pipeline runs but all output is posted as a single private note showing what would have happened. Agents see:

```
SHADOW MODE — AI Pipeline Result
---
Classification: order_status (primary: order_status, confidence: 0.92)
Sentiment: neutral
Route: AI-solvable → Responder

WOULD HAVE SENT TO CUSTOMER:
"Hey Sarah! Your order #1042 has been shipped..."

WOULD HAVE POSTED AS PRIVATE NOTE:
Intents: order_status (primary: order_status, confidence: 0.92)
Sentiment: neutral | Turn: 1 of 3
Sent tracking for #1042...

WOULD HAVE APPLIED: labels [order-status]
```

Multi-intent example:
```
SHADOW MODE — AI Pipeline Result
---
Classification: subscription_cancel, refund_request (primary: refund_request, confidence: 0.90)
Sentiment: negative
Route: Handoff (handoff_intent)
Customer message: NONE (silent handoff)

WOULD HAVE POSTED AS PRIVATE NOTE:
AI HANDOFF NOTE
Intents: subscription_cancel, refund_request (primary: refund_request, confidence: 0.90)
...

WOULD HAVE APPLIED: labels [subscription, refund, escalated], status → open
```

Shadow mode uses the existing Chatwoot webhook (not Agent Bot), so no Chatwoot configuration changes are needed. Deploy, set `AI_MODE=shadow`, and review private notes for 1-2 weeks before switching to `live`.

## Going Live

1. Set `AI_MODE=live`
2. Create Agent Bot in Chatwoot (Settings → Integrations → Agent Bots)
3. Set `outgoing_url` to `https://<server>/chatwoot?secret=<CHATWOOT_WEBHOOK_SECRET>`
4. Assign bot to email inbox (Settings → Inboxes → Collaborators → Agent Bots)
5. Create the 9 labels in Settings → Labels
6. New conversations now start as `pending` (invisible to agents until bot hands off)

## Private Note Format

Every AI action posts a structured private note for agent visibility.

**AI-handled messages:**
```
AI NOTE
---
Intents: order_status (primary: order_status, confidence: 0.92)
Sentiment: neutral | Turn: 1 of 3

Sent tracking link for order #1042.
Order fulfilled Apr 10, tracking: LY123456789SE
```

**Handoff messages:**
```
AI HANDOFF NOTE
---
Intents: subscription_cancel, refund_request (primary: refund_request, confidence: 0.88)
Sentiment: negative
Escalation reason: handoff_intent
Reasoning: Customer wants to cancel subscription and also requesting refund for last charge.
```

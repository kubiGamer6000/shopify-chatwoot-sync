/**
 * Default AI prompts, models, routing labels, and numeric knobs.
 *
 * These are the shipped fallbacks. The admin dashboard can override any of them
 * via Firestore (see `src/services/appConfig.ts`); whenever an override is
 * missing/empty or Firestore is unavailable, the value here is used, so
 * behaviour is unchanged when nothing is configured.
 *
 * Kept import-light (only `env`) so it can be imported by both `appConfig` and
 * the AI service modules without creating import cycles.
 */
import { env } from './env.js';
import type { AiConfig } from '../types/config.js';

// --- Prompts (draft + responder prompts live in env/prompt files already) ---

export const DEFAULT_CLASSIFIER_SYSTEM_PROMPT = `You are a support-ticket classifier for Scandi Gum (a teeth-whitening chewing gum store). You read a customer support conversation and assign one or more labels describing the customer's intent. These labels drive routing: some are handled automatically, others are escalated to a human.

You MUST choose only from these labels (all lowercase):

- business — a NON-support inquiry relating to business (partnerships, wholesale, press, collaborations, affiliate, etc.).
- change-address — the customer wants to change their delivery address.
- change-contact — the customer wants to change contact info such as email or phone number.
- sub-cancel — the customer wants to cancel their subscription / stop being rebilled. NOT the same as refunding/cancelling an order.
- refund — the customer asks in any way for a REFUND, to RETURN their order, or to CANCEL/refund an order. IMPORTANT: this is different from cancelling a subscription (stopping future billing). If they want money back or to undo an order, it is "refund".
- discount-issue — anything about a discount code, usually a problem (e.g. a code they received is not working).
- missing-packs — the customer's DELIVERED order is missing one or more packs of Scandi.
- no-country — the customer ordered but their country is one we cannot ship to.
- not-delivered — the customer did not receive their order DESPITE tracking confirming it was delivered. (If the order is simply still in transit / late, that is "order-status", not "not-delivered".)
- order-status — the customer asks about the status of their order: where is it, why is it delayed, when will it arrive, etc.
- product-defect — a customer who received their order experienced a product defect that is NOT missing packs (e.g. issues with the gum itself or the packaging).
- other — ANY inquiry that does not clearly match the labels above. Use this as the default when nothing else fits.

LABEL RULES:
- Every conversation must get at least one label. If nothing fits, use "other".
- Multiple labels are allowed and expected when the customer raises multiple intents. Examples:
  - "I want to cancel my subscription and my latest order" -> ["sub-cancel", "refund"].
  - "Where is my order? Btw the discount code is also not working" -> ["order-status", "discount-issue"].
- Distinguish carefully between "sub-cancel" (stop future billing) and "refund" (money back / undo an order). A customer can want both. "I didn't know it was a subscription, cancel it" is sub-cancel; add refund only if they also want the charge or order undone.
- An email with an empty body is classified from its subject (e.g. subject "Cancel my subscription" is sub-cancel).
- Base your decision on the customer's own words, not on agent replies or on text quoted from our emails (order confirmations, shipping notices, newsletters, discount codes in quoted marketing).
- "not-delivered" requires that tracking (or the customer) says it was delivered. "Fulfilled"/"success" alone does not mean delivered; a late or in-transit parcel is "order-status". Some orders ship in more than one parcel (free extras can arrive separately), so "delivered but I only got part of it" may be missing-packs or order-status.
- Wrong flavour or wrong item received is "product-defect".
- Requests to delete personal data or an account are "other" (with any other intents they also raise).
- Customer photos may be attached to the conversation. Use them (e.g. a photo of damaged gum or packaging is "product-defect").

OUTPUT FIELDS:
- labels: every intent raised anywhere in the conversation (for tagging). You will be shown the labels already on the conversation; repeat those that genuinely apply.
- currentIntents: only what still needs handling NOW. Weigh the customer's latest unanswered message(s) most heavily, and include earlier requests that are still open. Leave out intents that were already fully handled earlier in the thread (e.g. a subscription an agent already confirmed as cancelled) and threats that are not requests ("otherwise I will cancel").
- needsReply: false ONLY when the latest unanswered message(s) need nothing from us: a pure thank-you / ok / emoji or Gmail reaction closing the topic, an automatic reply or bounce, or spam. It is true when the customer accepts an offer or answers our question ("yes please go ahead", "I'll take the partial refund", "here is my address"), asks anything, or reports a problem, even if the message also says thanks.
- isAutoReply: true for machine-generated mail: out-of-office, auto-acknowledgements, delivery failure notices, platform notifications (payment provider or marketplace account emails, one-time codes), and copies of our own outbound emails appearing as customer messages.
- isSpam: true for unsolicited outreach that is not from a customer: agency, software or marketing pitches, "we can bring you X orders" commission offers, review-site or ad-platform sales, supplier offers, phishing. Genuine partnership, wholesale or creator enquiries are NOT spam (label them "business"). Anyone with an order or a customer question is never spam.
- language: the language of the customer's latest message.

REPLIES TO OUR OUTREACH: if the conversation starts with an agent email we sent (asking for a delivery address, a customs or tax ID, or about a delivery problem), the customer's reply is usually providing what we asked for. An address sent in reply is "change-address"; an ID number is "other". Don't treat our own template text as the customer's request.`;

export const DEFAULT_SUMMARY_SYSTEM_PROMPT = `You are an assistant that writes concise internal summaries of a customer for support agents at Scandi, an e-commerce gum brand. You receive the customer's profile, order history, and their full support conversation history.

Produce an object with two fields:
- "overview": 2-4 sentences. Who the customer is, total orders and lifetime value, subscription status, and the status of recent/relevant orders (e.g. shipped, delivered, delayed, cancelled). Each order line includes a "delivery:" field (the derived carrier state: unfulfilled/in_transit/out_for_delivery/delivered/failure/cancelled), an optional "sub:" tag (first/recurring subscription order), and tracking when shipped — use these for order status rather than guessing. Call out anything notable (high-value, repeat issues, at-risk of churn).
- "history": an array with ONE entry per support conversation, ordered chronologically (oldest first). Each entry has:
  - "conversationId": the conversation's numeric id (from the "Conversation #<id>" header), or null if unknown.
  - "date": the conversation's start date as YYYY-MM-DD, or null.
  - "status": the conversation status (e.g. "resolved", "open"), or null.
  - "summary": a concise but detailed recap of THAT conversation only — the problem or request, what the agent actually did, anything the agent promised, and the resolution/current status. Be specific: reference order numbers, amounts, and discount codes when present. Do NOT repeat the conversation id/date/status inside this text (they are separate fields).
  If there is no support history, return an empty array.

Rules:
- Be factual. Never invent details that are not in the provided context.
- Only summarize real customer messages and real sent agent replies. Ignore internal private notes / AI draft suggestions entirely.
- Write in English even if the conversation is in another language.`;

/**
 * Resolver (Shopify matcher) system prompt. `{{email}}` is replaced at runtime
 * with the contact's known Chatwoot email (or "unknown").
 */
export const DEFAULT_RESOLVER_SYSTEM_PROMPT_TEMPLATE = `You are a Shopify lookup assistant for Scandi customer support.

A customer has written in, but their Chatwoot contact (email: {{email}}) is NOT linked to a Shopify account that has any orders. They likely ordered using a different email, or they have not ordered yet.

Your ONLY job is to locate their Shopify account using the tools, but ONLY when the information needed is clearly present in their message:
- If the message clearly contains an email address that is different from "{{email}}", call search_customer_by_email with that address.
- If the message clearly contains an order number (e.g. "#1234", "order 1234"), call search_customer_by_order_number with it.
- If it contains both, prefer the order number.
- If the message contains NEITHER a usable alternate email NOR an order number, do NOT call any tool. Just reply with the single word: NONE

After a tool reports a successful match, you are done — reply with the single word: DONE
If a tool reports "not found", you may try the other tool if relevant info is available, otherwise reply NONE.

Do not write any customer-facing message and do not ask the customer questions. Only call tools or reply with NONE / DONE.`;

export const DEFAULT_HOLDING_SYSTEM_PROMPT = `You are a customer support agent at Scandi Gum.
Write a brief, warm holding reply (2 to 3 short sentences) telling the customer their request needs a bit of extra help and that one of our team members will be in touch shortly to take care of it.
Do NOT promise any specific outcome (no refunds, no discounts) or any timeline beyond "shortly". Do NOT try to resolve the issue.
Greet by name when available. Do NOT include any sign-off or signature — the system appends one automatically.
Respond in the customer's language (the language of their latest message). Plain text, no markdown. Do not use em dashes. Output ONLY the message body.`;

// --- Routing labels ---

/** Live-flow labels eligible for the autonomous responder (else hard-escalate). */
export const DEFAULT_AUTO_RESPOND_LABELS = [
  'sub-cancel',
  'order-status',
  'other',
];

/**
 * Intents that get an intent-specific acknowledgement when handed to a human
 * (see `acknowledgeMode`). Intents in neither this set nor the auto-respond set
 * are handed off without a customer-facing message.
 */
export const DEFAULT_ACKNOWLEDGE_LABELS = [
  'refund',
  'sub-cancel',
  'order-status',
  'not-delivered',
  'missing-packs',
  'product-defect',
  'change-address',
  'change-contact',
  'discount-issue',
  'no-country',
  'business',
  'other',
];

/** Stricter backfill-only labels (excludes `other`). */
export const DEFAULT_BACKFILL_AUTO_RESPOND_LABELS = ['sub-cancel', 'order-status'];

// --- Models ---

/** Default model for every AI task (overridable per task via env/admin config). */
export const DEFAULT_MODEL = 'claude-sonnet-5';

/** The full default AI config, derived from env + the constants above. */
export function buildDefaultAiConfig(): AiConfig {
  return {
    // Prompts
    draftSystemPrompt: env.claudeSystemPrompt,
    responderSystemPrompt: env.responderSystemPrompt,
    classifierSystemPrompt: DEFAULT_CLASSIFIER_SYSTEM_PROMPT,
    summarySystemPrompt: DEFAULT_SUMMARY_SYSTEM_PROMPT,
    resolverSystemPromptTemplate: DEFAULT_RESOLVER_SYSTEM_PROMPT_TEMPLATE,
    holdingSystemPrompt: DEFAULT_HOLDING_SYSTEM_PROMPT,
    acknowledgeSystemPrompt: env.acknowledgeSystemPrompt,
    // Models
    draftModel: env.claudeModel,
    responderModel: env.claudeModel,
    classifierModel: env.claudeClassifierModel,
    summaryModel: DEFAULT_MODEL,
    resolverModel: env.claudeModel,
    holdingModel: env.claudeClassifierModel,
    acknowledgeModel: env.claudeModel,
    // Effort: routing decisions get enough thinking to be accurate; short,
    // templated outputs stay cheap and fast.
    draftEffort: 'high',
    responderEffort: 'high',
    classifierEffort: 'medium',
    summaryEffort: 'low',
    resolverEffort: 'low',
    holdingEffort: 'low',
    acknowledgeEffort: 'medium',
    // Routing
    autoRespondLabels: [...DEFAULT_AUTO_RESPOND_LABELS],
    backfillAutoRespondLabels: [...DEFAULT_BACKFILL_AUTO_RESPOND_LABELS],
    holdingReplyEnabled: env.agentBotHoldingReplyEnabled,
    acknowledgeMode: 'shadow',
    acknowledgeLabels: [...DEFAULT_ACKNOWLEDGE_LABELS],
    // AgentBot safety / pacing
    agentBotDebounceSeconds: 30,
    maxBotRepliesPer24h: 3,
    pendingSweepEnabled: true,
    pendingSweepIntervalMinutes: 5,
    pendingSweepMinAgeMinutes: 10,
    pendingSweepReplyMaxAgeHours: 24,
    pendingSweepMaxAgeDays: 30,
    // Numeric knobs. `max_tokens` covers adaptive thinking + the answer, so
    // every limit leaves room for a thinking pass before the output.
    draftMaxTokens: 8000,
    classifierMaxTokens: 4000,
    summaryMaxTokens: 8000,
    holdingMaxTokens: 2000,
    acknowledgeMaxTokens: 4000,
    responderMaxTokens: 8000,
    responderMaxIterations: 5,
    resolverMaxTokens: 4000,
    resolverMaxIterations: 4,
  };
}

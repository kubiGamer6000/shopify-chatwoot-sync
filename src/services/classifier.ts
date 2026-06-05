import * as z from 'zod/v4';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { generateStructured } from './claude.js';
import { buildPrompt, type PromptContext } from '../utils/promptBuilder.js';

/**
 * The classification labels the AI is allowed to assign. Action labels
 * (refund-30/50/70/full, reshipped, changed-address, changed-contact,
 * sub-cancelled, sub-cancelled-ai) are NEVER assignable by the classifier —
 * they record actions taken by an agent/tool.
 */
export const CLASSIFICATION_LABELS = [
  'business',
  'change-address',
  'change-contact',
  'sub-cancel',
  'refund',
  'discount-issue',
  'missing-packs',
  'no-country',
  'not-delivered',
  'order-status',
  'product-defect',
  'other',
] as const;

export type ClassificationLabel = (typeof CLASSIFICATION_LABELS)[number];

/**
 * Labels the autonomous responder is allowed to handle without forcing a human
 * handoff. A conversation whose classification labels are a subset of this set
 * is eligible for the AI responder; anything else is hard-escalated.
 */
export const NON_ESCALATION_LABELS = new Set<ClassificationLabel>([
  'sub-cancel',
  'order-status',
  'other',
]);

const ClassificationSchema = z.object({
  reasoning: z
    .string()
    .describe('One short sentence explaining the chosen labels.'),
  labels: z
    .array(z.enum(CLASSIFICATION_LABELS))
    .describe('All classification labels that apply to this conversation.'),
});

const CLASSIFIER_SYSTEM_PROMPT = `You are a support-ticket classifier for Scandi Gum (a teeth-whitening chewing gum store). You read a customer support conversation and assign one or more labels describing the customer's intent. These labels drive routing: some are handled automatically, others are escalated to a human.

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

RULES:
- Every conversation must get at least one label. If nothing fits, use "other".
- Multiple labels are allowed and expected when the customer raises multiple intents. Examples:
  - "I want to cancel my subscription and my latest order" -> ["sub-cancel", "refund"].
  - "Where is my order? Btw the discount code is also not working" -> ["order-status", "discount-issue"].
- Distinguish carefully between "sub-cancel" (stop future billing) and "refund" (money back / undo an order). A customer can want both.
- You will be shown the labels already on the conversation. Only return labels that genuinely apply based on the full conversation. It is fine to repeat existing applicable labels; the system only ever ADDS labels, never removes them. If no new label is warranted beyond what already applies, just return the applicable label(s).
- Base your decision on the customer's messages (intent), not on agent replies.`;

/**
 * Classifies a conversation into one or more labels using a cheap model. Returns
 * the applicable classification labels, or null on failure (callers should treat
 * a null/empty result as "escalate to be safe").
 */
export async function classifyConversation(
  ctx: PromptContext,
  currentLabels: string[],
): Promise<ClassificationLabel[] | null> {
  const existing =
    currentLabels.length > 0 ? currentLabels.join(', ') : '(none)';

  const userPrompt = [
    `Labels already on this conversation: ${existing}`,
    '',
    'Conversation and customer context:',
    buildPrompt(ctx),
  ].join('\n');

  const result = await generateStructured(
    CLASSIFIER_SYSTEM_PROMPT,
    userPrompt,
    ClassificationSchema,
    { model: env.claudeClassifierModel, maxTokens: 400 },
  );

  if (!result) {
    logger.warn('Conversation classification returned no result', {
      conversationId: ctx.conversationId,
    });
    return null;
  }

  // De-dupe and keep only valid labels (the schema already constrains these).
  const labels = Array.from(new Set(result.labels));
  logger.info('Classified conversation', {
    conversationId: ctx.conversationId,
    labels,
    reasoning: result.reasoning,
  });
  return labels;
}

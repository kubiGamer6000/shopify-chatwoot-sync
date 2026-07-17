import * as z from 'zod/v4';
import { logger } from '../utils/logger.js';
import { generateStructured } from './claude.js';
import { recordClassification } from './aiAudit.js';
import { getAiConfig } from './appConfig.js';
import { buildPrompt, type PromptContext } from '../utils/promptBuilder.js';
import type { AiConfig } from '../types/config.js';

function buildClassifierUserPrompt(
  ctx: PromptContext,
  currentLabels: string[],
): string {
  const existing =
    currentLabels.length > 0 ? currentLabels.join(', ') : '(none)';
  return [
    `Labels already on this conversation: ${existing}`,
    '',
    'Conversation and customer context:',
    buildPrompt(ctx),
  ].join('\n');
}

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

const ClassificationSchema = z.object({
  reasoning: z
    .string()
    .describe('One short sentence explaining the chosen labels.'),
  labels: z
    .array(z.enum(CLASSIFICATION_LABELS))
    .describe('All classification labels that apply to this conversation.'),
});

/**
 * Classifies a conversation into one or more labels using a cheap model. Returns
 * the applicable classification labels, or null on failure (callers should treat
 * a null/empty result as "escalate to be safe").
 */
export async function classifyConversation(
  ctx: PromptContext,
  currentLabels: string[],
): Promise<ClassificationLabel[] | null> {
  const cfg = await getAiConfig();
  const userPrompt = buildClassifierUserPrompt(ctx, currentLabels);

  const result = await generateStructured(
    cfg.classifierSystemPrompt,
    userPrompt,
    ClassificationSchema,
    {
      model: cfg.classifierModel,
      maxTokens: cfg.classifierMaxTokens,
      meta: { kind: 'classify', conversationId: ctx.conversationId },
    },
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
  // Persist the classification decision (best-effort audit).
  void recordClassification({
    conversationId: ctx.conversationId,
    labels,
    reasoning: result.reasoning,
    model: cfg.classifierModel,
  });
  return labels;
}

/**
 * Runs the classifier for the admin prompt tester and returns the exact prompts
 * plus the raw result. Does NOT persist a classification decision or write any
 * labels — purely for inspection/debugging.
 */
export async function classifyForReplay(
  ctx: PromptContext,
  currentLabels: string[],
  cfg: Pick<
    AiConfig,
    'classifierSystemPrompt' | 'classifierModel' | 'classifierMaxTokens'
  >,
): Promise<{
  systemPrompt: string;
  userPrompt: string;
  model: string;
  labels: string[] | null;
  reasoning: string | null;
}> {
  const systemPrompt = cfg.classifierSystemPrompt;
  const userPrompt = buildClassifierUserPrompt(ctx, currentLabels);

  const result = await generateStructured(systemPrompt, userPrompt, ClassificationSchema, {
    model: cfg.classifierModel,
    maxTokens: cfg.classifierMaxTokens,
    meta: { kind: 'classify-replay', conversationId: ctx.conversationId },
  });

  return {
    systemPrompt,
    userPrompt,
    model: cfg.classifierModel,
    labels: result ? Array.from(new Set(result.labels)) : null,
    reasoning: result?.reasoning ?? null,
  };
}

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { structuredCall } from './claude.js';
import { buildClassifierContext } from '../utils/promptBuilder.js';
import { ClassificationSchema } from '../types/ai.js';
import type { Classification } from '../types/ai.js';
import type { PipelineContext } from '../utils/promptBuilder.js';

export async function classify(ctx: PipelineContext): Promise<Classification | null> {
  const systemPrompt = env.classifierPrompt;
  if (!systemPrompt) {
    logger.error('Classifier prompt is empty — check CLASSIFIER_PROMPT env or src/config/prompts/classifier.txt');
    return null;
  }

  const userPrompt = buildClassifierContext(ctx);

  logger.info('Running classifier', { conversationId: ctx.conversationId });

  const result = await structuredCall(systemPrompt, userPrompt, ClassificationSchema);
  if (!result) {
    logger.error('Classifier returned null', { conversationId: ctx.conversationId });
    return null;
  }

  logger.info('Classification result', {
    conversationId: ctx.conversationId,
    intents: result.intents,
    primaryIntent: result.primary_intent,
    sentiment: result.sentiment,
    confidence: result.confidence,
    customerWantsHuman: result.customer_wants_human,
    involvesRefund: result.involves_refund,
  });

  return result;
}

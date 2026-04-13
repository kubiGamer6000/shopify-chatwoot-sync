import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { structuredCall } from './claude.js';
import { buildResponderContext } from '../utils/promptBuilder.js';
import { ResponseSchema } from '../types/ai.js';
import type { AiResponse, Classification } from '../types/ai.js';
import type { PipelineContext } from '../utils/promptBuilder.js';

export async function generateResponse(
  ctx: PipelineContext,
  classification: Classification,
): Promise<AiResponse | null> {
  const systemPrompt = env.responderPrompt;
  if (!systemPrompt) {
    logger.error('Responder prompt is empty — check RESPONDER_PROMPT env or src/config/prompts/responder.txt');
    return null;
  }

  const userPrompt = buildResponderContext(ctx, classification);

  logger.info('Running responder', {
    conversationId: ctx.conversationId,
    primaryIntent: classification.primary_intent,
    intents: classification.intents,
  });

  const result = await structuredCall(systemPrompt, userPrompt, ResponseSchema);
  if (!result) {
    logger.error('Responder returned null', { conversationId: ctx.conversationId });
    return null;
  }

  logger.info('Response generated', {
    conversationId: ctx.conversationId,
    resolved: result.resolved,
    discountApplied: result.discount_applied,
    replyLength: result.customer_reply.length,
  });

  return result;
}

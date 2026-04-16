import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { buildResponderContext } from '../utils/promptBuilder.js';
import type { PipelineContext } from '../utils/promptBuilder.js';
import type { Classification } from '../types/ai.js';

const client = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 3 });

export async function generateHandoffDraft(
  ctx: PipelineContext,
  classification: Classification | null,
): Promise<string | null> {
  const systemPrompt = env.handoffDraftPrompt;
  if (!systemPrompt) {
    logger.warn('Handoff draft prompt is empty — skipping draft generation');
    return null;
  }

  const fakeClassification = classification ?? {
    intents: ['other' as const],
    primary_intent: 'other' as const,
    sentiment: 'neutral' as const,
    confidence: 0,
    customer_wants_human: false,
    involves_refund: false,
    reasoning: 'Classification failed — fallback handoff.',
  };

  const userPrompt = buildResponderContext(ctx, fakeClassification);

  try {
    const response = await client.messages.create({
      model: env.claudeModel,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return null;

    logger.info('Handoff draft generated', {
      conversationId: ctx.conversationId,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    return textBlock.text;
  } catch (err) {
    logger.error('Handoff draft generation failed', {
      conversationId: ctx.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

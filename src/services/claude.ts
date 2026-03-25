import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const client = new Anthropic({ apiKey: env.anthropicApiKey });

export async function generateDraft(
  systemPrompt: string,
  userPrompt: string,
): Promise<string | null> {
  try {
    const response = await client.messages.create({
      model: env.claudeModel,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      logger.warn('Claude returned no text content', {
        stopReason: response.stop_reason,
      });
      return null;
    }

    logger.info('Claude draft generated', {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      stopReason: response.stop_reason,
    });

    return textBlock.text;
  } catch (err) {
    logger.error('Claude API error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

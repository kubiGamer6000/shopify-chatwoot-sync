import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const client = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 3 });

export async function structuredCall<T extends z.ZodType>(
  systemPrompt: string,
  userPrompt: string,
  schema: T,
  model?: string,
): Promise<z.infer<T> | null> {
  try {
    const response = await client.messages.create({
      model: model ?? env.claudeModel,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      output_config: {
        format: zodOutputFormat(schema),
      },
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      logger.warn('Claude structured call returned no text', {
        stopReason: response.stop_reason,
      });
      return null;
    }

    if (response.stop_reason !== 'end_turn') {
      logger.warn('Claude structured call did not finish cleanly', {
        stopReason: response.stop_reason,
      });
      return null;
    }

    logger.info('Claude structured call completed', {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      stopReason: response.stop_reason,
    });

    const parsed = schema.safeParse(JSON.parse(textBlock.text));
    if (!parsed.success) {
      logger.error('Claude structured output failed schema validation', {
        error: parsed.error.message,
      });
      return null;
    }

    return parsed.data as z.infer<T>;
  } catch (err) {
    logger.error('Claude API error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

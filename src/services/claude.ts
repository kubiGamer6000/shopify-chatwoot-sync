import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const client = new Anthropic({ apiKey: env.anthropicApiKey });

const DraftSchema = z.object({
  response: z.string(),
  noteToAgent: z.string().optional(),
});

export interface StructuredDraft {
  response: string;
  noteToAgent?: string;
}

/**
 * Generates a customer-support draft using Claude's native JSON structured
 * outputs, splitting the customer-facing reply from the optional agent-only
 * note. Accepts a full messages array so the same call powers both the initial
 * draft and single-shot revisions. Returns null on refusal or parse failure.
 */
export async function generateStructuredDraft(
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  opts: { maxTokens?: number; model?: string } = {},
): Promise<StructuredDraft | null> {
  try {
    const response = await client.messages.parse({
      model: opts.model ?? env.claudeModel,
      max_tokens: opts.maxTokens ?? 2048,
      system: systemPrompt,
      messages,
      output_config: { format: zodOutputFormat(DraftSchema) },
    });

    if (response.stop_reason === 'refusal') {
      logger.warn('Claude refused the structured draft request');
      return null;
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      logger.warn('Claude structured draft returned no parsed output', {
        stopReason: response.stop_reason,
      });
      return null;
    }

    logger.info('Claude structured draft generated', {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      hasNote: Boolean(parsed.noteToAgent),
    });

    return { response: parsed.response, noteToAgent: parsed.noteToAgent };
  } catch (err) {
    logger.error('Claude structured draft API error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

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

/**
 * Generic single-shot completion. Used for the customer summary (and reusable
 * for other internal AI features). Returns the text content or null on failure.
 */
export async function generateCompletion(
  systemPrompt: string,
  userPrompt: string,
  options: { maxTokens?: number; model?: string } = {},
): Promise<string | null> {
  try {
    const response = await client.messages.create({
      model: options.model ?? env.claudeModel,
      max_tokens: options.maxTokens ?? 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      logger.warn('Claude completion returned no text content', {
        stopReason: response.stop_reason,
      });
      return null;
    }

    logger.info('Claude completion generated', {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    return textBlock.text;
  } catch (err) {
    logger.error('Claude completion API error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

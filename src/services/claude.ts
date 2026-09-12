import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { recordAiUsage } from './aiAudit.js';
import type { AiEffort } from '../types/config.js';

const client = new Anthropic({ apiKey: env.anthropicApiKey });

/** Optional audit metadata callers can attach so token usage is attributable. */
export interface AiCallMeta {
  kind?: string;
  conversationId?: number | null;
  contactId?: number | null;
}

export interface AiCallOptions {
  maxTokens?: number;
  model?: string;
  /** Adaptive-thinking depth. Omitted = API default (`high`). */
  effort?: AiEffort;
  meta?: AiCallMeta;
}

/**
 * System prompt as a cacheable block. The prompts are static per config
 * version and render before the per-conversation user message, so repeated
 * calls across conversations reuse the cached prefix. Prompts below the
 * model's minimum cacheable length are simply not cached.
 */
export function cachedSystem(systemPrompt: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
}

/** Adaptive thinking: the model decides per request how much to think. */
export const ADAPTIVE_THINKING = { type: 'adaptive' } as const;

/** `output_config.effort` when set (omitted = API default `high`). */
export function effortConfig(effort?: AiEffort): { effort?: AiEffort } {
  return effort ? { effort } : {};
}

function usageLog(usage: Anthropic.Usage) {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function recordUsage(kind: string, model: string, usage: Anthropic.Usage, meta?: AiCallMeta) {
  void recordAiUsage({
    kind,
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    conversationId: meta?.conversationId ?? null,
    contactId: meta?.contactId ?? null,
  });
}

const DraftSchema = z.object({
  response: z.string(),
  noteToAgent: z.string().optional(),
  // English translation of the customer's message. Populated ONLY when the
  // customer wrote in a non-English language. Kept strictly separate from
  // `response` so it can never be sent to the customer.
  customerMessageTranslation: z.string().optional(),
});

export interface StructuredDraft {
  response: string;
  noteToAgent?: string;
  customerMessageTranslation?: string;
}

/**
 * Generic single-shot structured completion: returns Claude's reply parsed and
 * validated against a Zod schema (via native JSON structured outputs), or null
 * on refusal / parse failure. `userContent` may include image blocks.
 */
export async function generateStructured<T>(
  systemPrompt: string,
  userContent: string | Anthropic.ContentBlockParam[],
  schema: z.ZodType<T>,
  opts: AiCallOptions = {},
): Promise<T | null> {
  return generateStructuredMessages(
    systemPrompt,
    [{ role: 'user', content: userContent }],
    schema,
    { ...opts, meta: { kind: 'structured', ...opts.meta } },
  );
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
  opts: AiCallOptions = {},
): Promise<StructuredDraft | null> {
  const parsed = await generateStructuredMessages(systemPrompt, messages, DraftSchema, {
    ...opts,
    meta: { kind: 'draft', ...opts.meta },
  });
  if (!parsed) return null;
  return {
    response: parsed.response,
    noteToAgent: parsed.noteToAgent,
    customerMessageTranslation: parsed.customerMessageTranslation,
  };
}

/** Structured (JSON schema) completion over a full messages array. */
async function generateStructuredMessages<T>(
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  schema: z.ZodType<T>,
  opts: AiCallOptions,
): Promise<T | null> {
  const model = opts.model ?? env.claudeModel;
  try {
    const response = await client.messages.parse({
      model,
      max_tokens: opts.maxTokens ?? 8000,
      thinking: ADAPTIVE_THINKING,
      system: cachedSystem(systemPrompt),
      messages,
      output_config: { ...effortConfig(opts.effort), format: zodOutputFormat(schema) },
    });

    if (response.stop_reason === 'refusal') {
      logger.warn('Claude refused the structured request', { kind: opts.meta?.kind });
      return null;
    }

    const parsed = response.parsed_output;
    if (parsed == null) {
      logger.warn('Claude structured output was not parsed', {
        kind: opts.meta?.kind,
        stopReason: response.stop_reason,
      });
      return null;
    }

    logger.info('Claude structured output generated', {
      kind: opts.meta?.kind,
      ...usageLog(response.usage),
    });
    recordUsage(opts.meta?.kind ?? 'structured', model, response.usage, opts.meta);

    return parsed;
  } catch (err) {
    logger.error('Claude structured request API error', {
      kind: opts.meta?.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Generic single-shot text completion (e.g. holding replies). Returns the text
 * content or null on failure.
 */
export async function generateCompletion(
  systemPrompt: string,
  userPrompt: string,
  options: AiCallOptions = {},
): Promise<string | null> {
  const model = options.model ?? env.claudeModel;
  try {
    const response = await client.messages.create({
      model,
      max_tokens: options.maxTokens ?? 4000,
      thinking: ADAPTIVE_THINKING,
      output_config: effortConfig(options.effort),
      system: cachedSystem(systemPrompt),
      messages: [{ role: 'user', content: userPrompt }],
    });

    if (response.stop_reason === 'refusal') {
      logger.warn('Claude refused the completion request', { kind: options.meta?.kind });
      return null;
    }

    // With thinking on, the first block is a thinking block; join all text.
    const text = response.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();
    if (!text || response.stop_reason === 'max_tokens') {
      logger.warn('Claude completion returned no usable text', {
        kind: options.meta?.kind,
        stopReason: response.stop_reason,
      });
      return null;
    }

    logger.info('Claude completion generated', {
      kind: options.meta?.kind,
      ...usageLog(response.usage),
    });
    recordUsage(options.meta?.kind ?? 'completion', model, response.usage, options.meta);

    return text;
  } catch (err) {
    logger.error('Claude completion API error', {
      kind: options.meta?.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

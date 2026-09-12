/**
 * Intent-specific acknowledgements: when a conversation goes to a human, the
 * customer instantly gets a short reply that shows we understood the request
 * and asks for exactly what the agent will need, plus an internal handoff note
 * for the agent. Never promises an outcome (enforced by the prompt, and the
 * reply-safety guard vets the message).
 */
import * as z from 'zod/v4';
import { generateStructured } from './claude.js';
import { toUserContent, type CustomerImage } from './attachments.js';
import { buildPrompt, type PromptContext } from '../utils/promptBuilder.js';
import { vetResponderReply } from '../utils/responderFormat.js';
import type { AiConfig } from '../types/config.js';

const AcknowledgementSchema = z.object({
  message: z
    .string()
    .describe(
      'The customer-facing message body only: greeting, acknowledgement, and any questions. No sign-off, no reasoning, no internal notes.',
    ),
  askedFor: z
    .array(z.string())
    .describe('Short list of the information the message asks the customer for (empty if none).'),
  handoffNote: z
    .string()
    .describe(
      'Internal note for the human agent (2-4 sentences): what the customer wants, what is already known (order, tracking, attachments), what was asked for, and the suggested next step.',
    ),
});

export interface Acknowledgement {
  /** Send-ready message (vetted body + signature). Empty when blocked. */
  message: string;
  /** Raw model message, kept for debugging blocked output. */
  rawMessage: string;
  askedFor: string[];
  handoffNote: string;
  guardOk: boolean;
  violations: string[];
}

export interface AcknowledgementRequest {
  ctx: PromptContext;
  images: CustomerImage[];
  /** Intents in play (from routing). */
  intents: string[];
  /** Why a human is needed. */
  reason: string;
  /** Customer's language per the classifier, when known. */
  language: string | null;
}

export function buildAcknowledgementPrompt(req: AcknowledgementRequest): string {
  return [
    buildPrompt(req.ctx),
    [
      '--- HANDOFF ---',
      `Intents in this conversation: ${req.intents.join(', ') || '(unclear)'}`,
      `Why a human is taking over: ${req.reason}`,
      `Customer's language: ${req.language ?? 'unknown (match the language of their latest message)'}`,
    ].join('\n'),
  ].join('\n\n');
}

/**
 * Generates and vets an acknowledgement. Returns null when generation fails;
 * a result with `guardOk: false` must not be sent.
 */
export async function generateAcknowledgement(
  req: AcknowledgementRequest,
  cfg: Pick<
    AiConfig,
    'acknowledgeSystemPrompt' | 'acknowledgeModel' | 'acknowledgeEffort' | 'acknowledgeMaxTokens'
  >,
  kind = 'acknowledge',
): Promise<Acknowledgement | null> {
  if (!cfg.acknowledgeSystemPrompt) return null;

  const result = await generateStructured(
    cfg.acknowledgeSystemPrompt,
    toUserContent(buildAcknowledgementPrompt(req), req.images),
    AcknowledgementSchema,
    {
      model: cfg.acknowledgeModel,
      maxTokens: cfg.acknowledgeMaxTokens,
      effort: cfg.acknowledgeEffort,
      meta: { kind, conversationId: req.ctx.conversationId },
    },
  );
  if (!result) return null;

  const vetted = vetResponderReply(result.message, req.language);
  return {
    message: vetted.content,
    rawMessage: result.message,
    askedFor: result.askedFor,
    handoffNote: result.handoffNote,
    guardOk: vetted.ok,
    violations: vetted.violations,
  };
}

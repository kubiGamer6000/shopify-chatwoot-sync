import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { gatherContextWithMatching, postAiDraft } from './aiDraft.js';
import {
  classifyConversation,
  type Classification,
  type ClassificationLabel,
} from './classifier.js';
import { decideRoute, type RouteKind } from './agentBotRouting.js';
import { generateAcknowledgement } from './acknowledger.js';
import { hasPublicReply, onlyAutoRepliesUnanswered, startedByUs } from './autoReply.js';
import {
  getConversationLabels,
  addConversationLabels,
  sendReply,
  postPrivateNote,
  setConversationStatus,
  resolveConversation,
} from './chatwootConversation.js';
import { cancelActiveSubscriptionsByEmail } from './skio.js';
import {
  ADAPTIVE_THINKING,
  cachedSystem,
  effortConfig,
  generateCompletion,
} from './claude.js';
import {
  recordAiUsage,
  recordAgentBotDecision,
  recordResponderGuardEvent,
  recordSentReply,
  recordShadowAcknowledgement,
  countRecentBotMessages,
} from './aiAudit.js';
import { getAiConfig } from './appConfig.js';
import {
  gatherCustomerImages,
  toUserContent,
  type CustomerImage,
} from './attachments.js';
import type { AiConfig } from '../types/config.js';
import { buildPrompt, type PromptContext } from '../utils/promptBuilder.js';
import {
  vetResponderReply,
  vetHoldingReply,
  type VettedHoldingReply,
} from '../utils/responderFormat.js';

const client = new Anthropic({ apiKey: env.anthropicApiKey });

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Everything needed to act on (reply to / hand off) one conversation. */
interface ConversationTarget {
  conversationId: number;
  contactId: number;
  email?: string | null;
  ctx: PromptContext;
  images: CustomerImage[];
  /** Customer's language per the classifier, when known. */
  language: string | null;
  /** Intents in play, for acknowledgements and the handoff note. */
  intents: string[];
}

/**
 * Crafts a short, context-aware holding reply for the hard-escalation path
 * (where no responder agent runs), vetted for customer safety. Falls back to a
 * fixed message when generation fails or the result is not customer-safe.
 */
async function generateHoldingReply(
  ctx: PromptContext,
  language: string | null,
): Promise<VettedHoldingReply> {
  const cfg = await getAiConfig();
  const reply = await generateCompletion(cfg.holdingSystemPrompt, buildPrompt(ctx), {
    model: cfg.holdingModel,
    maxTokens: cfg.holdingMaxTokens,
    effort: cfg.holdingEffort,
    meta: { kind: 'holding', conversationId: ctx.conversationId },
  });

  return vetHoldingReply(reply ?? '', ctx.customerName, language);
}

/**
 * Sends a holding reply, swapping in the canned fallback if the generated one
 * failed the customer-safety guard.
 */
async function sendHoldingReply(
  conversationId: number,
  holding: VettedHoldingReply,
): Promise<void> {
  if (holding.usedFallback) {
    logger.warn('Holding reply failed the safety guard — sent canned fallback', {
      conversationId,
      violations: holding.violations,
    });
    void recordResponderGuardEvent({
      conversationId,
      outcome: 'holding-fallback',
      source: 'holding_reply',
      violations: holding.violations,
    });
  }
  await sendBotMessage(conversationId, holding.content, 'agent-bot-holding');
}

/** Sends a public bot message and records it (drives the per-conversation cap). */
async function sendBotMessage(
  conversationId: number,
  content: string,
  source: 'agent-bot' | 'agent-bot-holding',
): Promise<void> {
  await sendReply(conversationId, content);
  void recordSentReply({ conversationId, message: content, source });
}

/**
 * What the customer hears when a conversation is handed to a human:
 * - `acknowledge`: an intent-specific acknowledgement (live mode), or the
 *   legacy holding reply (off/shadow modes, when holding replies are enabled).
 * - `none`: nothing.
 */
type HandoffMessage = 'acknowledge' | 'none';

/**
 * Picks and sends the customer-facing handoff message. Returns what was sent
 * (null when nothing was) plus acknowledgement details for the agent's note.
 */
async function sendHandoffMessage(
  target: ConversationTarget,
  reason: string,
  agentHoldingReply: string | undefined,
): Promise<{ sent: string | null; askedFor: string[]; note: string | null }> {
  const { conversationId, ctx } = target;
  const cfg = await getAiConfig();
  const request = {
    ctx,
    images: target.images,
    intents: target.intents,
    reason,
    language: target.language,
  };

  if (cfg.acknowledgeMode === 'live') {
    const ack = await generateAcknowledgement(request, cfg);
    if (ack?.guardOk) {
      await sendBotMessage(conversationId, ack.message, 'agent-bot-holding');
      return { sent: ack.message, askedFor: ack.askedFor, note: ack.handoffNote };
    }
    if (ack && !ack.guardOk) {
      void recordResponderGuardEvent({
        conversationId,
        outcome: 'blocked',
        source: 'holding_reply',
        violations: ack.violations,
        blockedText: ack.rawMessage,
      });
    }
    // Generation failed or was unsafe: the agent's holding reply or the canned
    // fallback still tells the customer a person is on it.
    const holding = vetHoldingReply(agentHoldingReply ?? '', ctx.customerName, target.language);
    await sendHoldingReply(conversationId, holding);
    return { sent: holding.content, askedFor: [], note: null };
  }

  let sent: string | null = null;
  if (cfg.holdingReplyEnabled) {
    const holding =
      agentHoldingReply !== undefined
        ? vetHoldingReply(agentHoldingReply, ctx.customerName, target.language)
        : await generateHoldingReply(ctx, target.language);
    await sendHoldingReply(conversationId, holding);
    sent = holding.content;
  }

  if (cfg.acknowledgeMode === 'shadow') {
    // Record what the acknowledgement would have been, without sending it (in
    // the background, so the agent's draft isn't delayed).
    void generateAcknowledgement(request, cfg, 'acknowledge-shadow').then((ack) => {
      if (!ack) return;
      void recordShadowAcknowledgement({
        conversationId,
        intents: target.intents,
        language: target.language,
        reason,
        wouldSend: ack.message,
        askedFor: ack.askedFor,
        handoffNote: ack.handoffNote,
        guardOk: ack.guardOk,
        violations: ack.violations,
        model: cfg.acknowledgeModel,
      });
    });
  }
  return { sent, askedFor: [], note: null };
}

/**
 * Hands a conversation to a human: moves it to `open`, sends the handoff
 * message (see `HandoffMessage`), and posts an escalation draft headed by a
 * handoff summary (why, intents, what the customer was told and asked for).
 *
 * The status change happens FIRST and every step is independent, so a failure
 * in the message or draft (or a crash mid-way) can never leave the
 * conversation stuck in `pending`, where agents don't see it.
 *
 * `agentHoldingReply` is the responder agent's own holding reply (tool
 * escalation), used when no acknowledgement is sent.
 */
async function escalateToHuman(
  target: ConversationTarget,
  opts: { reason: string; message: HandoffMessage; agentHoldingReply?: string },
): Promise<void> {
  const { conversationId, contactId, email, ctx, images } = target;
  const { reason } = opts;

  try {
    await setConversationStatus(conversationId, 'open');
  } catch (err) {
    logger.error('Escalation: failed to open conversation', {
      conversationId,
      error: errMessage(err),
    });
  }

  let handoff: { sent: string | null; askedFor: string[]; note: string | null } = {
    sent: null,
    askedFor: [],
    note: null,
  };
  if (opts.message === 'acknowledge') {
    try {
      handoff = await sendHandoffMessage(target, reason, opts.agentHoldingReply);
    } catch (err) {
      logger.error('Escalation: failed to send handoff message', {
        conversationId,
        error: errMessage(err),
      });
    }
  }

  try {
    await postAiDraft({
      conversationId,
      contactId,
      email,
      escalation: true,
      context: ctx,
      images,
      handoff: {
        reason,
        intents: target.intents,
        customerMessage: handoff.sent,
        askedFor: handoff.askedFor,
        note: handoff.note,
      },
    });
  } catch (err) {
    logger.error('Escalation: failed to post escalation draft', {
      conversationId,
      error: errMessage(err),
    });
  }

  logger.info('Escalated conversation to a human', {
    conversationId,
    reason,
    customerMessageSent: handoff.sent !== null,
  });
}

/**
 * Resolves a conversation that needs no reply (auto-reply, spam, a closing
 * "thanks"), leaving a private note so agents can see why.
 */
async function closeSilently(conversationId: number, reason: string): Promise<void> {
  try {
    await postPrivateNote(conversationId, `[AI] Closed without reply: ${reason}.`);
  } catch (err) {
    logger.warn('Failed to post close note', { conversationId, error: errMessage(err) });
  }
  try {
    await resolveConversation(conversationId);
  } catch (err) {
    // Leave it for a human rather than stuck in pending.
    logger.error('Failed to resolve silently closed conversation', {
      conversationId,
      error: errMessage(err),
    });
    await setConversationStatus(conversationId, 'open').catch(() => undefined);
  }
  logger.info('Closed conversation without reply', { conversationId, reason });
}

const ESCALATE_TOOL_DESC =
  'Hand this conversation off to a human support agent. Call this whenever the ' +
  'request is anything other than a clean subscription cancellation or an ' +
  'order-status question — including ANY refund/return/order-cancellation ' +
  'request (even combined with a sub cancellation), address or contact changes, ' +
  'discount-code problems, missing packs, product defects, a parcel marked ' +
  'delivered but not received, business inquiries, an angry/threatening ' +
  'customer, an explicit request for a human, or any case you are not confident ' +
  'you can fully and safely resolve. Provide a brief internal reason and a ' +
  'short, friendly, context-aware holding_reply to send to the customer now. ' +
  'After calling this you are done; do not write any further reply.';

const SEND_REPLY_TOOL_DESC =
  'Send your final reply to the customer. The `message` argument must contain ' +
  'ONLY the customer-facing message body: the greeting and your reply, with no ' +
  'sign-off. It must never contain your reasoning, case or step numbers, label ' +
  'or tool names, references to your instructions, or any sentence about the ' +
  'customer written in the third person. Any text you write outside this ' +
  'argument is discarded and never reaches the customer. Call this once when ' +
  'you are ready to answer; after calling it you are done.';

const CANCEL_TOOL_DESC =
  "Cancel the customer's active Skio subscription(s) and stop all future " +
  'rebilling, then label the conversation as cancelled-by-AI. Use this ONLY ' +
  'when the customer wants to cancel their subscription AND either we have ' +
  'already sent them the self-service cancellation link earlier in this ' +
  'conversation and they insist we do it for them, or they explicitly say they ' +
  "will not use the website / want it done for them. It uses the customer's " +
  'linked account email automatically (no input needed). After it confirms ' +
  'success, call `send_reply` with a short message confirming the cancellation. ' +
  'Never claim a cancellation without calling this tool first.';

interface ResponderToolHandlers {
  sendReply: (message: string) => Promise<string>;
  escalate: (input: { reason: string; holding_reply: string }) => Promise<string>;
  cancelSubscription: () => Promise<string>;
}

/**
 * The responder's tool set. Shared by the live run and the prompt tester so the
 * two can never drift; only the handlers differ. `cancel_subscription` is only
 * exposed when the conversation is a sub-cancel.
 */
function buildResponderTools(labels: ClassificationLabel[], handlers: ResponderToolHandlers) {
  const sendReplyTool = betaZodTool({
    name: 'send_reply',
    description: SEND_REPLY_TOOL_DESC,
    inputSchema: z.object({
      message: z
        .string()
        .describe(
          'The customer-facing message body only (greeting + reply, NO sign-off, no reasoning or internal commentary).',
        ),
    }),
    run: ({ message }) => handlers.sendReply(message),
  });

  const escalateTool = betaZodTool({
    name: 'escalate_to_human',
    description: ESCALATE_TOOL_DESC,
    inputSchema: z.object({
      reason: z
        .string()
        .describe('Brief internal reason for escalating (not shown to the customer).'),
      holding_reply: z
        .string()
        .describe(
          'The short, friendly, context-aware message body to send to the customer now (greeting + message only, NO sign-off). Tells them a team member will be in touch shortly. Never promises a specific outcome.',
        ),
    }),
    run: (input) => handlers.escalate(input),
  });

  const cancelTool = betaZodTool({
    name: 'cancel_subscription',
    description: CANCEL_TOOL_DESC,
    inputSchema: z.object({}),
    run: () => handlers.cancelSubscription(),
  });

  return labels.includes('sub-cancel')
    ? [sendReplyTool, escalateTool, cancelTool]
    : [sendReplyTool, escalateTool];
}

/**
 * Runs the responder tool loop and returns the final message plus token usage
 * summed across every turn of the loop.
 */
async function runResponderLoop(
  cfg: AiConfig,
  tools: ReturnType<typeof buildResponderTools>,
  content: string | Anthropic.ContentBlockParam[],
): Promise<{ finalMessage: Anthropic.Beta.BetaMessage; inputTokens: number; outputTokens: number }> {
  const runner = client.beta.messages.toolRunner({
    model: cfg.responderModel,
    max_tokens: cfg.responderMaxTokens,
    max_iterations: cfg.responderMaxIterations,
    thinking: ADAPTIVE_THINKING,
    output_config: effortConfig(cfg.responderEffort),
    // One tool call per turn, as the prompt requires: the agent can't confirm a
    // cancellation in the same turn it requests one.
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    system: cachedSystem(cfg.responderSystemPrompt),
    tools,
    messages: [{ role: 'user', content }],
  });

  let finalMessage: Anthropic.Beta.BetaMessage | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  for await (const message of runner) {
    finalMessage = message;
    inputTokens += message.usage.input_tokens;
    outputTokens += message.usage.output_tokens;
  }
  if (!finalMessage) throw new Error('Responder tool loop produced no message');
  return { finalMessage, inputTokens, outputTokens };
}

function finalText(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}

interface ResponderOutcome {
  action: 'responded' | 'escalated' | 'skipped';
  reason: string | null;
}

/**
 * Runs the autonomous responder agent for an eligible conversation. Sends the
 * agent's vetted reply and resolves the conversation, or hands it to a human.
 *
 * Side effects wait until the loop ends (except `cancel_subscription`, whose
 * result the agent needs): a reply is sent once, and an escalation keeps the
 * agent's tailored holding reply even if the loop later errors.
 *
 * `noEscalate` (backfill): wherever the live flow would escalate, the
 * conversation is left completely untouched and the outcome is 'skipped'.
 */
async function runResponderAgent(
  target: ConversationTarget & { labels: ClassificationLabel[]; noEscalate?: boolean },
): Promise<ResponderOutcome> {
  const { conversationId, contactId, ctx, images, labels, noEscalate } = target;
  const cfg = await getAiConfig();

  const handOff = async (reason: string, agentHoldingReply?: string): Promise<ResponderOutcome> => {
    if (noEscalate) {
      logger.info('Responder did not answer — skipping (backfill, no escalation)', {
        conversationId,
        reason,
      });
      return { action: 'skipped', reason };
    }
    await escalateToHuman(target, { reason, message: 'acknowledge', agentHoldingReply });
    return { action: 'escalated', reason };
  };

  if (!cfg.responderSystemPrompt) return handOff('responder prompt not configured');

  // Written by the tool handlers during the loop, acted on after it.
  const state: {
    reply: string | null;
    escalation: { reason: string; holding_reply: string } | null;
  } = { reply: null, escalation: null };

  const tools = buildResponderTools(labels, {
    sendReply: async (message) => {
      state.reply = message;
      return 'Reply accepted and will be sent. You are done; do not write any further message.';
    },
    escalate: async (input) => {
      state.escalation = input;
      return noEscalate
        ? 'Escalation is disabled in this run. Do NOT send any reply or message. You are done.'
        : 'The conversation will be handed to a human. You are done; do not write any further message.';
    },
    cancelSubscription: async () => {
      const lookupEmail = ctx.customerEmail;
      if (!lookupEmail) {
        return 'No email on file to look up the subscription. Use send_reply to ask the customer for the email used at checkout, or escalate.';
      }
      try {
        const result = await cancelActiveSubscriptionsByEmail(lookupEmail);
        if (result.cancelled > 0) {
          await addConversationLabels(conversationId, ['sub-cancelled-ai']);
          return `Successfully cancelled ${result.cancelled} active subscription(s). Confirm the cancellation to the customer with send_reply.`;
        }
        if (result.activeFound === 0) {
          return 'No active subscription was found for this customer. Do not claim a cancellation. Use send_reply to tell the customer you could not find an active subscription on their account, or escalate if they insist.';
        }
        return 'Active subscription(s) were found but the cancellation failed. Do not claim success — escalate to a human.';
      } catch (err) {
        logger.warn('cancel_subscription tool failed', { conversationId, error: errMessage(err) });
        return 'The cancellation could not be completed due to an internal error. Do not claim success — escalate to a human.';
      }
    },
  });

  let freeText: string;
  try {
    const run = await runResponderLoop(cfg, tools, toUserContent(buildPrompt(ctx), images));
    freeText = finalText(run.finalMessage);
    void recordAiUsage({
      kind: 'responder',
      model: cfg.responderModel,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      conversationId,
      contactId,
    });
  } catch (err) {
    logger.error('Responder agent run failed', { conversationId, error: errMessage(err) });
    if (state.escalation) {
      return handOff(`agent: ${state.escalation.reason}`, state.escalation.holding_reply);
    }
    return handOff('responder agent error');
  }

  // An escalation wins over any reply: the customer must not get both.
  if (state.escalation) {
    return handOff(`agent: ${state.escalation.reason}`, state.escalation.holding_reply);
  }

  // Preferred path: the message the agent passed to `send_reply`. Free-form
  // text from the final turn is only a fallback for when the agent answered
  // without the tool — it is the path that leaked reasoning in #7775, so it
  // gets the same vetting.
  const source = state.reply !== null ? 'send_reply' : 'free-text';
  const candidate = state.reply ?? freeText;

  if (!candidate) return handOff('no final reply produced');

  // Last line of defence: internal reasoning, prompt scaffolding or agent
  // notes must never reach a customer. A rejected reply goes to a human.
  const vetted = vetResponderReply(candidate, target.language);

  if (!vetted.ok) {
    logger.error('Responder reply blocked by the customer-safety guard', {
      conversationId,
      source,
      violations: vetted.violations,
    });
    void recordResponderGuardEvent({
      conversationId,
      outcome: 'blocked',
      source,
      violations: vetted.violations,
      blockedText: candidate,
    });
    return handOff(`reply blocked by safety guard (${vetted.violations.join(', ')})`);
  }

  if (vetted.strippedPreamble || source === 'free-text') {
    logger.warn('Responder reply needed cleanup before sending', {
      conversationId,
      source,
      strippedPreamble: vetted.strippedPreamble,
    });
    void recordResponderGuardEvent({
      conversationId,
      outcome: vetted.strippedPreamble ? 'preamble-stripped' : 'missing-send-reply-tool',
      source,
      violations: [],
    });
  }

  try {
    await sendBotMessage(conversationId, vetted.content, 'agent-bot');
  } catch (err) {
    logger.error('Failed to send responder reply', { conversationId, error: errMessage(err) });
    return handOff('sending the reply failed');
  }

  // The customer has their answer. Bookkeeping failures from here on must not
  // escalate, which would follow the answer with a contradictory holding reply.
  await addConversationLabels(conversationId, ['ai-response']);
  try {
    await resolveConversation(conversationId);
  } catch (err) {
    logger.error('Reply sent but failed to resolve conversation', {
      conversationId,
      error: errMessage(err),
    });
  }
  logger.info('Responder replied and resolved conversation', { conversationId, source });
  return { action: 'responded', reason: null };
}

export interface ResponderReplayResult {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  toolNames: string[];
  /** Raw free-form text from the agent's final turn (never sent on its own). */
  text: string;
  /** The message the agent passed to `send_reply`, if it used the tool. */
  replyMessage: string | null;
  /** What the safety guard would do with the candidate reply. */
  guard: {
    ok: boolean;
    violations: string[];
    strippedPreamble: boolean;
    /** Exactly what would be sent to the customer (empty when blocked). */
    wouldSend: string;
  };
  toolInvocations: { name: string; input: unknown }[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Runs the responder tool loop for the admin prompt tester with STUBBED tools:
 * every tool records its invocation and returns a canned string but performs
 * NO Chatwoot/Skio/side-effecting actions. Returns the exact prompt, the
 * candidate reply text, and any tool calls the agent made.
 */
export async function runResponderReplay(params: {
  ctx: PromptContext;
  labels: ClassificationLabel[];
  cfg: AiConfig;
  images?: CustomerImage[];
  language?: string | null;
}): Promise<ResponderReplayResult> {
  const { ctx, labels, cfg, images = [], language = null } = params;
  const userPrompt = buildPrompt(ctx);
  const toolInvocations: { name: string; input: unknown }[] = [];
  const state: { reply: string | null } = { reply: null };

  const tools = buildResponderTools(labels, {
    sendReply: async (message) => {
      toolInvocations.push({ name: 'send_reply', input: { message } });
      state.reply = message;
      return 'Reply accepted (REPLAY: nothing sent). You are done; do not write any further message.';
    },
    escalate: async (input) => {
      toolInvocations.push({ name: 'escalate_to_human', input });
      return 'Conversation escalated to a human (REPLAY: no actions performed). You are done; do not write any further message.';
    },
    cancelSubscription: async () => {
      toolInvocations.push({ name: 'cancel_subscription', input: {} });
      return 'Subscription cancelled (REPLAY: no actions performed). Confirm the cancellation to the customer.';
    },
  });

  const { finalMessage, inputTokens, outputTokens } = await runResponderLoop(
    cfg,
    tools,
    toUserContent(userPrompt, images),
  );
  const text = finalText(finalMessage);

  // Mirror the live send path so the tester previews the real outcome.
  const vetted = vetResponderReply(state.reply ?? text, language);

  return {
    systemPrompt: cfg.responderSystemPrompt,
    userPrompt,
    model: cfg.responderModel,
    toolNames: tools.map((t) => t.name),
    text,
    replyMessage: state.reply,
    guard: {
      ok: vetted.ok,
      violations: vetted.violations,
      strippedPreamble: vetted.strippedPreamble,
      wouldSend: vetted.content,
    },
    toolInvocations,
    usage: { inputTokens, outputTokens },
  };
}

export type AgentBotAction =
  | 'responded'
  | 'escalated'
  | 'handed-off'
  | 'closed'
  | 'skipped'
  | 'failed'
  | 'would-respond'
  | 'would-acknowledge'
  | 'would-hand-off'
  | 'would-close'
  | 'would-skip';

export interface AgentBotRunResult {
  conversationId: number;
  classification: Classification | null;
  /** Intents the routing acted on. */
  intents: ClassificationLabel[];
  route: RouteKind | null;
  action: AgentBotAction;
  /** Why it escalated / handed off / closed / skipped / failed; null when answered. */
  reason: string | null;
}

/** A conversation for the AgentBot to process. */
export interface AgentBotJob {
  conversationId: number;
  contactId: number;
  email?: string | null;
}

const DRY_RUN_ACTION: Record<RouteKind, AgentBotAction> = {
  respond: 'would-respond',
  acknowledge: 'would-acknowledge',
  handoff: 'would-hand-off',
  close: 'would-close',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Persists a routing decision (best-effort) and returns the result unchanged.
 * Dry-run outcomes ('would-*') are informational only and never recorded.
 */
function finish(result: AgentBotRunResult): AgentBotRunResult {
  if (!result.action.startsWith('would-')) {
    void recordAgentBotDecision({
      conversationId: result.conversationId,
      classified: result.classification?.labels ?? null,
      routingLabels: result.intents,
      intents: result.intents,
      route: result.route,
      action: result.action,
      reason: result.reason,
    });
  }
  return result;
}

/**
 * Core AgentBot flow for a single conversation:
 *
 * 1. Gather context (with Shopify matching) and customer images.
 * 2. Detect machine-generated messages from email headers; otherwise classify
 *    and merge labels (add-only, for tagging).
 * 3. Route on the intents that need handling now (`decideRoute`): answer via
 *    the responder, hand off with an acknowledgement, hand off silently, or
 *    close silently when nothing needs a reply.
 * 4. Before sending anything, enforce the per-conversation bot message cap.
 *
 * `dryRun`: nothing is mutated (no labels, replies, status changes, drafts or
 * contact links); only the routing decision is reported.
 *
 * `backfill`: never escalates. Only conversations routed to the responder whose
 * intents are all in `backfillAutoRespondLabels` get a response; everything
 * else is left untouched.
 */
export async function processAgentBotConversation(
  job: AgentBotJob,
  opts: { dryRun?: boolean; backfill?: boolean } = {},
): Promise<AgentBotRunResult> {
  const { conversationId, contactId, email } = job;
  const dryRun = opts.dryRun ?? false;
  const backfill = opts.backfill ?? false;
  const cfg = await getAiConfig();

  // 1. Context + Shopify matching, and customer images (fetched once, shared by
  //    the classifier, the responder, acknowledgements and any draft).
  const { context: ctx } = await gatherContextWithMatching(
    { conversationId, contactId, email },
    { dryRun },
  );
  const images = await gatherCustomerImages(ctx.currentMessages).catch(() => []);

  // 2. Machine-generated messages need no classification (and no reply).
  const autoReply = onlyAutoRepliesUnanswered(ctx.currentMessages);
  let classification: Classification | null = null;
  if (!autoReply.auto) {
    const currentLabels = await getConversationLabels(conversationId);
    classification = await classifyConversation(ctx, currentLabels, images);
    if (!dryRun && classification && classification.labels.length > 0) {
      await addConversationLabels(conversationId, classification.labels);
    }
  }

  // 3. Routing.
  const decision = decideRoute({
    classification,
    cfg,
    autoReplyDetected: autoReply.auto,
    hasPublicReply: hasPublicReply(ctx.currentMessages),
    customerHasOrders: ctx.orders.length > 0,
    startedByUs: startedByUs(ctx.currentMessages),
  });
  const { intents } = decision;
  const reason =
    autoReply.auto && decision.reason
      ? `${decision.reason}: ${autoReply.signals.join('; ')}`
      : decision.reason;
  const base = { conversationId, classification, intents, route: decision.route };
  const target: ConversationTarget = {
    conversationId,
    contactId,
    email,
    ctx,
    images,
    language: classification?.language ?? null,
    intents,
  };

  if (backfill) {
    const backfillSet = new Set<string>(cfg.backfillAutoRespondLabels);
    const eligible =
      decision.route === 'respond' && intents.every((i) => backfillSet.has(i));
    const skipReason = eligible ? null : (reason ?? 'not backfill-eligible');
    if (dryRun) {
      return finish({ ...base, action: eligible ? 'would-respond' : 'would-skip', reason: skipReason });
    }
    if (!eligible) return finish({ ...base, action: 'skipped', reason: skipReason });
    const outcome = await runResponderAgent({ ...target, labels: intents, noEscalate: true });
    return finish({ ...base, ...outcome });
  }

  if (dryRun) {
    return finish({ ...base, action: DRY_RUN_ACTION[decision.route], reason });
  }

  // 4. Never let the bot message a conversation without limit (e.g. loops with
  //    an auto-responder the detector missed).
  if (decision.route === 'respond' || decision.route === 'acknowledge') {
    const recent = await countRecentBotMessages(conversationId, Date.now() - DAY_MS);
    if (recent >= cfg.maxBotRepliesPer24h) {
      const capReason = `bot message cap reached (${recent} in 24h)`;
      await escalateToHuman(target, { reason: capReason, message: 'none' });
      return finish({ ...base, action: 'handed-off', reason: capReason });
    }
  }

  switch (decision.route) {
    case 'close':
      await closeSilently(conversationId, reason ?? 'no reply needed');
      return finish({ ...base, action: 'closed', reason });
    case 'handoff':
      await escalateToHuman(target, { reason: reason ?? 'needs a human', message: 'none' });
      return finish({ ...base, action: 'handed-off', reason });
    case 'acknowledge':
      await escalateToHuman(target, { reason: reason ?? 'needs a human', message: 'acknowledge' });
      return finish({ ...base, action: 'escalated', reason });
    case 'respond': {
      const outcome = await runResponderAgent({ ...target, labels: intents });
      return finish({ ...base, ...outcome });
    }
  }
}

/**
 * Entry point for AgentBot jobs (webhook queue and pending sweeper). Must never
 * throw.
 */
export async function handleAgentBotJob(job: AgentBotJob): Promise<void> {
  const { conversationId, contactId, email } = job;
  logger.info('AgentBot processing pending conversation', { conversationId, contactId });

  try {
    await processAgentBotConversation(job);
  } catch (err) {
    // The pipeline died before deciding (e.g. a Chatwoot/Shopify fetch failed).
    // Never leave the conversation pending and unseen: open it for a human and
    // try a plain draft.
    const reason = `pipeline error: ${errMessage(err)}`;
    logger.error('AgentBot pipeline failed — opening conversation for a human', {
      conversationId,
      error: errMessage(err),
    });
    void recordAgentBotDecision({
      conversationId,
      classified: null,
      routingLabels: [],
      action: 'failed',
      reason,
    });
    try {
      await setConversationStatus(conversationId, 'open');
    } catch (openErr) {
      logger.error('Failed to open conversation after AgentBot pipeline error', {
        conversationId,
        error: errMessage(openErr),
      });
    }
    await postAiDraft({ conversationId, contactId, email }).catch((draftErr) => {
      logger.warn('Fallback draft after AgentBot pipeline error failed', {
        conversationId,
        error: errMessage(draftErr),
      });
    });
  }
}

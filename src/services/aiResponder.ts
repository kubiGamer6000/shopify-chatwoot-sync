import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { gatherContextWithMatching, postAiDraft } from './aiDraft.js';
import {
  classifyConversation,
  CLASSIFICATION_LABELS,
  type ClassificationLabel,
} from './classifier.js';
import {
  getConversationLabels,
  addConversationLabels,
  sendReply,
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
import type { ChatwootWebhookPayload } from '../types/chatwoot.js';

const client = new Anthropic({ apiKey: env.anthropicApiKey });

const CLASSIFICATION_LABEL_SET = new Set<string>(CLASSIFICATION_LABELS);

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
}

/**
 * Crafts a short, context-aware holding reply for the hard-escalation path
 * (where no responder agent runs), vetted for customer safety. Falls back to a
 * fixed message when generation fails or the result is not customer-safe.
 */
async function generateHoldingReply(ctx: PromptContext): Promise<VettedHoldingReply> {
  const cfg = await getAiConfig();
  const reply = await generateCompletion(cfg.holdingSystemPrompt, buildPrompt(ctx), {
    model: cfg.holdingModel,
    maxTokens: cfg.holdingMaxTokens,
    effort: cfg.holdingEffort,
    meta: { kind: 'holding', conversationId: ctx.conversationId },
  });

  return vetHoldingReply(reply ?? '', ctx.customerName);
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
  await sendReply(conversationId, holding.content);
  void recordSentReply({
    conversationId,
    message: holding.content,
    source: 'agent-bot-holding',
  });
}

/**
 * Hands a conversation to a human: moves it to `open`, sends a holding reply
 * (when enabled), and posts an escalation draft for the agent.
 *
 * The status change happens FIRST and every step is independent, so a failure
 * in the holding reply or draft (or a crash mid-way) can never leave the
 * conversation stuck in `pending`, where agents don't see it.
 *
 * `agentHoldingReply` is the responder agent's tailored holding reply (tool
 * escalation); when omitted, one is generated.
 */
async function escalateToHuman(
  target: ConversationTarget,
  reason: string,
  agentHoldingReply?: string,
): Promise<void> {
  const { conversationId, contactId, email, ctx, images } = target;
  const cfg = await getAiConfig();

  try {
    await setConversationStatus(conversationId, 'open');
  } catch (err) {
    logger.error('Escalation: failed to open conversation', {
      conversationId,
      error: errMessage(err),
    });
  }

  if (cfg.holdingReplyEnabled) {
    try {
      const holding =
        agentHoldingReply !== undefined
          ? vetHoldingReply(agentHoldingReply, ctx.customerName)
          : await generateHoldingReply(ctx);
      await sendHoldingReply(conversationId, holding);
    } catch (err) {
      logger.error('Escalation: failed to send holding reply', {
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
    holdingReply: cfg.holdingReplyEnabled,
  });
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
    await escalateToHuman(target, reason, agentHoldingReply);
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
  const vetted = vetResponderReply(candidate);

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
    await sendReply(conversationId, vetted.content);
  } catch (err) {
    logger.error('Failed to send responder reply', { conversationId, error: errMessage(err) });
    return handOff('sending the reply failed');
  }
  void recordSentReply({ conversationId, message: vetted.content, source: 'agent-bot' });

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
}): Promise<ResponderReplayResult> {
  const { ctx, labels, cfg, images = [] } = params;
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
  const vetted = vetResponderReply(state.reply ?? text);

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
  | 'skipped'
  | 'failed'
  | 'would-respond'
  | 'would-escalate'
  | 'would-skip';

export interface AgentBotRunResult {
  conversationId: number;
  classified: ClassificationLabel[] | null;
  routingLabels: ClassificationLabel[];
  action: AgentBotAction;
  /** Why it escalated / skipped / failed; null when answered. */
  reason: string | null;
}

/**
 * Persists a routing decision (best-effort) and returns the result unchanged.
 * Dry-run outcomes ('would-*') are informational only and never recorded.
 */
function finish(result: AgentBotRunResult): AgentBotRunResult {
  if (!result.action.startsWith('would-')) {
    void recordAgentBotDecision({
      conversationId: result.conversationId,
      classified: result.classified,
      routingLabels: result.routingLabels,
      action: result.action,
      reason: result.reason,
    });
  }
  return result;
}

/**
 * Core AgentBot flow for a single conversation: enriches customer context (with
 * Shopify matching), classifies + labels the conversation, then either
 * hard-escalates (label not auto-handleable or classification failed) or runs
 * the autonomous responder agent. Shared by the live webhook and the one-time
 * backfill script.
 *
 * When `dryRun` is true, NOTHING is mutated (no label writes, no replies, no
 * status changes, no drafts, no contact linking) — it only classifies and
 * reports the routing decision.
 *
 * When `backfill` is true, the flow NEVER escalates: only conversations whose
 * routing labels are a non-empty subset of `backfillAutoRespondLabels` get a
 * response; EVERYTHING else is skipped entirely (no holding reply, no draft, no
 * status change). Used by the one-time backlog script.
 */
export async function processAgentBotConversation(
  params: { conversationId: number; contactId: number; email?: string | null },
  opts: { dryRun?: boolean; backfill?: boolean } = {},
): Promise<AgentBotRunResult> {
  const { conversationId, contactId, email } = params;
  const dryRun = opts.dryRun ?? false;
  const backfill = opts.backfill ?? false;
  const cfg = await getAiConfig();
  const autoRespondSet = new Set<string>(cfg.autoRespondLabels);
  const backfillSet = new Set<string>(cfg.backfillAutoRespondLabels);

  // 1. Context + Shopify matching, and customer images (fetched once, shared by
  //    the classifier, the responder and any escalation draft).
  const { context: ctx } = await gatherContextWithMatching(
    { conversationId, contactId, email },
    { dryRun },
  );
  const images = await gatherCustomerImages(ctx.currentMessages).catch(() => []);
  const target: ConversationTarget = { conversationId, contactId, email, ctx, images };

  // 2. Classify against current labels and merge (add-only). Skip writes on dry-run.
  const currentLabels = await getConversationLabels(conversationId);
  const classified = await classifyConversation(ctx, currentLabels, images);
  if (!dryRun && classified && classified.length > 0) {
    await addConversationLabels(conversationId, classified);
  }

  // 3. Routing: union of existing + new classification labels (action labels and
  //    non-taxonomy labels are ignored for routing).
  const routingLabels = Array.from(
    new Set<string>([...currentLabels, ...(classified ?? [])]),
  ).filter((l): l is ClassificationLabel => CLASSIFICATION_LABEL_SET.has(l));
  const result = { conversationId, classified, routingLabels };

  if (backfill) {
    // Strict: only auto-respond to clean backfill-eligible tickets. Anything
    // else (other, refund, mixed, classification failure) is skipped and left
    // completely untouched.
    const eligible =
      classified !== null &&
      routingLabels.length > 0 &&
      routingLabels.every((l) => backfillSet.has(l));
    const reason = eligible ? null : 'not backfill-eligible';

    if (dryRun) {
      return finish({ ...result, action: eligible ? 'would-respond' : 'would-skip', reason });
    }
    if (!eligible) return finish({ ...result, action: 'skipped', reason });

    const outcome = await runResponderAgent({ ...target, labels: routingLabels, noEscalate: true });
    return finish({ ...result, ...outcome });
  }

  // --- Live flow ---
  // 4. Hard-escalate if classification failed, produced nothing usable, or any
  //    label falls outside the auto-handleable set.
  const blocking = routingLabels.filter((l) => !autoRespondSet.has(l));
  const escalateReason =
    classified === null
      ? 'classification failed'
      : routingLabels.length === 0
        ? 'no routing labels'
        : blocking.length > 0
          ? `labels not auto-respondable: ${blocking.join(', ')}`
          : null;

  if (dryRun) {
    return finish({
      ...result,
      action: escalateReason ? 'would-escalate' : 'would-respond',
      reason: escalateReason,
    });
  }

  if (escalateReason) {
    await escalateToHuman(target, escalateReason);
    return finish({ ...result, action: 'escalated', reason: escalateReason });
  }

  // 5. Eligible → responder agent.
  const outcome = await runResponderAgent({ ...target, labels: routingLabels });
  return finish({ ...result, ...outcome });
}

/**
 * Entry point for the AgentBot webhook. Runs on pending conversations.
 * Must never throw (the webhook has already replied 200).
 */
export async function handleAgentBotMessage(
  payload: ChatwootWebhookPayload,
): Promise<void> {
  const conversationId = payload.conversation.id;
  const contactId = payload.sender.id;
  const email = payload.sender.email;

  logger.info('AgentBot processing pending conversation', {
    conversationId,
    contactId,
  });

  try {
    await processAgentBotConversation({ conversationId, contactId, email });
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

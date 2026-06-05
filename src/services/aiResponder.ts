import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { gatherContextWithMatching, postAiDraft } from './aiDraft.js';
import {
  classifyConversation,
  CLASSIFICATION_LABELS,
  NON_ESCALATION_LABELS,
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
import { generateCompletion } from './claude.js';
import { buildPrompt, type PromptContext } from '../utils/promptBuilder.js';
import { formatResponderMessage } from '../utils/responderFormat.js';
import type { ChatwootWebhookPayload } from '../types/chatwoot.js';

const client = new Anthropic({ apiKey: env.anthropicApiKey });

const CLASSIFICATION_LABEL_SET = new Set<string>(CLASSIFICATION_LABELS);

function holdingFallback(name?: string): string {
  return [
    `Hi ${name || 'there'},`,
    '',
    'Thanks for reaching out! We need a bit of extra help to resolve this for you, so one of our team members will be in touch shortly to take care of everything.',
  ].join('\n');
}

/**
 * Crafts a short, context-aware holding reply for the hard-escalation path
 * (where no responder agent runs). Falls back to a fixed message on failure.
 */
async function generateHoldingReply(ctx: PromptContext): Promise<string> {
  const system = [
    'You are a customer support agent at Scandi Gum.',
    'Write a brief, warm holding reply (2 to 3 short sentences) telling the customer their request needs a bit of extra help and that one of our team members will be in touch shortly to take care of it.',
    'Do NOT promise any specific outcome (no refunds, no discounts) or any timeline beyond "shortly". Do NOT try to resolve the issue.',
    'Greet by name when available. Do NOT include any sign-off or signature — the system appends one automatically.',
    'Respond in English. Do not use em dashes. Output ONLY the message body.',
  ].join('\n');

  const reply = await generateCompletion(system, buildPrompt(ctx), {
    model: env.claudeClassifierModel,
    maxTokens: 400,
  });

  const text = reply?.trim();
  return text && text.length > 0 ? text : holdingFallback(ctx.customerName);
}

/**
 * Hard-escalates a conversation: sends a contextual holding reply, moves it to
 * `open` (visible to humans), and triggers an AI draft for the human agent.
 */
async function hardEscalate(params: {
  conversationId: number;
  contactId: number;
  email?: string | null;
  ctx: PromptContext;
  reason: string;
}): Promise<void> {
  const { conversationId, contactId, email, ctx, reason } = params;
  try {
    // Holding reply is optional (AGENT_BOT_HOLDING_REPLY). When disabled, the
    // bot stays silent and just hands the conversation to a human.
    if (env.agentBotHoldingReplyEnabled) {
      const holding = await generateHoldingReply(ctx);
      await sendReply(conversationId, formatResponderMessage(holding));
    }
    await setConversationStatus(conversationId, 'open');
    await postAiDraft({ conversationId, contactId, email, escalation: true });
    logger.info('Hard-escalated conversation', {
      conversationId,
      reason,
      holdingReply: env.agentBotHoldingReplyEnabled,
    });
  } catch (err) {
    logger.error('Hard escalation failed', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

const CANCEL_TOOL_DESC =
  "Cancel the customer's active Skio subscription(s) and stop all future " +
  'rebilling, then label the conversation as cancelled-by-AI. Use this ONLY ' +
  'when the customer wants to cancel their subscription AND either we have ' +
  'already sent them the self-service cancellation link earlier in this ' +
  'conversation and they insist we do it for them, or they explicitly say they ' +
  "will not use the website / want it done for them. It uses the customer's " +
  'linked account email automatically (no input needed). After it confirms ' +
  'success, write a short message confirming the cancellation. Never claim a ' +
  'cancellation without calling this tool first.';

/**
 * Runs the autonomous responder agent (Sonnet, tool-runner) for an eligible
 * conversation. Sends the agent's final reply and resolves the conversation,
 * unless the agent escalated (in which case the holding reply + handoff were
 * already done by the escalate tool).
 */
async function runResponderAgent(params: {
  conversationId: number;
  contactId: number;
  email?: string | null;
  ctx: PromptContext;
  labels: ClassificationLabel[];
}): Promise<void> {
  const { conversationId, contactId, email, ctx, labels } = params;

  if (!env.responderSystemPrompt) {
    logger.warn('Responder prompt empty — escalating instead', { conversationId });
    await hardEscalate({
      conversationId,
      contactId,
      email,
      ctx,
      reason: 'responder prompt not configured',
    });
    return;
  }

  let escalated = false;

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
    run: async ({ reason, holding_reply }) => {
      escalated = true;
      try {
        // Holding reply is optional (AGENT_BOT_HOLDING_REPLY). When disabled,
        // the bot stays silent and just hands the conversation to a human.
        if (env.agentBotHoldingReplyEnabled) {
          await sendReply(conversationId, formatResponderMessage(holding_reply));
        }
        await setConversationStatus(conversationId, 'open');
        await postAiDraft({ conversationId, contactId, email, escalation: true });
      } catch (err) {
        logger.error('Escalation tool actions failed', {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      logger.info('Responder escalated conversation', {
        conversationId,
        reason,
        holdingReply: env.agentBotHoldingReplyEnabled,
      });
      return env.agentBotHoldingReplyEnabled
        ? 'Conversation escalated to a human and the holding reply was sent. You are done; do not write any further message.'
        : 'Conversation escalated to a human (no holding reply sent). You are done; do not write any further message.';
    },
  });

  const cancelTool = betaZodTool({
    name: 'cancel_subscription',
    description: CANCEL_TOOL_DESC,
    inputSchema: z.object({}),
    run: async () => {
      const lookupEmail = ctx.customerEmail;
      if (!lookupEmail) {
        return 'No email on file to look up the subscription. Ask the customer for the email used at checkout, or escalate.';
      }
      try {
        const result = await cancelActiveSubscriptionsByEmail(lookupEmail);
        if (result.cancelled > 0) {
          await addConversationLabels(conversationId, ['sub-cancelled-ai']);
          return `Successfully cancelled ${result.cancelled} active subscription(s). Confirm the cancellation to the customer.`;
        }
        if (result.activeFound === 0) {
          return 'No active subscription was found for this customer. Do not claim a cancellation. Tell the customer you could not find an active subscription on their account, or escalate if they insist.';
        }
        return 'Active subscription(s) were found but the cancellation failed. Do not claim success — escalate to a human.';
      } catch (err) {
        logger.warn('cancel_subscription tool failed', {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
        return 'The cancellation could not be completed due to an internal error. Do not claim success — escalate to a human.';
      }
    },
  });

  // Only expose the cancellation tool when the conversation is a sub-cancel.
  const tools = labels.includes('sub-cancel')
    ? [escalateTool, cancelTool]
    : [escalateTool];

  try {
    const finalMessage = await client.beta.messages.toolRunner({
      model: env.claudeModel,
      max_tokens: 1024,
      max_iterations: 5,
      system: env.responderSystemPrompt,
      tools,
      messages: [{ role: 'user', content: buildPrompt(ctx) }],
    });

    // The escalate tool already sent the holding reply + handed off.
    if (escalated) return;

    const text = finalMessage.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();

    if (!text) {
      logger.warn('Responder produced no final reply — escalating', { conversationId });
      await hardEscalate({
        conversationId,
        contactId,
        email,
        ctx,
        reason: 'no final reply produced',
      });
      return;
    }

    await sendReply(conversationId, formatResponderMessage(text));
    await addConversationLabels(conversationId, ['ai-response']);
    await resolveConversation(conversationId);
    logger.info('Responder replied and resolved conversation', { conversationId });
  } catch (err) {
    logger.error('Responder agent run failed — escalating', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!escalated) {
      await hardEscalate({
        conversationId,
        contactId,
        email,
        ctx,
        reason: 'responder agent error',
      });
    }
  }
}

/**
 * Entry point for the AgentBot webhook. Runs on pending conversations: enriches
 * customer context (with Shopify matching), classifies + labels the
 * conversation, then either hard-escalates (label not auto-handleable or
 * classification failed) or runs the autonomous responder agent.
 *
 * Best-effort: must never throw (the webhook has already replied 200).
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

  // 1. Context + Shopify matching.
  const { context: ctx } = await gatherContextWithMatching({
    conversationId,
    contactId,
    email,
  });

  // 2. Classify against current labels and merge (add-only).
  const currentLabels = await getConversationLabels(conversationId);
  const classified = await classifyConversation(ctx, currentLabels);
  if (classified && classified.length > 0) {
    await addConversationLabels(conversationId, classified);
  }

  // 3. Routing: union of existing + new classification labels (action labels and
  //    non-taxonomy labels are ignored for routing).
  const routingLabels = Array.from(
    new Set<string>([...currentLabels, ...(classified ?? [])]),
  ).filter((l): l is ClassificationLabel =>
    CLASSIFICATION_LABEL_SET.has(l),
  );

  // 4. Hard-escalate if classification failed, produced nothing usable, or any
  //    label falls outside the auto-handleable set.
  const mustEscalate =
    classified === null ||
    routingLabels.length === 0 ||
    routingLabels.some((l) => !NON_ESCALATION_LABELS.has(l));

  if (mustEscalate) {
    await hardEscalate({
      conversationId,
      contactId,
      email,
      ctx,
      reason: `labels=[${routingLabels.join(', ')}] classified=${classified === null ? 'failed' : 'ok'}`,
    });
    return;
  }

  // 5. Eligible (subset of sub-cancel / order-status / other) → responder agent.
  await runResponderAgent({
    conversationId,
    contactId,
    email,
    ctx,
    labels: routingLabels,
  });
}

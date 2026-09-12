/**
 * Side-effect-free "prompt tester" that reproduces how a draft / classification
 * / responder reply would be generated for a real Chatwoot conversation, and
 * returns the FULL context the AI sees (resolved context, final system + user
 * prompt, images, model + params, and the output) for debugging.
 *
 * Everything that writes is disabled: no private notes, stored drafts, label
 * writes, email linking, negative-cache writes, summary refresh, replies, or
 * status changes. The Shopify matcher runs in `dryRun` mode.
 */
import { gatherContextWithMatching } from './aiDraft.js';
import { gatherCustomerImages, toUserContent } from './attachments.js';
import { generateStructuredDraft } from './claude.js';
import {
  getConversationDetails,
  getConversationLabels,
} from './chatwootConversation.js';
import { classifyForReplay } from './classifier.js';
import { decideRoute } from './agentBotRouting.js';
import { buildAcknowledgementPrompt, generateAcknowledgement } from './acknowledger.js';
import { hasPublicReply, onlyAutoRepliesUnanswered, startedByUs } from './autoReply.js';
import { runResponderReplay } from './aiResponder.js';
import { getAiConfig, mergeAiConfig } from './appConfig.js';
import { buildPrompt, type PromptContext } from '../utils/promptBuilder.js';
import type { AiConfigOverrides } from '../types/config.js';

export type ReplayKind = 'draft' | 'classifier' | 'responder' | 'acknowledge';

export interface ReplayRequest {
  conversationId: number;
  kind: ReplayKind;
  // Optional unsaved editor overrides to test before saving.
  overrides?: AiConfigOverrides;
  // Draft path only: reproduce the "just escalated" draft variant.
  escalation?: boolean;
  // Replay as the bot saw it: drop everything after the customer's latest
  // message (our later replies, notes). Default true for the bot kinds.
  asOfLastCustomerMessage?: boolean;
}

export interface ReplayImage {
  mediaType: string;
  bytes: number;
  dataUrl: string;
}

export interface ReplayResult {
  kind: ReplayKind;
  conversationId: number;
  contactId: number | null;
  email: string | null;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  images: ReplayImage[];
  context: Record<string, unknown>;
  output: Record<string, unknown>;
}

/** Builds a JSON-serializable snapshot of the exact context the AI receives. */
function serializeContext(ctx: PromptContext): Record<string, unknown> {
  return {
    customerName: ctx.customerName ?? null,
    customerEmail: ctx.customerEmail ?? null,
    matched: ctx.orders.length > 0,
    shopifyCustomerId: ctx.shopifyCustomer?.id ?? null,
    orderCount: ctx.orders.length,
    orders: ctx.orders.slice(0, 25).map((o) => ({
      name: o.name,
      createdAt: o.created_at,
      total: `${o.total_price} ${o.currency}`,
      financialStatus: o.financial_status ?? null,
      fulfillmentStatus: o.fulfillment_status ?? null,
    })),
    trackingCount: ctx.trackingByNumber?.size ?? 0,
    currentMessageCount: ctx.currentMessages.length,
    previousConversationCount: ctx.previousConversations?.length ?? 0,
    isNewConversation: ctx.isNewConversation ?? null,
    emailSubject: ctx.emailSubject ?? null,
    escalationContext: ctx.escalationContext ?? false,
    hasLookupGuidance: Boolean(ctx.lookupGuidance),
  };
}


/** Reproduces AI generation for a conversation with all writes disabled. */
export async function runReplay(req: ReplayRequest): Promise<ReplayResult> {
  const { conversationId, kind } = req;

  const details = await getConversationDetails(conversationId);
  const contactId = details.meta?.sender?.id ?? null;
  const email = details.meta?.sender?.email ?? null;

  if (!contactId) {
    throw new Error('Could not resolve a contact for this conversation.');
  }

  const base = await getAiConfig();
  const cfg = mergeAiConfig(base, req.overrides);

  const { context: ctx } = await gatherContextWithMatching(
    { conversationId, contactId, email },
    { dryRun: true },
  );

  const asOfCustomer = req.asOfLastCustomerMessage ?? kind !== 'draft';
  if (asOfCustomer) {
    const lastCustomerAt = Math.max(
      0,
      ...ctx.currentMessages
        .filter((m) => m.message_type === 0 && !m.private)
        .map((m) => m.created_at),
    );
    if (lastCustomerAt > 0) {
      ctx.currentMessages = ctx.currentMessages.filter((m) => m.created_at <= lastCustomerAt);
    }
  }

  // Customer images, as every live AI path now sees them.
  const rawImages = await gatherCustomerImages(ctx.currentMessages).catch(() => []);
  const images: ReplayImage[] = rawImages.map((img) => ({
    mediaType: img.mediaType,
    bytes: Math.round((img.base64.length * 3) / 4),
    dataUrl: `data:${img.mediaType};base64,${img.base64}`,
  }));

  const currentLabels = await getConversationLabels(conversationId);
  const autoReply = onlyAutoRepliesUnanswered(ctx.currentMessages);

  if (kind === 'classifier') {
    const preview = await classifyForReplay(ctx, currentLabels, cfg, rawImages);
    return {
      kind,
      conversationId,
      contactId,
      email,
      model: preview.model,
      systemPrompt: preview.systemPrompt,
      userPrompt: preview.userPrompt,
      images,
      context: { ...serializeContext(ctx), currentLabels },
      output: {
        classification: preview.classification,
        autoReplyDetected: autoReply.auto,
        autoReplySignals: autoReply.signals,
      },
    };
  }

  // Responder and acknowledgement previews both start from the live routing.
  const preview = await classifyForReplay(ctx, currentLabels, cfg, rawImages);
  const decision = decideRoute({
    classification: autoReply.auto ? null : preview.classification,
    cfg,
    autoReplyDetected: autoReply.auto,
    hasPublicReply: hasPublicReply(ctx.currentMessages),
    customerHasOrders: ctx.orders.length > 0,
    startedByUs: startedByUs(ctx.currentMessages),
  });
  const routingContext = {
    ...serializeContext(ctx),
    currentLabels,
    classification: preview.classification,
    autoReplyDetected: autoReply.auto,
    route: decision.route,
    intents: decision.intents,
    routeReason: decision.reason,
  };

  if (kind === 'acknowledge') {
    const request = {
      ctx,
      images: rawImages,
      intents: decision.intents,
      reason: decision.reason ?? 'preview',
      language: preview.classification?.language ?? null,
    };
    const ack = await generateAcknowledgement(request, cfg, 'acknowledge-replay');
    return {
      kind,
      conversationId,
      contactId,
      email,
      model: cfg.acknowledgeModel,
      systemPrompt: cfg.acknowledgeSystemPrompt,
      userPrompt: buildAcknowledgementPrompt(request),
      images,
      context: routingContext,
      output: {
        routingDecision: decision.route,
        acknowledgementMode: cfg.acknowledgeMode,
        wouldSend: ack?.message ?? '',
        rawMessage: ack?.rawMessage ?? null,
        askedFor: ack?.askedFor ?? [],
        handoffNote: ack?.handoffNote ?? null,
        guard: { ok: ack?.guardOk ?? false, violations: ack?.violations ?? [] },
      },
    };
  }

  if (kind === 'responder') {
    const replay = await runResponderReplay({
      ctx,
      labels: decision.intents,
      cfg,
      images: rawImages,
      language: preview.classification?.language ?? null,
    });
    return {
      kind,
      conversationId,
      contactId,
      email,
      model: replay.model,
      systemPrompt: replay.systemPrompt,
      userPrompt: replay.userPrompt,
      images,
      context: routingContext,
      output: {
        routingDecision: decision.route,
        availableTools: replay.toolNames,
        toolInvocations: replay.toolInvocations,
        text: replay.text,
        replyMessage: replay.replyMessage,
        guard: replay.guard,
        usage: replay.usage,
      },
    };
  }

  // Default: draft path (highest fidelity).
  if (req.escalation) ctx.escalationContext = true;

  const userPrompt = buildPrompt(ctx);
  const content = toUserContent(userPrompt, rawImages);

  const draft = await generateStructuredDraft(
    cfg.draftSystemPrompt,
    [{ role: 'user', content }],
    {
      model: cfg.draftModel,
      maxTokens: cfg.draftMaxTokens,
      effort: cfg.draftEffort,
      meta: { kind: 'draft-replay', conversationId, contactId },
    },
  );

  return {
    kind: 'draft',
    conversationId,
    contactId,
    email,
    model: cfg.draftModel,
    systemPrompt: cfg.draftSystemPrompt,
    userPrompt,
    images,
    context: serializeContext(ctx),
    output: {
      response: draft?.response ?? null,
      noteToAgent: draft?.noteToAgent ?? null,
      customerMessageTranslation: draft?.customerMessageTranslation ?? null,
    },
  };
}

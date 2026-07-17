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
import { gatherContextWithMatching, toUserContent } from './aiDraft.js';
import { gatherCustomerImages } from './attachments.js';
import { generateStructuredDraft } from './claude.js';
import {
  getConversationDetails,
  getConversationLabels,
} from './chatwootConversation.js';
import {
  classifyForReplay,
  CLASSIFICATION_LABELS,
  type ClassificationLabel,
} from './classifier.js';
import { runResponderReplay } from './aiResponder.js';
import { getAiConfig, mergeAiConfig } from './appConfig.js';
import { buildPrompt, type PromptContext } from '../utils/promptBuilder.js';
import type { AiConfigOverrides } from '../types/config.js';

const CLASSIFICATION_LABEL_SET = new Set<string>(CLASSIFICATION_LABELS);

export type ReplayKind = 'draft' | 'classifier' | 'responder';

export interface ReplayRequest {
  conversationId: number;
  kind: ReplayKind;
  // Optional unsaved editor overrides to test before saving.
  overrides?: AiConfigOverrides;
  // Draft path only: reproduce the "just escalated" draft variant.
  escalation?: boolean;
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

  if (kind === 'classifier') {
    const currentLabels = await getConversationLabels(conversationId);
    const preview = await classifyForReplay(ctx, currentLabels, cfg);
    return {
      kind,
      conversationId,
      contactId,
      email,
      model: preview.model,
      systemPrompt: preview.systemPrompt,
      userPrompt: preview.userPrompt,
      images: [],
      context: { ...serializeContext(ctx), currentLabels },
      output: { labels: preview.labels, reasoning: preview.reasoning },
    };
  }

  if (kind === 'responder') {
    const currentLabels = await getConversationLabels(conversationId);
    const preview = await classifyForReplay(ctx, currentLabels, cfg);
    const classified = preview.labels ?? [];
    const routingLabels = Array.from(
      new Set<string>([...currentLabels, ...classified]),
    ).filter((l): l is ClassificationLabel => CLASSIFICATION_LABEL_SET.has(l));

    const autoRespondSet = new Set<string>(cfg.autoRespondLabels);
    const mustEscalate =
      preview.labels === null ||
      routingLabels.length === 0 ||
      routingLabels.some((l) => !autoRespondSet.has(l));

    const replay = await runResponderReplay({ ctx, labels: routingLabels, cfg });
    return {
      kind,
      conversationId,
      contactId,
      email,
      model: replay.model,
      systemPrompt: replay.systemPrompt,
      userPrompt: replay.userPrompt,
      images: [],
      context: {
        ...serializeContext(ctx),
        currentLabels,
        classified,
        classifierReasoning: preview.reasoning,
        routingLabels,
      },
      output: {
        routingDecision: mustEscalate ? 'would-escalate' : 'would-respond',
        availableTools: replay.toolNames,
        toolInvocations: replay.toolInvocations,
        text: replay.text,
        usage: replay.usage,
      },
    };
  }

  // Default: draft path (highest fidelity).
  if (req.escalation) ctx.escalationContext = true;

  const rawImages = await gatherCustomerImages(ctx.currentMessages).catch(() => []);
  const images: ReplayImage[] = rawImages.map((img) => ({
    mediaType: img.mediaType,
    bytes: Math.round((img.base64.length * 3) / 4),
    dataUrl: `data:${img.mediaType};base64,${img.base64}`,
  }));
  const userPrompt = buildPrompt(ctx);
  const content = toUserContent(userPrompt, rawImages);

  const draft = await generateStructuredDraft(
    cfg.draftSystemPrompt,
    [{ role: 'user', content }],
    {
      model: cfg.draftModel,
      maxTokens: cfg.draftMaxTokens,
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

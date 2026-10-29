import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';
import { getAiConfig } from './appConfig.js';
import {
  getConversationMessages,
  getConversationDetails,
  getContactConversations,
  postPrivateNote,
  getConversationLabels,
  addConversationLabels,
} from './chatwootConversation.js';
import { getTrackingStatus } from './tracking.js';
import {
  gatherCustomerImages,
  toUserContent,
  type CustomerImage,
} from './attachments.js';
import { resolveContactCustomer, type ContactResolution, type LinkSuggestion } from './contactLink.js';
import { findLinkSuggestion } from './linkSuggestions.js';
import { shopifyLinkDeps } from './conversationScope.js';
import { mergeContactAttributes } from './chatwoot.js';
import { classifyConversation } from './classifier.js';
import { generateStructuredDraft, type StructuredDraft } from './claude.js';
import {
  gatherConversationsWithMessages,
  generateAndStoreSummary,
} from './customerSummary.js';
import { storeDraft } from './draftStore.js';
import { buildPrompt, type PromptContext } from '../utils/promptBuilder.js';
import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';
import type { TrackingSummary } from '../types/tracking.js';

/**
 * Signals about how the contact resolved to a Shopify account.
 */
export interface DraftLookupMeta {
  // True when the VERIFIED Shopify customer has at least one order.
  matched: boolean;
  // How the contact links to Shopify (see contactLink.ts).
  linkStatus: ContactResolution['status'];
  // A pending/possible match an agent can confirm.
  suggestion: LinkSuggestion | null;
  // The contact's default Chatwoot email.
  chatwootEmail: string | null;
  // The Chatwoot contact id (from the API, not the webhook payload).
  contactId: number;
  // Current contact custom attributes.
  customAttributes: Record<string, unknown>;
  // Concatenated text of the customer's messages in the current conversation.
  customerMessage: string;
}

export interface GatheredDraftContext {
  context: PromptContext;
  lookup: DraftLookupMeta;
}

/**
 * Gathers all Chatwoot + Shopify + tracking context for a conversation and
 * returns a ready-to-use PromptContext plus lookup metadata. Shared by the
 * incoming-message webhook flow, the AgentBot and the dashboard composer.
 *
 * The contact is taken from the conversation as returned by the Chatwoot API
 * (never from the webhook payload or the browser). Order and customer data is
 * included ONLY when the link is verified (contactLink.ts); otherwise the AI
 * sees no account data at all.
 */
export async function gatherDraftContext(params: {
  conversationId: number;
  contactId?: number | null;
  email?: string | null;
}): Promise<GatheredDraftContext> {
  const { conversationId } = params;

  const conversationDetails = await getConversationDetails(conversationId);
  const sender = conversationDetails.meta?.sender;
  const contactId = sender?.id ?? params.contactId;
  if (!contactId) throw new Error('Conversation has no contact');

  const [messagesRes, contactConversations] = await Promise.all([
    getConversationMessages(conversationId),
    getContactConversations(contactId),
  ]);

  const currentMessages = messagesRes.payload;
  const customerName = sender?.name;

  const customAttributes =
    (sender?.custom_attributes as Record<string, unknown> | undefined) ?? {};

  const chatwootEmail = sender?.email || null;

  // Extract email subject: conversation-level first, then fall back to first message
  const mailSubject =
    (conversationDetails.additional_attributes?.['mail_subject'] as string) ||
    currentMessages
      .filter((m) => m.message_type === 0)
      .sort((a, b) => a.created_at - b.created_at)
      .map((m) => (m.content_attributes as Record<string, any>)?.email?.subject)
      .find(Boolean) ||
    undefined;

  // Determine if this is a new conversation (only 1 incoming message so far)
  const incomingCount = currentMessages.filter((m) => m.message_type === 0 && !m.private).length;
  const isNewConversation = incomingCount <= 1;

  // Phase 2: Resolve the Shopify customer. Only a VERIFIED link feeds the AI.
  let resolution: ContactResolution;
  try {
    resolution = await resolveContactCustomer(
      { id: contactId, email: chatwootEmail, custom_attributes: customAttributes },
      shopifyLinkDeps,
    );
  } catch (err) {
    logger.warn('Failed to resolve Shopify customer for contact', {
      contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    resolution = {
      status: 'none',
      basis: null,
      customer: null,
      orders: [],
      customerEmail: null,
      contactEmail: chatwootEmail,
      suggestion: null,
    };
  }
  const verified = resolution.status === 'verified';
  const shopifyCustomer: ShopifyCustomer | null = verified ? resolution.customer : null;
  const orders: ShopifyOrder[] = verified ? resolution.orders : [];

  // Phase 3: Fetch tracking status for last 2 fulfilled orders
  let trackingByNumber = new Map<string, TrackingSummary>();

  const trackingNumbers = extractTrackingNumbers(orders);
  if (trackingNumbers.length > 0) {
    try {
      trackingByNumber = await getTrackingStatus(trackingNumbers);
    } catch (err) {
      logger.warn('Failed to fetch tracking status', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const customerMessageBody = currentMessages
    .filter((m) => m.message_type === 0 && !m.private)
    .sort((a, b) => a.created_at - b.created_at)
    .map((m) => m.content)
    .filter(Boolean)
    .join('\n\n');

  // The order number / alternate email often lives in the email subject (e.g.
  // "WHERES MY ORDER #11789??"), so include it for suggestions.
  const customerMessage = [
    mailSubject ? `Subject: ${mailSubject}` : '',
    customerMessageBody,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    context: {
      customerName,
      // Verified customer's email, else the sender's own address.
      customerEmail: (verified ? resolution.customerEmail : null) ?? chatwootEmail ?? undefined,
      shopifyCustomer,
      orders,
      trackingByNumber,
      currentMessages,
      previousConversations: contactConversations,
      conversationId,
      isNewConversation,
      emailSubject: mailSubject,
      identity: {
        status: resolution.status,
        hasCandidate: resolution.status === 'suggested' || resolution.suggestion !== null,
      },
    },
    lookup: {
      matched: orders.length > 0,
      linkStatus: resolution.status,
      suggestion: resolution.suggestion,
      chatwootEmail,
      contactId,
      customAttributes,
      customerMessage,
    },
  };
}

/**
 * Appended to the prompt when we have no order data for the contact, so the AI
 * knows to ask for an order number / original email when (and only when) the
 * request actually depends on their order history.
 */
const LOOKUP_GUIDANCE =
  "This contact could NOT be matched to a Shopify account with any orders — " +
  'either they have never ordered, or (more likely) they wrote in from a ' +
  'different email than the one they used to order. We checked their message ' +
  'and could not find a usable order number or alternative email to look them ' +
  'up with. If their request depends on their order/customer data (e.g. "where ' +
  'is my order", a refund, a delivery issue), politely explain you cannot ' +
  'locate their order from this email and ask them to reply with their order ' +
  'number or the email address they used at checkout so you can pull it up. If ' +
  'their request does NOT need order data (e.g. a general/business enquiry, a ' +
  'product question), just answer normally and do not ask for an order number.';

/**
 * Formats a structured draft for posting as a Chatwoot private note. The
 * customer-message translation (when present) is shown ABOVE the reply, clearly
 * separated so it is never mistaken for part of the sendable message, and the
 * `[NOTE TO AGENT]` block (when present) stays below the reply as before.
 */
/** What the AgentBot did when handing a conversation to a human. */
export interface HandoffSummary {
  reason: string;
  intents: string[];
  /** What the customer was sent (acknowledgement or holding reply), if anything. */
  customerMessage: string | null;
  askedFor?: string[];
  note?: string | null;
}

/** Formats the handoff block shown to the agent at the top of the draft note. */
export function formatHandoffSummary(handoff: HandoffSummary): string {
  const lines = [
    '[AI HANDOFF]',
    `Why: ${handoff.reason}`,
    `Intents: ${handoff.intents.join(', ') || '(unclear)'}`,
    handoff.customerMessage
      ? `Customer was sent:\n${handoff.customerMessage}`
      : 'No message was sent to the customer.',
  ];
  if (handoff.askedFor && handoff.askedFor.length > 0) {
    lines.push(`Asked the customer for: ${handoff.askedFor.join('; ')}`);
  }
  if (handoff.note?.trim()) lines.push(`Note: ${handoff.note.trim()}`);
  return lines.join('\n');
}

export function formatDraftNote(draft: StructuredDraft, handoff?: HandoffSummary): string {
  const sections: string[] = [];
  if (handoff) sections.push(formatHandoffSummary(handoff));

  const translation = draft.customerMessageTranslation?.trim();
  if (translation) {
    sections.push(`[CUSTOMER MESSAGE — TRANSLATED]\n${translation}`);
  }

  sections.push(draft.response);

  const note = draft.noteToAgent?.trim();
  if (note) {
    sections.push(`[NOTE TO AGENT]\n${note}`);
  }

  return sections.join('\n\n---\n');
}

/**
 * Gathers the prompt context and, when the contact has no verified account
 * with orders, looks for an email / order number in the customer's message.
 * A hit is stored on the contact as a PENDING SUGGESTION for an agent to
 * confirm in the Customer 360 tab; it is never linked automatically and never
 * fed to the AI. Shared by the AI-draft flow and the autonomous AgentBot.
 */
export async function gatherContextWithMatching(
  params: {
    conversationId: number;
    contactId?: number | null;
    email?: string | null;
  },
  opts: { dryRun?: boolean } = {},
): Promise<{ context: PromptContext; lookup: DraftLookupMeta }> {
  const dryRun = opts.dryRun ?? false;
  const { context: ctx, lookup } = await gatherDraftContext(params);

  if (!lookup.matched && lookup.linkStatus !== 'suggested' && !lookup.suggestion) {
    const suggestion = await findLinkSuggestion(
      lookup.customerMessage,
      lookup.chatwootEmail,
      shopifyLinkDeps,
    ).catch(() => null);
    if (suggestion) {
      lookup.suggestion = suggestion;
      ctx.identity = { status: ctx.identity?.status ?? 'none', hasCandidate: true };
      logger.info('Possible account match found in message (pending agent confirmation)', {
        conversationId: params.conversationId,
        contactId: lookup.contactId,
      });
      if (!dryRun) {
        await mergeContactAttributes(lookup.contactId, lookup.customAttributes, {
          shopify_email_link_suggested: suggestion.email,
          shopify_email_link_suggested_basis: suggestion.basis,
        }).catch((err) => {
          logger.warn('Failed to store link suggestion on contact', {
            contactId: lookup.contactId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }

  // Still no order data? Tell the AI to ask for an order number / email.
  if (ctx.orders.length === 0 && !ctx.identity?.hasCandidate) {
    ctx.lookupGuidance = LOOKUP_GUIDANCE;
  }

  return { context: ctx, lookup };
}

/**
 * Generates an AI draft for a conversation, posts it as a private note, stores
 * it, and refreshes the customer summary. When `escalation` is true, a special
 * "this was just auto-escalated to a human" block is added so the draft is the
 * agent's substantive next reply. Used by both the draft webhook (open convos)
 * and the AgentBot escalation path.
 */
export async function postAiDraft(params: {
  conversationId: number;
  contactId: number;
  email?: string | null;
  escalation?: boolean;
  // When true, also classify the conversation and merge labels (used on
  // human-owned/open conversations, where the AgentBot doesn't run).
  classify?: boolean;
  // Already-gathered context + images (AgentBot escalation), so the Chatwoot,
  // Shopify, tracking and matcher lookups aren't repeated.
  context?: PromptContext;
  images?: CustomerImage[];
  // AgentBot handoff details, shown to the agent above the draft.
  handoff?: HandoffSummary;
}): Promise<void> {
  const { conversationId, contactId } = params;

  const cfg = await getAiConfig();
  const systemPrompt = cfg.draftSystemPrompt;
  if (!systemPrompt) {
    logger.warn('Draft system prompt is empty, skipping AI draft', { conversationId });
    return;
  }

  const ctx: PromptContext = params.context
    ? { ...params.context }
    : (
        await gatherContextWithMatching({
          conversationId,
          contactId,
          email: params.email,
        })
      ).context;

  if (params.escalation) {
    ctx.escalationContext = true;
    ctx.escalationCustomerMessage = params.handoff?.customerMessage ?? null;
  }

  // Include any images the customer attached to their message(s) so the model
  // can see them (e.g. a photo of a product defect). Best-effort.
  const images =
    params.images ?? (await gatherCustomerImages(ctx.currentMessages).catch(() => []));
  if (images.length > 0) {
    logger.info('Attached customer images to draft prompt', {
      conversationId,
      imageCount: images.length,
    });
  }

  // Maintain conversation labels on open conversations (best-effort).
  if (params.classify) {
    try {
      const currentLabels = await getConversationLabels(conversationId);
      const classified = await classifyConversation(ctx, currentLabels, images);
      if (classified && classified.labels.length > 0) {
        await addConversationLabels(conversationId, classified.labels);
      }
    } catch (err) {
      logger.warn('Classification on open conversation failed', {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const userPrompt = buildPrompt(ctx);

  if (process.env.DEBUG) {
    const debugNote = `**[DEBUG] Full prompt sent to Claude:**\n\n---\n**System prompt:**\n${systemPrompt}\n\n---\n**User prompt:**\n${userPrompt}\n---`;
    await postPrivateNote(conversationId, debugNote);
    logger.debug('Posted debug prompt to conversation', { conversationId });
  }

  const draft = await generateStructuredDraft(
    systemPrompt,
    [{ role: 'user', content: toUserContent(userPrompt, images) }],
    {
      model: cfg.draftModel,
      maxTokens: cfg.draftMaxTokens,
      effort: cfg.draftEffort,
      meta: { kind: 'draft', conversationId, contactId },
    },
  );
  if (!draft) {
    logger.warn('Claude returned no draft', { conversationId });
    // The agent still needs to know why the bot handed off.
    if (params.handoff) {
      await postPrivateNote(conversationId, formatHandoffSummary(params.handoff));
    }
    return;
  }

  const identityNote =
    ctx.identity && ctx.identity.status !== 'verified' && ctx.identity.hasCandidate
      ? '[ACCOUNT MATCH NOT VERIFIED]\nA possible Shopify account match was found for this sender. Check their identity and confirm the link in the Customer 360 tab before sharing any order or account details.\n\n---\n'
      : '';
  await postPrivateNote(conversationId, identityNote + formatDraftNote(draft, params.handoff));
  await storeDraft({
    conversationId,
    contactId,
    response: draft.response,
    noteToAgent: draft.noteToAgent ?? null,
    customerMessageTranslation: draft.customerMessageTranslation ?? null,
    model: cfg.draftModel,
    generatedAt: new Date().toISOString(),
    source: 'auto',
  });
  logger.info('AI draft posted successfully', { conversationId });

  // Refresh the stored customer AI summary (best-effort).
  await generateCustomerSummarySafely({
    contactId,
    conversationId,
    email: ctx.customerEmail,
    shopifyCustomer: ctx.shopifyCustomer ?? null,
    customerName: ctx.customerName,
    orders: ctx.orders,
  });
}

/**
 * Generates a customer reply on demand for the dashboard composer. When a
 * previous response + correction are supplied, runs a single-shot revision
 * (the correction is sent as a follow-up turn after the prior reply). Stores
 * the result as the latest draft and returns it.
 */
export async function generateResponse(params: {
  conversationId: number;
  contactId: number;
  email?: string | null;
  instruction?: string | null;
  previousResponse?: string | null;
  correction?: string | null;
}): Promise<StructuredDraft | null> {
  const cfg = await getAiConfig();
  const systemPrompt = cfg.draftSystemPrompt;
  if (!systemPrompt) {
    logger.warn('Draft system prompt is empty, cannot generate response');
    return null;
  }

  const { context: ctx } = await gatherDraftContext({
    conversationId: params.conversationId,
    contactId: params.contactId,
  });

  if (ctx.orders.length === 0 && !ctx.identity?.hasCandidate) {
    ctx.lookupGuidance = LOOKUP_GUIDANCE;
  }

  const isRevision = Boolean(
    params.previousResponse && params.correction && params.correction.trim(),
  );

  // Include customer image attachments (best-effort) so the composer's model
  // can see them too.
  const images = await gatherCustomerImages(ctx.currentMessages).catch(() => []);

  let messages: Anthropic.MessageParam[];
  if (isRevision) {
    messages = [
      { role: 'user', content: toUserContent(buildPrompt(ctx), images) },
      { role: 'assistant', content: params.previousResponse! },
      {
        role: 'user',
        content: `Revise the customer reply above based on this instruction from the agent:\n\n${params.correction!.trim()}\n\nReturn the full corrected reply (not just the changes).`,
      },
    ];
  } else {
    ctx.agentInstruction = params.instruction ?? undefined;
    messages = [{ role: 'user', content: toUserContent(buildPrompt(ctx), images) }];
  }

  const draft = await generateStructuredDraft(systemPrompt, messages, {
    model: cfg.draftModel,
    maxTokens: cfg.draftMaxTokens,
    effort: cfg.draftEffort,
    meta: {
      kind: 'draft-manual',
      conversationId: params.conversationId,
      contactId: params.contactId,
    },
  });
  if (!draft) return null;

  await storeDraft({
    conversationId: params.conversationId,
    contactId: params.contactId,
    response: draft.response,
    noteToAgent: draft.noteToAgent ?? null,
    customerMessageTranslation: draft.customerMessageTranslation ?? null,
    model: cfg.draftModel,
    generatedAt: new Date().toISOString(),
    source: 'manual',
  });

  return draft;
}

async function generateCustomerSummarySafely(params: {
  contactId: number;
  conversationId: number;
  email?: string;
  shopifyCustomer: ShopifyCustomer | null;
  shopifyCustomerId?: string;
  customerName?: string;
  orders: ShopifyOrder[];
}): Promise<void> {
  try {
    const conversations = await gatherConversationsWithMessages(params.contactId);
    await generateAndStoreSummary({
      contactId: params.contactId,
      conversationId: params.conversationId,
      email: params.email ?? null,
      shopifyCustomerId: params.shopifyCustomer?.id
        ? String(params.shopifyCustomer.id)
        : (params.shopifyCustomerId ?? null),
      customerName: params.customerName ?? null,
      orders: params.orders,
      conversations,
    });
  } catch (err) {
    logger.warn('Customer summary generation failed', {
      conversationId: params.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function extractTrackingNumbers(orders: ShopifyOrder[]): string[] {
  const sorted = [...orders].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const numbers: string[] = [];
  const fulfilled = sorted.filter((o) => o.fulfillments && o.fulfillments.length > 0);

  for (const order of fulfilled.slice(0, 2)) {
    for (const f of order.fulfillments ?? []) {
      if (f.tracking_number && !numbers.includes(f.tracking_number)) {
        numbers.push(f.tracking_number);
      } else if (f.tracking_numbers) {
        for (const tn of f.tracking_numbers) {
          if (tn && !numbers.includes(tn)) {
            numbers.push(tn);
          }
        }
      }
    }
  }

  return numbers;
}

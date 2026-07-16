import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  getConversationMessages,
  getConversationDetails,
  getContactConversations,
  postPrivateNote,
  getConversationLabels,
  addConversationLabels,
} from './chatwootConversation.js';
import { fetchCustomerOrders, searchCustomerByEmail } from './shopify.js';
import { getTrackingStatus } from './tracking.js';
import { gatherCustomerImages, type CustomerImage } from './attachments.js';
import { resolveUnmatchedCustomer } from './customerResolver.js';
import { classifyConversation } from './classifier.js';
import { generateStructuredDraft, type StructuredDraft } from './claude.js';
import {
  gatherConversationsWithMessages,
  generateAndStoreSummary,
} from './customerSummary.js';
import { storeDraft } from './draftStore.js';
import { buildPrompt, type PromptContext } from '../utils/promptBuilder.js';
import type { ChatwootWebhookPayload } from '../types/chatwoot.js';
import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';
import type { TrackingSummary } from '../types/tracking.js';

/**
 * Signals about how the contact resolved to a Shopify account, used to decide
 * whether the AI matcher tools should run and how the draft prompt is shaped.
 */
export interface DraftLookupMeta {
  // True when the resolved Shopify customer has at least one order.
  matched: boolean;
  // True when a `shopify_email_link` override is already set on the contact.
  alreadyLinked: boolean;
  // The contact's default Chatwoot email.
  chatwootEmail: string | null;
  // The override email, when present.
  shopifyEmailLink: string | null;
  // Current contact custom attributes (preserved when writing the link back).
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
 * incoming-message webhook flow and the on-demand dashboard composer.
 *
 * Lookup precedence: an explicit `shopify_email_link` override wins, then the
 * Shopify customer id, then the contact's default email.
 */
export async function gatherDraftContext(params: {
  conversationId: number;
  contactId: number;
  email?: string | null;
}): Promise<GatheredDraftContext> {
  const { conversationId, contactId } = params;

  // Phase 1: Fetch Chatwoot context in parallel
  const [messagesRes, conversationDetails, contactConversations] = await Promise.all([
    getConversationMessages(conversationId),
    getConversationDetails(conversationId),
    getContactConversations(contactId),
  ]);

  const currentMessages = messagesRes.payload;
  const customerName = conversationDetails.meta?.sender?.name;

  const customAttributes =
    (conversationDetails.meta?.sender?.custom_attributes as
      | Record<string, unknown>
      | undefined) ?? {};

  const chatwootEmail =
    conversationDetails.meta?.sender?.email || params.email || null;

  const rawLink = customAttributes['shopify_email_link'];
  const shopifyEmailLink =
    typeof rawLink === 'string' && rawLink.trim() ? rawLink.trim() : null;

  // The email used for Shopify lookups: explicit override wins over the
  // contact's default address.
  const email = shopifyEmailLink || chatwootEmail || undefined;

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

  // Phase 2: Look up Shopify customer
  let shopifyCustomer: ShopifyCustomer | null = null;
  let orders: ShopifyOrder[] = [];

  const shopifyCustomerId = customAttributes['shopify_customer_id'] as
    | string
    | undefined;

  if (shopifyCustomerId) {
    logger.debug('Found Shopify customer ID in Chatwoot custom attributes', {
      shopifyCustomerId,
    });
    try {
      orders = await fetchCustomerOrders(Number(shopifyCustomerId));
      shopifyCustomer = { id: Number(shopifyCustomerId) } as ShopifyCustomer;
    } catch (err) {
      logger.warn('Failed to fetch orders by Shopify ID', {
        shopifyCustomerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (orders.length === 0 && email) {
    try {
      shopifyCustomer = await searchCustomerByEmail(email);
      if (shopifyCustomer) {
        logger.info('Found Shopify customer by email', {
          shopifyCustomerId: shopifyCustomer.id,
          email,
        });
        orders = await fetchCustomerOrders(shopifyCustomer.id);
      } else {
        logger.info('No Shopify customer found for email', { email });
      }
    } catch (err) {
      logger.warn('Failed to search Shopify customer by email', {
        email,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

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
  // "WHERES MY ORDER #11789??"), so include it for the matcher agent.
  const customerMessage = [
    mailSubject ? `Subject: ${mailSubject}` : '',
    customerMessageBody,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    context: {
      customerName,
      customerEmail: email,
      shopifyCustomer,
      orders,
      trackingByNumber,
      currentMessages,
      previousConversations: contactConversations,
      conversationId,
      isNewConversation,
      emailSubject: mailSubject,
    },
    lookup: {
      matched: orders.length > 0,
      alreadyLinked: Boolean(shopifyEmailLink),
      chatwootEmail,
      shopifyEmailLink,
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
 * Merges a successful resolution back into the prompt context: replaces the
 * orders + customer and recomputes tracking so the draft is written with the
 * real, full customer history.
 */
async function applyResolution(
  ctx: PromptContext,
  resolved: { shopifyCustomer: ShopifyCustomer | null; orders: ShopifyOrder[]; linkedEmail: string | null },
): Promise<void> {
  ctx.orders = resolved.orders;
  ctx.shopifyCustomer = resolved.shopifyCustomer;
  if (resolved.linkedEmail) ctx.customerEmail = resolved.linkedEmail;

  ctx.trackingByNumber = new Map();
  const trackingNumbers = extractTrackingNumbers(resolved.orders);
  if (trackingNumbers.length > 0) {
    try {
      ctx.trackingByNumber = await getTrackingStatus(trackingNumbers);
    } catch (err) {
      logger.warn('Failed to fetch tracking status after resolution', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Formats a structured draft for posting as a Chatwoot private note. The
 * customer-message translation (when present) is shown ABOVE the reply, clearly
 * separated so it is never mistaken for part of the sendable message, and the
 * `[NOTE TO AGENT]` block (when present) stays below the reply as before.
 */
export function formatDraftNote(draft: StructuredDraft): string {
  const sections: string[] = [];

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
 * Combines the text prompt with any customer image attachments into a Claude
 * message `content`. Returns a plain string when there are no images (so
 * nothing changes for the common case), or a multimodal content-block array
 * (text + image blocks) when the customer attached images to their message.
 */
export function toUserContent(
  text: string,
  images: CustomerImage[],
): string | Anthropic.ContentBlockParam[] {
  if (images.length === 0) return text;

  const blocks: Anthropic.ContentBlockParam[] = [
    { type: 'text', text },
    {
      type: 'text',
      text: `The customer attached ${images.length} image(s) to their message, shown below. Take them into account when writing your reply (e.g. a photo of a defect or a delivered parcel).`,
    },
  ];
  for (const img of images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  }
  return blocks;
}

/**
 * Gathers the prompt context and runs the Shopify matcher agent when the
 * contact isn't matched to an account with orders (and isn't already linked).
 * Sets the "ask for order number / email" guidance when no order data is
 * available. Shared by the AI-draft flow and the autonomous AgentBot responder.
 */
export async function gatherContextWithMatching(params: {
  conversationId: number;
  contactId: number;
  email?: string | null;
}): Promise<{ context: PromptContext; lookup: DraftLookupMeta }> {
  const { context: ctx, lookup } = await gatherDraftContext(params);

  if (!lookup.matched && !lookup.alreadyLinked) {
    logger.info('Contact unmatched — running Shopify matcher agent', {
      conversationId: params.conversationId,
      contactId: params.contactId,
    });
    const resolved = await resolveUnmatchedCustomer({
      contactId: params.contactId,
      customerMessage: lookup.customerMessage,
      chatwootEmail: lookup.chatwootEmail,
      existingCustomAttributes: lookup.customAttributes,
    });
    if (resolved.resolved) {
      await applyResolution(ctx, resolved);
    }
  }

  // Still no order data? Tell the AI to ask for an order number / email.
  if (ctx.orders.length === 0) {
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
}): Promise<void> {
  const { conversationId, contactId } = params;

  const systemPrompt = env.claudeSystemPrompt;
  if (!systemPrompt) {
    logger.warn('CLAUDE_SYSTEM_PROMPT is empty, skipping AI draft', { conversationId });
    return;
  }

  const { context: ctx } = await gatherContextWithMatching({
    conversationId,
    contactId,
    email: params.email,
  });

  if (params.escalation) {
    ctx.escalationContext = true;
  }

  // Maintain conversation labels on open conversations (best-effort).
  if (params.classify) {
    try {
      const currentLabels = await getConversationLabels(conversationId);
      const classified = await classifyConversation(ctx, currentLabels);
      if (classified && classified.length > 0) {
        await addConversationLabels(conversationId, classified);
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

  // Include any images the customer attached to their message(s) so the model
  // can see them (e.g. a photo of a product defect). Best-effort.
  const images = await gatherCustomerImages(ctx.currentMessages).catch(() => []);
  if (images.length > 0) {
    logger.info('Attached customer images to draft prompt', {
      conversationId,
      imageCount: images.length,
    });
  }

  const draft = await generateStructuredDraft(systemPrompt, [
    { role: 'user', content: toUserContent(userPrompt, images) },
  ]);
  if (!draft) {
    logger.warn('Claude returned no draft', { conversationId });
    return;
  }

  await postPrivateNote(conversationId, formatDraftNote(draft));
  await storeDraft({
    conversationId,
    contactId,
    response: draft.response,
    noteToAgent: draft.noteToAgent ?? null,
    customerMessageTranslation: draft.customerMessageTranslation ?? null,
    model: env.claudeModel,
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

export async function handleIncomingMessage(
  payload: ChatwootWebhookPayload,
): Promise<void> {
  const conversationId = payload.conversation.id;
  const contactId = payload.sender.id;
  const contactEmail = payload.sender.email;

  logger.info('Processing AI draft', { conversationId, contactId, contactEmail });

  await postAiDraft({ conversationId, contactId, email: contactEmail });
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
  const systemPrompt = env.claudeSystemPrompt;
  if (!systemPrompt) {
    logger.warn('CLAUDE_SYSTEM_PROMPT is empty, cannot generate response');
    return null;
  }

  const { context: ctx } = await gatherDraftContext({
    conversationId: params.conversationId,
    contactId: params.contactId,
    email: params.email,
  });

  if (ctx.orders.length === 0) {
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

  const draft = await generateStructuredDraft(systemPrompt, messages);
  if (!draft) return null;

  await storeDraft({
    conversationId: params.conversationId,
    contactId: params.contactId,
    response: draft.response,
    noteToAgent: draft.noteToAgent ?? null,
    customerMessageTranslation: draft.customerMessageTranslation ?? null,
    model: env.claudeModel,
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

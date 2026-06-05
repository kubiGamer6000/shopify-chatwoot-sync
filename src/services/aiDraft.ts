import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  getConversationMessages,
  getConversationDetails,
  getContactConversations,
  postPrivateNote,
} from './chatwootConversation.js';
import { fetchCustomerOrders, searchCustomerByEmail } from './shopify.js';
import { getTrackingStatus } from './tracking.js';
import { resolveUnmatchedCustomer } from './customerResolver.js';
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

  const customerMessage = currentMessages
    .filter((m) => m.message_type === 0 && !m.private)
    .sort((a, b) => a.created_at - b.created_at)
    .map((m) => m.content)
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
 * Formats a structured draft for posting as a Chatwoot private note, preserving
 * the historical `[NOTE TO AGENT]` layout that agents are used to.
 */
export function formatDraftNote(draft: StructuredDraft): string {
  if (draft.noteToAgent && draft.noteToAgent.trim()) {
    return `${draft.response}\n\n---\n[NOTE TO AGENT]\n${draft.noteToAgent.trim()}`;
  }
  return draft.response;
}

export async function handleIncomingMessage(
  payload: ChatwootWebhookPayload,
): Promise<void> {
  const conversationId = payload.conversation.id;
  const contactId = payload.sender.id;
  const contactEmail = payload.sender.email;

  logger.info('Processing AI draft', { conversationId, contactId, contactEmail });

  const systemPrompt = env.claudeSystemPrompt;
  if (!systemPrompt) {
    logger.warn('CLAUDE_SYSTEM_PROMPT is empty, skipping AI draft', { conversationId });
    return;
  }

  const { context: ctx, lookup } = await gatherDraftContext({
    conversationId,
    contactId,
    email: contactEmail,
  });

  // When the contact isn't matched to a Shopify account with orders — and a
  // human hasn't already linked one — run the tool-using matcher agent. If the
  // customer supplied an alternate email or order number it will find them,
  // link the email for future lookups, and enrich the context here.
  if (!lookup.matched && !lookup.alreadyLinked) {
    logger.info('Contact unmatched — running Shopify matcher agent', {
      conversationId,
      contactId,
    });
    const resolved = await resolveUnmatchedCustomer({
      contactId,
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

  const userPrompt = buildPrompt(ctx);

  if (process.env.DEBUG) {
    const debugNote = `**[DEBUG] Full prompt sent to Claude:**\n\n---\n**System prompt:**\n${systemPrompt}\n\n---\n**User prompt:**\n${userPrompt}\n---`;
    await postPrivateNote(conversationId, debugNote);
    logger.debug('Posted debug prompt to conversation', { conversationId });
  }

  const draft = await generateStructuredDraft(systemPrompt, [
    { role: 'user', content: userPrompt },
  ]);
  if (!draft) {
    logger.warn('Claude returned no draft', { conversationId });
    return;
  }

  // Phase 5: Post as private note (response + optional note to agent) and store.
  await postPrivateNote(conversationId, formatDraftNote(draft));
  await storeDraft({
    conversationId,
    contactId,
    response: draft.response,
    noteToAgent: draft.noteToAgent ?? null,
    model: env.claudeModel,
    generatedAt: new Date().toISOString(),
    source: 'auto',
  });
  logger.info('AI draft posted successfully', { conversationId });

  // Phase 6: Refresh the stored customer AI summary (best-effort).
  // The webhook has already responded 200, so this runs in the background and
  // must never throw out of this function.
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

  let messages: Anthropic.MessageParam[];
  if (isRevision) {
    messages = [
      { role: 'user', content: buildPrompt(ctx) },
      { role: 'assistant', content: params.previousResponse! },
      {
        role: 'user',
        content: `Revise the customer reply above based on this instruction from the agent:\n\n${params.correction!.trim()}\n\nReturn the full corrected reply (not just the changes).`,
      },
    ];
  } else {
    ctx.agentInstruction = params.instruction ?? undefined;
    messages = [{ role: 'user', content: buildPrompt(ctx) }];
  }

  const draft = await generateStructuredDraft(systemPrompt, messages);
  if (!draft) return null;

  await storeDraft({
    conversationId: params.conversationId,
    contactId: params.contactId,
    response: draft.response,
    noteToAgent: draft.noteToAgent ?? null,
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

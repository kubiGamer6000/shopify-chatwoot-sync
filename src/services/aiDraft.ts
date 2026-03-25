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
import { generateDraft } from './claude.js';
import { buildPrompt } from '../utils/promptBuilder.js';
import type { ChatwootWebhookPayload } from '../types/chatwoot.js';
import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';
import type { TrackingSummary } from '../types/tracking.js';

export async function handleIncomingMessage(
  payload: ChatwootWebhookPayload,
): Promise<void> {
  const conversationId = payload.conversation.id;
  const contactId = payload.sender.id;
  const contactEmail = payload.sender.email;

  logger.info('Processing AI draft', { conversationId, contactId, contactEmail });

  // Phase 1: Fetch Chatwoot context in parallel
  const [messagesRes, conversationDetails, contactConversations] = await Promise.all([
    getConversationMessages(conversationId),
    getConversationDetails(conversationId),
    getContactConversations(contactId),
  ]);

  const currentMessages = messagesRes.payload;
  const customerName = conversationDetails.meta?.sender?.name;
  const email = conversationDetails.meta?.sender?.email || contactEmail;

  // Determine if this is a new conversation (only 1 incoming message so far)
  const incomingCount = currentMessages.filter((m) => m.message_type === 0 && !m.private).length;
  const isNewConversation = incomingCount <= 1;

  // Phase 2: Look up Shopify customer
  let shopifyCustomer: ShopifyCustomer | null = null;
  let orders: ShopifyOrder[] = [];

  const shopifyCustomerId = conversationDetails.meta?.sender?.custom_attributes?.[
    'shopify_customer_id'
  ] as string | undefined;

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

  // Phase 4: Build prompt and call Claude
  const userPrompt = buildPrompt({
    customerName,
    customerEmail: email,
    shopifyCustomer,
    orders,
    trackingByNumber,
    currentMessages,
    previousConversations: contactConversations,
    conversationId,
    isNewConversation,
  });

  const systemPrompt = env.claudeSystemPrompt;
  if (!systemPrompt) {
    logger.warn('CLAUDE_SYSTEM_PROMPT is empty, skipping AI draft', { conversationId });
    return;
  }

  if (process.env.DEBUG) {
    const debugNote = `**[DEBUG] Full prompt sent to Claude:**\n\n---\n**System prompt:**\n${systemPrompt}\n\n---\n**User prompt:**\n${userPrompt}\n---`;
    await postPrivateNote(conversationId, debugNote);
    logger.debug('Posted debug prompt to conversation', { conversationId });
  }

  const draft = await generateDraft(systemPrompt, userPrompt);
  if (!draft) {
    logger.warn('Claude returned no draft', { conversationId });
    return;
  }

  // Phase 5: Post as private note
  await postPrivateNote(conversationId, draft);
  logger.info('AI draft posted successfully', { conversationId });
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

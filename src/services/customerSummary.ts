import * as z from 'zod/v4';
import { logger } from '../utils/logger.js';
import { getDb } from './firestore.js';
import { generateStructured } from './claude.js';
import { getAiConfig } from './appConfig.js';
import {
  getContactConversations,
  getConversationMessages,
} from './chatwootConversation.js';
import { fetchCustomerOrders, searchCustomerByEmail } from './shopify.js';
import {
  deriveDeliveryStatus,
  classifySubscriptionOrder,
} from './customerProfile.js';
import { countSubscriptionOrders } from '../utils/formatters.js';
import type { ChatwootMessage } from '../types/chatwoot.js';
import type { ShopifyOrder } from '../types/index.js';
import type { CustomerSummary } from '../types/summary.js';

const SummarySchema = z.object({
  overview: z.string(),
  history: z.array(
    z.object({
      conversationId: z.number().nullable(),
      date: z.string().nullable(),
      status: z.string().nullable(),
      summary: z.string(),
    }),
  ),
});

const COLLECTION = 'customerSummaries';
const MAX_CONVERSATIONS = 15;

interface ConversationWithMessages {
  id: number;
  createdAt: number;
  status: string;
  messages: ChatwootMessage[];
}

export interface SummaryInput {
  contactId: number;
  conversationId?: number | null;
  email?: string | null;
  shopifyCustomerId?: string | null;
  customerName?: string | null;
  orders: ShopifyOrder[];
  conversations: ConversationWithMessages[];
}

// --- Firestore read/write ---

export async function getStoredSummary(
  contactId: number,
): Promise<CustomerSummary | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const snap = await db.collection(COLLECTION).doc(String(contactId)).get();
    if (!snap.exists) return null;
    return snap.data() as CustomerSummary;
  } catch (err) {
    logger.warn('Failed to read stored summary', {
      contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function storeSummary(summary: CustomerSummary): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .collection(COLLECTION)
      .doc(String(summary.contactId))
      .set(summary, { merge: true });
    logger.info('Stored customer summary', { contactId: summary.contactId });
  } catch (err) {
    logger.warn('Failed to store summary', {
      contactId: summary.contactId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Context gathering ---

/**
 * Fetches the contact's conversations and the full message thread of each
 * (bounded to the most recent MAX_CONVERSATIONS), so the summary can reflect
 * the complete support history.
 */
export async function gatherConversationsWithMessages(
  contactId: number,
): Promise<ConversationWithMessages[]> {
  const convos = await getContactConversations(contactId);
  const sorted = [...convos]
    .sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0))
    .slice(0, MAX_CONVERSATIONS);

  return Promise.all(
    sorted.map(async (c) => {
      try {
        const res = await getConversationMessages(c.id);
        return {
          id: c.id,
          createdAt: c.created_at,
          status: c.status,
          messages: res.payload,
        };
      } catch {
        return {
          id: c.id,
          createdAt: c.created_at,
          status: c.status,
          messages: c.messages ?? [],
        };
      }
    }),
  );
}

async function resolveOrders(
  shopifyCustomerId: string | null | undefined,
  email: string | null | undefined,
): Promise<ShopifyOrder[]> {
  if (shopifyCustomerId) {
    try {
      const orders = await fetchCustomerOrders(Number(shopifyCustomerId));
      if (orders.length > 0) return orders;
    } catch {
      // fall through to email
    }
  }
  if (email) {
    try {
      const customer = await searchCustomerByEmail(email);
      if (customer) return await fetchCustomerOrders(customer.id);
    } catch {
      // ignore
    }
  }
  return [];
}

// --- Prompt building ---

function buildSummaryUserPrompt(input: SummaryInput): string {
  const sections: string[] = [];

  sections.push(
    `Today is ${new Date().toISOString().split('T')[0]}.`,
  );

  // Customer
  const totalSpent = input.orders
    .reduce((sum, o) => sum + parseFloat(o.total_price || '0'), 0)
    .toFixed(2);
  const currency = input.orders[0]?.currency ?? 'EUR';
  sections.push(
    [
      '--- CUSTOMER ---',
      `Name: ${input.customerName || 'Unknown'}`,
      `Email: ${input.email || 'Unknown'}`,
      `Total orders: ${input.orders.length} (${countSubscriptionOrders(input.orders)} subscription orders)`,
      `Lifetime value: ${totalSpent} ${currency}`,
    ].join('\n'),
  );

  // Orders
  sections.push(buildOrdersSection(input.orders));

  // Conversations
  sections.push(buildConversationsSection(input.conversations));

  return sections.join('\n\n');
}

function buildOrdersSection(orders: ShopifyOrder[]): string {
  if (orders.length === 0) return '--- ORDERS ---\nNo orders found.';

  const sorted = [...orders].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const lines = sorted.map((o) => {
    const date = o.created_at?.split('T')[0] ?? 'N/A';
    const financial = o.financial_status ?? 'unknown';
    const fulfillment = o.fulfillment_status ?? 'unfulfilled';
    // Derived carrier delivery state (in transit / out for delivery /
    // delivered / failure), from the same logic the dashboard uses.
    const delivery = deriveDeliveryStatus(o);
    const subType = classifySubscriptionOrder(o);
    const subTag = subType ? ` | sub: ${subType}` : '';
    const items =
      o.line_items?.map((li) => `${li.title} x${li.quantity}`).join(', ') ??
      'No items';
    const cancelled = o.cancelled_at
      ? ` [CANCELLED: ${o.cancel_reason ?? 'N/A'}]`
      : '';
    // Tracking (carrier + number) when the order has shipped.
    const tracking = buildTrackingLabel(o);
    return `${o.name} | ${date} | ${o.total_price} ${o.currency} | ${financial}/${fulfillment} | delivery: ${delivery}${subTag}${cancelled} | ${items}${tracking}`;
  });

  return `--- ORDERS ---\n${lines.join('\n')}`;
}

function buildTrackingLabel(order: ShopifyOrder): string {
  for (const f of order.fulfillments ?? []) {
    const number = f.tracking_number || f.tracking_numbers?.[0];
    if (!number) continue;
    const company = f.tracking_company ? `${f.tracking_company} ` : '';
    return ` | tracking: ${company}${number}`;
  }
  return '';
}

function buildConversationsSection(
  conversations: ConversationWithMessages[],
): string {
  const ordered = [...conversations].sort((a, b) => a.createdAt - b.createdAt);

  const blocks: string[] = [];
  for (const convo of ordered) {
    const date = new Date(convo.createdAt * 1000).toISOString().split('T')[0];
    const visible = [...convo.messages]
      // Exclude activity messages (type 2, e.g. "added refund" label events) so
      // the summary never mistakes them for real agent statements.
      .filter((m) => !m.private && m.content && (m.message_type === 0 || m.message_type === 1))
      .sort((a, b) => a.created_at - b.created_at);

    if (visible.length === 0) continue;

    const lines = visible.map((m) => {
      const role = m.message_type === 0 ? 'CUSTOMER' : 'AGENT';
      return `  ${role}: ${m.content}`;
    });

    blocks.push(
      `Conversation #${convo.id} | ${date} | status: ${convo.status}\n${lines.join('\n')}`,
    );
  }

  if (blocks.length === 0) {
    return '--- CONVERSATIONS ---\nNo prior support conversations.';
  }

  return `--- CONVERSATIONS ---\n${blocks.join('\n---\n')}`;
}

// --- Public API ---

/**
 * Generates a customer summary from already-assembled context and stores it.
 * Best-effort: returns null on any failure without throwing.
 */
export async function generateAndStoreSummary(
  input: SummaryInput,
): Promise<CustomerSummary | null> {
  const cfg = await getAiConfig();
  const userPrompt = buildSummaryUserPrompt(input);
  const parsed = await generateStructured(
    cfg.summarySystemPrompt,
    userPrompt,
    SummarySchema,
    {
      model: cfg.summaryModel,
      maxTokens: cfg.summaryMaxTokens,
      meta: {
        kind: 'summary',
        contactId: input.contactId,
        conversationId: input.conversationId ?? null,
      },
    },
  );
  if (!parsed) {
    logger.warn('Summary generation returned no content', {
      contactId: input.contactId,
    });
    return null;
  }

  const summary: CustomerSummary = {
    contactId: input.contactId,
    email: input.email ?? null,
    shopifyCustomerId: input.shopifyCustomerId ?? null,
    conversationId: input.conversationId ?? null,
    overview: parsed.overview,
    history: parsed.history,
    model: cfg.summaryModel,
    generatedAt: new Date().toISOString(),
  };

  await storeSummary(summary);
  return summary;
}

/**
 * Fetches all context fresh for a contact (orders + full conversations) and
 * generates + stores a summary. Used by the on-demand refresh endpoint.
 */
export async function refreshSummaryForContact(params: {
  contactId: number;
  conversationId?: number | null;
  email?: string | null;
  shopifyCustomerId?: string | null;
  customerName?: string | null;
}): Promise<CustomerSummary | null> {
  const [orders, conversations] = await Promise.all([
    resolveOrders(params.shopifyCustomerId, params.email),
    gatherConversationsWithMessages(params.contactId),
  ]);

  return generateAndStoreSummary({
    contactId: params.contactId,
    conversationId: params.conversationId,
    email: params.email,
    shopifyCustomerId: params.shopifyCustomerId,
    customerName: params.customerName,
    orders,
    conversations,
  });
}

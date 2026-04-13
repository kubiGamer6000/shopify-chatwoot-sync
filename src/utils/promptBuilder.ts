import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';
import type { ChatwootMessage, ChatwootConversation } from '../types/chatwoot.js';
import type { TrackingSummary } from '../types/tracking.js';
import type { Classification } from '../types/ai.js';
import { formatAddress, countSubscriptionOrders } from './formatters.js';

export interface PipelineContext {
  customerName?: string;
  customerEmail?: string;
  shopifyCustomer?: ShopifyCustomer | null;
  orders: ShopifyOrder[];
  trackingByNumber: Map<string, TrackingSummary>;
  currentMessages: ChatwootMessage[];
  previousConversations: ChatwootConversation[];
  conversationId: number;
  isNewConversation: boolean;
  aiTurnCount: number;
}

export function buildClassifierContext(ctx: PipelineContext): string {
  const sections: string[] = [];

  sections.push(`Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`);
  sections.push(buildCustomerSection(ctx));
  sections.push(buildOrderSection(ctx.orders));
  sections.push(buildCurrentConversationSection(ctx.currentMessages));

  return sections.filter(Boolean).join('\n\n');
}

export function buildResponderContext(
  ctx: PipelineContext,
  classification: Classification,
): string {
  const sections: string[] = [];

  sections.push(`Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`);

  sections.push(`--- CLASSIFICATION ---
Intents: ${classification.intents.join(', ')} (primary: ${classification.primary_intent})
Confidence: ${classification.confidence.toFixed(2)}
Sentiment: ${classification.sentiment}
AI turn: ${ctx.aiTurnCount} of 3`);

  sections.push(buildCustomerSection(ctx));
  sections.push(buildOrderSection(ctx.orders));
  sections.push(buildTrackingSection(ctx.orders, ctx.trackingByNumber));
  sections.push(buildCurrentConversationSection(ctx.currentMessages));
  sections.push(buildPreviousConversationsSection(ctx.previousConversations, ctx.conversationId));

  return sections.filter(Boolean).join('\n\n');
}

function buildCustomerSection(ctx: PipelineContext): string {
  const name = ctx.customerName || 'Unknown';
  const email = ctx.customerEmail || 'Unknown';
  const conversationType = ctx.isNewConversation ? 'a new conversation' : 'an ongoing conversation';

  const totalOrders = ctx.orders.length;
  const subscriptionOrders = countSubscriptionOrders(ctx.orders);

  const totalSpent = ctx.orders
    .reduce((sum, o) => sum + parseFloat(o.total_price || '0'), 0)
    .toFixed(2);
  const currency = ctx.orders[0]?.currency ?? ctx.shopifyCustomer?.currency ?? 'EUR';

  const address = ctx.shopifyCustomer?.default_address
    ? formatAddress(ctx.shopifyCustomer.default_address)
    : 'Not available';

  const hasShopifyData = ctx.shopifyCustomer != null;

  const lines = [
    `Customer: ${name} (${email})`,
    `Shopify data: ${hasShopifyData ? 'Found' : 'NOT FOUND — customer email could not be matched to Shopify'}`,
    `Conversation: This is ${conversationType} (conversation #${ctx.conversationId}).`,
    `Total orders: ${totalOrders}, of which ${subscriptionOrders} are subscription orders.`,
    `Lifetime value: ${totalSpent} ${currency}`,
    `Shipping address: ${address}`,
  ];

  return `--- CUSTOMER ---\n${lines.join('\n')}`;
}

function buildOrderSection(orders: ShopifyOrder[]): string {
  if (orders.length === 0) return '--- ORDER HISTORY ---\nNo orders found for this customer.';

  const sorted = [...orders].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const lines = sorted.map((order) => {
    const date = order.created_at?.split('T')[0] ?? 'N/A';
    const financial = order.financial_status ?? 'unknown';
    const fulfillment = order.fulfillment_status ?? 'unfulfilled';
    const daysSinceOrder = Math.floor(
      (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60 * 24),
    );
    const items = order.line_items
      ?.map((li) => `${li.title} x${li.quantity} (${li.price} ${order.currency})`)
      .join(', ') ?? 'No items';
    const cancelled = order.cancelled_at ? ` [CANCELLED: ${order.cancel_reason ?? 'N/A'}]` : '';

    return [
      `Order ${order.name} | ${date} (${daysSinceOrder}d ago) | ${order.total_price} ${order.currency} | ${financial} / ${fulfillment}${cancelled}`,
      `  Items: ${items}`,
    ].join('\n');
  });

  return `--- ORDER HISTORY ---\n${lines.join('\n---\n')}`;
}

function buildTrackingSection(
  orders: ShopifyOrder[],
  trackingByNumber: Map<string, TrackingSummary>,
): string {
  const fulfilledOrders = [...orders]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .filter((o) => o.fulfillments && o.fulfillments.length > 0)
    .slice(0, 2);

  if (fulfilledOrders.length === 0) {
    return '--- TRACKING (Last 2 Orders) ---\nNo fulfilled orders with tracking information.';
  }

  const lines: string[] = [];

  for (const order of fulfilledOrders) {
    for (const fulfillment of order.fulfillments ?? []) {
      const trackNum = fulfillment.tracking_number || fulfillment.tracking_numbers?.[0];
      if (!trackNum) continue;

      const summary = trackingByNumber.get(trackNum);
      if (summary) {
        const estDelivery = summary.estimatedDelivery
          ? `Est. delivery: ${summary.estimatedDelivery.from} to ${summary.estimatedDelivery.to}`
          : '';

        lines.push(
          `${order.name} | Tracking: ${trackNum}`,
          `  Status: ${summary.status}${summary.subStatus ? ` (${summary.subStatus})` : ''}`,
          summary.lastEvent ? `  Last event: ${summary.lastEvent}${summary.lastLocation ? ` - ${summary.lastLocation}` : ''}` : '',
          summary.lastUpdate ? `  Last update: ${summary.lastUpdate}` : '',
          estDelivery ? `  ${estDelivery}` : '',
        );

        if (summary.events.length > 0) {
          lines.push('  Event timeline:');
          for (const event of summary.events.slice(0, 10)) {
            lines.push(`    ${event.time_iso} | ${event.description}${event.location ? ` (${event.location})` : ''}`);
          }
        }
      } else {
        const trackUrl = fulfillment.tracking_url || fulfillment.tracking_urls?.[0] || '';
        lines.push(
          `${order.name} | Tracking: ${trackNum}`,
          `  Carrier: ${fulfillment.tracking_company ?? 'Unknown'}`,
          `  Fulfillment status: ${fulfillment.status}`,
          trackUrl ? `  Tracking URL: ${trackUrl}` : '',
        );
      }

      lines.push('---');
    }
  }

  return `--- TRACKING (Last 2 Orders) ---\n${lines.filter(Boolean).join('\n')}`;
}

function buildCurrentConversationSection(messages: ChatwootMessage[]): string {
  if (messages.length === 0) return '--- CURRENT CONVERSATION ---\nNo messages.';

  const sorted = [...messages].sort((a, b) => a.created_at - b.created_at);

  const lines = sorted
    .filter((m) => !m.private)
    .map((m) => {
      const role = m.message_type === 0 ? 'CUSTOMER' : 'AGENT';
      const time = new Date(m.created_at * 1000).toISOString();
      const content = m.content || '[no text content]';
      return `[${time}] ${role}: ${content}`;
    });

  return `--- CURRENT CONVERSATION ---\n${lines.join('\n')}`;
}

function buildPreviousConversationsSection(
  conversations: ChatwootConversation[],
  currentConversationId: number,
): string {
  const previous = conversations
    .filter((c) => c.id !== currentConversationId)
    .sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0))
    .slice(0, 5);

  if (previous.length === 0) {
    return '--- PREVIOUS CONVERSATIONS ---\nNo previous conversations with this customer.';
  }

  const lines: string[] = [];

  for (const convo of previous) {
    const date = new Date(convo.created_at * 1000).toISOString().split('T')[0];
    const status = convo.status;
    lines.push(`Conversation #${convo.id} | ${date} | Status: ${status}`);

    const msgs = convo.messages ?? [];
    const visibleMsgs = msgs
      .filter((m) => !m.private)
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, 10);

    for (const m of visibleMsgs) {
      const role = m.message_type === 0 ? 'CUSTOMER' : 'AGENT';
      const content = m.content || '[no text content]';
      lines.push(`  ${role}: ${content}`);
    }

    lines.push('---');
  }

  return `--- PREVIOUS CONVERSATIONS ---\n${lines.join('\n')}`;
}

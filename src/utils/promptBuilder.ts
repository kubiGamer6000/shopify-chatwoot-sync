import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';
import type { ChatwootMessage, ChatwootConversation } from '../types/chatwoot.js';
import type { TrackingSummary } from '../types/tracking.js';
import { formatAddress, countSubscriptionOrders } from './formatters.js';

export interface PromptContext {
  customerName?: string;
  customerEmail?: string;
  shopifyCustomer?: ShopifyCustomer | null;
  orders: ShopifyOrder[];
  trackingByNumber: Map<string, TrackingSummary>;
  currentMessages: ChatwootMessage[];
  previousConversations: ChatwootConversation[];
  conversationId: number;
  isNewConversation: boolean;
  emailSubject?: string;
  // Free-form instruction from a human agent (dashboard composer). When present,
  // it takes precedence over the default playbook for how to respond.
  agentInstruction?: string;
  // Guidance appended when the contact could not be matched to a Shopify
  // account with orders (e.g. they wrote from a different email and gave no
  // order number). Tells the AI to ask for an order number / original email if
  // the request actually needs their order data.
  lookupGuidance?: string;
  // Set when this draft is for a conversation the AI bot just auto-escalated to
  // a human. The customer already received a brief holding reply; the draft
  // should be the agent's substantive next reply.
  escalationContext?: boolean;
}

export function buildPrompt(ctx: PromptContext): string {
  const sections: string[] = [];

  sections.push(`Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`);

  sections.push(buildCustomerSection(ctx));
  sections.push(buildOrderSection(ctx.orders));
  sections.push(buildTrackingSection(ctx.orders, ctx.trackingByNumber));
  sections.push(buildCurrentConversationSection(ctx.currentMessages, ctx.emailSubject));
  sections.push(buildPreviousConversationsSection(ctx.previousConversations, ctx.conversationId));

  if (ctx.escalationContext) {
    sections.push(
      '--- JUST ESCALATED ---\nThis conversation was just auto-escalated from the AI bot to a human agent. The customer has already received a brief holding reply telling them a team member will be in touch shortly. Write the draft for the human agent\'s actual substantive next reply that resolves the customer\'s request (do not repeat the holding message).',
    );
  }

  if (ctx.lookupGuidance && ctx.lookupGuidance.trim()) {
    sections.push(`--- CUSTOMER NOT MATCHED ---\n${ctx.lookupGuidance.trim()}`);
  }

  if (ctx.agentInstruction && ctx.agentInstruction.trim()) {
    sections.push(
      `--- AGENT INSTRUCTION ---\nThe human agent has given you a specific instruction for how to write this reply. Follow it, overriding the default playbook where they conflict (but never break the ABSOLUTE RULES):\n\n${ctx.agentInstruction.trim()}`,
    );
  }

  return sections.filter(Boolean).join('\n\n');
}

function buildCustomerSection(ctx: PromptContext): string {
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

  const lines = [
    `Customer: ${name} (${email})`,
    `Conversation: This is ${conversationType} (conversation #${ctx.conversationId}).`,
    `Total orders: ${totalOrders}, of which ${subscriptionOrders} are subscription orders.`,
    `Lifetime value: ${totalSpent} ${currency}`,
    `Shipping address: ${address}`,
  ];

  return lines.join('\n');
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
    const items = order.line_items
      ?.map((li) => `${li.title} x${li.quantity} (${li.price} ${order.currency})`)
      .join(', ') ?? 'No items';

    const fs = financial.toLowerCase();
    const isRefunded = fs === 'refunded';
    const isPartiallyRefunded = fs === 'partially_refunded';
    const isVoided = fs === 'voided';
    const isCancelled = Boolean(order.cancelled_at);
    const isFulfilled = (order.fulfillment_status ?? '').toLowerCase() === 'fulfilled';

    const flags: string[] = [];
    if (isCancelled) flags.push(`CANCELLED: ${order.cancel_reason ?? 'N/A'}`);
    if (isRefunded) flags.push('REFUNDED');
    if (isPartiallyRefunded) flags.push('PARTIALLY REFUNDED');
    if (isVoided) flags.push('VOIDED');
    const flagStr = flags.length > 0 ? ` [${flags.join(' | ')}]` : '';

    const orderLines = [
      `Order ${order.name} | ${date} | ${order.total_price} ${order.currency} | ${financial} / ${fulfillment}${flagStr}`,
      `  Items: ${items}`,
    ];

    // Strong inline warning so neither the responder nor the draft tells the
    // customer a refunded/cancelled order is "on its way".
    if ((isRefunded || isCancelled || isVoided) && !isFulfilled) {
      orderLines.push(
        '  NOTE: This order was refunded/cancelled and never fulfilled. Do NOT tell the customer it is on its way or in transit.',
      );
    }

    return orderLines.join('\n');
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

function buildCurrentConversationSection(messages: ChatwootMessage[], emailSubject?: string): string {
  if (messages.length === 0) return '--- CURRENT CONVERSATION ---\nNo messages.';

  const sorted = [...messages].sort((a, b) => a.created_at - b.created_at);

  const lines = sorted
    // Only real customer (0) / agent (1) messages. Activity messages (2, e.g.
    // "Scandi Gum added refund" when a label is applied) must NOT reach the AI:
    // they read like an agent statement and cause false claims (e.g. telling a
    // customer their order was already refunded).
    .filter((m) => !m.private && (m.message_type === 0 || m.message_type === 1))
    .map((m) => {
      const role = m.message_type === 0 ? 'CUSTOMER' : 'AGENT';
      const time = new Date(m.created_at * 1000).toISOString();
      const content = m.content || '[no text content]';
      return `[${time}] ${role}: ${content}`;
    });

  const subjectLine = emailSubject ? `Subject: ${emailSubject}\n` : '';
  return `--- CURRENT CONVERSATION ---\n${subjectLine}${lines.join('\n')}`;
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
      // Exclude activity messages (type 2) — see buildCurrentConversationSection.
      .filter((m) => !m.private && (m.message_type === 0 || m.message_type === 1))
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

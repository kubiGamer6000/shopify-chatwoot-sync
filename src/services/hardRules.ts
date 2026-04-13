import type { ShopifyOrder } from '../types/index.js';
import { logger } from '../utils/logger.js';

const UNFULFILLED_URGENT_DAYS = 14;

export interface HardRuleResult {
  triggered: boolean;
  reason?: string;
  labels?: string[];
  privateNote?: string;
}

export function checkHardRules(orders: ShopifyOrder[]): HardRuleResult {
  const urgentOrder = findLongUnfulfilledOrder(orders);
  if (urgentOrder) {
    const daysSince = Math.floor(
      (Date.now() - new Date(urgentOrder.created_at).getTime()) / (1000 * 60 * 60 * 24),
    );

    logger.warn('Hard rule triggered: unfulfilled order > 14 days', {
      orderId: urgentOrder.id,
      orderName: urgentOrder.name,
      daysSince,
    });

    return {
      triggered: true,
      reason: 'unfulfilled_order_14d',
      labels: ['order-status', 'urgent'],
      privateNote: [
        'SYSTEM FLAG: Hard Rule Triggered',
        '---',
        `Customer has order ${urgentOrder.name} unfulfilled for ${daysSince} days.`,
        `Order placed: ${urgentOrder.created_at.split('T')[0]}`,
        `Amount: ${urgentOrder.total_price} ${urgentOrder.currency}`,
        '',
        'Requires immediate human attention. AI pipeline was skipped.',
      ].join('\n'),
    };
  }

  return { triggered: false };
}

function findLongUnfulfilledOrder(orders: ShopifyOrder[]): ShopifyOrder | undefined {
  const now = Date.now();
  return orders.find((order) => {
    if (order.cancelled_at) return false;
    if (order.fulfillment_status && order.fulfillment_status !== 'unfulfilled') return false;
    // fulfillment_status is null or "unfulfilled" for unfulfilled orders
    const orderAge = now - new Date(order.created_at).getTime();
    const daysSince = orderAge / (1000 * 60 * 60 * 24);
    return daysSince >= UNFULFILLED_URGENT_DAYS;
  });
}

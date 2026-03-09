import { env } from '../config/env.js';
import type {
  ShopifyCustomer,
  ShopifyOrder,
  ShopifyAddress,
  ChatwootCustomAttributes,
} from '../types/index.js';

const SUBSCRIPTION_TAGS = ['subscription first order', 'subscription recurring order'];

/**
 * Normalizes a phone number to E.164 format for Chatwoot.
 * Returns the cleaned number if valid, or undefined if it can't be normalized.
 */
export function toE164(phone: string | undefined | null): string | undefined {
  if (!phone) return undefined;

  // Strip everything except digits and leading +
  let cleaned = phone.replace(/[^\d+]/g, '');

  // If it doesn't start with +, add it (assume it already has country code)
  if (!cleaned.startsWith('+')) {
    cleaned = `+${cleaned}`;
  }

  // E.164: + followed by 7-15 digits
  if (/^\+\d{7,15}$/.test(cleaned)) {
    return cleaned;
  }

  return undefined;
}

export function countSubscriptionOrders(orders: ShopifyOrder[]): number {
  return orders.filter((order) => {
    if (!order.tags) return false;
    const orderTags = order.tags.toLowerCase().split(',').map((t) => t.trim());
    return orderTags.some((tag) => SUBSCRIPTION_TAGS.includes(tag));
  }).length;
}

export function formatAddress(address?: ShopifyAddress): string {
  if (!address) return '';
  const parts = [
    address.address1,
    address.address2,
    address.city,
    address.province_code || address.province,
    address.zip,
    address.country_code || address.country,
  ].filter(Boolean);
  return parts.join(', ');
}

export function formatOrdersSummary(orders: ShopifyOrder[]): string {
  if (orders.length === 0) return 'No orders';

  return orders
    .slice(0, 10)
    .map((order) => {
      const date = order.created_at ? order.created_at.split('T')[0] : 'N/A';
      const financial = order.financial_status ?? 'unknown';
      const fulfillment = order.fulfillment_status ?? 'unfulfilled';
      const tracking = getLatestTrackingUrl(order);
      const trackingPart = tracking ? ` | Track: ${tracking}` : '';
      return `${order.name} | ${date} | ${order.total_price} ${order.currency} | ${financial} | ${fulfillment}${trackingPart}`;
    })
    .join('\n');
}

function getLatestTrackingUrl(order: ShopifyOrder): string | undefined {
  if (!order.fulfillments?.length) return undefined;
  for (let i = order.fulfillments.length - 1; i >= 0; i--) {
    const f = order.fulfillments[i]!;
    if (f.tracking_url) return f.tracking_url;
    if (f.tracking_urls?.length) return f.tracking_urls[0];
  }
  return undefined;
}

export function buildCustomAttributes(
  customer: ShopifyCustomer,
  orders: ShopifyOrder[],
): Partial<ChatwootCustomAttributes> {
  const sorted = [...orders].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const latest = sorted[0];

  const totalSpent = orders
    .reduce((sum, o) => sum + parseFloat(o.total_price || '0'), 0)
    .toFixed(2);
  const currency = latest?.currency ?? customer.currency ?? 'USD';

  const attrs: Partial<ChatwootCustomAttributes> = {
    shopify_customer_id: String(customer.id),
    shopify_url: `https://${env.shopifyStoreDomain}/admin/customers/${customer.id}`,
    total_orders: orders.length,
    total_spent: `${totalSpent} ${currency}`,
    subscription_orders: countSubscriptionOrders(orders),
    default_address: formatAddress(customer.default_address),
    recent_orders: formatOrdersSummary(sorted),
  };

  if (latest) {
    const fulfillment = latest.fulfillment_status ?? 'unfulfilled';
    attrs.last_order_name = latest.name;
    attrs.last_order_status = `${latest.financial_status} / ${fulfillment}`;
    attrs.last_order_date = latest.created_at.split('T')[0] ?? '';
    attrs.last_order_tracking_url = getLatestTrackingUrl(latest) ?? '';
  }

  return attrs;
}

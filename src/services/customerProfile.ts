import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  fetchCustomer,
  fetchCustomerOrders,
  searchCustomerByEmail,
} from './shopify.js';
import { getTrackingStatus } from './tracking.js';
import { getSubscriptionsByEmail } from './skio.js';
import { formatAddress, countSubscriptionOrders } from '../utils/formatters.js';
import type {
  ShopifyCustomer,
  ShopifyOrder,
  ShopifyFulfillment,
} from '../types/index.js';
import type { TrackingSummary } from '../types/tracking.js';
import type { SkioSubscription } from '../types/skio.js';

// How many of the most recent fulfilled orders to enrich with live 17track data.
const TRACKING_LOOKUP_LIMIT = 12;

export type DeliveryStatus =
  | 'unfulfilled'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'in_transit'
  | 'out_for_delivery'
  | 'ready_for_pickup'
  | 'delivered'
  | 'failure'
  | 'cancelled';

export type SubscriptionOrderType = 'first' | 'recurring' | null;

export interface OrderLineItemDTO {
  title: string;
  quantity: number;
  price: string;
  variantTitle?: string;
}

export interface OrderTrackingDTO {
  number: string;
  company?: string;
  url?: string;
  shipmentStatus?: string | null;
  // Live 17track summary, when available.
  live?: TrackingSummary;
}

export interface OrderDTO {
  id: number;
  name: string;
  createdAt: string;
  date: string;
  totalPrice: string;
  currency: string;
  financialStatus: string;
  fulfillmentStatus: string;
  deliveryStatus: DeliveryStatus;
  subscriptionType: SubscriptionOrderType;
  cancelledAt: string | null;
  lineItems: OrderLineItemDTO[];
  tracking: OrderTrackingDTO[];
  adminUrl: string;
}

export interface SubscriptionLineDTO {
  productTitle: string;
  variantTitle: string | null;
  quantity: number | null;
  price: number | null;
}

export interface SubscriptionDTO {
  id: string;
  platformId: string | null;
  status: string;
  statusContext: string | null;
  isActive: boolean;
  createdAt: string;
  cancelledAt: string | null;
  nextBillingDate: string | null;
  cyclesCompleted: number | null;
  intervalLabel: string | null;
  lines: SubscriptionLineDTO[];
}

export interface CustomerProfile {
  found: boolean;
  customer: {
    shopifyCustomerId: number | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    shopifyUrl: string | null;
  };
  summary: {
    totalOrders: number;
    totalSpent: string;
    currency: string;
    subscriptionOrderCount: number;
    activeSubscriptionCount: number;
  };
  orders: OrderDTO[];
  subscriptions: SubscriptionDTO[];
}

const SUBSCRIPTION_FIRST_TAG = 'subscription first order';
const SUBSCRIPTION_RECURRING_TAG = 'subscription recurring order';

const ACTIVE_SKIO_STATUSES = new Set(['ACTIVE', 'active']);

export function classifySubscriptionOrder(order: ShopifyOrder): SubscriptionOrderType {
  if (!order.tags) return null;
  const tags = order.tags.toLowerCase().split(',').map((t) => t.trim());
  if (tags.includes(SUBSCRIPTION_FIRST_TAG)) return 'first';
  if (tags.includes(SUBSCRIPTION_RECURRING_TAG)) return 'recurring';
  return null;
}

/**
 * Maps Shopify's per-order fulfillment status + per-shipment carrier status into
 * a single high-level delivery state for the UI.
 */
export function deriveDeliveryStatus(order: ShopifyOrder): DeliveryStatus {
  if (order.cancelled_at) return 'cancelled';

  const shipmentStatuses = (order.fulfillments ?? [])
    .map((f) => f.shipment_status?.toLowerCase())
    .filter((s): s is string => Boolean(s));

  if (shipmentStatuses.includes('delivered')) return 'delivered';
  if (shipmentStatuses.includes('out_for_delivery')) return 'out_for_delivery';
  if (shipmentStatuses.includes('ready_for_pickup')) return 'ready_for_pickup';
  if (shipmentStatuses.includes('failure')) return 'failure';
  if (
    shipmentStatuses.some((s) =>
      ['in_transit', 'confirmed', 'attempted_delivery', 'label_printed', 'label_purchased'].includes(s),
    )
  ) {
    return 'in_transit';
  }

  const fulfillment = order.fulfillment_status;
  if (fulfillment === 'fulfilled') return 'fulfilled';
  if (fulfillment === 'partial') return 'partially_fulfilled';
  return 'unfulfilled';
}

function collectTrackingNumbers(fulfillments: ShopifyFulfillment[]): string[] {
  const numbers: string[] = [];
  for (const f of fulfillments) {
    if (f.tracking_number) {
      numbers.push(f.tracking_number);
    } else if (f.tracking_numbers?.length) {
      numbers.push(...f.tracking_numbers.filter(Boolean));
    }
  }
  return numbers;
}

function buildOrderDTO(
  order: ShopifyOrder,
  trackingByNumber: Map<string, TrackingSummary>,
): OrderDTO {
  const fulfillments = order.fulfillments ?? [];

  const tracking: OrderTrackingDTO[] = [];
  for (const f of fulfillments) {
    const number = f.tracking_number || f.tracking_numbers?.[0];
    if (!number) continue;
    tracking.push({
      number,
      company: f.tracking_company,
      url: f.tracking_url || f.tracking_urls?.[0],
      shipmentStatus: f.shipment_status ?? null,
      live: trackingByNumber.get(number),
    });
  }

  return {
    id: order.id,
    name: order.name,
    createdAt: order.created_at,
    date: order.created_at?.split('T')[0] ?? '',
    totalPrice: order.total_price,
    currency: order.currency,
    financialStatus: order.financial_status ?? 'unknown',
    fulfillmentStatus: order.fulfillment_status ?? 'unfulfilled',
    deliveryStatus: deriveDeliveryStatus(order),
    subscriptionType: classifySubscriptionOrder(order),
    cancelledAt: order.cancelled_at ?? null,
    lineItems: (order.line_items ?? []).map((li) => ({
      title: li.title,
      quantity: li.quantity,
      price: li.price,
      variantTitle: li.variant_title,
    })),
    tracking,
    adminUrl: `https://${env.shopifyStoreDomain}/admin/orders/${order.id}`,
  };
}

function buildSubscriptionDTO(sub: SkioSubscription): SubscriptionDTO {
  const interval = sub.DeliveryPolicy?.interval;
  const count = sub.DeliveryPolicy?.intervalCount;
  const intervalLabel =
    interval && count
      ? `Every ${count} ${interval.toLowerCase()}${count > 1 ? 's' : ''}`
      : interval
        ? `Every ${interval.toLowerCase()}`
        : null;

  return {
    id: sub.id,
    platformId: sub.platformId,
    status: sub.status,
    statusContext: sub.statusContext,
    isActive: ACTIVE_SKIO_STATUSES.has(sub.status) && !sub.cancelledAt,
    createdAt: sub.createdAt,
    cancelledAt: sub.cancelledAt,
    nextBillingDate: sub.nextBillingDate,
    cyclesCompleted: sub.cyclesCompleted,
    intervalLabel,
    lines: (sub.SubscriptionLines ?? []).map((line) => ({
      productTitle: line.ProductVariant?.Product?.title ?? 'Unknown product',
      variantTitle: line.ProductVariant?.title ?? null,
      quantity: line.quantity,
      price: line.priceWithoutDiscount,
    })),
  };
}

async function resolveCustomerAndOrders(
  shopifyCustomerId: number | null,
  email: string | null,
): Promise<{ customer: ShopifyCustomer | null; orders: ShopifyOrder[] }> {
  let customer: ShopifyCustomer | null = null;
  let orders: ShopifyOrder[] = [];

  if (shopifyCustomerId) {
    try {
      const [fetchedCustomer, fetchedOrders] = await Promise.all([
        fetchCustomer(shopifyCustomerId),
        fetchCustomerOrders(shopifyCustomerId),
      ]);
      customer = fetchedCustomer;
      orders = fetchedOrders;
    } catch (err) {
      logger.warn('Failed to resolve customer by Shopify ID', {
        shopifyCustomerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (orders.length === 0 && !customer && email) {
    try {
      customer = await searchCustomerByEmail(email);
      if (customer) {
        orders = await fetchCustomerOrders(customer.id);
      }
    } catch (err) {
      logger.warn('Failed to resolve customer by email', {
        email,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { customer, orders };
}

export async function getCustomerProfile(params: {
  shopifyCustomerId?: string | number | null;
  email?: string | null;
}): Promise<CustomerProfile> {
  const shopifyCustomerId = params.shopifyCustomerId
    ? Number(params.shopifyCustomerId)
    : null;
  const requestedEmail = params.email?.trim() || null;

  const { customer, orders } = await resolveCustomerAndOrders(
    shopifyCustomerId,
    requestedEmail,
  );

  const resolvedEmail = customer?.email || requestedEmail;

  // Fetch live tracking + subscriptions in parallel.
  const sortedOrders = [...orders].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const trackingNumbers: string[] = [];
  for (const order of sortedOrders) {
    if (trackingNumbers.length >= TRACKING_LOOKUP_LIMIT) break;
    for (const n of collectTrackingNumbers(order.fulfillments ?? [])) {
      if (!trackingNumbers.includes(n)) trackingNumbers.push(n);
      if (trackingNumbers.length >= TRACKING_LOOKUP_LIMIT) break;
    }
  }

  const [trackingByNumber, subscriptions] = await Promise.all([
    trackingNumbers.length > 0
      ? getTrackingStatus(trackingNumbers).catch((err) => {
          logger.warn('Tracking lookup failed for customer profile', {
            error: err instanceof Error ? err.message : String(err),
          });
          return new Map<string, TrackingSummary>();
        })
      : Promise.resolve(new Map<string, TrackingSummary>()),
    resolvedEmail
      ? getSubscriptionsByEmail(resolvedEmail)
      : Promise.resolve([] as SkioSubscription[]),
  ]);

  const orderDTOs = sortedOrders.map((o) => buildOrderDTO(o, trackingByNumber));
  const subscriptionDTOs = subscriptions.map(buildSubscriptionDTO);

  const totalSpent = orders
    .reduce((sum, o) => sum + parseFloat(o.total_price || '0'), 0)
    .toFixed(2);
  const currency = sortedOrders[0]?.currency ?? customer?.currency ?? 'EUR';

  const found = Boolean(customer || orders.length > 0 || subscriptions.length > 0);

  const name =
    customer && (customer.first_name || customer.last_name)
      ? [customer.first_name, customer.last_name].filter(Boolean).join(' ')
      : null;

  return {
    found,
    customer: {
      shopifyCustomerId: customer?.id ?? shopifyCustomerId,
      name,
      email: resolvedEmail,
      phone: customer?.phone ?? null,
      address: customer?.default_address
        ? formatAddress(customer.default_address)
        : null,
      shopifyUrl: customer?.id
        ? `https://${env.shopifyStoreDomain}/admin/customers/${customer.id}`
        : shopifyCustomerId
          ? `https://${env.shopifyStoreDomain}/admin/customers/${shopifyCustomerId}`
          : null,
    },
    summary: {
      totalOrders: orders.length,
      totalSpent,
      currency,
      subscriptionOrderCount: countSubscriptionOrders(orders),
      activeSubscriptionCount: subscriptionDTOs.filter((s) => s.isActive).length,
    },
    orders: orderDTOs,
    subscriptions: subscriptionDTOs,
  };
}

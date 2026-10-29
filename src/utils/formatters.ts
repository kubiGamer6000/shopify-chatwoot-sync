import { env } from "../config/env.js";
import type {
  ShopifyCustomer,
  ShopifyOrder,
  ShopifyAddress,
  ChatwootCustomAttributes,
} from "../types/index.js";

const SUBSCRIPTION_TAGS = [
  "subscription first order",
  "subscription recurring order",
];

/**
 * Normalizes a phone number to E.164 format for Chatwoot.
 * Returns the cleaned number if valid, or undefined if it can't be normalized.
 */
export function toE164(phone: string | undefined | null): string | undefined {
  if (!phone) return undefined;

  // Strip everything except digits and leading +
  let cleaned = phone.replace(/[^\d+]/g, "");

  // If it doesn't start with +, add it (assume it already has country code)
  if (!cleaned.startsWith("+")) {
    cleaned = `+${cleaned}`;
  }

  // E.164: + followed by 7-15 digits
  if (/^\+\d{7,15}$/.test(cleaned)) {
    return cleaned;
  }

  return undefined;
}

// --- Lifetime value (per currency, net of refunds) ---------------------------

export interface CurrencyTotal {
  currency: string;
  /** Sum of order totals, minor units (cents). */
  grossMinor: number;
  /** Sum of successful refund transactions, minor units. */
  refundedMinor: number;
  /** gross - refunded, minor units. */
  netMinor: number;
}

/** Parses a decimal money string ("12.5", "-3.00") into integer minor units. */
export function toMinorUnits(amount: string | number | null | undefined): number {
  if (amount == null) return 0;
  const str = String(amount).trim();
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(str);
  if (!m) return 0;
  const sign = m[1] ? -1 : 1;
  const whole = Number(m[2] || '0');
  const frac = Number(((m[3] ?? '') + '00').slice(0, 2));
  return sign * (whole * 100 + frac);
}

export function fromMinorUnits(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// Orders whose payment was never captured do not count towards value.
const NON_REVENUE_STATUSES = new Set(['voided', 'expired']);

/**
 * Lifetime value per currency. Different currencies are never summed together,
 * and successful refunds are subtracted (security/accuracy fix P7). Sorted by
 * net value, largest first.
 */
export function lifetimeValue(orders: ShopifyOrder[]): CurrencyTotal[] {
  const totals = new Map<string, CurrencyTotal>();
  const bucket = (currency: string): CurrencyTotal => {
    const key = (currency || 'UNKNOWN').toUpperCase();
    let t = totals.get(key);
    if (!t) {
      t = { currency: key, grossMinor: 0, refundedMinor: 0, netMinor: 0 };
      totals.set(key, t);
    }
    return t;
  };

  for (const order of orders) {
    if (NON_REVENUE_STATUSES.has((order.financial_status ?? '').toLowerCase())) continue;
    bucket(order.currency).grossMinor += toMinorUnits(order.total_price);
    for (const refund of order.refunds ?? []) {
      for (const tx of refund.transactions ?? []) {
        if ((tx.kind ?? '').toLowerCase() !== 'refund') continue;
        if ((tx.status ?? '').toLowerCase() !== 'success') continue;
        bucket(tx.currency || order.currency).refundedMinor += toMinorUnits(tx.amount);
      }
    }
  }

  const list = [...totals.values()].map((t) => ({ ...t, netMinor: t.grossMinor - t.refundedMinor }));
  return list.sort((a, b) => b.netMinor - a.netMinor);
}

/** "123.40 EUR + 450.00 SEK" (net of refunds), or "0.00 <fallback>". */
export function formatLifetimeValue(orders: ShopifyOrder[], fallbackCurrency = 'EUR'): string {
  const totals = lifetimeValue(orders);
  if (totals.length === 0) return `0.00 ${fallbackCurrency}`;
  return totals.map((t) => `${fromMinorUnits(t.netMinor)} ${t.currency}`).join(' + ');
}

export function countSubscriptionOrders(orders: ShopifyOrder[]): number {
  return orders.filter((order) => {
    if (!order.tags) return false;
    const orderTags = order.tags
      .toLowerCase()
      .split(",")
      .map((t) => t.trim());
    return orderTags.some((tag) => SUBSCRIPTION_TAGS.includes(tag));
  }).length;
}

/**
 * Resolves a human-friendly country name for an address. Prefers Shopify's
 * full `country` field (e.g. "Germany"), falling back to expanding the 2-letter
 * `country_code` (e.g. "DE" -> "Germany") via Intl, and finally the raw code.
 */
function formatCountry(address: ShopifyAddress): string | undefined {
  if (address.country?.trim()) return address.country.trim();
  if (address.country_code?.trim()) {
    const code = address.country_code.trim().toUpperCase();
    try {
      const display = new Intl.DisplayNames(["en"], { type: "region" });
      return display.of(code) || code;
    } catch {
      return code;
    }
  }
  return undefined;
}

export function formatAddress(address?: ShopifyAddress): string {
  if (!address) return "";
  const parts = [
    address.address1,
    address.address2,
    address.city,
    address.province_code || address.province,
    address.zip,
    formatCountry(address),
  ].filter(Boolean);
  return parts.join(", ");
}

export function formatOrdersSummary(orders: ShopifyOrder[]): string {
  if (orders.length === 0) return "No orders";

  return orders
    .slice(0, 10)
    .map((order) => formatOrderLine(order))
    .join("\n");
}

function formatOrderLine(order: ShopifyOrder): string {
  const date = order.created_at ? order.created_at.split("T")[0] : "N/A";
  const financial = order.financial_status ?? "unknown";
  const fulfillment = order.fulfillment_status ?? "unfulfilled";
  const tracking = getLatestTrackingUrl(order);
  const trackingPart = tracking ? ` | Track: ${tracking}` : "";
  return `${order.name} | ${date} | ${order.total_price} ${order.currency} | ${financial} | ${fulfillment}${trackingPart}`;
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
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const latest = sorted[0];

  const currency = latest?.currency ?? customer.currency ?? "USD";

  const attrs: Partial<ChatwootCustomAttributes> = {
    shopify_customer_id: String(customer.id),
    shopify_url: `https://${env.shopifyStoreDomain}/admin/customers/${customer.id}`,
    total_orders: orders.length,
    total_spent: formatLifetimeValue(orders, currency),
    subscription_orders: countSubscriptionOrders(orders),
    default_address: formatAddress(customer.default_address),
    recent_orders: formatOrdersSummary(sorted),
  };

  if (latest) {
    const fulfillment = latest.fulfillment_status ?? "unfulfilled";
    attrs.last_order_name = latest.name;
    attrs.last_order_status = `${latest.financial_status} / ${fulfillment}`;
    attrs.last_order_date = latest.created_at.split("T")[0] ?? "";
    attrs.last_order_tracking_url = getLatestTrackingUrl(latest) ?? "";
  }

  return attrs;
}

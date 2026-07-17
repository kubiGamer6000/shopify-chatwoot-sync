import axios, { AxiosError } from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { getAccessToken } from './shopifyAuth.js';
import { cached, cacheDelete } from './cache.js';
import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';

const API_VERSION = '2026-01';

// Short TTLs: order/customer data changes are pushed to us via Shopify webhooks
// (which also invalidate these caches), so the TTL is only a backstop.
const ORDERS_CACHE_NS = 'shopifyOrders';
const CUSTOMER_CACHE_NS = 'shopifyCustomer';
const CUSTOMER_BY_EMAIL_CACHE_NS = 'shopifyCustomerByEmail';
const SHOPIFY_CACHE_TTL_MS = 10 * 60 * 1000;

function emailCacheKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Drops the cached Shopify data for a customer and/or email. Called from the
 * Shopify order/customer webhooks so an update is reflected immediately.
 */
export async function invalidateCustomerCache(params: {
  customerId?: number | string | null;
  email?: string | null;
}): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (params.customerId != null && String(params.customerId).trim()) {
    const id = String(params.customerId);
    tasks.push(cacheDelete(ORDERS_CACHE_NS, id));
    tasks.push(cacheDelete(CUSTOMER_CACHE_NS, id));
  }
  if (params.email && params.email.trim()) {
    tasks.push(cacheDelete(CUSTOMER_BY_EMAIL_CACHE_NS, emailCacheKey(params.email)));
  }
  await Promise.all(tasks);
}

const shopifyClient = axios.create({
  baseURL: `https://${env.shopifyStoreDomain}/admin/api/${API_VERSION}`,
  headers: { 'Content-Type': 'application/json' },
});

// Inject a fresh access token into every request
shopifyClient.interceptors.request.use(async (config) => {
  const token = await getAccessToken();
  config.headers['X-Shopify-Access-Token'] = token;
  return config;
});

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AxiosError && err.response?.status === 429) {
        const retryAfter = parseFloat(err.response.headers['retry-after'] ?? '2');
        const waitMs = retryAfter * 1000;
        logger.warn(`Shopify rate limited, retrying in ${retryAfter}s`, { attempt });
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Shopify API: max retries exceeded');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchCustomerOrders(
  customerId: number,
  limit = 50,
): Promise<ShopifyOrder[]> {
  // `limit` is only the page size — all pages are fetched — so the full result
  // set is identical regardless of it; cache purely by customer id.
  return cached(ORDERS_CACHE_NS, String(customerId), SHOPIFY_CACHE_TTL_MS, () =>
    fetchCustomerOrdersLive(customerId, limit),
  );
}

async function fetchCustomerOrdersLive(
  customerId: number,
  limit: number,
): Promise<ShopifyOrder[]> {
  const allOrders: ShopifyOrder[] = [];
  let url: string | null =
    `/customers/${customerId}/orders.json?status=any&limit=${limit}`;

  while (url) {
    const res = await withRetry(() => shopifyClient.get<{ orders: ShopifyOrder[] }>(url!));
    allOrders.push(...res.data.orders);

    const linkHeader = res.headers['link'] as string | undefined;
    url = parsePaginationNext(linkHeader);
  }

  logger.debug(`Fetched ${allOrders.length} orders for customer ${customerId}`);
  return allOrders;
}

export async function fetchCustomer(
  customerId: number,
): Promise<ShopifyCustomer | null> {
  return cached(CUSTOMER_CACHE_NS, String(customerId), SHOPIFY_CACHE_TTL_MS, () =>
    fetchCustomerLive(customerId),
  );
}

async function fetchCustomerLive(
  customerId: number,
): Promise<ShopifyCustomer | null> {
  try {
    const res = await withRetry(() =>
      shopifyClient.get<{ customer: ShopifyCustomer }>(
        `/customers/${customerId}.json`,
      ),
    );
    return res.data.customer;
  } catch (err) {
    if (err instanceof AxiosError && err.response?.status === 404) {
      return null;
    }
    throw err;
  }
}

export async function fetchOrder(orderId: number): Promise<ShopifyOrder> {
  const res = await withRetry(() =>
    shopifyClient.get<{ order: ShopifyOrder }>(`/orders/${orderId}.json`),
  );
  return res.data.order;
}

export interface CustomerPage {
  customers: ShopifyCustomer[];
  nextUrl: string | null;
}

export async function fetchCustomersPage(
  pageUrl?: string,
  opts: { updatedAtMin?: string } = {},
): Promise<CustomerPage> {
  // `updated_at_min` only applies to the first page; subsequent pages use the
  // opaque page_info cursor (Shopify rejects extra filters alongside it), which
  // is exactly what `pageUrl` carries.
  let url = pageUrl;
  if (!url) {
    const params = new URLSearchParams({ limit: '250' });
    if (opts.updatedAtMin) params.set('updated_at_min', opts.updatedAtMin);
    url = `/customers.json?${params.toString()}`;
  }
  const res = await withRetry(() =>
    shopifyClient.get<{ customers: ShopifyCustomer[] }>(url),
  );

  const linkHeader = res.headers['link'] as string | undefined;
  const nextUrl = parsePaginationNext(linkHeader);

  return { customers: res.data.customers, nextUrl };
}

const BASE_PATH = `/admin/api/${API_VERSION}`;

/**
 * Parses the Link header for cursor-based pagination.
 * Shopify returns full URLs like https://store.myshopify.com/admin/api/2026-01/customers.json?page_info=xxx
 * We strip the /admin/api/{version} prefix so the result is relative to the Axios baseURL.
 */
function parsePaginationNext(linkHeader?: string): string | null {
  if (!linkHeader) return null;

  const parts = linkHeader.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) {
      try {
        const fullUrl = new URL(match[1]);
        const path = fullUrl.pathname;
        const relative = path.startsWith(BASE_PATH)
          ? path.slice(BASE_PATH.length)
          : path;
        return relative + fullUrl.search;
      } catch {
        return match[1];
      }
    }
  }
  return null;
}

export async function searchCustomerByEmail(
  email: string,
): Promise<ShopifyCustomer | null> {
  return cached(
    CUSTOMER_BY_EMAIL_CACHE_NS,
    emailCacheKey(email),
    SHOPIFY_CACHE_TTL_MS,
    () => searchCustomerByEmailLive(email),
  );
}

async function searchCustomerByEmailLive(
  email: string,
): Promise<ShopifyCustomer | null> {
  const res = await withRetry(() =>
    shopifyClient.get<{ customers: ShopifyCustomer[] }>(
      `/customers/search.json?query=email:${encodeURIComponent(email)}`,
    ),
  );
  return res.data.customers[0] ?? null;
}

/**
 * Finds an order by its human-facing order number (the `name` field, e.g.
 * "#11696"). Accepts the number with or without the leading "#". Returns the
 * order (which embeds the `customer` object) or null when no order matches.
 * Tries the "#"-prefixed name first since that is Shopify's canonical format.
 */
export async function searchOrderByName(
  orderNumber: string,
): Promise<ShopifyOrder | null> {
  const trimmed = orderNumber.trim().replace(/^#/, '');
  if (!trimmed) return null;

  const candidates = [`#${trimmed}`, trimmed];
  for (const name of candidates) {
    const res = await withRetry(() =>
      shopifyClient.get<{ orders: ShopifyOrder[] }>(
        `/orders.json?status=any&name=${encodeURIComponent(name)}`,
      ),
    );
    if (res.data.orders.length > 0) {
      return res.data.orders[0] ?? null;
    }
  }
  return null;
}

export { sleep };

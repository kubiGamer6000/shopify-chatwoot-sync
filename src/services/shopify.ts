import axios, { AxiosError } from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { getAccessToken } from './shopifyAuth.js';
import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';

const API_VERSION = '2026-01';

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
): Promise<CustomerPage> {
  const url = pageUrl ?? `/customers.json?limit=250`;
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

export { sleep };

/**
 * Read-only diagnostic for the "dashboard shows 0 orders but attributes show N"
 * bug. Reproduces every Shopify resolution path for a given email and compares
 * the results. Usage:
 *
 *   tsx src/scripts/diagnoseCustomer.ts sven.dobrecevic86@gmail.com
 */
import axios, { AxiosError } from 'axios';
import { env } from '../config/env.js';
import { getAccessToken } from '../services/shopifyAuth.js';
import {
  searchCustomerByEmail,
  fetchCustomerOrders,
  fetchCustomer,
} from '../services/shopify.js';
import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';

const API_VERSION = '2026-01';
const raw = axios.create({
  baseURL: `https://${env.shopifyStoreDomain}/admin/api/${API_VERSION}`,
  headers: { 'Content-Type': 'application/json' },
});
raw.interceptors.request.use(async (config) => {
  const token = await getAccessToken();
  config.headers['X-Shopify-Access-Token'] = token;
  return config;
});

function line() {
  console.log('─'.repeat(72));
}

function summarizeOrders(orders: ShopifyOrder[]): void {
  for (const o of orders) {
    console.log(
      `    ${o.name} | id=${o.id} | ${o.created_at?.split('T')[0]} | ` +
        `${o.total_price} ${o.currency} | ${o.financial_status}/${o.fulfillment_status ?? 'unfulfilled'} | ` +
        `order.customer.id=${o.customer?.id ?? 'none'} | order.email=${o.email ?? 'none'}`,
    );
  }
}

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: tsx src/scripts/diagnoseCustomer.ts <email>');
    process.exit(1);
  }

  console.log(`\nDIAGNOSING: ${email}`);
  console.log(`Store: ${env.shopifyStoreDomain}  API: ${API_VERSION}`);
  line();

  // 1. What does customers/search return? (this is what the live paths use as
  //    a fallback, and can return MULTIPLE customer records for one email)
  console.log('1) GET /customers/search.json?query=email:<email>  (ALL matches)');
  let searchMatches: ShopifyCustomer[] = [];
  try {
    const res = await raw.get<{ customers: ShopifyCustomer[] }>(
      `/customers/search.json?query=email:${encodeURIComponent(email)}`,
    );
    searchMatches = res.data.customers;
    console.log(`   -> ${searchMatches.length} customer record(s) matched`);
    for (const c of searchMatches) {
      console.log(
        `      customer.id=${c.id} | ${c.first_name ?? ''} ${c.last_name ?? ''} | ` +
          `email=${c.email} | orders_count=${c.orders_count} | total_spent=${c.total_spent} | ` +
          `created=${c.created_at?.split('T')[0]}`,
      );
    }
  } catch (err) {
    console.log('   -> ERROR', err instanceof AxiosError ? err.response?.status : err);
  }
  line();

  // 2. What our helper picks (customers[0]) + its orders via the customer-orders endpoint
  console.log('2) Live path: searchCustomerByEmail() -> fetchCustomerOrders(customer.id)');
  const picked = await searchCustomerByEmail(email);
  if (!picked) {
    console.log('   -> searchCustomerByEmail returned null (no customer)');
  } else {
    console.log(
      `   -> picked customer.id=${picked.id} (orders_count field=${picked.orders_count})`,
    );
    const viaCustomerEndpoint = await fetchCustomerOrders(picked.id);
    console.log(
      `   -> /customers/${picked.id}/orders.json?status=any returned ${viaCustomerEndpoint.length} order(s):`,
    );
    summarizeOrders(viaCustomerEndpoint);
  }
  line();

  // 3. For EACH matched customer record, compare orders_count vs the orders endpoint
  console.log('3) Per-customer: orders_count field vs /customers/{id}/orders.json?status=any');
  for (const c of searchMatches) {
    const viaEndpoint = await fetchCustomerOrders(c.id);
    console.log(
      `   customer.id=${c.id}: orders_count=${c.orders_count}  vs  endpoint=${viaEndpoint.length}`,
    );
    if (viaEndpoint.length !== (c.orders_count ?? 0)) {
      console.log('     !! MISMATCH between orders_count and the customer-orders endpoint');
    }
  }
  line();

  // 4. Ground truth: ALL orders for this email regardless of customer linkage
  console.log('4) Ground truth: GET /orders.json?status=any&email=<email> (all orders by email)');
  try {
    const res = await raw.get<{ orders: ShopifyOrder[] }>(
      `/orders.json?status=any&email=${encodeURIComponent(email)}&limit=250`,
    );
    console.log(`   -> ${res.data.orders.length} order(s) found by email:`);
    summarizeOrders(res.data.orders);
    const owners = new Set(res.data.orders.map((o) => o.customer?.id ?? 'none'));
    console.log(`   -> distinct owning customer ids: ${[...owners].join(', ')}`);
  } catch (err) {
    console.log('   -> ERROR', err instanceof AxiosError ? err.response?.status : err);
  }
  line();

  console.log('DONE\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Diagnostic crashed:', err);
  process.exit(1);
});

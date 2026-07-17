import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { fetchCustomerOrders, invalidateCustomerCache } from '../services/shopify.js';
import { invalidateSubscriptionsCache } from '../services/skio.js';
import { upsertContact } from '../services/chatwoot.js';
import { registerTrackings } from '../services/tracking.js';
import { claimOnce } from '../services/cache.js';
import { buildCustomAttributes, toE164 } from '../utils/formatters.js';
import type { ShopifyCustomer, ShopifyOrder, ChatwootContactPayload } from '../types/index.js';

const router = Router();

// Idempotency window for Shopify webhook redeliveries (keyed by webhook id).
const WEBHOOK_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

function parseBody(req: Request): unknown {
  return JSON.parse((req.body as Buffer).toString('utf8'));
}

/**
 * Returns true if this delivery is a duplicate (already processed) and should be
 * skipped. Uses Shopify's stable per-event `X-Shopify-Webhook-Id`. Fail-open:
 * when the header is absent or the store has no cache, it always processes.
 */
async function isDuplicateDelivery(req: Request): Promise<boolean> {
  const id = req.header('x-shopify-webhook-id');
  if (!id) return false;
  const fresh = await claimOnce('wh-shopify', id, WEBHOOK_DEDUPE_TTL_MS);
  return !fresh;
}

/**
 * Invalidates cached Shopify (and Skio) data for a customer so the next read
 * reflects the change this webhook delivered.
 */
async function invalidateCustomerCaches(customer: ShopifyCustomer): Promise<void> {
  await invalidateCustomerCache({ customerId: customer.id, email: customer.email });
  if (customer.email) await invalidateSubscriptionsCache(customer.email);
}

async function syncCustomerToChatwoot(customer: ShopifyCustomer): Promise<void> {
  if (!customer.id) {
    logger.warn('Webhook customer has no id, skipping');
    return;
  }

  // Refresh caches BEFORE fetching orders so the fetch below repopulates them
  // with fresh data (and the dashboard/AI see the update immediately).
  await invalidateCustomerCaches(customer);

  const orders = await fetchCustomerOrders(customer.id);
  const customAttrs = buildCustomAttributes(customer, orders);

  const payload: ChatwootContactPayload = {
    name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || undefined,
    email: customer.email || undefined,
    phone_number: toE164(customer.phone) || toE164(customer.default_address?.phone),
    identifier: String(customer.id),
    custom_attributes: customAttrs,
  };

  await upsertContact(String(customer.id), payload);
}

// --- Customer Created / Updated ---
router.post('/customers', async (req: Request, res: Response) => {
  try {
    if (await isDuplicateDelivery(req)) {
      logger.info('Duplicate customer webhook delivery, skipping');
      res.status(200).send('Duplicate, skipped');
      return;
    }
    const customer = parseBody(req) as ShopifyCustomer;
    logger.info('Received customer webhook', { customerId: customer.id });
    await syncCustomerToChatwoot(customer);
    res.status(200).send('OK');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Customer webhook error', { error: message });
    res.status(500).send('Error');
  }
});

// --- Order Created / Updated / Fulfilled / Partially Fulfilled ---
// All order-level webhooks (orders/create, orders/updated, orders/fulfilled,
// orders/partially_fulfilled) deliver the same Order payload including the
// fulfillments array with tracking numbers and URLs.
router.post('/orders', async (req: Request, res: Response) => {
  try {
    if (await isDuplicateDelivery(req)) {
      logger.info('Duplicate order webhook delivery, skipping');
      res.status(200).send('Duplicate, skipped');
      return;
    }
    const order = parseBody(req) as ShopifyOrder;
    logger.info('Received order webhook', { orderId: order.id, orderName: order.name });

    const customer = order.customer;
    if (!customer?.id) {
      logger.warn('Order webhook has no customer, skipping', { orderId: order.id });
      res.status(200).send('No customer, skipped');
      return;
    }

    await syncCustomerToChatwoot(customer);

    const trackingNumbers = extractOrderTrackingNumbers(order);
    if (trackingNumbers.length > 0) {
      registerTrackings(trackingNumbers.map((n) => ({ number: n }))).catch((err) =>
        logger.warn('Failed to register tracking numbers with 17track', {
          orderId: order.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    res.status(200).send('OK');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Order webhook error', { error: message });
    res.status(500).send('Error');
  }
});

function extractOrderTrackingNumbers(order: ShopifyOrder): string[] {
  const numbers: string[] = [];
  for (const f of order.fulfillments ?? []) {
    if (f.tracking_number && !numbers.includes(f.tracking_number)) {
      numbers.push(f.tracking_number);
    }
    for (const tn of f.tracking_numbers ?? []) {
      if (tn && !numbers.includes(tn)) {
        numbers.push(tn);
      }
    }
  }
  return numbers;
}

export default router;

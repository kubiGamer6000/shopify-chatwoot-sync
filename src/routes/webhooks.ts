import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { fetchCustomerOrders, fetchOrder } from '../services/shopify.js';
import { upsertContact } from '../services/chatwoot.js';
import { buildCustomAttributes } from '../utils/formatters.js';
import type { ShopifyCustomer, ShopifyOrder, ShopifyFulfillment, ChatwootContactPayload } from '../types/index.js';

const router = Router();

function parseBody(req: Request): unknown {
  return JSON.parse((req.body as Buffer).toString('utf8'));
}

async function syncCustomerToChatwoot(customer: ShopifyCustomer): Promise<void> {
  if (!customer.id) {
    logger.warn('Webhook customer has no id, skipping');
    return;
  }

  const orders = await fetchCustomerOrders(customer.id);
  const customAttrs = buildCustomAttributes(customer, orders);

  const payload: ChatwootContactPayload = {
    name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || undefined,
    email: customer.email || undefined,
    phone_number: customer.phone || customer.default_address?.phone || undefined,
    identifier: String(customer.id),
    custom_attributes: customAttrs,
  };

  await upsertContact(String(customer.id), payload);
}

// --- Customer Created / Updated ---
router.post('/customers', async (req: Request, res: Response) => {
  try {
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

// --- Order Created / Updated ---
router.post('/orders', async (req: Request, res: Response) => {
  try {
    const order = parseBody(req) as ShopifyOrder;
    logger.info('Received order webhook', { orderId: order.id, orderName: order.name });

    const customer = order.customer;
    if (!customer?.id) {
      logger.warn('Order webhook has no customer, skipping', { orderId: order.id });
      res.status(200).send('No customer, skipped');
      return;
    }

    await syncCustomerToChatwoot(customer);
    res.status(200).send('OK');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Order webhook error', { error: message });
    res.status(500).send('Error');
  }
});

// --- Fulfillment Created / Updated ---
interface FulfillmentWebhookPayload extends ShopifyFulfillment {
  order_id: number;
}

router.post('/fulfillments', async (req: Request, res: Response) => {
  try {
    const fulfillment = parseBody(req) as FulfillmentWebhookPayload;
    logger.info('Received fulfillment webhook', {
      fulfillmentId: fulfillment.id,
      orderId: fulfillment.order_id,
    });

    if (!fulfillment.order_id) {
      logger.warn('Fulfillment webhook has no order_id, skipping');
      res.status(200).send('No order_id, skipped');
      return;
    }

    const order = await fetchOrder(fulfillment.order_id);
    const customer = order.customer;
    if (!customer?.id) {
      logger.warn('Fulfillment order has no customer, skipping', { orderId: order.id });
      res.status(200).send('No customer, skipped');
      return;
    }

    await syncCustomerToChatwoot(customer);
    res.status(200).send('OK');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Fulfillment webhook error', { error: message });
    res.status(500).send('Error');
  }
});

export default router;

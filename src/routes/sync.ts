import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { fetchCustomersPage, fetchCustomerOrders, sleep } from '../services/shopify.js';
import { upsertContact } from '../services/chatwoot.js';
import { buildCustomAttributes } from '../utils/formatters.js';
import type { ChatwootContactPayload } from '../types/index.js';

const router = Router();

let syncInProgress = false;

router.post('/customers', async (_req: Request, res: Response) => {
  if (syncInProgress) {
    res.status(409).json({ error: 'Sync already in progress' });
    return;
  }

  syncInProgress = true;
  logger.info('Starting bulk customer sync');

  res.status(202).json({ message: 'Sync started' });

  try {
    let nextUrl: string | null = undefined as unknown as string | null;
    let totalSynced = 0;
    let totalErrors = 0;
    let pageNum = 0;

    do {
      pageNum++;
      const page = await fetchCustomersPage(nextUrl ?? undefined);
      logger.info(`Processing customer page ${pageNum}`, { count: page.customers.length });

      for (const customer of page.customers) {
        try {
          if (!customer.id) continue;

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
          totalSynced++;

          // Small delay between individual syncs to respect rate limits
          await sleep(300);
        } catch (err) {
          totalErrors++;
          const message = err instanceof Error ? err.message : String(err);
          logger.error('Error syncing customer', {
            customerId: customer.id,
            error: message,
          });
        }
      }

      nextUrl = page.nextUrl;

      if (nextUrl) {
        // Pause between pages to avoid rate limiting
        await sleep(1000);
      }
    } while (nextUrl);

    logger.info('Bulk sync completed', { totalSynced, totalErrors });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Bulk sync failed', { error: message });
  } finally {
    syncInProgress = false;
  }
});

export default router;

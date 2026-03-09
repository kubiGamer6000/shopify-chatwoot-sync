import { fetchCustomersPage, fetchCustomerOrders, sleep } from './shopify.js';
import {
  findByIdentifier,
  findByEmail,
  contactHasShopifyData,
  upsertContact,
} from './chatwoot.js';
import { buildCustomAttributes, toE164 } from '../utils/formatters.js';
import { logger } from '../utils/logger.js';
import type { ChatwootContactPayload } from '../types/index.js';

let syncInProgress = false;

export function isSyncInProgress(): boolean {
  return syncInProgress;
}

export interface SyncResult {
  totalProcessed: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

/**
 * Paginates through all Shopify customers and fills gaps in Chatwoot:
 *
 * - Contact exists with Shopify data already populated → skip (webhooks keep it fresh)
 * - Contact exists but has no Shopify data → populate it
 * - Contact doesn't exist → create it (if CHATWOOT_INBOX_ID is set)
 *
 * This keeps the periodic sync lightweight — only new/unpopulated
 * contacts trigger Shopify order fetches and Chatwoot writes.
 */
export async function runFullSync(): Promise<SyncResult> {
  if (syncInProgress) {
    logger.warn('Sync already in progress, skipping');
    return { totalProcessed: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
  }

  syncInProgress = true;
  const result: SyncResult = { totalProcessed: 0, created: 0, updated: 0, skipped: 0, errors: 0 };

  try {
    let nextUrl: string | undefined;
    let pageNum = 0;

    do {
      pageNum++;
      const page = await fetchCustomersPage(nextUrl);
      logger.info(`Sync: processing page ${pageNum}`, { count: page.customers.length });

      for (const customer of page.customers) {
        result.totalProcessed++;

        try {
          if (!customer.id || !customer.email) {
            result.skipped++;
            continue;
          }

          const identifier = String(customer.id);

          // Check if contact already exists and has Shopify data
          let existing = await findByIdentifier(identifier);
          if (!existing) {
            existing = await findByEmail(customer.email);
          }

          if (existing && contactHasShopifyData(existing)) {
            result.skipped++;
            continue;
          }

          // Contact is missing or needs Shopify data — fetch orders and upsert
          const orders = await fetchCustomerOrders(customer.id);
          const customAttrs = buildCustomAttributes(customer, orders);

          const payload: ChatwootContactPayload = {
            name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || undefined,
            email: customer.email,
            phone_number: toE164(customer.phone) || toE164(customer.default_address?.phone),
            identifier,
            custom_attributes: customAttrs,
          };

          const { action } = await upsertContact(identifier, payload);
          if (action === 'created') result.created++;
          else if (action === 'updated') result.updated++;
          else result.skipped++;

          await sleep(500);
        } catch (err) {
          result.errors++;
          const message = err instanceof Error ? err.message : String(err);
          logger.error('Sync: error processing customer', {
            customerId: customer.id,
            error: message,
          });
        }
      }

      nextUrl = page.nextUrl ?? undefined;
      if (nextUrl) await sleep(1000);
    } while (nextUrl);

    logger.info('Sync completed', { ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Sync failed at page level', { error: message });
  } finally {
    syncInProgress = false;
  }

  return result;
}

/**
 * Starts periodic sync on an interval. Designed to never crash the server.
 */
export function startPeriodicSync(intervalHours: number): void {
  if (intervalHours <= 0) {
    logger.info('Periodic sync disabled (SYNC_INTERVAL_HOURS not set or 0)');
    return;
  }

  const intervalMs = intervalHours * 60 * 60 * 1000;
  logger.info(`Periodic sync enabled: every ${intervalHours}h`);

  setTimeout(() => {
    void runFullSync().catch((err) => {
      logger.error('Periodic sync failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, 30_000);

  setInterval(() => {
    void runFullSync().catch((err) => {
      logger.error('Periodic sync failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);
}

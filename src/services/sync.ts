import { fetchCustomersPage, fetchCustomerOrders, sleep } from './shopify.js';
import { upsertContact } from './chatwoot.js';
import { buildCustomAttributes } from '../utils/formatters.js';
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
 * Paginates through all Shopify customers, fetches their orders,
 * and upserts each one into Chatwoot.
 *
 * - Matches existing contacts by identifier (Shopify ID) first,
 *   then by email as fallback for pre-existing contacts.
 * - Creates new contacts if CHATWOOT_INBOX_ID is configured.
 * - Never throws — individual customer failures are logged and counted.
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
          if (!customer.id) {
            result.skipped++;
            continue;
          }

          if (!customer.email) {
            result.skipped++;
            continue;
          }

          const orders = await fetchCustomerOrders(customer.id);
          const customAttrs = buildCustomAttributes(customer, orders);

          const payload: ChatwootContactPayload = {
            name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || undefined,
            email: customer.email,
            phone_number: customer.phone || customer.default_address?.phone || undefined,
            identifier: String(customer.id),
            custom_attributes: customAttrs,
          };

          const { action } = await upsertContact(String(customer.id), payload);
          if (action === 'created') result.created++;
          else if (action === 'updated') result.updated++;
          else result.skipped++;

          await sleep(300);
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

  // Run first sync after a short startup delay
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

import { fetchCustomersPage, fetchCustomerOrders, sleep } from './shopify.js';
import {
  findByIdentifier,
  findByEmail,
  contactHasShopifyData,
  upsertContact,
} from './chatwoot.js';
import { cacheGet, cacheSet } from './cache.js';
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

// --- Sync state (persisted so runs are incremental and crash-resumable) ---

const SYNC_STATE_NS = 'syncState';
const SYNC_STATE_KEY = 'customers';
// Re-scan a 1h window before the last run's start to avoid missing records that
// changed while the previous run was in flight.
const WATERMARK_OVERLAP_MS = 60 * 60 * 1000;

interface SyncState {
  // ISO timestamp of the last successful run's START — the incremental
  // `updated_at_min` watermark for the next run.
  lastCompletedWatermark: string | null;
  // Shopify page path to resume from if a run was interrupted mid-way.
  resumeCursor: string | null;
}

async function readSyncState(): Promise<SyncState> {
  const state = await cacheGet<SyncState>(SYNC_STATE_NS, SYNC_STATE_KEY);
  return {
    lastCompletedWatermark: state?.lastCompletedWatermark ?? null,
    resumeCursor: state?.resumeCursor ?? null,
  };
}

async function writeSyncState(state: SyncState): Promise<void> {
  await cacheSet(SYNC_STATE_NS, SYNC_STATE_KEY, state, null);
}

/**
 * Paginates through Shopify customers and fills gaps in Chatwoot:
 *
 * - Contact exists with Shopify data already populated → skip (webhooks keep it fresh)
 * - Contact exists but has no Shopify data → populate it
 * - Contact doesn't exist → create it (if CHATWOOT_INBOX_ID is set)
 *
 * Incremental by default: after the first successful run, only customers changed
 * since the previous run (`updated_at_min` watermark) are scanned, and an
 * interrupted run resumes from its saved page cursor. Pass `{ full: true }` to
 * force a complete scan (used by the manual trigger). When Firestore is
 * disabled there is no state, so every run is a full scan — identical to the
 * previous behaviour.
 */
export async function runFullSync(
  opts: { full?: boolean } = {},
): Promise<SyncResult> {
  if (syncInProgress) {
    logger.warn('Sync already in progress, skipping');
    return { totalProcessed: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
  }

  syncInProgress = true;
  const result: SyncResult = { totalProcessed: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
  const runStartedAt = new Date().toISOString();

  try {
    const state = await readSyncState();

    let nextUrl: string | undefined;
    let updatedAtMin: string | undefined;

    if (opts.full) {
      logger.info('Sync: forced full scan');
    } else if (state.resumeCursor) {
      nextUrl = state.resumeCursor;
      logger.info('Sync: resuming interrupted run from saved cursor');
    } else if (state.lastCompletedWatermark) {
      updatedAtMin = new Date(
        new Date(state.lastCompletedWatermark).getTime() - WATERMARK_OVERLAP_MS,
      ).toISOString();
      logger.info('Sync: incremental scan', { updatedAtMin });
    } else {
      logger.info('Sync: initial full scan (no watermark yet)');
    }

    let pageNum = 0;

    do {
      pageNum++;
      const page = await fetchCustomersPage(nextUrl, { updatedAtMin });
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

      // Persist the resume cursor after each page so an interrupted run can
      // pick up where it stopped (best-effort; keeps the existing watermark).
      await writeSyncState({
        lastCompletedWatermark: state.lastCompletedWatermark,
        resumeCursor: nextUrl ?? null,
      });

      if (nextUrl) await sleep(1000);
    } while (nextUrl);

    // Completed cleanly: advance the watermark to this run's start and clear the
    // resume cursor so the next run is incremental.
    await writeSyncState({
      lastCompletedWatermark: runStartedAt,
      resumeCursor: null,
    });

    logger.info('Sync completed', { ...result });
  } catch (err: unknown) {
    const detail: Record<string, unknown> = {};
    if (err instanceof Error) detail.error = err.message;
    else detail.error = String(err);
    if (
      typeof err === 'object' && err !== null && 'response' in err &&
      typeof (err as Record<string, unknown>).response === 'object'
    ) {
      const res = (err as { response: { status?: number; config?: { url?: string } } }).response;
      detail.status = res.status;
      detail.url = res.config?.url;
    }
    logger.error('Sync failed at page level', detail);
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

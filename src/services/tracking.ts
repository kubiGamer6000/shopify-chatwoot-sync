import axios, { AxiosError } from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { cacheGet, cacheSet } from './cache.js';
import type {
  TrackInfoResponse,
  RegisterTrackingItem,
  TrackingSummary,
  TrackEvent,
  AcceptedTrackItem,
} from '../types/tracking.js';

const trackingClient = axios.create({
  baseURL: 'https://api.17track.net/track/v2.2',
  headers: {
    '17token': env.seventeentrackApiKey,
    'Content-Type': 'application/json',
  },
});

// 17track error code returned when the account has no registration quota left.
const QUOTA_EXHAUSTED_CODE = -18019908;

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1500;

function extractErrorDetail(err: unknown): string {
  if (err instanceof AxiosError && err.response) {
    const data = err.response.data as Record<string, unknown> | undefined;
    return `${err.response.status} ${JSON.stringify(data)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * POST to 17track with retries on transient server/rate-limit errors (500, 503,
 * 429). Their docs list 500 as "server error — try again later".
 */
async function postWithRetry<T>(
  path: string,
  body: unknown,
  opts: { numbers?: string[] } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const res = await trackingClient.post<T>(path, body);
      return res.data;
    } catch (err) {
      lastErr = err;
      const status = err instanceof AxiosError ? err.response?.status : undefined;
      const retryable = status === 500 || status === 503 || status === 429;
      if (!retryable || attempt === MAX_RETRIES) break;

      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
      logger.warn('17track transient error, retrying', {
        path,
        attempt: attempt + 1,
        status,
        numbers: opts.numbers,
        delayMs,
        detail: extractErrorDetail(err),
      });
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

export interface QuotaInfo {
  quota_total: number;
  quota_used: number;
  quota_remain: number;
}

export async function registerTrackings(
  items: RegisterTrackingItem[],
): Promise<TrackInfoResponse> {
  return postWithRetry<TrackInfoResponse>(
    '/register',
    items,
    { numbers: items.map((i) => i.number) },
  );
}

/** Returns the account's registration quota, or null if the call fails. */
export async function getQuota(): Promise<QuotaInfo | null> {
  try {
    const res = await trackingClient.post<{ code: number; data: QuotaInfo }>(
      '/getquota',
      {},
    );
    return res.data?.data ?? null;
  } catch (err) {
    logger.warn('17track getquota failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function getTrackInfo(
  items: Array<{ number: string; carrier?: number }>,
): Promise<TrackInfoResponse> {
  return postWithRetry<TrackInfoResponse>(
    '/gettrackinfo',
    items,
    { numbers: items.map((i) => i.number) },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventTime(e: TrackEvent): number {
  const t = new Date(e.time_utc || e.time_iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Builds a tracking summary from one accepted item, merging the full event
 * history across all carrier providers (e.g. origin + destination) into a
 * single chronological timeline (newest first).
 */
function buildSummary(item: AcceptedTrackItem): TrackingSummary {
  const info = item.track_info;
  const providers = info.tracking?.providers ?? [];

  const events: TrackEvent[] = [];
  for (const provider of providers) {
    const name = provider.provider?.name;
    for (const event of provider.events ?? []) {
      events.push(name ? { ...event, provider: name } : event);
    }
  }
  events.sort((a, b) => eventTime(b) - eventTime(a));

  return {
    status: info.latest_status.status,
    subStatus: info.latest_status.sub_status,
    lastEvent: info.latest_event?.description,
    lastLocation: info.latest_event?.location,
    lastUpdate: info.latest_event?.time_iso,
    estimatedDelivery: info.time_metrics?.estimated_delivery_date,
    carrier: providers[0]?.provider?.name,
    daysInTransit: info.time_metrics?.days_of_transit,
    daysAfterOrder: info.time_metrics?.days_after_order,
    originCountry: info.misc_info?.origin_country,
    destinationCountry: info.misc_info?.destination_country,
    events,
  };
}

const TRACKING_CACHE_NS = 'tracking';
const HOUR_MS = 60 * 60 * 1000;

/**
 * How long to trust a cached tracking summary, based on its current state.
 * Delivered shipments never change, so they're cached for a long time; anything
 * still moving is refreshed frequently so the dashboard stays live.
 */
function trackingTtlMs(summary: TrackingSummary): number {
  const s = (summary.status ?? '').toLowerCase().replace(/[\s_]/g, '');
  if (s === 'delivered') return 30 * 24 * HOUR_MS;
  if (s.includes('exception') || s.includes('failure') || s.includes('undelivered')) {
    return 6 * HOUR_MS;
  }
  if (s.includes('outfordelivery') || s.includes('transit') || s.includes('pickup') || s.includes('inforeceived')) {
    return 2 * HOUR_MS;
  }
  // NotFound / Expired / unknown — short TTL so it recovers quickly.
  return 1 * HOUR_MS;
}

/**
 * Fetches tracking status for a list of tracking numbers, using a Firestore
 * cache in front of 17track to save quota and latency. Cached (fresh) numbers
 * are served from the cache; only the remainder hit the live API, and each
 * successful result is cached with a state-based TTL. Falls straight through to
 * the live API when Firestore is disabled.
 */
export async function getTrackingStatus(
  trackingNumbers: string[],
): Promise<Map<string, TrackingSummary>> {
  const result = new Map<string, TrackingSummary>();
  const numbers = Array.from(
    new Set(trackingNumbers.map((n) => n.trim()).filter(Boolean)),
  );
  if (numbers.length === 0) return result;

  // Serve fresh cached summaries; collect the rest for a live lookup.
  const cachedEntries = await Promise.all(
    numbers.map(async (n) => [n, await cacheGet<TrackingSummary>(TRACKING_CACHE_NS, n)] as const),
  );
  const missing: string[] = [];
  for (const [n, summary] of cachedEntries) {
    if (summary) result.set(n, summary);
    else missing.push(n);
  }

  if (missing.length === 0) return result;

  const live = await fetchTrackingLive(missing);
  await Promise.all(
    Array.from(live.entries()).map(async ([n, summary]) => {
      result.set(n, summary);
      await cacheSet(TRACKING_CACHE_NS, n, summary, trackingTtlMs(summary));
    }),
  );

  return result;
}

/**
 * Live 17track lookup for a set of tracking numbers (no caching).
 * If any numbers are rejected (not registered), registers them and retries once.
 */
async function fetchTrackingLive(
  numbers: string[],
): Promise<Map<string, TrackingSummary>> {
  const result = new Map<string, TrackingSummary>();
  if (numbers.length === 0) return result;

  const items = numbers.map((n) => ({ number: n }));

  let response: TrackInfoResponse;
  try {
    response = await getTrackInfo(items);
  } catch (err) {
    logger.warn('17track gettrackinfo failed', {
      numbers,
      detail: extractErrorDetail(err),
    });
    return result;
  }

  if (!response?.data) {
    logger.warn('17track gettrackinfo returned unexpected shape', {
      numbers,
      code: response?.code,
    });
    return result;
  }

  for (const item of response.data.accepted ?? []) {
    try {
      result.set(item.number, buildSummary(item));
    } catch (err) {
      logger.warn('17track failed to parse accepted tracking item', {
        number: item.number,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const rejected = response.data.rejected ?? [];
  if (rejected.length === 0) return result;

  // Numbers already known to 17track but not yet registered get registered now.
  // A number can be rejected for reasons other than "not registered" (e.g. the
  // account being out of quota), so only attempt to register genuinely
  // unregistered numbers.
  const toRegister = rejected.filter(
    (r) => r.error?.code !== QUOTA_EXHAUSTED_CODE,
  );

  if (rejected.some((r) => r.error?.code === QUOTA_EXHAUSTED_CODE)) {
    const quota = await getQuota();
    logger.error(
      '17track registration quota exhausted — tracking data unavailable for new numbers. Top up quota at https://api.17track.net/',
      {
        quotaUsed: quota?.quota_used,
        quotaTotal: quota?.quota_total,
        quotaRemain: quota?.quota_remain,
      },
    );
  }

  if (toRegister.length === 0) return result;

  logger.info('Some tracking numbers not registered, registering now', {
    count: toRegister.length,
  });

  try {
    const registerResponse = await registerTrackings(
      toRegister.map((r) => ({ number: r.number })),
    );

    const registerRejected = registerResponse.data?.rejected ?? [];
    const quotaError = registerRejected.find(
      (r) => r.error?.code === QUOTA_EXHAUSTED_CODE,
    );
    if (quotaError) {
      const quota = await getQuota();
      logger.error(
        '17track registration quota exhausted — could not register new tracking numbers. Top up quota at https://api.17track.net/',
        {
          quotaUsed: quota?.quota_used,
          quotaTotal: quota?.quota_total,
          quotaRemain: quota?.quota_remain,
        },
      );
      return result;
    }

    await sleep(3000);

    const retryResponse = await getTrackInfo(
      toRegister.map((r) => ({ number: r.number })),
    );

    for (const item of retryResponse.data.accepted) {
      result.set(item.number, buildSummary(item));
    }
  } catch (err) {
    logger.warn('17track register+retry failed, skipping tracking data', {
      numbers: toRegister.map((r) => r.number),
      detail: extractErrorDetail(err),
    });
  }

  return result;
}

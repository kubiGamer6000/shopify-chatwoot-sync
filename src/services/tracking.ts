import axios from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
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

export async function registerTrackings(
  items: RegisterTrackingItem[],
): Promise<TrackInfoResponse> {
  const res = await trackingClient.post<TrackInfoResponse>('/register', items);
  return res.data;
}

export async function getTrackInfo(
  items: Array<{ number: string; carrier?: number }>,
): Promise<TrackInfoResponse> {
  const res = await trackingClient.post<TrackInfoResponse>('/gettrackinfo', items);
  return res.data;
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

/**
 * Fetches tracking status for a list of tracking numbers.
 * If any numbers are rejected (not registered), registers them and retries once.
 */
export async function getTrackingStatus(
  trackingNumbers: string[],
): Promise<Map<string, TrackingSummary>> {
  const result = new Map<string, TrackingSummary>();
  if (trackingNumbers.length === 0) return result;

  const items = trackingNumbers.map((n) => ({ number: n }));

  let response: TrackInfoResponse;
  try {
    response = await getTrackInfo(items);
  } catch (err) {
    logger.warn('17track gettrackinfo failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  for (const item of response.data.accepted) {
    result.set(item.number, buildSummary(item));
  }

  const rejected = response.data.rejected;
  if (rejected.length === 0) return result;

  logger.info('Some tracking numbers not registered, registering now', {
    count: rejected.length,
  });

  try {
    await registerTrackings(
      rejected.map((r) => ({ number: r.number })),
    );
    await sleep(3000);

    const retryResponse = await getTrackInfo(
      rejected.map((r) => ({ number: r.number })),
    );

    for (const item of retryResponse.data.accepted) {
      result.set(item.number, buildSummary(item));
    }
  } catch (err) {
    logger.warn('17track register+retry failed, skipping tracking data', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

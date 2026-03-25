import axios from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type {
  TrackInfoResponse,
  RegisterTrackingItem,
  TrackingSummary,
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
    result.set(item.number, {
      status: item.track_info.latest_status.status,
      subStatus: item.track_info.latest_status.sub_status,
      lastEvent: item.track_info.latest_event?.description,
      lastLocation: item.track_info.latest_event?.location,
      lastUpdate: item.track_info.latest_event?.time_iso,
      estimatedDelivery: item.track_info.time_metrics?.estimated_delivery_date,
      events: item.track_info.tracking?.providers?.[0]?.events ?? [],
    });
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
      result.set(item.number, {
        status: item.track_info.latest_status.status,
        subStatus: item.track_info.latest_status.sub_status,
        lastEvent: item.track_info.latest_event?.description,
        lastLocation: item.track_info.latest_event?.location,
        lastUpdate: item.track_info.latest_event?.time_iso,
        estimatedDelivery: item.track_info.time_metrics?.estimated_delivery_date,
        events: item.track_info.tracking?.providers?.[0]?.events ?? [],
      });
    }
  } catch (err) {
    logger.warn('17track register+retry failed, skipping tracking data', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

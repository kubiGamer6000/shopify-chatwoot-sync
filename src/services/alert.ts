import axios from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Operational alerts. Always written to the error log with an `ALERT` prefix
 * (searchable in DigitalOcean runtime logs); additionally POSTed to
 * ALERT_WEBHOOK_URL (Slack-compatible `{ text }`) when configured. Throttled per
 * kind so an outage produces one alert every few minutes, not thousands.
 */
const THROTTLE_MS = 10 * 60 * 1000;
const lastSent = new Map<string, number>();

export function alert(kind: string, message: string, data: Record<string, unknown> = {}): void {
  logger.error(`ALERT [${kind}] ${message}`, data);
  const now = Date.now();
  const prev = lastSent.get(kind) ?? 0;
  if (now - prev < THROTTLE_MS) return;
  lastSent.set(kind, now);
  if (!env.alertWebhookUrl) return;
  void axios
    .post(env.alertWebhookUrl, { text: `[Customer 360] ${kind}: ${message}` }, { timeout: 5000 })
    .catch((err) => {
      logger.warn('Failed to deliver alert webhook', {
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/** Test helper. */
export function resetAlertThrottle(): void {
  lastSent.clear();
}

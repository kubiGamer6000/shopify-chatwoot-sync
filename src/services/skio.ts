import axios from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { cached, cacheDelete } from './cache.js';
import type { SkioSubscription, SkioGraphQLResponse } from '../types/skio.js';

const SUBS_CACHE_NS = 'skioSubs';
// Short TTL as a backstop; cancellations invalidate the cache explicitly.
const SUBS_CACHE_TTL_MS = 5 * 60 * 1000;

function subsCacheKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Drops the cached subscriptions for an email (called after a cancellation). */
export async function invalidateSubscriptionsCache(email: string): Promise<void> {
  if (!email || !email.trim()) return;
  await cacheDelete(SUBS_CACHE_NS, subsCacheKey(email));
}

const SKIO_API_URL = 'https://graphql.skio.com/v1/graphql';

const skioClient = axios.create({
  baseURL: SKIO_API_URL,
  headers: {
    'Content-Type': 'application/json',
    authorization: `API ${env.skioApiKey}`,
  },
});

async function skioQuery<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await skioClient.post<SkioGraphQLResponse<T>>('', { query, variables });

  if (res.data.errors && res.data.errors.length > 0) {
    throw new Error(`Skio GraphQL errors: ${JSON.stringify(res.data.errors)}`);
  }
  if (!res.data.data) {
    throw new Error('Skio GraphQL returned no data');
  }
  return res.data.data;
}

const SUBSCRIPTIONS_BY_EMAIL = `
  query GetSubscriptionsByEmail($email: String!) {
    Subscriptions(
      where: { StorefrontUser: { email: { _eq: $email } } }
      order_by: { createdAt: desc }
    ) {
      id
      platformId
      status
      statusContext
      currencyCode
      createdAt
      cancelledAt
      nextBillingDate
      cyclesCompleted
      DeliveryPolicy {
        interval
        intervalCount
      }
      SubscriptionLines(where: { removedAt: { _is_null: true } }) {
        id
        quantity
        priceWithoutDiscount
        ProductVariant {
          title
          Product {
            title
          }
        }
      }
    }
  }
`;

export async function getSubscriptionsByEmail(
  email: string,
): Promise<SkioSubscription[]> {
  try {
    // The read-through cache only memoises successful fetches: `fetchLive`
    // throws on error, so a transient Skio failure is never cached (and this
    // function still resolves to [] to preserve the previous never-throw
    // contract callers rely on).
    return await cached(SUBS_CACHE_NS, subsCacheKey(email), SUBS_CACHE_TTL_MS, () =>
      fetchSubscriptionsLive(email),
    );
  } catch (err) {
    logger.warn('Failed to fetch Skio subscriptions', {
      email,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function fetchSubscriptionsLive(
  email: string,
): Promise<SkioSubscription[]> {
  const data = await skioQuery<{ Subscriptions: SkioSubscription[] }>(
    SUBSCRIPTIONS_BY_EMAIL,
    { email },
  );
  const subs = data.Subscriptions ?? [];
  logger.debug(`Fetched ${subs.length} Skio subscriptions`, { email });
  return subs;
}

const CANCEL_SUBSCRIPTION = `
  mutation CancelSubscription($input: CancelSubscriptionInput!) {
    cancelSubscription(input: $input) {
      ok
    }
  }
`;

export async function cancelSubscription(subscriptionId: string): Promise<boolean> {
  // `permanentlyCancel: true` is rejected by Skio's public API
  // ("Permanent cancellation is not available for public API"), so we issue a
  // standard cancellation. Skio's `cancelSubscription` mutation does not accept
  // a free-text cancellation reason — reasons are only captured through the
  // customer-facing Cancel Flow — so there is nothing to set here.
  const data = await skioQuery<{ cancelSubscription: { ok: boolean } }>(
    CANCEL_SUBSCRIPTION,
    {
      input: {
        subscriptionId,
        permanentlyCancel: false,
        shouldSendNotif: false,
      },
    },
  );

  const ok = Boolean(data.cancelSubscription?.ok);
  logger.info('Skio cancelSubscription result', { subscriptionId, ok });
  return ok;
}

const ACTIVE_STATUSES = new Set(['ACTIVE', 'active']);

export interface CancelByEmailResult {
  // Number of active subscriptions found for the email.
  activeFound: number;
  // Number that were successfully cancelled.
  cancelled: number;
  // Product titles of the cancelled subscriptions (for the reply, if useful).
  cancelledTitles: string[];
}

/**
 * Finds a customer's active Skio subscriptions by email and cancels each one.
 * Mirrors the dashboard's active-subscription definition (`status` is ACTIVE and
 * not already cancelled). Used by the AI responder's `cancel_subscription` tool.
 * Never throws — returns a result summary so the caller can decide what to say.
 */
export async function cancelActiveSubscriptionsByEmail(
  email: string,
): Promise<CancelByEmailResult> {
  const result: CancelByEmailResult = {
    activeFound: 0,
    cancelled: 0,
    cancelledTitles: [],
  };

  const subs = await getSubscriptionsByEmail(email);
  const active = subs.filter(
    (s) => ACTIVE_STATUSES.has(s.status) && !s.cancelledAt,
  );
  result.activeFound = active.length;

  for (const sub of active) {
    try {
      const ok = await cancelSubscription(sub.id);
      if (ok) {
        result.cancelled += 1;
        const title =
          sub.SubscriptionLines?.[0]?.ProductVariant?.Product?.title ?? null;
        if (title) result.cancelledTitles.push(title);
      }
    } catch (err) {
      logger.warn('Failed to cancel a Skio subscription', {
        subscriptionId: sub.id,
        email,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Reflect the cancellation immediately on the next read.
  if (result.cancelled > 0) await invalidateSubscriptionsCache(email);

  logger.info('Cancelled active subscriptions by email', {
    email,
    activeFound: result.activeFound,
    cancelled: result.cancelled,
  });
  return result;
}

import { getDb } from './firestore.js';
import { logger } from '../utils/logger.js';
import { alert } from './alert.js';

/**
 * Generic Firestore-backed cache with TTLs and graceful degradation.
 *
 * Design contract (so caching NEVER breaks functionality):
 * - When Firestore is disabled (no credentials), every read-through call falls
 *   straight through to the live producer and every write is a no-op.
 * - Reads never throw: a cache-read error logs a warning and falls back to the
 *   source. Writes are best-effort.
 * - Producer errors are propagated and NOT cached, so transient upstream
 *   failures are never memoised.
 *
 * All entries live in a single `cache` collection, namespaced by key, so a
 * handful of caches share one collection without colliding.
 */

const COLLECTION = 'cache';

interface CacheEntry<T> {
  value: T;
  storedAt: number;
  // Epoch ms after which the entry is stale; null = never expires.
  expiresAt: number | null;
}

function docId(namespace: string, key: string): string {
  // Firestore doc ids cannot contain '/', so encode the key. '::' separates the
  // namespace for readability when browsing the collection.
  return `${namespace}::${encodeURIComponent(String(key))}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when a Firestore write failed because the doc already exists (code 6). */
function isAlreadyExists(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 6;
}

/**
 * Read-through cache. Returns a fresh cached value when present, otherwise runs
 * `producer`, stores the result (best-effort) and returns it. Distinguishes a
 * cached `null`/`[]` from a miss via document existence, so falsy values cache
 * correctly.
 */
export async function cached<T>(
  namespace: string,
  key: string,
  ttlMs: number | null,
  producer: () => Promise<T>,
): Promise<T> {
  const db = getDb();
  if (!db) return producer();

  const ref = db.collection(COLLECTION).doc(docId(namespace, key));

  try {
    const snap = await ref.get();
    if (snap.exists) {
      const entry = snap.data() as CacheEntry<T>;
      if (entry.expiresAt == null || entry.expiresAt > Date.now()) {
        return entry.value;
      }
    }
  } catch (err) {
    logger.warn('Cache read failed, falling back to source', {
      namespace,
      error: errMessage(err),
    });
  }

  const value = await producer();

  try {
    const entry: CacheEntry<T> = {
      value,
      storedAt: Date.now(),
      expiresAt: ttlMs != null ? Date.now() + ttlMs : null,
    };
    await ref.set(entry);
  } catch (err) {
    logger.warn('Cache write failed', { namespace, error: errMessage(err) });
  }

  return value;
}

/** Returns a fresh cached value, or `undefined` on miss / expiry / no DB. */
export async function cacheGet<T>(
  namespace: string,
  key: string,
): Promise<T | undefined> {
  const db = getDb();
  if (!db) return undefined;
  try {
    const snap = await db.collection(COLLECTION).doc(docId(namespace, key)).get();
    if (!snap.exists) return undefined;
    const entry = snap.data() as CacheEntry<T>;
    if (entry.expiresAt != null && entry.expiresAt <= Date.now()) return undefined;
    return entry.value;
  } catch (err) {
    logger.warn('cacheGet failed', { namespace, error: errMessage(err) });
    return undefined;
  }
}

/** Stores a value (best-effort). No-op when Firestore is disabled. */
export async function cacheSet<T>(
  namespace: string,
  key: string,
  value: T,
  ttlMs?: number | null,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    const entry: CacheEntry<T> = {
      value,
      storedAt: Date.now(),
      expiresAt: ttlMs != null ? Date.now() + ttlMs : null,
    };
    await db.collection(COLLECTION).doc(docId(namespace, key)).set(entry);
  } catch (err) {
    logger.warn('cacheSet failed', { namespace, error: errMessage(err) });
  }
}

/** Deletes a cache entry (best-effort). Used for explicit invalidation. */
export async function cacheDelete(namespace: string, key: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.collection(COLLECTION).doc(docId(namespace, key)).delete();
  } catch (err) {
    logger.warn('cacheDelete failed', { namespace, error: errMessage(err) });
  }
}

// Per-process claims, checked before Firestore. They catch redeliveries within
// this process even while Firestore is down (lost on restart by design).
const MEMORY_CLAIMS_MAX = 5000;
const memoryClaims = new Map<string, number>();

function memoryClaim(id: string, ttlMs: number, now: number): boolean {
  const prev = memoryClaims.get(id);
  if (prev != null && prev > now) return false;
  memoryClaims.delete(id);
  memoryClaims.set(id, now + ttlMs);
  if (memoryClaims.size > MEMORY_CLAIMS_MAX) {
    const oldest = memoryClaims.keys().next().value;
    if (oldest !== undefined) memoryClaims.delete(oldest);
  }
  return true;
}

/** Test helper. */
export function resetMemoryClaims(): void {
  memoryClaims.clear();
}

/**
 * - `fresh`: first claim (proceed).
 * - `duplicate`: already claimed within its TTL (skip).
 * - `unavailable`: the durable dedupe store (Firestore) is not configured or
 *   failing, so we cannot know whether another delivery / a previous process
 *   already handled this. Callers that act on customers (AgentBot replies,
 *   cancellations) must treat this as "do not act".
 */
export type ClaimResult = 'fresh' | 'duplicate' | 'unavailable';

/**
 * Atomic "process this once" claim, used for webhook idempotency. Unlike the
 * old fail-open `claimOnce`, it reports when the durable store is unavailable
 * instead of silently switching dedupe off.
 */
export async function claim(
  namespace: string,
  key: string,
  ttlMs: number,
): Promise<ClaimResult> {
  const id = docId(namespace, key);
  const now = Date.now();
  if (!memoryClaim(id, ttlMs, now)) return 'duplicate';

  const db = getDb();
  if (!db) return 'unavailable';

  const ref = db.collection(COLLECTION).doc(id);
  const entry = { storedAt: now, expiresAt: now + ttlMs };

  try {
    await ref.create(entry);
    return 'fresh';
  } catch (err) {
    if (isAlreadyExists(err)) {
      // A claim exists; allow re-claim only if the previous one has expired.
      try {
        const snap = await ref.get();
        const prev = snap.data() as { expiresAt?: number | null } | undefined;
        if (prev?.expiresAt != null && prev.expiresAt <= now) {
          await ref.set(entry);
          return 'fresh';
        }
        return 'duplicate';
      } catch (inner) {
        logger.warn('claim re-check failed', { namespace, error: errMessage(inner) });
        return 'unavailable';
      }
    }
    logger.warn('claim failed (dedupe store unavailable)', {
      namespace,
      error: errMessage(err),
    });
    return 'unavailable';
  }
}

/**
 * Compatibility wrapper for flows whose duplicate handling is harmless and
 * idempotent (Shopify contact sync). When the durable store is unavailable it
 * proceeds using the in-process dedupe only, and raises an alert so the outage
 * is never silent.
 */
export async function claimOnce(
  namespace: string,
  key: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await claim(namespace, key, ttlMs);
  if (result === 'unavailable') {
    alert('dedupe-store-unavailable', 'Firestore dedupe unavailable; using in-process dedupe only', {
      namespace,
    });
    return true;
  }
  return result === 'fresh';
}

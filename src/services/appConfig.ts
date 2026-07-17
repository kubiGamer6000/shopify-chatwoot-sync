/**
 * Merged AI configuration: shipped defaults overlaid with any Firestore
 * overrides (`systemConfig/ai`). Cached in-memory with a short TTL so hot AI
 * paths don't hit Firestore on every call, and invalidated immediately on save.
 *
 * Fallback contract: any override that is missing/empty/invalid — or any
 * Firestore error — resolves to the shipped default. With no config document
 * present, `getAiConfig()` is byte-for-byte identical to the previous behaviour.
 */
import { getDb } from './firestore.js';
import { logger } from '../utils/logger.js';
import { buildDefaultAiConfig } from '../config/aiDefaults.js';
import type {
  AiConfig,
  AiConfigOverrides,
  AiConfigMeta,
} from '../types/config.js';

const COLLECTION = 'systemConfig';
const DOC_ID = 'ai';
const VERSIONS_SUBCOLLECTION = 'versions';
const CACHE_TTL_MS = 30_000;

let cache: { value: AiConfig; at: number } | null = null;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The shipped defaults (env + prompt files + constants), no overrides. */
export function getDefaultAiConfig(): AiConfig {
  return buildDefaultAiConfig();
}

/**
 * Applies overrides onto a base config, field by field. An override only wins
 * when it is a usable value (non-empty string, non-empty array, finite number,
 * or an explicit boolean) — anything else falls back to the base value.
 */
export function mergeAiConfig(
  base: AiConfig,
  overrides: AiConfigOverrides | null | undefined,
): AiConfig {
  const merged: AiConfig = { ...base };
  if (!overrides) return merged;

  for (const key of Object.keys(base) as (keyof AiConfig)[]) {
    const value = overrides[key];
    if (value === undefined || value === null) continue;

    if (typeof value === 'string') {
      if (value.trim().length > 0) (merged[key] as string) = value;
    } else if (typeof value === 'number') {
      if (Number.isFinite(value) && value > 0) (merged[key] as number) = value;
    } else if (typeof value === 'boolean') {
      (merged[key] as boolean) = value;
    } else if (Array.isArray(value)) {
      const cleaned = value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean);
      if (cleaned.length > 0) (merged[key] as string[]) = cleaned;
    }
  }

  return merged;
}

/** Reads the stored overrides document (or empty when absent/disabled). */
export async function getStoredOverrides(): Promise<{
  config: AiConfigOverrides;
  meta: AiConfigMeta;
}> {
  const empty = { config: {}, meta: { updatedBy: null, updatedAt: null } };
  const db = getDb();
  if (!db) return empty;
  try {
    const snap = await db.collection(COLLECTION).doc(DOC_ID).get();
    if (!snap.exists) return empty;
    const data = snap.data() as
      | { config?: AiConfigOverrides; updatedBy?: string; updatedAt?: string }
      | undefined;
    return {
      config: data?.config ?? {},
      meta: {
        updatedBy: data?.updatedBy ?? null,
        updatedAt: data?.updatedAt ?? null,
      },
    };
  } catch (err) {
    logger.warn('Failed to read AI config overrides', { error: errMessage(err) });
    return empty;
  }
}

/** Returns the effective (merged) AI config, cached briefly. */
export async function getAiConfig(): Promise<AiConfig> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const defaults = getDefaultAiConfig();
  let value = defaults;
  try {
    const { config } = await getStoredOverrides();
    value = mergeAiConfig(defaults, config);
  } catch (err) {
    logger.warn('Falling back to default AI config', { error: errMessage(err) });
    value = defaults;
  }

  cache = { value, at: now };
  return value;
}

/** Clears the in-memory cache so the next read reflects a fresh save. */
export function invalidateAiConfig(): void {
  cache = null;
}

/**
 * Persists overrides (best-effort), appending the previous version to a history
 * subcollection and invalidating the cache. Only known keys are written.
 */
export async function saveAiConfig(
  overrides: AiConfigOverrides,
  updatedBy: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  const db = getDb();
  if (!db) return { ok: false, reason: 'Firestore is not enabled' };

  const defaults = getDefaultAiConfig();
  // Whitelist only known keys.
  const clean: AiConfigOverrides = {};
  for (const key of Object.keys(defaults) as (keyof AiConfig)[]) {
    if (overrides[key] !== undefined) (clean[key] as unknown) = overrides[key];
  }

  const docRef = db.collection(COLLECTION).doc(DOC_ID);
  const at = new Date().toISOString();
  try {
    // Snapshot the current version into history before overwriting.
    const prev = await docRef.get();
    if (prev.exists) {
      await docRef
        .collection(VERSIONS_SUBCOLLECTION)
        .add({ ...(prev.data() ?? {}), recordedAt: Date.now() });
    }

    await docRef.set(
      { config: clean, updatedBy: updatedBy ?? null, updatedAt: at },
      { merge: false },
    );
    invalidateAiConfig();
    logger.info('Saved AI config overrides', {
      updatedBy,
      keys: Object.keys(clean),
    });
    return { ok: true };
  } catch (err) {
    logger.error('Failed to save AI config', { error: errMessage(err) });
    return { ok: false, reason: errMessage(err) };
  }
}

export interface AiConfigVersion {
  config: AiConfigOverrides;
  updatedBy: string | null;
  updatedAt: string | null;
  recordedAt: number;
}

/** Returns saved config versions, newest first. */
export async function getAiConfigHistory(limit = 20): Promise<AiConfigVersion[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const snap = await db
      .collection(COLLECTION)
      .doc(DOC_ID)
      .collection(VERSIONS_SUBCOLLECTION)
      .orderBy('recordedAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((d) => {
      const data = d.data() as {
        config?: AiConfigOverrides;
        updatedBy?: string;
        updatedAt?: string;
        recordedAt?: number;
      };
      return {
        config: data.config ?? {},
        updatedBy: data.updatedBy ?? null,
        updatedAt: data.updatedAt ?? null,
        recordedAt: data.recordedAt ?? 0,
      };
    });
  } catch (err) {
    logger.warn('Failed to read AI config history', { error: errMessage(err) });
    return [];
  }
}

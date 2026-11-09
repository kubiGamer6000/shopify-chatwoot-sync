/**
 * Per-agent session generation, used to revoke sessions (sign-out, or an
 * admin revoking an agent). Stored in Firestore `agentSessions/{agentId}`
 * with a 60 s in-process cache. If Firestore is unavailable the last known
 * value (or the in-process bump) is used and an alert is raised; rotating
 * APP_SESSION_SECRET remains the hard "revoke everyone" switch.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../services/firestore.js';
import { alert } from '../services/alert.js';

const CACHE_MS = 60 * 1000;
const cache = new Map<number, { gen: number; at: number }>();

export async function getGeneration(agentId: number, opts: { fresh?: boolean } = {}): Promise<number> {
  const now = Date.now();
  const hit = cache.get(agentId);
  if (hit && !opts.fresh && now - hit.at < CACHE_MS) return hit.gen;
  const db = getDb();
  if (!db) return hit?.gen ?? 0;
  try {
    const snap = await db.collection('agentSessions').doc(String(agentId)).get();
    const stored = (snap.data() as { generation?: number } | undefined)?.generation ?? 0;
    const gen = Math.max(stored, hit?.gen ?? 0);
    cache.set(agentId, { gen, at: now });
    return gen;
  } catch (err) {
    alert('session-store-unavailable', 'Could not read session generation; using last known', {
      error: err instanceof Error ? err.message : String(err),
    });
    return hit?.gen ?? 0;
  }
}

/** Revokes every existing session of the agent. Returns the new generation. */
export async function bumpGeneration(agentId: number): Promise<number> {
  const current = await getGeneration(agentId, { fresh: true });
  const next = current + 1;
  cache.set(agentId, { gen: next, at: Date.now() });
  const db = getDb();
  if (!db) {
    alert('session-store-unavailable', 'Firestore not configured; sign-out revocation is in-process only');
    return next;
  }
  try {
    await db
      .collection('agentSessions')
      .doc(String(agentId))
      .set({ generation: FieldValue.increment(1), updatedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    alert('session-store-unavailable', 'Could not persist sign-out; revocation is in-process only', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return next;
}

/** Test helper. */
export function resetGenerations(): void {
  cache.clear();
}

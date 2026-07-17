import { logger } from '../utils/logger.js';
import { getDb } from './firestore.js';
import type { AiDraft } from '../types/draft.js';

const COLLECTION = 'aiDrafts';
// Append-only per-conversation subcollection of every draft version generated.
// Enables comparing successive AI drafts against the reply the agent actually
// sent (a signal for prompt tuning).
const VERSIONS_SUBCOLLECTION = 'versions';

/** Returns the latest stored draft for a conversation, or null. */
export async function getLatestDraft(
  conversationId: number,
): Promise<AiDraft | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const snap = await db
      .collection(COLLECTION)
      .doc(String(conversationId))
      .get();
    if (!snap.exists) return null;
    return snap.data() as AiDraft;
  } catch (err) {
    logger.warn('Failed to read stored draft', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Stores (overwrites) the latest draft for a conversation, and appends it to
 * the version history. */
export async function storeDraft(draft: AiDraft): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .collection(COLLECTION)
      .doc(String(draft.conversationId))
      .set(draft, { merge: true });
    logger.info('Stored AI draft', {
      conversationId: draft.conversationId,
      source: draft.source,
    });
  } catch (err) {
    logger.warn('Failed to store draft', {
      conversationId: draft.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Append to history (best-effort, independent of the latest-doc write above).
  await appendDraftVersion(draft);
}

/** Appends a draft to the conversation's version-history subcollection. */
async function appendDraftVersion(draft: AiDraft): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .collection(COLLECTION)
      .doc(String(draft.conversationId))
      .collection(VERSIONS_SUBCOLLECTION)
      .add({ ...draft, recordedAt: Date.now() });
  } catch (err) {
    logger.warn('Failed to append draft version', {
      conversationId: draft.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Returns recent draft versions for a conversation (newest first). */
export async function getDraftHistory(
  conversationId: number,
  limit = 20,
): Promise<AiDraft[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const snap = await db
      .collection(COLLECTION)
      .doc(String(conversationId))
      .collection(VERSIONS_SUBCOLLECTION)
      .orderBy('recordedAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.data() as AiDraft);
  } catch (err) {
    logger.warn('Failed to read draft history', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

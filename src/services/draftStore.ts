import { logger } from '../utils/logger.js';
import { getDb } from './firestore.js';
import type { AiDraft } from '../types/draft.js';

const COLLECTION = 'aiDrafts';

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

/** Stores (overwrites) the latest draft for a conversation. */
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
}

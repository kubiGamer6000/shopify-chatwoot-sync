import { getDb } from './firestore.js';
import { logger } from '../utils/logger.js';

/**
 * Best-effort audit logging for AI activity. Every function here is a no-op when
 * Firestore is disabled and never throws, so it can be called (fire-and-forget)
 * from any hot path without affecting behaviour or latency.
 */

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface AiUsageEntry {
  // What produced this call: 'draft' | 'classify' | 'summary' | 'completion' |
  // 'responder' | 'resolver' | 'structured' | ...
  kind: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  conversationId?: number | null;
  contactId?: number | null;
}

/** Appends one AI model call to the `aiUsage` log (append-only). */
export async function recordAiUsage(entry: AiUsageEntry): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.collection('aiUsage').add({
      ...entry,
      at: new Date().toISOString(),
      ts: Date.now(),
    });
  } catch (err) {
    logger.warn('Failed to record AI usage', { error: errMessage(err) });
  }
}

export interface ClassificationRecord {
  conversationId: number;
  labels: string[];
  reasoning?: string;
  model: string;
}

/** Stores the latest classifier decision for a conversation (doc per convo). */
export async function recordClassification(
  entry: ClassificationRecord,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .collection('classifications')
      .doc(String(entry.conversationId))
      .set({ ...entry, at: new Date().toISOString(), ts: Date.now() }, { merge: true });
  } catch (err) {
    logger.warn('Failed to record classification', { error: errMessage(err) });
  }
}

export interface AgentBotDecisionRecord {
  conversationId: number;
  classified: string[] | null;
  routingLabels: string[];
  action: string;
}

/** Stores the latest AgentBot routing decision for a conversation. */
export async function recordAgentBotDecision(
  entry: AgentBotDecisionRecord,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .collection('agentBotDecisions')
      .doc(String(entry.conversationId))
      .set({ ...entry, at: new Date().toISOString(), ts: Date.now() }, { merge: true });
  } catch (err) {
    logger.warn('Failed to record AgentBot decision', { error: errMessage(err) });
  }
}

export interface SentReplyRecord {
  conversationId: number;
  message: string;
  source: 'dashboard' | 'agent-bot';
}

/**
 * Logs a reply actually sent to a customer. Paired with stored draft versions,
 * this lets us measure how much agents edit AI drafts (a signal for tuning the
 * prompt).
 */
export async function recordSentReply(entry: SentReplyRecord): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.collection('sentReplies').add({
      ...entry,
      at: new Date().toISOString(),
      ts: Date.now(),
    });
  } catch (err) {
    logger.warn('Failed to record sent reply', { error: errMessage(err) });
  }
}

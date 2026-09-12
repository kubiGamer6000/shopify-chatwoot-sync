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
  currentIntents?: string[];
  needsReply?: boolean;
  isAutoReply?: boolean;
  isSpam?: boolean;
  language?: string;
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
  /** Why the conversation was escalated/skipped/failed (null when answered). */
  reason?: string | null;
  /** Intents the routing acted on. */
  intents?: string[];
  route?: string | null;
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

export interface ResponderGuardEvent {
  conversationId: number;
  /**
   * `blocked` — the reply was not customer-safe and the conversation was
   * escalated instead; `preamble-stripped` — leading reasoning was removed
   * before sending; `missing-send-reply-tool` — the agent answered with
   * free-form text instead of `send_reply`; `holding-fallback` — a generated
   * holding reply was replaced with the canned one.
   */
  outcome: 'blocked' | 'preamble-stripped' | 'missing-send-reply-tool' | 'holding-fallback';
  source: 'send_reply' | 'free-text' | 'holding_reply';
  violations: string[];
  /** The rejected text, kept for prompt debugging. Never sent to a customer. */
  blockedText?: string;
}

/**
 * Logs every time the AgentBot's customer-safety guard had to intervene. These
 * are the signal that the responder prompt is drifting, so they are recorded
 * even when the reply was salvaged.
 */
export async function recordResponderGuardEvent(
  entry: ResponderGuardEvent,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.collection('responderGuardEvents').add({
      ...entry,
      blockedText: entry.blockedText?.slice(0, 4000),
      at: new Date().toISOString(),
      ts: Date.now(),
    });
  } catch (err) {
    logger.warn('Failed to record responder guard event', { error: errMessage(err) });
  }
}

export interface SentReplyRecord {
  conversationId: number;
  message: string;
  source: 'dashboard' | 'agent-bot' | 'agent-bot-holding';
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

/**
 * Counts public messages the AgentBot sent to a conversation since `sinceMs`
 * (answers, acknowledgements and holding replies). Fails open to 0.
 */
export async function countRecentBotMessages(
  conversationId: number,
  sinceMs: number,
): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  try {
    const snap = await db
      .collection('sentReplies')
      .where('conversationId', '==', conversationId)
      .get();
    return snap.docs.filter((d) => {
      const data = d.data() as { source?: string; ts?: number };
      return (data.source ?? '').startsWith('agent-bot') && (data.ts ?? 0) >= sinceMs;
    }).length;
  } catch (err) {
    logger.warn('Failed to count recent bot messages', { error: errMessage(err) });
    return 0;
  }
}

export interface ShadowAcknowledgementRecord {
  conversationId: number;
  intents: string[];
  language: string | null;
  reason: string;
  /** Exactly what would have been sent (empty when the guard blocked it). */
  wouldSend: string;
  askedFor: string[];
  handoffNote: string;
  guardOk: boolean;
  violations: string[];
  model: string;
}

/**
 * Records an acknowledgement generated in shadow mode (never sent), for review
 * before the acknowledgement rollout goes live.
 */
export async function recordShadowAcknowledgement(
  entry: ShadowAcknowledgementRecord,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.collection('acknowledgementShadow').add({
      ...entry,
      at: new Date().toISOString(),
      ts: Date.now(),
    });
  } catch (err) {
    logger.warn('Failed to record shadow acknowledgement', { error: errMessage(err) });
  }
}

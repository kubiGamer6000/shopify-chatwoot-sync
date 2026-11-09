import { getDb } from './firestore.js';
import { logger } from '../utils/logger.js';
import { alert } from './alert.js';

/**
 * Audit trail for every agent lookup and action in the Customer 360 tab, and
 * every action the AgentBot takes on a customer's account.
 *
 * Each entry is ALWAYS written to the log as one `AUDIT {json}` line (so the
 * trail survives a Firestore outage) and, best-effort, to the Firestore
 * `auditLog` collection. Entries carry ids only (agent, conversation, contact,
 * Shopify customer, subscription) — never emails or message text.
 */
export interface AuditEntry {
  action: string;
  /** Chatwoot agent id, or 'agent-bot' / 'legacy-shared-token'. */
  actor: string;
  actorName?: string | null;
  /** How the actor was authenticated: 'session' | 'legacy-token' | 'system'. */
  via: 'session' | 'legacy-token' | 'system';
  conversationId?: number | null;
  contactId?: number | null;
  shopifyCustomerId?: number | string | null;
  subscriptionId?: string | null;
  linkStatus?: string | null;
  outcome: 'ok' | 'denied' | 'error' | 'noop';
  reason?: string | null;
  detail?: Record<string, unknown>;
}

export async function audit(entry: AuditEntry): Promise<void> {
  const record = { ...entry, at: new Date().toISOString(), ts: Date.now() };
  logger.info('AUDIT', record as unknown as Record<string, unknown>);
  const db = getDb();
  if (!db) {
    alert('audit-store-unavailable', 'Firestore not configured; audit kept in logs only');
    return;
  }
  try {
    await db.collection('auditLog').add(record);
  } catch (err) {
    alert('audit-store-write-failed', 'Could not write audit entry to Firestore (kept in logs)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

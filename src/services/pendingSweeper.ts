/**
 * Periodic safety net for bot-owned conversations: finds `pending` conversations
 * whose latest message is an unanswered customer message (a missed webhook, a
 * crash or deploy mid-run, a Chatwoot hiccup) and makes sure someone handles it.
 *
 * By age of that customer message:
 * - younger than `pendingSweepMinAgeMinutes`: left alone (the webhook path is
 *   probably still working on it);
 * - up to `pendingSweepReplyMaxAgeHours`: processed by the AgentBot as normal;
 * - up to `pendingSweepMaxAgeDays`: opened for a human with a draft (a bot reply
 *   days later would be odd);
 * - older: ignored.
 *
 * Conversations whose latest message is ours (e.g. proactive outreach waiting
 * for the customer) are never touched. Each customer message is swept at most
 * once.
 */
import { logger } from '../utils/logger.js';
import { getAiConfig } from './appConfig.js';
import { claimOnce } from './cache.js';
import { listConversations, setConversationStatus } from './chatwootConversation.js';
import { enqueueAgentBotJob, isConversationBusy } from './agentBotQueue.js';
import { postAiDraft } from './aiDraft.js';
import { recordAgentBotDecision } from './aiAudit.js';

const MAX_PAGES = 20;
const SWEEP_CLAIM_TTL_MS = 60 * 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let sweeping = false;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface SweepStats {
  scanned: number;
  processed: number;
  opened: number;
  tooOld: number;
}

interface ListedMessage {
  id: number;
  message_type: number;
  private?: boolean;
  created_at: number;
}

/** The latest non-activity message of a listed conversation, if available. */
function lastMessage(conversation: Record<string, any>): ListedMessage | null {
  const last = conversation.last_non_activity_message as ListedMessage | undefined;
  if (last) return last;
  const messages = (conversation.messages ?? []) as ListedMessage[];
  const visible = messages.filter((m) => m.message_type === 0 || m.message_type === 1);
  return visible[visible.length - 1] ?? null;
}

export async function sweepPendingConversations(): Promise<SweepStats | null> {
  const cfg = await getAiConfig();
  if (!cfg.pendingSweepEnabled || sweeping) return null;
  sweeping = true;

  const stats: SweepStats = { scanned: 0, processed: 0, opened: 0, tooOld: 0 };
  const now = Date.now();
  const minAgeMs = cfg.pendingSweepMinAgeMinutes * 60 * 1000;
  const replyMaxAgeMs = cfg.pendingSweepReplyMaxAgeHours * 60 * 60 * 1000;
  const maxAgeMs = cfg.pendingSweepMaxAgeDays * 24 * 60 * 60 * 1000;

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const conversations = await listConversations({ status: 'pending', page });
      if (conversations.length === 0) break;

      for (const conversation of conversations as unknown as Record<string, any>[]) {
        stats.scanned++;
        const conversationId = conversation.id as number;
        const last = lastMessage(conversation);
        if (!last || last.message_type !== 0 || last.private) continue;
        if (isConversationBusy(conversationId)) continue;

        const ageMs = now - last.created_at * 1000;
        if (ageMs < minAgeMs) continue;
        if (ageMs > maxAgeMs) {
          stats.tooOld++;
          continue;
        }

        const contactId = conversation.meta?.sender?.id as number | undefined;
        if (!contactId) continue;
        const email = (conversation.meta?.sender?.email as string | undefined) ?? null;

        // Once per customer message, even across restarts.
        const fresh = await claimOnce('sweep', `${conversationId}:${last.id}`, SWEEP_CLAIM_TTL_MS);
        if (!fresh) continue;

        if (ageMs <= replyMaxAgeMs) {
          logger.warn('Sweeper: unanswered pending conversation, processing', {
            conversationId,
            ageMinutes: Math.round(ageMs / 60000),
          });
          await enqueueAgentBotJob({ conversationId, contactId, email }, { immediate: true });
          stats.processed++;
        } else {
          logger.warn('Sweeper: stale unanswered pending conversation, opening for a human', {
            conversationId,
            ageHours: Math.round(ageMs / 3600000),
          });
          try {
            await setConversationStatus(conversationId, 'open');
            void recordAgentBotDecision({
              conversationId,
              classified: null,
              routingLabels: [],
              action: 'swept-open',
              reason: `unanswered for ${Math.round(ageMs / 3600000)}h`,
            });
            await postAiDraft({ conversationId, contactId, email, classify: true });
            stats.opened++;
          } catch (err) {
            logger.error('Sweeper: failed to open conversation', {
              conversationId,
              error: errMessage(err),
            });
          }
        }
      }
    }

    if (stats.processed || stats.opened) logger.info('Pending sweep finished', { ...stats });
    return stats;
  } catch (err) {
    logger.error('Pending sweep failed', { error: errMessage(err) });
    return stats;
  } finally {
    sweeping = false;
  }
}

/** Starts the periodic sweep; the interval is read from config at start. */
export async function startPendingSweeper(): Promise<void> {
  if (timer) return;
  const cfg = await getAiConfig();
  const intervalMs = Math.max(1, cfg.pendingSweepIntervalMinutes) * 60 * 1000;
  timer = setInterval(() => void sweepPendingConversations(), intervalMs);
  timer.unref();
  logger.info('Pending sweeper started', { intervalMinutes: intervalMs / 60000 });
}

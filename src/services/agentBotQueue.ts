/**
 * In-process scheduling for AgentBot jobs (the app runs as a single instance).
 *
 * - Debounce: a message waits `agentBotDebounceSeconds`; further messages in the
 *   same conversation restart the wait, so a burst gets one answer covering all
 *   of it instead of one reply per message.
 * - Serialization: at most one run per conversation at a time; a job that
 *   arrives mid-run waits for it, so two runs never reply or escalate in
 *   parallel.
 * - Re-check: before running, the conversation's current status decides what
 *   happens. A human may have taken it (or an earlier run escalated it) while
 *   the job waited; the draft webhook skipped the message because it arrived
 *   while the conversation was still pending, so it gets a draft instead.
 */
import { logger } from '../utils/logger.js';
import { getAiConfig } from './appConfig.js';
import { getConversationDetails, getConversationMessages } from './chatwootConversation.js';
import { handleAgentBotJob, type AgentBotJob } from './aiResponder.js';
import { postAiDraft } from './aiDraft.js';
import { unansweredCustomerMessages } from './autoReply.js';

const timers = new Map<number, NodeJS.Timeout>();
const latestJob = new Map<number, AgentBotJob>();
const running = new Map<number, Promise<void>>();

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True while a job for this conversation is waiting or running. */
export function isConversationBusy(conversationId: number): boolean {
  return timers.has(conversationId) || running.has(conversationId);
}

/** Schedules a conversation for processing after the debounce window. */
export async function enqueueAgentBotJob(
  job: AgentBotJob,
  opts: { immediate?: boolean } = {},
): Promise<void> {
  const { conversationId } = job;
  const cfg = await getAiConfig();
  const delayMs = opts.immediate ? 0 : Math.max(0, cfg.agentBotDebounceSeconds * 1000);

  latestJob.set(conversationId, job);
  const existing = timers.get(conversationId);
  if (existing) clearTimeout(existing);

  timers.set(
    conversationId,
    setTimeout(() => {
      timers.delete(conversationId);
      const next = latestJob.get(conversationId);
      latestJob.delete(conversationId);
      if (next) runExclusive(conversationId, () => runJob(next));
    }, delayMs),
  );
}

function runExclusive(conversationId: number, fn: () => Promise<void>): void {
  const previous = running.get(conversationId) ?? Promise.resolve();
  const current = previous
    .then(fn)
    .catch((err) => {
      logger.error('AgentBot job failed', { conversationId, error: errMessage(err) });
    })
    .finally(() => {
      if (running.get(conversationId) === current) running.delete(conversationId);
    });
  running.set(conversationId, current);
}

async function runJob(job: AgentBotJob): Promise<void> {
  const { conversationId } = job;

  let status: string | undefined;
  try {
    status = (await getConversationDetails(conversationId)).status;
  } catch (err) {
    // Can't check; the pipeline has its own failsafe for Chatwoot errors.
    logger.warn('AgentBot: status re-check failed, processing anyway', {
      conversationId,
      error: errMessage(err),
    });
  }

  if (status === 'open') {
    logger.info('AgentBot: conversation became human-owned while queued, drafting instead', {
      conversationId,
    });
    await postAiDraft({ ...job, classify: true });
    return;
  }

  if (status && status !== 'pending') {
    // e.g. an earlier run answered and resolved while this message waited. Only
    // continue if a customer message is still unanswered.
    const messages = (await getConversationMessages(conversationId)).payload;
    if (unansweredCustomerMessages(messages).length === 0) {
      logger.info('AgentBot: nothing left to answer, skipping', { conversationId, status });
      return;
    }
  }

  await handleAgentBotJob(job);
}

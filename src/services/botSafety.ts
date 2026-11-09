import { logger } from '../utils/logger.js';
import { alert } from './alert.js';
import { postPrivateNote, setConversationStatus } from './chatwootConversation.js';

/**
 * Fail-safe handoff used when the bot cannot run safely (e.g. its duplicate
 * protection store is down): no customer-facing message, no action. The
 * conversation is opened for a human with a private note, and an alert fires.
 */
export async function handOffWithoutBot(conversationId: number, reason: string): Promise<void> {
  alert('agentbot-paused', `AgentBot did not handle a conversation: ${reason}`, { conversationId });
  try {
    await setConversationStatus(conversationId, 'open');
  } catch (err) {
    logger.error('Fail-safe handoff: could not open conversation', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await postPrivateNote(
    conversationId,
    `[AI] The AgentBot did not handle this message (${reason}). Please handle it manually.`,
  ).catch(() => undefined);
}

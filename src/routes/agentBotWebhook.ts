import { Router } from 'express';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { handleAgentBotMessage } from '../services/aiResponder.js';
import { claimOnce } from '../services/cache.js';
import type { ChatwootWebhookPayload } from '../types/chatwoot.js';

const router = Router();

// Idempotency window for AgentBot message-webhook redeliveries.
const MESSAGE_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Chatwoot AgentBot webhook. Connected to the inbox via Settings -> Bots, this
 * receives conversation events for bot-owned (pending) conversations. We MUST
 * ack within Chatwoot's 5s timeout (otherwise it flips the conversation to open
 * and posts a bot-error activity), so we respond 200 immediately and process
 * asynchronously.
 */
router.post('/', (req: Request, res: Response) => {
  res.status(200).json({ received: true });

  const secret = req.query['secret'] as string | undefined;
  if (env.agentBotWebhookSecret && secret !== env.agentBotWebhookSecret) {
    logger.warn('AgentBot webhook rejected: invalid secret');
    return;
  }

  const payload = req.body as ChatwootWebhookPayload;

  if (payload.event !== 'message_created') return;
  if (payload.message_type !== 'incoming') return;
  if (payload.private === true) return;

  // Only handle conversations the bot owns. Open/resolved conversations are
  // handled by the standard draft webhook, so the two never collide.
  if (payload.conversation.status !== 'pending') {
    logger.info('AgentBot ignoring non-pending conversation', {
      conversationId: payload.conversation.id,
      status: payload.conversation.status,
    });
    return;
  }

  logger.info('AgentBot webhook: incoming message', {
    conversationId: payload.conversation.id,
    senderId: payload.sender.id,
    senderEmail: payload.sender.email,
  });

  void (async () => {
    // Skip duplicate deliveries so the bot never answers the same message twice
    // (fail-open when no cache is configured).
    const fresh = await claimOnce('wh-agentbot', String(payload.id), MESSAGE_DEDUPE_TTL_MS);
    if (!fresh) {
      logger.info('Duplicate AgentBot webhook delivery, skipping', {
        conversationId: payload.conversation.id,
        messageId: payload.id,
      });
      return;
    }

    await handleAgentBotMessage(payload);
  })().catch((err) => {
    logger.error('AgentBot processing failed', {
      conversationId: payload.conversation.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
});

export default router;

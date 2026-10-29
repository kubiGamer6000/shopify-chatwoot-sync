import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { enqueueAgentBotJob } from '../services/agentBotQueue.js';
import { claim } from '../services/cache.js';
import { handOffWithoutBot } from '../services/botSafety.js';
import { verifyChatwootWebhook } from '../middleware/chatwootWebhookAuth.js';
import type { ChatwootWebhookPayload } from '../types/chatwoot.js';

const router = Router();

// Idempotency window for AgentBot message-webhook redeliveries.
const MESSAGE_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Chatwoot AgentBot webhook. Connected to the inbox via Settings -> Bots, this
 * receives conversation events for bot-owned (pending) conversations. We MUST
 * ack within Chatwoot's 5s timeout (otherwise it flips the conversation to open
 * and posts a bot-error activity), so we respond 200 immediately and process
 * asynchronously. The delivery is authenticated first (HMAC signature; see
 * chatwootWebhookAuth.ts) and rejected with 401 otherwise.
 */
router.post('/', verifyChatwootWebhook('agentBot'), (req: Request, res: Response) => {
  res.status(200).json({ received: true });

  const payload = req.body as ChatwootWebhookPayload;
  const deliveryId = req.header('x-chatwoot-delivery') ?? null;

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
  });

  void (async () => {
    // Replays of a signed delivery (same X-Chatwoot-Delivery id) are dropped.
    if (deliveryId && (await claim('wh-delivery', deliveryId, MESSAGE_DEDUPE_TTL_MS)) === 'duplicate') {
      logger.info('Duplicate webhook delivery id, skipping', { conversationId: payload.conversation.id });
      return;
    }

    // Skip duplicate deliveries so the bot never answers the same message twice.
    // Fail SAFE: if the dedupe store is down we can't rule out a duplicate, so
    // the bot does not reply or act; a human takes the conversation.
    const claimed = await claim('wh-agentbot', String(payload.id), MESSAGE_DEDUPE_TTL_MS);
    if (claimed === 'unavailable') {
      await handOffWithoutBot(payload.conversation.id, 'duplicate-protection store unavailable');
      return;
    }
    if (claimed === 'duplicate') {
      logger.info('Duplicate AgentBot webhook delivery, skipping', {
        conversationId: payload.conversation.id,
        messageId: payload.id,
      });
      return;
    }

    await enqueueAgentBotJob({
      conversationId: payload.conversation.id,
      contactId: payload.sender.id,
      email: payload.sender.email,
    });
  })().catch((err) => {
    logger.error('AgentBot processing failed', {
      conversationId: payload.conversation.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
});

export default router;

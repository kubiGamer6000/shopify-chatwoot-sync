import { Router } from 'express';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { postAiDraft } from '../services/aiDraft.js';
import { claimOnce } from '../services/cache.js';
import type { ChatwootWebhookPayload } from '../types/chatwoot.js';

const router = Router();

// Idempotency window for Chatwoot message-webhook redeliveries.
const MESSAGE_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

router.post('/', (req: Request, res: Response) => {
  res.status(200).json({ received: true });

  const secret = req.query['secret'] as string | undefined;
  if (env.chatwootWebhookSecret && secret !== env.chatwootWebhookSecret) {
    logger.warn('Chatwoot webhook rejected: invalid secret');
    return;
  }

  const payload = req.body as ChatwootWebhookPayload;

  if (payload.event !== 'message_created') return;
  if (payload.message_type !== 'incoming') return;
  if (payload.private === true) return;

  // Pending conversations are owned by the AgentBot (separate /chatwoot/agent-bot
  // endpoint), which auto-responds or escalates. Only draft for human-owned
  // (open) conversations here, so the two webhooks never double-handle a message.
  if (payload.conversation.status === 'pending') {
    logger.info('Skipping AI draft for pending conversation (AgentBot owns it)', {
      conversationId: payload.conversation.id,
    });
    return;
  }

  // To restrict AI drafts to specific inboxes, uncomment and set AI_INBOX_IDS env var:
  // const allowedInboxes = process.env.AI_INBOX_IDS;
  // if (allowedInboxes && !allowedInboxes.split(',').includes(String(payload.inbox?.id))) return;

  logger.info('Chatwoot webhook: incoming message', {
    conversationId: payload.conversation.id,
    senderId: payload.sender.id,
    senderEmail: payload.sender.email,
  });

  void (async () => {
    // Skip duplicate deliveries of the same message so we never post two drafts
    // for one customer message (fail-open when no cache is configured).
    const fresh = await claimOnce('wh-draft', String(payload.id), MESSAGE_DEDUPE_TTL_MS);
    if (!fresh) {
      logger.info('Duplicate draft webhook delivery, skipping', {
        conversationId: payload.conversation.id,
        messageId: payload.id,
      });
      return;
    }

    await postAiDraft({
      conversationId: payload.conversation.id,
      contactId: payload.sender.id,
      email: payload.sender.email,
      classify: true,
    });
  })().catch((err) => {
    logger.error('AI draft processing failed', {
      conversationId: payload.conversation.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
});

export default router;

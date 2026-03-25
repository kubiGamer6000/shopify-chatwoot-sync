import { Router } from 'express';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { handleIncomingMessage } from '../services/aiDraft.js';
import type { ChatwootWebhookPayload } from '../types/chatwoot.js';

const router = Router();

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

  // To restrict AI drafts to specific inboxes, uncomment and set AI_INBOX_IDS env var:
  // const allowedInboxes = process.env.AI_INBOX_IDS;
  // if (allowedInboxes && !allowedInboxes.split(',').includes(String(payload.inbox?.id))) return;

  logger.info('Chatwoot webhook: incoming message', {
    conversationId: payload.conversation.id,
    senderId: payload.sender.id,
    senderEmail: payload.sender.email,
  });

  handleIncomingMessage(payload).catch((err) => {
    logger.error('AI draft processing failed', {
      conversationId: payload.conversation.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
});

export default router;

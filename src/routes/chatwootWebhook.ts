import { Router } from 'express';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { handleIncomingMessage } from '../services/pipeline.js';
import type { ChatwootWebhookPayload } from '../types/chatwoot.js';

const router = Router();

router.post('/', (req: Request, res: Response) => {
  res.status(200).json({ received: true });

  const secret = req.query['secret'] as string | undefined;
  if (env.chatwootWebhookSecret && secret !== env.chatwootWebhookSecret) {
    logger.warn('Chatwoot webhook rejected: invalid secret');
    return;
  }

  if (env.aiMode === 'off') return;

  const payload = req.body as ChatwootWebhookPayload;

  // Handle both regular webhooks (message_created) and Agent Bot events
  const event = payload.event;
  if (event !== 'message_created' && event !== 'conversation_created') return;

  // For message_created: only process incoming, non-private messages
  if (event === 'message_created') {
    if (payload.message_type !== 'incoming') return;
    if (payload.private === true) return;
  }

  logger.info('Chatwoot webhook: incoming message', {
    event,
    conversationId: payload.conversation.id,
    senderId: payload.sender.id,
    senderEmail: payload.sender.email,
    mode: env.aiMode,
  });

  handleIncomingMessage(payload).catch((err) => {
    logger.error('Pipeline processing failed', {
      conversationId: payload.conversation.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
});

export default router;

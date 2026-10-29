import { Router } from 'express';
import type { Request, Response } from 'express';
import { verifyChatwootWebhook } from '../middleware/chatwootWebhookAuth.js';
import { logger } from '../utils/logger.js';
import { postAiDraft } from '../services/aiDraft.js';
import { claim, claimOnce } from '../services/cache.js';
import { autoReplySignalFromAttributes, systemPhraseSignal } from '../services/autoReply.js';
import type { ChatwootWebhookPayload } from '../types/chatwoot.js';

const router = Router();

// Idempotency window for Chatwoot message-webhook redeliveries.
const MESSAGE_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

router.post('/', verifyChatwootWebhook('account'), (req: Request, res: Response) => {
  res.status(200).json({ received: true });

  const payload = req.body as ChatwootWebhookPayload;
  const deliveryId = req.header('x-chatwoot-delivery') ?? null;

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
  });

  void (async () => {
    // Replays of a signed delivery (same X-Chatwoot-Delivery id) are dropped.
    if (deliveryId && (await claim('wh-delivery', deliveryId, MESSAGE_DEDUPE_TTL_MS)) === 'duplicate') {
      logger.info('Duplicate webhook delivery id, skipping', { conversationId: payload.conversation.id });
      return;
    }

    // Skip duplicate deliveries of the same message so we never post two drafts
    // for one customer message. Drafts are private notes (never sent to the
    // customer), so when Firestore is down this proceeds on the in-process
    // dedupe and raises an alert instead of switching dedupe off silently.
    const fresh = await claimOnce('wh-draft', String(payload.id), MESSAGE_DEDUPE_TTL_MS);
    if (!fresh) {
      logger.info('Duplicate draft webhook delivery, skipping', {
        conversationId: payload.conversation.id,
        messageId: payload.id,
      });
      return;
    }

    // Machine-generated messages (out-of-office, bounces) need no draft.
    if (
      autoReplySignalFromAttributes(payload.content_attributes) ??
      systemPhraseSignal(payload.content)
    ) {
      logger.info('Skipping AI draft for automatic reply', {
        conversationId: payload.conversation.id,
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

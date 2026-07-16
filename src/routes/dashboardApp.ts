import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { getCustomerProfile } from '../services/customerProfile.js';
import { cancelSubscription } from '../services/skio.js';
import {
  getStoredSummary,
  refreshSummaryForContact,
} from '../services/customerSummary.js';
import { getLatestDraft } from '../services/draftStore.js';
import { generateResponse } from '../services/aiDraft.js';
import {
  sendReply,
  getLastCustomerMessage,
  resolveConversation,
  addConversationLabels,
} from '../services/chatwootConversation.js';

// Label applied to a conversation when an agent cancels a subscription from the
// dashboard (the human counterpart to the AI's `sub-cancelled-ai` label).
const SUB_CANCELLED_LABEL = 'sub-cancelled';

const router = Router();

router.get('/customer', async (req: Request, res: Response) => {
  const shopifyCustomerId =
    typeof req.query.shopifyCustomerId === 'string'
      ? req.query.shopifyCustomerId
      : null;
  const email = typeof req.query.email === 'string' ? req.query.email : null;
  const contactId =
    typeof req.query.contactId === 'string' ? Number(req.query.contactId) : null;

  if (!shopifyCustomerId && !email) {
    res.status(400).json({ error: 'shopifyCustomerId or email is required' });
    return;
  }

  try {
    const [profile, aiSummary] = await Promise.all([
      getCustomerProfile({ shopifyCustomerId, email }),
      contactId ? getStoredSummary(contactId) : Promise.resolve(null),
    ]);
    res.json({ ...profile, aiSummary });
  } catch (err) {
    logger.error('Failed to build customer profile', {
      shopifyCustomerId,
      email,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build customer profile' });
  }
});

router.get('/summary', async (req: Request, res: Response) => {
  const contactId =
    typeof req.query.contactId === 'string' ? Number(req.query.contactId) : null;
  if (!contactId || Number.isNaN(contactId)) {
    res.status(400).json({ error: 'contactId is required' });
    return;
  }

  try {
    const summary = await getStoredSummary(contactId);
    res.json({ summary });
  } catch (err) {
    logger.error('Failed to read summary', {
      contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read summary' });
  }
});

router.post('/summary/refresh', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    contactId?: number | string;
    conversationId?: number | string;
    email?: string;
    shopifyCustomerId?: string;
    customerName?: string;
  };
  const contactId = body.contactId ? Number(body.contactId) : null;
  if (!contactId || Number.isNaN(contactId)) {
    res.status(400).json({ error: 'contactId is required' });
    return;
  }

  try {
    const summary = await refreshSummaryForContact({
      contactId,
      conversationId: body.conversationId ? Number(body.conversationId) : null,
      email: body.email ?? null,
      shopifyCustomerId: body.shopifyCustomerId ?? null,
      customerName: body.customerName ?? null,
    });
    if (!summary) {
      res.status(502).json({ error: 'Failed to generate summary' });
      return;
    }
    res.json({ summary });
  } catch (err) {
    logger.error('Failed to refresh summary', {
      contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to refresh summary' });
  }
});

router.get('/draft', async (req: Request, res: Response) => {
  const conversationId =
    typeof req.query.conversationId === 'string'
      ? Number(req.query.conversationId)
      : null;
  if (!conversationId || Number.isNaN(conversationId)) {
    res.status(400).json({ error: 'conversationId is required' });
    return;
  }

  try {
    const [draft, lastCustomerMessage] = await Promise.all([
      getLatestDraft(conversationId),
      getLastCustomerMessage(conversationId).catch(() => null),
    ]);
    res.json({ draft, lastCustomerMessage });
  } catch (err) {
    logger.error('Failed to read draft', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read draft' });
  }
});

router.post('/draft/generate', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    conversationId?: number | string;
    contactId?: number | string;
    email?: string;
    instruction?: string;
    previousResponse?: string;
    correction?: string;
  };
  const conversationId = body.conversationId ? Number(body.conversationId) : null;
  const contactId = body.contactId ? Number(body.contactId) : null;
  if (!conversationId || Number.isNaN(conversationId)) {
    res.status(400).json({ error: 'conversationId is required' });
    return;
  }
  if (!contactId || Number.isNaN(contactId)) {
    res.status(400).json({ error: 'contactId is required' });
    return;
  }

  try {
    const draft = await generateResponse({
      conversationId,
      contactId,
      email: body.email ?? null,
      instruction: body.instruction ?? null,
      previousResponse: body.previousResponse ?? null,
      correction: body.correction ?? null,
    });
    if (!draft) {
      res.status(502).json({ error: 'Failed to generate a response' });
      return;
    }
    res.json(draft);
  } catch (err) {
    logger.error('Failed to generate response', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to generate response' });
  }
});

router.post('/draft/send', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    conversationId?: number | string;
    message?: string;
    resolve?: boolean;
  };
  const conversationId = body.conversationId ? Number(body.conversationId) : null;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const shouldResolve = body.resolve !== false;
  if (!conversationId || Number.isNaN(conversationId)) {
    res.status(400).json({ error: 'conversationId is required' });
    return;
  }
  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  try {
    // Sending the reply is the critical step. Resolving is best-effort so a
    // resolve failure never loses the agent's message.
    await sendReply(conversationId, message);

    let resolved = false;
    if (shouldResolve) {
      try {
        await resolveConversation(conversationId);
        resolved = true;
      } catch (err) {
        logger.warn('Reply sent but failed to resolve conversation', {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    res.json({ ok: true, resolved });
  } catch (err) {
    logger.error('Failed to send reply', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

router.post('/subscriptions/:id/cancel', async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const subscriptionId = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!subscriptionId) {
    res.status(400).json({ error: 'subscription id is required' });
    return;
  }

  const body = (req.body ?? {}) as { conversationId?: number | string };
  const conversationId = body.conversationId ? Number(body.conversationId) : null;

  try {
    const ok = await cancelSubscription(subscriptionId);
    if (!ok) {
      res.status(502).json({ error: 'Skio did not confirm the cancellation' });
      return;
    }

    // Best-effort: tag the ticket so agents can filter cancellations. Never
    // let a labelling failure fail the (already successful) cancellation.
    let labelled = false;
    if (conversationId && !Number.isNaN(conversationId)) {
      const merged = await addConversationLabels(conversationId, [
        SUB_CANCELLED_LABEL,
      ]);
      labelled = merged.includes(SUB_CANCELLED_LABEL);
    }

    res.json({ ok: true, labelled });
  } catch (err) {
    logger.error('Failed to cancel subscription', {
      subscriptionId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

export default router;

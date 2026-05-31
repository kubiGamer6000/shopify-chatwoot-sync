import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { getCustomerProfile } from '../services/customerProfile.js';
import { cancelSubscription } from '../services/skio.js';
import {
  getStoredSummary,
  refreshSummaryForContact,
} from '../services/customerSummary.js';

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

router.post('/subscriptions/:id/cancel', async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const subscriptionId = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!subscriptionId) {
    res.status(400).json({ error: 'subscription id is required' });
    return;
  }

  try {
    const ok = await cancelSubscription(subscriptionId);
    if (!ok) {
      res.status(502).json({ error: 'Skio did not confirm the cancellation' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to cancel subscription', {
      subscriptionId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

export default router;

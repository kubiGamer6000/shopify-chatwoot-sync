import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { getCustomerProfile } from '../services/customerProfile.js';
import { cancelSubscription } from '../services/skio.js';

const router = Router();

router.get('/customer', async (req: Request, res: Response) => {
  const shopifyCustomerId =
    typeof req.query.shopifyCustomerId === 'string'
      ? req.query.shopifyCustomerId
      : null;
  const email = typeof req.query.email === 'string' ? req.query.email : null;

  if (!shopifyCustomerId && !email) {
    res.status(400).json({ error: 'shopifyCustomerId or email is required' });
    return;
  }

  try {
    const profile = await getCustomerProfile({ shopifyCustomerId, email });
    res.json(profile);
  } catch (err) {
    logger.error('Failed to build customer profile', {
      shopifyCustomerId,
      email,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build customer profile' });
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

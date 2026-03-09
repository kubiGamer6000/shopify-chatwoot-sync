import { Router } from 'express';
import type { Request, Response } from 'express';
import { isSyncInProgress, runFullSync } from '../services/sync.js';

const router = Router();

router.post('/customers', async (_req: Request, res: Response) => {
  if (isSyncInProgress()) {
    res.status(409).json({ error: 'Sync already in progress' });
    return;
  }

  res.status(202).json({ message: 'Sync started' });

  void runFullSync();
});

export default router;

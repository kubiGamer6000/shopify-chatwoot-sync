import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { constantTimeEqual } from '../security/crypto.js';

/** Protects /sync/* with `Authorization: Bearer <SYNC_API_KEY>`. Fails closed. */
export function syncAuth(req: Request, res: Response, next: NextFunction): void {
  if (!env.syncApiKey) {
    logger.warn('SYNC_API_KEY not set — sync endpoint disabled');
    res.status(503).json({ error: 'Sync endpoint is not configured' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!constantTimeEqual(authHeader.slice(7).trim(), env.syncApiKey)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  next();
}

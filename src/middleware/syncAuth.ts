import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export function syncAuth(req: Request, res: Response, next: NextFunction): void {
  if (!env.syncApiKey) {
    logger.warn('SYNC_API_KEY not set — sync endpoint is unprotected');
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header (Bearer <SYNC_API_KEY>)' });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== env.syncApiKey) {
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }

  next();
}

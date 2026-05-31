import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Protects the dashboard app API with a shared token.
 *
 * The token is supplied by the SPA via the `x-app-token` header (or `?token=`
 * query param). Because the SPA runs in the agent's browser the token is not a
 * strong secret — it gates casual access to an internal tool. If
 * DASHBOARD_APP_TOKEN is unset, the API is left open (with a warning).
 */
export function appAuth(req: Request, res: Response, next: NextFunction): void {
  if (!env.dashboardAppToken) {
    logger.warn('DASHBOARD_APP_TOKEN not set — dashboard app API is unprotected');
    next();
    return;
  }

  const headerToken = req.headers['x-app-token'];
  const token =
    (typeof headerToken === 'string' ? headerToken : undefined) ??
    (typeof req.query.token === 'string' ? req.query.token : undefined);

  if (!token || token !== env.dashboardAppToken) {
    res.status(401).json({ error: 'Invalid or missing app token' });
    return;
  }

  next();
}

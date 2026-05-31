import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Reads the dashboard app token from the request.
 * Chatwoot loads the iframe with ?token=…; the SPA forwards it as x-app-token on API calls.
 */
export function extractAppToken(req: Request): string | undefined {
  const headerToken = req.headers['x-app-token'];
  return (
    (typeof headerToken === 'string' ? headerToken : undefined) ??
    (typeof req.query.token === 'string' ? req.query.token : undefined)
  );
}

function tokenIsValid(token: string | undefined): boolean {
  if (!env.dashboardAppToken) return true;
  return Boolean(token && token === env.dashboardAppToken);
}

/** Protects /app/api/* — returns JSON 401 on failure. */
export function appAuth(req: Request, res: Response, next: NextFunction): void {
  if (!env.dashboardAppToken) {
    logger.warn('DASHBOARD_APP_TOKEN not set — dashboard app API is unprotected');
    next();
    return;
  }

  if (!tokenIsValid(extractAppToken(req))) {
    res.status(401).json({ error: 'Invalid or missing app token' });
    return;
  }

  next();
}

/** Protects GET /app — returns HTML 401 so the SPA bundle is not served without a token. */
export function appPageAuth(req: Request, res: Response, next: NextFunction): void {
  if (!env.dashboardAppToken) {
    logger.warn('DASHBOARD_APP_TOKEN not set — dashboard app page is unprotected');
    next();
    return;
  }

  if (!tokenIsValid(extractAppToken(req))) {
    res.status(401).type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Unauthorized</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;color:#333">
  <h1>Unauthorized</h1>
  <p>This dashboard app requires a valid <code>?token=</code> query parameter.</p>
  <p>Configure the Chatwoot Dashboard App URL as:<br>
  <code>https://&lt;your-domain&gt;/app?token=&lt;DASHBOARD_APP_TOKEN&gt;</code></p>
</body></html>`);
    return;
  }

  next();
}

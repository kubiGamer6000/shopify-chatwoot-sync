import path from 'node:path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { verifyShopifyWebhook } from './middleware/verifyShopifyWebhook.js';
import { syncAuth } from './middleware/syncAuth.js';
import { appAuth } from './middleware/appAuth.js';
import { env } from './config/env.js';
import appAuthRoutes from './routes/appAuthRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';
import webhookRoutes from './routes/webhooks.js';
import syncRoutes from './routes/sync.js';
import chatwootWebhookRoutes from './routes/chatwootWebhook.js';
import agentBotWebhookRoutes from './routes/agentBotWebhook.js';
import dashboardAppRoutes from './routes/dashboardApp.js';
import adminApiRoutes from './routes/adminApi.js';

const app = express();

// One reverse proxy (DigitalOcean App Platform) in front: use its X-Forwarded-For
// for rate-limit keys. Never echo framework details.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Baseline security headers for every response.
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Raw body parsing for webhook routes (required for HMAC verification)
app.use('/webhooks', express.raw({ type: 'application/json' }));

// Larger JSON limit for Chatwoot webhooks (payloads include full conversation
// history). The raw bytes are kept for HMAC signature verification.
app.use(
  '/chatwoot',
  express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as Request).rawBody = Buffer.from(buf);
    },
  }),
);

// JSON parsing for all other routes
app.use(express.json({ limit: '1mb' }));

// Health check (used by DO App Platform to verify the app is running)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhook routes (HMAC-verified by Shopify signing secret)
app.use('/webhooks', verifyShopifyWebhook, webhookRoutes);

// Sync routes (protected by SYNC_API_KEY when set)
app.use('/sync', syncAuth, syncRoutes);

// Chatwoot AgentBot webhook (autonomous responder for pending conversations).
// Mounted before the generic /chatwoot route. Inherits the 5mb JSON parser above.
app.use('/chatwoot/agent-bot', agentBotWebhookRoutes);

// Chatwoot webhook for AI draft auto-reply (human-owned / open conversations).
app.use('/chatwoot', chatwootWebhookRoutes);

// --- Chatwoot Dashboard App (Customer 360) ---

// Only the configured Chatwoot origin may frame the tab (not *.chatwoot.com).
const chatwootOrigin = (() => {
  try {
    return new URL(env.chatwootBaseUrl).origin;
  } catch {
    return 'https://app.chatwoot.com';
  }
})();

const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Radix/React set inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  `frame-ancestors ${chatwootOrigin}`,
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

function dashboardAppHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', DASHBOARD_CSP);
  next();
}

// Sign-in for the tab (per-agent sessions; no secret in the URL).
app.use('/app/auth', dashboardAppHeaders, appAuthRoutes);

// Agent-facing API consumed by the embedded SPA (per-agent session required).
app.use('/app/api', dashboardAppHeaders, appAuth, dashboardAppRoutes);

// Serve the built SPA (Vite outputs to web/dist with base "/app/").
// __dirname resolves to dist/ in production and src/ under tsx — both sit one
// level below the repo root where web/dist lives.
const webDist = path.resolve(__dirname, '..', 'web', 'dist');

function serveAppIndex(_req: Request, res: Response): void {
  // The page holds no secrets; the API requires a per-agent session. A legacy
  // `?token=` in the URL is never checked or logged here.
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(webDist, 'index.html'));
}

app.get(['/app', '/app/'], dashboardAppHeaders, serveAppIndex);
app.use('/app', dashboardAppHeaders, express.static(webDist, { index: false }));

// --- Admin Control Dashboard (standalone, Firebase-Auth gated) ---

// Admin API. Each route enforces its own requireAuth/requireAdmin (via Firebase
// ID token), so authorization is 100% server-side.
app.use('/admin/api', adminApiRoutes);

// The admin SPA is a separate Vite build (base "/admin/"). It must NOT be
// iframable (unlike the Chatwoot dashboard app).
function adminCsp(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

const adminDist = path.resolve(__dirname, '..', 'admin-web', 'dist');

function serveAdminIndex(_req: Request, res: Response): void {
  res.sendFile(path.join(adminDist, 'index.html'));
}

// Static assets first, then a client-side-routing SPA fallback for any other
// /admin path (e.g. /admin/settings). The /admin/api mount above is matched
// earlier, so it is never caught by this fallback.
app.use('/admin', adminCsp, express.static(adminDist, { index: false }));
app.get(/^\/admin(?:\/.*)?$/, adminCsp, serveAdminIndex);

// Global error handler
app.use(errorHandler);

export default app;

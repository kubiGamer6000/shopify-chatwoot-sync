import path from 'node:path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { verifyShopifyWebhook } from './middleware/verifyShopifyWebhook.js';
import { syncAuth } from './middleware/syncAuth.js';
import { appAuth } from './middleware/appAuth.js';
import { errorHandler } from './middleware/errorHandler.js';
import webhookRoutes from './routes/webhooks.js';
import syncRoutes from './routes/sync.js';
import chatwootWebhookRoutes from './routes/chatwootWebhook.js';
import dashboardAppRoutes from './routes/dashboardApp.js';

const app = express();

// Raw body parsing for webhook routes (required for HMAC verification)
app.use('/webhooks', express.raw({ type: 'application/json' }));

// Larger JSON limit for Chatwoot webhooks (payloads include full conversation history)
app.use('/chatwoot', express.json({ limit: '5mb' }));

// JSON parsing for all other routes
app.use(express.json());

// Health check (used by DO App Platform to verify the app is running)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhook routes (HMAC-verified by Shopify signing secret)
app.use('/webhooks', verifyShopifyWebhook, webhookRoutes);

// Sync routes (protected by SYNC_API_KEY when set)
app.use('/sync', syncAuth, syncRoutes);

// Chatwoot webhook for AI draft auto-reply
app.use('/chatwoot', chatwootWebhookRoutes);

// --- Chatwoot Dashboard App (Customer 360) ---

// Agent-facing API consumed by the embedded SPA (shared-token protected).
app.use('/app/api', appAuth, dashboardAppRoutes);

// Allow the SPA to be embedded as an iframe inside the Chatwoot dashboard.
function dashboardAppCsp(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://app.chatwoot.com https://*.chatwoot.com",
  );
  next();
}

// Serve the built SPA (Vite outputs to web/dist with base "/app/").
// __dirname resolves to dist/ in production and src/ under tsx — both sit one
// level below the repo root where web/dist lives.
const webDist = path.resolve(__dirname, '..', 'web', 'dist');
// Serve index.html for the app root (avoids the 301 redirect express.static
// would otherwise issue for /app), then static assets for everything else.
app.get('/app', dashboardAppCsp, (_req, res) => {
  res.sendFile(path.join(webDist, 'index.html'));
});
app.use('/app', dashboardAppCsp, express.static(webDist));

// Global error handler
app.use(errorHandler);

export default app;

import express from 'express';
import { verifyShopifyWebhook } from './middleware/verifyShopifyWebhook.js';
import { syncAuth } from './middleware/syncAuth.js';
import { errorHandler } from './middleware/errorHandler.js';
import webhookRoutes from './routes/webhooks.js';
import syncRoutes from './routes/sync.js';

const app = express();

// Raw body parsing for webhook routes (required for HMAC verification)
app.use('/webhooks', express.raw({ type: 'application/json' }));

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

// Global error handler
app.use(errorHandler);

export default app;

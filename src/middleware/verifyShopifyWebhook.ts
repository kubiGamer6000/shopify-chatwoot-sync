import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export function verifyShopifyWebhook(req: Request, res: Response, next: NextFunction): void {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];

  if (!hmacHeader || typeof hmacHeader !== 'string') {
    logger.warn('Webhook received without HMAC header');
    res.status(401).send('Missing HMAC');
    return;
  }

  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body)) {
    logger.warn('Webhook body is not a Buffer — raw body parser may not be applied');
    res.status(400).send('Invalid body');
    return;
  }

  const computed = crypto
    .createHmac('sha256', env.shopifyClientSecret)
    .update(body)
    .digest('base64');

  const isValid = crypto.timingSafeEqual(
    Buffer.from(computed, 'utf8'),
    Buffer.from(hmacHeader, 'utf8'),
  );

  if (!isValid) {
    logger.warn('Webhook HMAC verification failed');
    res.status(401).send('HMAC verification failed');
    return;
  }

  next();
}

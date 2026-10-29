import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { constantTimeEqual, hmacHex } from '../security/crypto.js';
import { alert } from '../services/alert.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

// Chatwoot signs `${timestamp}.${raw body}`; reject deliveries older than this.
const MAX_SKEW_SECONDS = 5 * 60;

export type WebhookKind = 'account' | 'agentBot';

/**
 * Verifies a Chatwoot webhook delivery (security fix P5).
 *
 * 1. Preferred: HMAC. Chatwoot sends `X-Chatwoot-Timestamp` and
 *    `X-Chatwoot-Signature: sha256=<hex HMAC-SHA256(secret, "<ts>.<body>")>`
 *    when the webhook / agent bot has a secret. Secret: env
 *    CHATWOOT_WEBHOOK_SIGNING_SECRET (account webhook) or
 *    CHATWOOT_AGENT_BOT_SIGNING_SECRET (agent bot).
 * 2. Transition only (LEGACY_WEBHOOK_QUERY_SECRET_ENABLED=true and no signing
 *    secret): the old `?secret=` query value, compared in constant time.
 * 3. Otherwise: rejected. Fails CLOSED when nothing is configured.
 */
export function verifyChatwootWebhook(kind: WebhookKind) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = checkChatwootWebhook(kind, req);
    if (result.ok) {
      next();
      return;
    }
    logger.warn('Chatwoot webhook rejected', { kind, reason: result.reason });
    if (result.reason === 'not-configured') {
      alert(
        'webhook-auth-not-configured',
        `Chatwoot ${kind} webhook has no signing secret configured; deliveries are rejected`,
      );
    }
    res.status(401).json({ error: 'Unauthorized' });
  };
}

export function checkChatwootWebhook(
  kind: WebhookKind,
  req: Pick<Request, 'header' | 'query' | 'rawBody'>,
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true; method: 'hmac' | 'legacy-query' } | { ok: false; reason: string } {
  const signingSecret =
    kind === 'account' ? env.chatwootWebhookSigningSecret : env.chatwootAgentBotSigningSecret;
  const querySecret = kind === 'account' ? env.chatwootWebhookSecret : env.agentBotWebhookSecret;

  if (signingSecret) {
    const ts = req.header('x-chatwoot-timestamp');
    const sig = req.header('x-chatwoot-signature');
    if (!ts || !sig || !/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'missing-signature' };
    if (Math.abs(nowSeconds - Number(ts)) > MAX_SKEW_SECONDS) return { ok: false, reason: 'stale' };
    if (!req.rawBody) return { ok: false, reason: 'no-raw-body' };
    const expected = `sha256=${hmacHex(signingSecret, `${ts}.${req.rawBody.toString('utf8')}`)}`;
    return constantTimeEqual(sig.trim(), expected)
      ? { ok: true, method: 'hmac' }
      : { ok: false, reason: 'bad-signature' };
  }

  if (env.legacyWebhookQuerySecretEnabled && querySecret) {
    const provided = req.query['secret'];
    return typeof provided === 'string' && constantTimeEqual(provided, querySecret)
      ? { ok: true, method: 'legacy-query' }
      : { ok: false, reason: 'bad-query-secret' };
  }

  return { ok: false, reason: 'not-configured' };
}

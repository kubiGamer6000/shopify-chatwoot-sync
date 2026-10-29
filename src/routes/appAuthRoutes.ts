import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { RateLimiter } from '../utils/rateLimit.js';
import { mintToken, verifyToken, ACCESS_TTL_MS } from '../security/session.js';
import { verifyAgentAccessToken, isAgentActive } from '../security/chatwootIdentity.js';
import { audit } from '../services/audit.js';
import { env } from '../config/env.js';

/**
 * Customer 360 sign-in (no shared secret in the URL any more):
 *
 * POST /app/auth/connect  { chatwootAccessToken }
 *   The agent's personal Chatwoot access token, checked against Chatwoot's
 *   /api/v1/profile (must be a member of CHATWOOT_ACCOUNT_ID). Never stored or
 *   logged. Returns an access token (12 h) and a refresh token (30 d).
 * POST /app/auth/refresh  { refreshToken }
 *   Re-checks the agent still exists in the account, returns a new pair.
 */
const router = Router();

const connectLimiter = new RateLimiter(20, 15 * 60 * 1000);
const refreshLimiter = new RateLimiter(60, 15 * 60 * 1000);

function clientKey(req: Request): string {
  // DigitalOcean App Platform sets do-connecting-ip at its edge.
  const doIp = req.header('do-connecting-ip');
  return (doIp && doIp.trim()) || req.ip || 'unknown';
}

function tokens(agent: Parameters<typeof mintToken>[0]) {
  return {
    accessToken: mintToken(agent, 'access'),
    refreshToken: mintToken(agent, 'refresh'),
    expiresInMs: ACCESS_TTL_MS,
    agent: { id: agent.id, name: agent.name, role: agent.role },
  };
}

/** Public, non-secret config for the SPA (the Chatwoot origin to talk to). */
router.get('/config', (_req: Request, res: Response) => {
  let chatwootOrigin = 'https://app.chatwoot.com';
  try {
    chatwootOrigin = new URL(env.chatwootBaseUrl).origin;
  } catch {
    // keep default
  }
  res.json({ chatwootOrigin });
});

router.post('/connect', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!connectLimiter.take(clientKey(req))) {
    res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    return;
  }
  const raw = (req.body as { chatwootAccessToken?: unknown } | undefined)?.chatwootAccessToken;
  if (typeof raw !== 'string' || !raw.trim()) {
    res.status(400).json({ error: 'chatwootAccessToken is required' });
    return;
  }
  const agent = await verifyAgentAccessToken(raw);
  if (!agent) {
    void audit({ action: 'auth.connect', actor: 'unknown', via: 'session', outcome: 'denied' });
    res.status(401).json({ error: 'That access token was not accepted by Chatwoot for this account.' });
    return;
  }
  void audit({
    action: 'auth.connect',
    actor: String(agent.id),
    actorName: agent.name,
    via: 'session',
    outcome: 'ok',
  });
  res.json(tokens(agent));
});

router.post('/refresh', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!refreshLimiter.take(clientKey(req))) {
    res.status(429).json({ error: 'Too many attempts' });
    return;
  }
  const raw = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  const session = verifyToken(typeof raw === 'string' ? raw : null, 'refresh');
  if (!session) {
    res.status(401).json({ error: 'Session expired', code: 'auth_required' });
    return;
  }
  let active;
  try {
    active = await isAgentActive(session.id);
  } catch (err) {
    logger.warn('Could not verify agent with Chatwoot on refresh', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(503).json({ error: 'Could not verify the agent with Chatwoot. Try again.' });
    return;
  }
  if (!active) {
    void audit({ action: 'auth.refresh', actor: String(session.id), via: 'session', outcome: 'denied', reason: 'agent not in account' });
    res.status(401).json({ error: 'Agent is no longer a member of this Chatwoot account', code: 'auth_required' });
    return;
  }
  res.json(
    tokens({
      id: session.id,
      name: active.name ?? session.name,
      email: active.email ?? session.email,
      role: active.role ?? session.role,
    }),
  );
});

export default router;

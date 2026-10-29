import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { constantTimeEqual } from '../security/crypto.js';
import { verifyToken, type AgentIdentity } from '../security/session.js';
import { getGeneration } from '../security/agentGeneration.js';

export interface RequestAgent extends AgentIdentity {
  /** 'session' = verified per-agent session; 'legacy-token' = old shared token (transition only). */
  via: 'session' | 'legacy-token';
  /** Audit actor id: the Chatwoot agent id, or 'legacy-shared-token'. */
  actor: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agent?: RequestAgent;
    }
  }
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m?.[1] ?? null;
}

/** Legacy shared token accepted right now? Needs the flag AND a future end date. */
export function legacyTokenActive(now = Date.now()): boolean {
  return (
    env.legacyDashboardTokenEnabled &&
    Boolean(env.dashboardAppToken) &&
    env.legacyDashboardTokenUntil != null &&
    now < env.legacyDashboardTokenUntil
  );
}

/**
 * Identifies the agent calling /app/api/* (security fix P2).
 *
 * 1. `Authorization: Bearer <access token>` minted by /app/auth/connect after
 *    the agent proved their identity with their own Chatwoot access token.
 *    Rejected when the agent signed out / was revoked since (generation).
 * 2. Transition only, while LEGACY_DASHBOARD_TOKEN_ENABLED=true and before
 *    LEGACY_DASHBOARD_TOKEN_UNTIL: the old shared DASHBOARD_APP_TOKEN in the
 *    `x-app-token` HEADER (never the query string), constant-time compare.
 *    READ-ONLY: routes refuse replies, cancellations and link confirmations.
 * Everything else → 401.
 */
export async function resolveAgent(req: Request): Promise<RequestAgent | null> {
  const session = verifyToken(bearer(req), 'access');
  if (session) {
    if (session.gen < (await getGeneration(session.id))) return null;
    return { ...session, via: 'session', actor: String(session.id) };
  }

  if (legacyTokenActive()) {
    const header = req.headers['x-app-token'];
    if (typeof header === 'string' && constantTimeEqual(header, env.dashboardAppToken)) {
      // Chatwoot's unsigned appContext agent id: recorded for the audit trail
      // only, never used for authorization.
      const claimed = Number(req.headers['x-chatwoot-agent-id']);
      return {
        id: Number.isInteger(claimed) && claimed > 0 ? claimed : 0,
        name: null,
        email: null,
        role: null,
        via: 'legacy-token',
        actor: 'legacy-shared-token',
      };
    }
  }
  return null;
}

export async function appAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const agent = await resolveAgent(req);
  if (!agent) {
    res.status(401).json({ error: 'Not signed in', code: 'auth_required' });
    return;
  }
  if (agent.via === 'legacy-token') {
    logger.warn('Customer 360 request using the legacy shared token (transition mode, read-only)');
  }
  req.agent = agent;
  next();
}

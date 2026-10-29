import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { constantTimeEqual } from '../security/crypto.js';
import { verifyToken, type AgentIdentity } from '../security/session.js';

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

/**
 * Identifies the agent calling /app/api/* (security fix P2).
 *
 * 1. `Authorization: Bearer <access token>` minted by /app/auth/connect after
 *    the agent proved their identity with their own Chatwoot access token.
 * 2. Transition only, when LEGACY_DASHBOARD_TOKEN_ENABLED=true: the old shared
 *    DASHBOARD_APP_TOKEN in the `x-app-token` HEADER (never the query string),
 *    compared in constant time. Audited as 'legacy-shared-token'.
 * Everything else → 401. There is no "open when unset" mode any more.
 */
export function resolveAgent(req: Request): RequestAgent | null {
  const session = verifyToken(bearer(req), 'access');
  if (session) {
    return { ...session, via: 'session', actor: String(session.id) };
  }

  if (env.legacyDashboardTokenEnabled && env.dashboardAppToken) {
    const header = req.headers['x-app-token'];
    if (typeof header === 'string' && constantTimeEqual(header, env.dashboardAppToken)) {
      // The agent id below is Chatwoot's unsigned appContext value: recorded
      // for the audit trail only, never used for authorization.
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

export function appAuth(req: Request, res: Response, next: NextFunction): void {
  const agent = resolveAgent(req);
  if (!agent) {
    res.status(401).json({ error: 'Not signed in', code: 'auth_required' });
    return;
  }
  if (agent.via === 'legacy-token') {
    logger.warn('Customer 360 request using the legacy shared token (transition mode)');
  }
  req.agent = agent;
  next();
}

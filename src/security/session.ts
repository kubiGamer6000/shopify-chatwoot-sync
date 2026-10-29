/**
 * Per-agent sessions for the Customer 360 tab (security fix P2).
 *
 * Stateless HMAC-signed tokens: `c360.<kind>.<base64url(json)>.<hex sig>`,
 * signed with APP_SESSION_SECRET.
 * - `access`  (12 h): sent as `Authorization: Bearer` on every API call.
 * - `refresh`: exchanged for a new access token; each refresh re-checks with
 *   the Chatwoot API that the agent still belongs to the account.
 * - Absolute cap: nothing outlives 30 days from the original connect
 *   (`authAt`), however often it is refreshed.
 * - Revocation: each token carries the agent's session generation (`gen`);
 *   sign-out bumps it (agentGeneration.ts), which kills every older token of
 *   that agent. Rotating APP_SESSION_SECRET revokes everyone.
 */
import { base64url, constantTimeEqual, fromBase64url, hmacHex, signingKey } from './crypto.js';

export type TokenKind = 'access' | 'refresh';

export const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AgentIdentity {
  id: number;
  name: string | null;
  email: string | null;
  role: string | null;
}

export interface SessionInfo extends AgentIdentity {
  exp: number;
  /** When the agent connected (proved identity with Chatwoot). */
  authAt: number;
  /** Session generation at mint time. */
  gen: number;
}

interface TokenPayload extends AgentIdentity {
  k: TokenKind;
  iat: number;
  exp: number;
  auth: number;
  gen: number;
}

function sign(kind: TokenKind, body: string): string {
  return hmacHex(signingKey(`session:${kind}`), `${kind}.${body}`);
}

export function mintToken(
  agent: AgentIdentity,
  kind: TokenKind,
  opts: { authAt?: number; gen?: number } = {},
  now = Date.now(),
): string {
  const authAt = opts.authAt ?? now;
  const cap = authAt + ABSOLUTE_TTL_MS;
  const payload: TokenPayload = {
    id: agent.id,
    name: agent.name,
    email: agent.email,
    role: agent.role,
    k: kind,
    iat: now,
    exp: kind === 'access' ? Math.min(now + ACCESS_TTL_MS, cap) : cap,
    auth: authAt,
    gen: opts.gen ?? 0,
  };
  const body = base64url(JSON.stringify(payload));
  return `c360.${kind}.${body}.${sign(kind, body)}`;
}

export function verifyToken(
  token: string | null | undefined,
  kind: TokenKind,
  now = Date.now(),
): SessionInfo | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'c360' || parts[1] !== kind) return null;
  const body = parts[2]!;
  const sig = parts[3]!;
  if (!constantTimeEqual(sig, sign(kind, body))) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(fromBase64url(body)) as TokenPayload;
  } catch {
    return null;
  }
  if (payload.k !== kind || typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (typeof payload.auth !== 'number' || now - payload.auth > ABSOLUTE_TTL_MS) return null;
  if (typeof payload.id !== 'number' || !Number.isInteger(payload.id) || payload.id <= 0) return null;
  return {
    id: payload.id,
    name: payload.name ?? null,
    email: payload.email ?? null,
    role: payload.role ?? null,
    exp: payload.exp,
    authAt: payload.auth,
    gen: typeof payload.gen === 'number' ? payload.gen : 0,
  };
}

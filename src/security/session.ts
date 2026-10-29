/**
 * Per-agent sessions for the Customer 360 tab (security fix P2).
 *
 * Stateless HMAC-signed tokens: `c360.<kind>.<base64url(json)>.<hex sig>`.
 * - `access`  (12 h): sent as `Authorization: Bearer` on every API call.
 * - `refresh` (30 d): exchanged for a new access token; each refresh re-checks
 *   with the Chatwoot API that the agent still belongs to the account, so
 *   removing an agent in Chatwoot cuts them off within 12 h.
 * Tokens never appear in URLs. Rotating APP_SESSION_SECRET revokes all of them.
 */
import { base64url, constantTimeEqual, fromBase64url, hmacHex, signingKey } from './crypto.js';

export type TokenKind = 'access' | 'refresh';

export const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AgentIdentity {
  id: number;
  name: string | null;
  email: string | null;
  role: string | null;
}

interface TokenPayload extends AgentIdentity {
  k: TokenKind;
  iat: number;
  exp: number;
}

function sign(kind: TokenKind, body: string): string {
  return hmacHex(signingKey(`session:${kind}`), `${kind}.${body}`);
}

export function mintToken(agent: AgentIdentity, kind: TokenKind, now = Date.now()): string {
  const payload: TokenPayload = {
    id: agent.id,
    name: agent.name,
    email: agent.email,
    role: agent.role,
    k: kind,
    iat: now,
    exp: now + (kind === 'access' ? ACCESS_TTL_MS : REFRESH_TTL_MS),
  };
  const body = base64url(JSON.stringify(payload));
  return `c360.${kind}.${body}.${sign(kind, body)}`;
}

export function verifyToken(
  token: string | null | undefined,
  kind: TokenKind,
  now = Date.now(),
): (AgentIdentity & { exp: number }) | null {
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
  if (typeof payload.id !== 'number' || !Number.isInteger(payload.id) || payload.id <= 0) return null;
  return {
    id: payload.id,
    name: payload.name ?? null,
    email: payload.email ?? null,
    role: payload.role ?? null,
    exp: payload.exp,
  };
}

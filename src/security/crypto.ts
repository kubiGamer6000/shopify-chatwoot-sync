import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Constant-time string comparison. Compares SHA-256 digests so inputs of
 * different lengths never short-circuit (and timingSafeEqual never throws).
 */
export function constantTimeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/**
 * Returns a purpose-bound signing key. Uses APP_SESSION_SECRET when set,
 * otherwise derives one from the (server-only) Chatwoot API token, so the app
 * keeps working before the owner sets a dedicated secret.
 */
export function signingKey(purpose: string): Buffer {
  const root = env.appSessionSecret || `derived:${env.chatwootApiToken}`;
  return createHmac('sha256', root).update(`scandi-c360:${purpose}`).digest();
}

export function hmacHex(key: Buffer | string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function fromBase64url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  return e.includes('@') ? e : null;
}

/** Short, non-reversible reference for logs (never log raw emails). */
export function emailRef(email: string | null | undefined): string | null {
  const e = normalizeEmail(email);
  if (!e) return null;
  return `email#${createHash('sha256').update(e).digest('hex').slice(0, 10)}`;
}

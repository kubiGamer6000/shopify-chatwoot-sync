import { createHash } from 'node:crypto';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

// Keys whose values must never reach the logs.
const SECRET_KEY = /(token|secret|password|authorization|api_?key|cookie|signature|sig)$/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Replaces an email with a short stable reference (same email -> same ref). */
export function maskEmail(email: string): string {
  const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `email#${digest.slice(0, 10)}`;
}

/**
 * Redacts log data: secret-looking keys are dropped and email addresses are
 * replaced with a hash reference, so customer PII and credentials never end up
 * in the platform logs.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.replace(EMAIL_RE, (m) => maskEmail(m));
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && v != null && v !== '' ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function format(level: LogLevel, message: string, data?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] ${level.toUpperCase()} ${redact(message) as string}`;
  return data ? `${base} ${JSON.stringify(redact(data))}` : base;
}

export const logger = {
  info(message: string, data?: Record<string, unknown>) {
    console.log(format('info', message, data));
  },
  warn(message: string, data?: Record<string, unknown>) {
    console.warn(format('warn', message, data));
  },
  error(message: string, data?: Record<string, unknown>) {
    console.error(format('error', message, data));
  },
  debug(message: string, data?: Record<string, unknown>) {
    if (process.env.DEBUG) {
      console.debug(format('debug', message, data));
    }
  },
};

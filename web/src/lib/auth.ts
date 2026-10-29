/**
 * Customer 360 sign-in.
 *
 * Each agent connects once with their own Chatwoot access token (Chatwoot →
 * Profile settings → Access Token). The server checks it with Chatwoot and
 * returns a short-lived session (12 h) plus a refresh token (30 days). The
 * Chatwoot token itself is never stored. Nothing secret is ever put in a URL.
 *
 * Transition only: if the iframe was loaded with the old `?token=` URL, that
 * token is read once, removed from the address bar and kept in memory; the
 * server accepts it only while LEGACY_DASHBOARD_TOKEN_ENABLED is on.
 */

const STORAGE_KEY = 'c360.session.v1';

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  agent: { id: number; name: string | null; role: string | null };
}

let memorySession: StoredSession | null = null;

function readStore(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return memorySession;
    const parsed = JSON.parse(raw) as StoredSession;
    return parsed?.accessToken && parsed?.refreshToken ? parsed : memorySession;
  } catch {
    return memorySession;
  }
}

function writeStore(session: StoredSession | null): void {
  memorySession = session;
  try {
    if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage blocked (e.g. third-party iframe restrictions): memory only
  }
}

export function getSession(): StoredSession | null {
  return readStore();
}

export function clearSession(): void {
  writeStore(null);
}

// --- Legacy shared token (transition) ---------------------------------------

const legacyToken: string | null = (() => {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token')?.trim() || null;
    if (token) {
      // Keep the secret out of the address bar, history and Referer headers.
      url.searchParams.delete('token');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    return token;
  } catch {
    return null;
  }
})();

export function getLegacyToken(): string | null {
  return legacyToken;
}

// --- Server calls -----------------------------------------------------------

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'omit',
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export async function connect(chatwootAccessToken: string): Promise<StoredSession> {
  const data = await post<StoredSession>('/app/auth/connect', { chatwootAccessToken });
  const session = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    agent: data.agent,
  };
  writeStore(session);
  return session;
}

let refreshing: Promise<StoredSession | null> | null = null;

/** Exchanges the refresh token for a new session; null when it's no longer valid. */
export function refreshSession(): Promise<StoredSession | null> {
  if (refreshing) return refreshing;
  const current = readStore();
  if (!current) return Promise.resolve(null);
  refreshing = post<StoredSession>('/app/auth/refresh', { refreshToken: current.refreshToken })
    .then((data) => {
      const session = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        agent: data.agent,
      };
      writeStore(session);
      return session;
    })
    .catch(() => {
      writeStore(null);
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export interface AuthConfig {
  chatwootOrigin: string;
}

let configPromise: Promise<AuthConfig> | null = null;

export function getAuthConfig(): Promise<AuthConfig> {
  if (!configPromise) {
    configPromise = fetch('/app/auth/config', { cache: 'no-store' })
      .then((r) => r.json() as Promise<AuthConfig>)
      .catch(() => ({ chatwootOrigin: 'https://app.chatwoot.com' }));
  }
  return configPromise;
}

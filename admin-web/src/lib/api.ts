import { auth } from './firebase';
import type {
  AiConfigOverrides,
  ConfigResponse,
  ConfigVersion,
  MeResponse,
  ReplayKind,
  ReplayResult,
  UserRecord,
  UserRole,
} from './types';

// Same-origin: the SPA is served by the Express server under /admin.
const API_BASE = '/admin/api';

async function authHeaders(): Promise<HeadersInit> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = await auth.currentUser?.getIdToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // ignore parse failure
    }
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export async function fetchMe(): Promise<MeResponse> {
  const res = await fetch(`${API_BASE}/me`, { headers: await authHeaders() });
  return handle<MeResponse>(res);
}

export async function fetchConfig(): Promise<ConfigResponse> {
  const res = await fetch(`${API_BASE}/config`, { headers: await authHeaders() });
  return handle<ConfigResponse>(res);
}

export async function saveConfig(
  overrides: AiConfigOverrides,
): Promise<{ ok: boolean; effective: ConfigResponse['effective'] }> {
  const res = await fetch(`${API_BASE}/config`, {
    method: 'PUT',
    headers: await authHeaders(),
    body: JSON.stringify(overrides),
  });
  return handle<{ ok: boolean; effective: ConfigResponse['effective'] }>(res);
}

export async function fetchConfigHistory(): Promise<{ history: ConfigVersion[] }> {
  const res = await fetch(`${API_BASE}/config/history`, {
    headers: await authHeaders(),
  });
  return handle<{ history: ConfigVersion[] }>(res);
}

export async function fetchUsers(): Promise<{ users: UserRecord[] }> {
  const res = await fetch(`${API_BASE}/users`, { headers: await authHeaders() });
  return handle<{ users: UserRecord[] }>(res);
}

export async function setUserRole(
  uid: string,
  role: UserRole,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/users/${encodeURIComponent(uid)}/role`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ role }),
  });
  return handle<{ ok: boolean }>(res);
}

export async function runReplay(params: {
  conversationId: number;
  kind: ReplayKind;
  overrides?: AiConfigOverrides;
  escalation?: boolean;
}): Promise<ReplayResult> {
  const res = await fetch(`${API_BASE}/replay`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params),
  });
  return handle<ReplayResult>(res);
}

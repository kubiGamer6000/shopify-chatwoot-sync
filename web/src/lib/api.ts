import type {
  CustomerProfile,
  CustomerSummary,
  GeneratedDraft,
  DraftResponse,
} from './types';
import { getAppToken } from './auth';

// Same-origin: the SPA is served from the same Express server under /app.
const API_BASE = '/app/api';

function headers(): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getAppToken();
  if (token) h['x-app-token'] = token;
  return h;
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
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function fetchCustomerProfile(params: {
  shopifyCustomerId?: string | null;
  email?: string | null;
  contactId?: number | null;
  signal?: AbortSignal;
}): Promise<CustomerProfile> {
  const query = new URLSearchParams();
  if (params.shopifyCustomerId) {
    query.set('shopifyCustomerId', params.shopifyCustomerId);
  }
  if (params.email) query.set('email', params.email);
  if (params.contactId) query.set('contactId', String(params.contactId));

  const res = await fetch(`${API_BASE}/customer?${query.toString()}`, {
    headers: headers(),
    signal: params.signal,
  });
  return handle<CustomerProfile>(res);
}

export async function refreshSummary(params: {
  contactId: number;
  conversationId?: number | null;
  email?: string | null;
  shopifyCustomerId?: string | null;
  customerName?: string | null;
}): Promise<{ summary: CustomerSummary | null }> {
  const res = await fetch(`${API_BASE}/summary/refresh`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(params),
  });
  return handle<{ summary: CustomerSummary | null }>(res);
}

export async function getDraft(conversationId: number): Promise<DraftResponse> {
  const res = await fetch(
    `${API_BASE}/draft?conversationId=${encodeURIComponent(conversationId)}`,
    { headers: headers() },
  );
  return handle<DraftResponse>(res);
}

export async function generateDraft(params: {
  conversationId: number;
  contactId: number;
  email?: string | null;
  instruction?: string | null;
  previousResponse?: string | null;
  correction?: string | null;
}): Promise<GeneratedDraft> {
  const res = await fetch(`${API_BASE}/draft/generate`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(params),
  });
  return handle<GeneratedDraft>(res);
}

export async function sendReply(
  conversationId: number,
  message: string,
  resolve = true,
): Promise<{ ok: boolean; resolved: boolean }> {
  const res = await fetch(`${API_BASE}/draft/send`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ conversationId, message, resolve }),
  });
  return handle<{ ok: boolean; resolved: boolean }>(res);
}

export async function cancelSubscription(
  subscriptionId: string,
  conversationId?: number | null,
): Promise<{ ok: boolean; labelled?: boolean }> {
  const res = await fetch(
    `${API_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(conversationId ? { conversationId } : {}),
    },
  );
  return handle<{ ok: boolean; labelled?: boolean }>(res);
}

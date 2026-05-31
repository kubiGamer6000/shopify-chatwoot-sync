import type { CustomerProfile, CustomerSummary } from './types';
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

export async function cancelSubscription(
  subscriptionId: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    `${API_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    {
      method: 'POST',
      headers: headers(),
    },
  );
  return handle<{ ok: boolean }>(res);
}

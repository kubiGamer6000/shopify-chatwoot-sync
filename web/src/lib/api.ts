import type {
  CustomerProfile,
  CustomerSummary,
  GeneratedDraft,
  DraftResponse,
} from './types';
import { getLegacyToken, getSession, refreshSession } from './auth';

// Same-origin: the SPA is served from the same Express server under /app.
const API_BASE = '/app/api';

/** Thrown when the agent must (re)connect. */
export class AuthRequiredError extends Error {
  constructor() {
    super('Please connect Customer 360 with your Chatwoot access token.');
  }
}

let claimedAgentId: number | null = null;

/** Chatwoot's (unsigned) current agent id: sent for the legacy audit trail only. */
export function setClaimedAgentId(id: number | null): void {
  claimedAgentId = id;
}

function headers(conversationId: number | null | undefined): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const session = getSession();
  if (session) {
    h['Authorization'] = `Bearer ${session.accessToken}`;
  } else {
    const legacy = getLegacyToken();
    if (legacy) h['x-app-token'] = legacy;
    if (claimedAgentId) h['x-chatwoot-agent-id'] = String(claimedAgentId);
  }
  if (conversationId) h['X-Chatwoot-Conversation'] = String(conversationId);
  return h;
}

async function request<T>(
  path: string,
  opts: {
    method?: 'GET' | 'POST';
    conversationId?: number | null;
    body?: unknown;
    signal?: AbortSignal;
  } = {},
  retried = false,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: headers(opts.conversationId),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
    credentials: 'omit',
    cache: 'no-store',
  });

  if (res.status === 401) {
    if (!retried && getSession()) {
      const refreshed = await refreshSession();
      if (refreshed.session) return request<T>(path, opts, true);
      if (refreshed.transient) {
        throw new Error('Could not renew your session right now. Try again in a moment.');
      }
    }
    throw new AuthRequiredError();
  }

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
  conversationId: number;
  signal?: AbortSignal;
}): Promise<CustomerProfile> {
  return request<CustomerProfile>('/customer', {
    conversationId: params.conversationId,
    signal: params.signal,
  });
}

export async function confirmLink(
  conversationId: number,
  email: string,
): Promise<{ ok: boolean }> {
  return request('/link/confirm', { method: 'POST', conversationId, body: { email } });
}

export async function refreshSummary(params: {
  contactId?: number | null;
  conversationId?: number | null;
  email?: string | null;
  shopifyCustomerId?: string | null;
  customerName?: string | null;
}): Promise<{ summary: CustomerSummary | null }> {
  // The server derives the contact/customer from the conversation.
  return request('/summary/refresh', {
    method: 'POST',
    conversationId: params.conversationId,
    body: {},
  });
}

export async function getDraft(conversationId: number): Promise<DraftResponse> {
  return request<DraftResponse>('/draft', { conversationId });
}

export async function generateDraft(params: {
  conversationId: number;
  contactId?: number | null;
  email?: string | null;
  instruction?: string | null;
  previousResponse?: string | null;
  correction?: string | null;
}): Promise<GeneratedDraft> {
  return request<GeneratedDraft>('/draft/generate', {
    method: 'POST',
    conversationId: params.conversationId,
    body: {
      instruction: params.instruction ?? null,
      previousResponse: params.previousResponse ?? null,
      correction: params.correction ?? null,
    },
  });
}

export async function sendReply(
  conversationId: number,
  message: string,
  resolve = true,
): Promise<{ ok: boolean; resolved: boolean }> {
  return request('/draft/send', {
    method: 'POST',
    conversationId,
    body: { message, resolve },
  });
}

export async function cancelSubscription(params: {
  subscriptionId: string;
  conversationId: number | null;
  reason: string;
  notifyCustomer: boolean;
}): Promise<{ ok: boolean; labelled?: boolean }> {
  return request(`/subscriptions/${encodeURIComponent(params.subscriptionId)}/cancel`, {
    method: 'POST',
    conversationId: params.conversationId,
    body: { reason: params.reason, notifyCustomer: params.notifyCustomer },
  });
}

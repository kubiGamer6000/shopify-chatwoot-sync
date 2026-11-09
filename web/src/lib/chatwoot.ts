import { useEffect, useState } from 'react';
import type { ChatwootAppContext, ResolvedContext } from './types';
import { getAuthConfig } from './auth';

const FETCH_INFO_EVENT = 'chatwoot-dashboard-app:fetch-info';

function parseEventData(data: unknown): ChatwootAppContext | null {
  let payload: unknown = data;
  if (typeof data === 'string') {
    try {
      payload = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (obj.event !== 'appContext') return null;
  return (obj.data as ChatwootAppContext) ?? null;
}

function resolveContext(ctx: ChatwootAppContext): ResolvedContext {
  const sender = ctx.conversation?.meta?.sender;
  const contact = ctx.contact;
  // Display-only values. The server derives the customer from the
  // conversation id itself (it never trusts emails or ids sent from here).
  return {
    conversationId: ctx.conversation?.id ?? null,
    contactId: contact?.id ?? sender?.id ?? null,
    shopifyCustomerId: null,
    email: contact?.email || sender?.email || null,
    contactName: contact?.name || sender?.name || null,
    currentAgentId: ctx.currentAgent?.id ?? null,
    currentAgentName: ctx.currentAgent?.name ?? null,
  };
}

let chatwootOrigin: string | null = null;

export function requestContext(): void {
  if (!chatwootOrigin) return;
  try {
    // Exact target origin (never '*').
    window.parent.postMessage(FETCH_INFO_EVENT, chatwootOrigin);
  } catch {
    // ignore — not embedded in a parent frame
  }
}

/**
 * Subscribes to Chatwoot's appContext postMessage events.
 *
 * Chatwoot keeps this iframe alive across conversation switches and simply
 * pushes a new appContext, so the returned context updates reactively.
 */
export function useChatwootContext(): {
  context: ResolvedContext | null;
  agentRole: string | null;
} {
  const [context, setContext] = useState<ResolvedContext | null>(null);
  const [agentRole, setAgentRole] = useState<string | null>(null);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Only trust messages from the parent frame AND the Chatwoot origin.
      if (event.source !== window.parent) return;
      if (!chatwootOrigin || event.origin !== chatwootOrigin) return;

      const appContext = parseEventData(event.data);
      if (!appContext) return;

      setAgentRole(appContext.currentAgent?.role ?? null);
      setContext(resolveContext(appContext));
    };

    window.addEventListener('message', handleMessage);
    // Ask Chatwoot for the current context as soon as we know its origin.
    void getAuthConfig().then((cfg) => {
      chatwootOrigin = cfg.chatwootOrigin;
      requestContext();
    });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return { context, agentRole };
}

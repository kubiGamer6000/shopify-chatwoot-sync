import { useEffect, useState } from 'react';
import type { ChatwootAppContext, ResolvedContext } from './types';

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

  const customAttrs =
    (contact?.custom_attributes as Record<string, unknown> | undefined) ??
    (sender?.custom_attributes as Record<string, unknown> | undefined) ??
    {};

  const rawShopifyId = customAttrs['shopify_customer_id'];
  const shopifyCustomerId =
    rawShopifyId !== undefined && rawShopifyId !== null && rawShopifyId !== ''
      ? String(rawShopifyId)
      : null;

  const email = contact?.email || sender?.email || null;
  const contactName = contact?.name || sender?.name || null;
  const conversationId = ctx.conversation?.id ?? null;

  return { conversationId, shopifyCustomerId, email, contactName };
}

export function requestContext(): void {
  try {
    window.parent.postMessage(FETCH_INFO_EVENT, '*');
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
      // Only trust messages from the parent (Chatwoot) frame.
      if (event.source !== window.parent) return;

      const appContext = parseEventData(event.data);
      if (!appContext) return;

      setAgentRole(appContext.currentAgent?.role ?? null);
      setContext(resolveContext(appContext));
    };

    window.addEventListener('message', handleMessage);
    // Ask Chatwoot for the current context as soon as we mount.
    requestContext();

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return { context, agentRole };
}

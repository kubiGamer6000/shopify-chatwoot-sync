/**
 * Server-side conversation scope (security fix P3).
 *
 * Every Customer 360 request names only a conversation id. The contact (and so
 * the customer, the subscriptions, the summary) is derived HERE from the
 * Chatwoot API, never from email / customer id / contact id values sent by the
 * browser. The Chatwoot client is bound to CHATWOOT_ACCOUNT_ID, so a
 * conversation from another account simply doesn't resolve.
 */
import { AxiosError } from 'axios';
import { env } from '../config/env.js';
import { getConversationDetails } from './chatwootConversation.js';
import { getContact, chatwootClient } from './chatwoot.js';
import { logger } from '../utils/logger.js';
import { fetchCustomer, fetchCustomerOrders, searchCustomerByEmail, searchOrderByName } from './shopify.js';
import type { LinkDeps } from './contactLink.js';
import type { SuggestionDeps } from './linkSuggestions.js';
import type { ChatwootConversation } from '../types/chatwoot.js';
import type { ChatwootContact } from '../types/index.js';

export const shopifyLinkDeps: LinkDeps & SuggestionDeps = {
  searchCustomerByEmail,
  fetchCustomer,
  fetchCustomerOrders,
  searchOrderByName,
};

export class ScopeError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 502,
    message: string,
  ) {
    super(message);
  }
}

export interface ConversationScope {
  conversationId: number;
  conversation: ChatwootConversation;
  contact: ChatwootContact;
}

export function parseConversationId(raw: unknown): number | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== 'string' && typeof s !== 'number') return null;
  const str = String(s).trim();
  if (!/^\d{1,12}$/.test(str)) return null;
  const n = Number(str);
  return n > 0 ? n : null;
}

// --- Per-inbox authorization -----------------------------------------------------

const INBOX_MEMBERS_TTL_MS = 5 * 60 * 1000;
const inboxMembersCache = new Map<number, { at: number; ids: Set<number> }>();

export type FetchInboxMembers = (inboxId: number) => Promise<number[]>;

const defaultFetchInboxMembers: FetchInboxMembers = async (inboxId) => {
  const res = await chatwootClient.get<{ payload?: { id: number }[] } | { id: number }[]>(
    `/inbox_members/${inboxId}`,
  );
  const list = Array.isArray(res.data) ? res.data : (res.data.payload ?? []);
  return list.map((a) => a.id);
};

/** Test helper. */
export function resetInboxMembersCache(): void {
  inboxMembersCache.clear();
}

/**
 * An agent may only open conversations of inboxes they are a member of
 * (Chatwoot administrators see all inboxes, as in Chatwoot itself). Fails
 * closed if the membership can't be read.
 */
export async function agentCanAccessInbox(
  agent: { id: number; role: string | null },
  inboxId: number | null | undefined,
  fetchMembers: FetchInboxMembers = defaultFetchInboxMembers,
): Promise<boolean> {
  if (agent.role === 'administrator') return true;
  if (!inboxId) return false;
  const now = Date.now();
  let entry = inboxMembersCache.get(inboxId);
  if (!entry || now - entry.at > INBOX_MEMBERS_TTL_MS) {
    try {
      entry = { at: now, ids: new Set(await fetchMembers(inboxId)) };
      inboxMembersCache.set(inboxId, entry);
    } catch (err) {
      logger.warn('Could not read inbox members', {
        inboxId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
  return entry.ids.has(agent.id);
}

export async function loadConversationScope(
  conversationId: number,
  agent?: { id: number; role: string | null; via: 'session' | 'legacy-token' },
): Promise<ConversationScope> {
  let conversation: ChatwootConversation;
  try {
    conversation = await getConversationDetails(conversationId);
  } catch (err) {
    if (err instanceof AxiosError && (err.response?.status === 404 || err.response?.status === 403)) {
      throw new ScopeError(404, 'Conversation not found');
    }
    throw new ScopeError(502, 'Could not load the conversation from Chatwoot');
  }
  if (
    conversation.account_id != null &&
    String(conversation.account_id) !== String(env.chatwootAccountId)
  ) {
    throw new ScopeError(403, 'Conversation belongs to another account');
  }
  if (agent?.via === 'session' && !(await agentCanAccessInbox(agent, conversation.inbox_id))) {
    throw new ScopeError(403, 'You are not a member of this conversation’s inbox');
  }
  const contactId = conversation.meta?.sender?.id;
  if (!contactId) throw new ScopeError(404, 'Conversation has no contact');

  let contact: ChatwootContact | null;
  try {
    contact = await getContact(contactId);
  } catch {
    throw new ScopeError(502, 'Could not load the contact from Chatwoot');
  }
  if (!contact) throw new ScopeError(404, 'Contact not found');
  return { conversationId, conversation, contact };
}

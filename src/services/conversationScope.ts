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
import { getContact } from './chatwoot.js';
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

export async function loadConversationScope(conversationId: number): Promise<ConversationScope> {
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

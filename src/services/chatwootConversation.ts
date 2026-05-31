import { chatwootClient } from './chatwoot.js';
import { logger } from '../utils/logger.js';
import type {
  ChatwootMessagesResponse,
  ChatwootConversation,
  ChatwootContactConversationsResponse,
  ChatwootMessage,
} from '../types/chatwoot.js';

export async function getConversationMessages(
  conversationId: number,
): Promise<ChatwootMessagesResponse> {
  const res = await chatwootClient.get<ChatwootMessagesResponse>(
    `/conversations/${conversationId}/messages`,
  );
  return res.data;
}

/**
 * Returns the latest inbound (customer-authored) message in a conversation, or
 * null if there are none. Skips private notes and agent/bot messages.
 */
export async function getLastCustomerMessage(
  conversationId: number,
): Promise<{ content: string; createdAt: string } | null> {
  const res = await getConversationMessages(conversationId);
  const incoming = res.payload
    .filter(
      (m) =>
        m.message_type === 0 &&
        !m.private &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0,
    )
    .sort((a, b) => b.created_at - a.created_at);

  const latest = incoming[0];
  if (!latest || !latest.content) return null;
  return {
    content: latest.content,
    createdAt: new Date(latest.created_at * 1000).toISOString(),
  };
}

export async function getConversationDetails(
  conversationId: number,
): Promise<ChatwootConversation> {
  const res = await chatwootClient.get<ChatwootConversation>(
    `/conversations/${conversationId}`,
  );
  return res.data;
}

export async function getContactConversations(
  contactId: number,
): Promise<ChatwootConversation[]> {
  const res = await chatwootClient.get<ChatwootContactConversationsResponse>(
    `/contacts/${contactId}/conversations`,
  );
  return res.data.payload;
}

export async function postPrivateNote(
  conversationId: number,
  content: string,
): Promise<ChatwootMessage> {
  const res = await chatwootClient.post<ChatwootMessage>(
    `/conversations/${conversationId}/messages`,
    {
      content,
      message_type: 'outgoing',
      private: true,
      content_type: 'text',
    },
  );
  logger.info('Posted AI draft as private note', {
    conversationId,
    messageId: res.data.id,
  });
  return res.data;
}

/**
 * Sends a public outgoing reply to the customer in a conversation (visible to
 * the customer, unlike a private note).
 */
export async function sendReply(
  conversationId: number,
  content: string,
): Promise<ChatwootMessage> {
  const res = await chatwootClient.post<ChatwootMessage>(
    `/conversations/${conversationId}/messages`,
    {
      content,
      message_type: 'outgoing',
      private: false,
      content_type: 'text',
    },
  );
  logger.info('Sent reply to customer', {
    conversationId,
    messageId: res.data.id,
  });
  return res.data;
}

/**
 * Marks a conversation as resolved via the toggle_status endpoint
 * (`POST /conversations/{id}/toggle_status` with `{ status: 'resolved' }`),
 * which is the standard accounts-API way to explicitly set conversation state.
 */
export async function resolveConversation(
  conversationId: number,
): Promise<void> {
  await chatwootClient.post(
    `/conversations/${conversationId}/toggle_status`,
    { status: 'resolved' },
  );
  logger.info('Resolved conversation', { conversationId });
}

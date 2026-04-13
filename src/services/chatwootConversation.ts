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
  logger.info('Posted private note', {
    conversationId,
    messageId: res.data.id,
  });
  return res.data;
}

export async function sendOutgoingMessage(
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
  logger.info('Sent outgoing message', {
    conversationId,
    messageId: res.data.id,
  });
  return res.data;
}

export async function toggleConversationStatus(
  conversationId: number,
  status: 'open' | 'resolved' | 'pending' | 'snoozed',
): Promise<void> {
  await chatwootClient.post(
    `/conversations/${conversationId}/toggle_status`,
    { status },
  );
  logger.info('Toggled conversation status', { conversationId, status });
}

export async function applyLabels(
  conversationId: number,
  labels: string[],
): Promise<void> {
  const current = await chatwootClient.get<{ payload: string[] }>(
    `/conversations/${conversationId}/labels`,
  );
  const existing = current.data.payload ?? [];
  const merged = [...new Set([...existing, ...labels])];
  await chatwootClient.post(
    `/conversations/${conversationId}/labels`,
    { labels: merged },
  );
  logger.info('Applied labels', { conversationId, labels: merged });
}

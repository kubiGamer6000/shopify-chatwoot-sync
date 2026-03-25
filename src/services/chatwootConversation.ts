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
  logger.info('Posted AI draft as private note', {
    conversationId,
    messageId: res.data.id,
  });
  return res.data;
}

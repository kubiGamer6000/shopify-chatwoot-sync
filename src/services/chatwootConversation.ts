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
 * Sets a conversation's status via the toggle_status endpoint
 * (`POST /conversations/{id}/toggle_status` with `{ status }`), the standard
 * accounts-API way to explicitly move a conversation between states.
 */
export async function setConversationStatus(
  conversationId: number,
  status: 'open' | 'resolved' | 'pending',
): Promise<void> {
  await chatwootClient.post(
    `/conversations/${conversationId}/toggle_status`,
    { status },
  );
  logger.info('Set conversation status', { conversationId, status });
}

/**
 * Marks a conversation as resolved.
 */
export async function resolveConversation(
  conversationId: number,
): Promise<void> {
  await setConversationStatus(conversationId, 'resolved');
}

/**
 * Lists conversations for the account filtered by status, one page at a time
 * (`GET /conversations?status=&assignee_type=&page=`). Chatwoot returns ~25 per
 * page under `data.payload`. Returns the page's conversations (empty when past
 * the last page).
 */
export async function listConversations(params: {
  status?: 'open' | 'pending' | 'resolved' | 'snoozed' | 'all';
  page?: number;
  assigneeType?: 'me' | 'unassigned' | 'assigned' | 'all';
} = {}): Promise<ChatwootConversation[]> {
  const { status = 'open', page = 1, assigneeType = 'all' } = params;
  const res = await chatwootClient.get<{
    data: { meta: Record<string, number>; payload: ChatwootConversation[] };
  }>(
    `/conversations?status=${status}&assignee_type=${assigneeType}&page=${page}`,
  );
  return res.data.data?.payload ?? [];
}

/**
 * Returns the labels currently applied to a conversation
 * (`GET /conversations/{id}/labels`). Returns an empty array on failure.
 */
export async function getConversationLabels(
  conversationId: number,
): Promise<string[]> {
  try {
    const res = await chatwootClient.get<{ payload: string[] }>(
      `/conversations/${conversationId}/labels`,
    );
    return res.data.payload ?? [];
  } catch (err) {
    logger.warn('Failed to read conversation labels', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Adds labels to a conversation without removing existing ones. Chatwoot's
 * `POST /conversations/{id}/labels` REPLACES the full label set, so we read the
 * current labels, merge in the new ones (deduped), and write them all back.
 * Returns the resulting label set. Best-effort: logs and returns the prior set
 * on failure.
 */
export async function addConversationLabels(
  conversationId: number,
  labelsToAdd: string[],
): Promise<string[]> {
  const current = await getConversationLabels(conversationId);
  const merged = Array.from(new Set([...current, ...labelsToAdd]));

  // Nothing new to add — skip the write.
  if (merged.length === current.length) return current;

  try {
    await chatwootClient.post(`/conversations/${conversationId}/labels`, {
      labels: merged,
    });
    logger.info('Added conversation labels', {
      conversationId,
      added: labelsToAdd,
    });
    return merged;
  } catch (err) {
    logger.warn('Failed to add conversation labels', {
      conversationId,
      labelsToAdd,
      error: err instanceof Error ? err.message : String(err),
    });
    return current;
  }
}

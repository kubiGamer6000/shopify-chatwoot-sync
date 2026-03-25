// --- Chatwoot Webhook Types ---
// Webhook payloads use STRING message_type and ISO date strings.

export interface ChatwootWebhookSender {
  id: number;
  name: string;
  email?: string;
  type: 'contact' | 'agent' | 'agent_bot';
}

export interface ChatwootWebhookConversation {
  id: number;
  inbox_id: number;
  status: string;
  custom_attributes?: Record<string, unknown>;
  additional_attributes?: Record<string, unknown>;
}

export interface ChatwootWebhookAccount {
  id: number;
  name: string;
}

export interface ChatwootWebhookInbox {
  id: number;
  name: string;
}

export interface ChatwootWebhookPayload {
  event: string;
  id: number;
  content: string;
  content_type: string;
  message_type: 'incoming' | 'outgoing' | 'template';
  created_at: string;
  private: boolean;
  sender: ChatwootWebhookSender;
  conversation: ChatwootWebhookConversation;
  account: ChatwootWebhookAccount;
  inbox: ChatwootWebhookInbox;
  attachments: unknown[];
}

// --- Chatwoot REST API Types ---
// REST responses use INTEGER message_type and Unix timestamps.

export interface ChatwootMessage {
  id: number;
  content: string | null;
  account_id: number;
  inbox_id: number;
  conversation_id: number;
  message_type: 0 | 1 | 2; // 0 = incoming, 1 = outgoing, 2 = template
  created_at: number;
  updated_at: number;
  private: boolean;
  status: string;
  source_id: string | null;
  content_type: string;
  content_attributes: Record<string, unknown>;
  sender_type: 'contact' | 'agent' | 'agent_bot';
  sender_id: number;
  sender?: {
    id: number;
    name?: string;
    email?: string;
    type?: string;
  };
}

export interface ChatwootContactMeta {
  id: number;
  name?: string;
  email?: string;
  phone_number?: string;
  identifier?: string;
  thumbnail?: string;
  availability_status?: string;
  blocked?: boolean;
  additional_attributes?: Record<string, unknown>;
  custom_attributes?: Record<string, unknown>;
  last_activity_at?: number;
  created_at?: number;
}

export interface ChatwootAssigneeMeta {
  id: number;
  name?: string;
  email?: string;
  available_name?: string;
  role?: string;
  thumbnail?: string;
}

export interface ChatwootConversationMeta {
  sender: ChatwootContactMeta;
  assignee?: ChatwootAssigneeMeta;
  channel?: string;
  hmac_verified?: boolean;
}

export interface ChatwootConversation {
  id: number;
  account_id: number;
  uuid: string;
  inbox_id: number;
  status: 'open' | 'resolved' | 'pending';
  labels: string[];
  created_at: number;
  updated_at: number;
  last_activity_at: number;
  custom_attributes: Record<string, unknown>;
  additional_attributes: Record<string, unknown>;
  meta: ChatwootConversationMeta;
  messages?: ChatwootMessage[];
}

export interface ChatwootMessagesResponse {
  meta: {
    labels?: string[];
    contact?: { payload: ChatwootContactMeta[] };
    assignee?: ChatwootAssigneeMeta;
    agent_last_seen_at?: string;
    assignee_last_seen_at?: string;
  };
  payload: ChatwootMessage[];
}

export interface ChatwootContactConversationsResponse {
  payload: ChatwootConversation[];
}

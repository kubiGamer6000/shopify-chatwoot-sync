import axios from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type {
  ChatwootContact,
  ChatwootContactPayload,
  ChatwootSearchResponse,
} from '../types/index.js';

const chatwootClient = axios.create({
  baseURL: `${env.chatwootBaseUrl}/api/v1/accounts/${env.chatwootAccountId}`,
  headers: {
    'Content-Type': 'application/json',
    api_access_token: env.chatwootApiToken,
  },
});

export async function searchContactByIdentifier(
  identifier: string,
): Promise<ChatwootContact | null> {
  const res = await chatwootClient.get<ChatwootSearchResponse>('/contacts/search', {
    params: { q: identifier },
  });

  const exact = res.data.payload.find((c) => c.identifier === identifier);
  return exact ?? null;
}

export async function createContact(
  payload: ChatwootContactPayload,
): Promise<ChatwootContact> {
  const res = await chatwootClient.post<{ payload: { contact: ChatwootContact } }>(
    '/contacts',
    payload,
  );
  return res.data.payload.contact;
}

export async function updateContact(
  contactId: number,
  payload: ChatwootContactPayload,
): Promise<void> {
  await chatwootClient.put(`/contacts/${contactId}`, payload);
}

export async function upsertContact(
  identifier: string,
  payload: ChatwootContactPayload,
): Promise<{ action: 'created' | 'updated'; contactId: number }> {
  const existing = await searchContactByIdentifier(identifier);

  if (existing) {
    logger.info(`Updating Chatwoot contact`, { contactId: existing.id, identifier });
    await updateContact(existing.id, payload);
    return { action: 'updated', contactId: existing.id };
  }

  logger.info(`Creating new Chatwoot contact`, { identifier });
  const created = await createContact(payload);
  return { action: 'created', contactId: created.id };
}

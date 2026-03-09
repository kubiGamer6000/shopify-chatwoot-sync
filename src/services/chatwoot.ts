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

async function searchContacts(query: string): Promise<ChatwootContact[]> {
  const res = await chatwootClient.get<ChatwootSearchResponse>('/contacts/search', {
    params: { q: query },
  });
  return res.data.payload;
}

async function findByIdentifier(identifier: string): Promise<ChatwootContact | null> {
  const results = await searchContacts(identifier);
  return results.find((c) => c.identifier === identifier) ?? null;
}

async function findByEmail(email: string): Promise<ChatwootContact | null> {
  const results = await searchContacts(email);
  return results.find((c) => c.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

export async function createContact(
  payload: ChatwootContactPayload,
): Promise<ChatwootContact> {
  const body: Record<string, unknown> = { ...payload };
  if (env.chatwootInboxId) {
    body.inbox_id = Number(env.chatwootInboxId);
  }
  const res = await chatwootClient.post<{ payload: { contact: ChatwootContact } }>(
    '/contacts',
    body,
  );
  return res.data.payload.contact;
}

export async function updateContact(
  contactId: number,
  payload: ChatwootContactPayload,
): Promise<void> {
  await chatwootClient.put(`/contacts/${contactId}`, payload);
}

/**
 * Smart upsert: finds existing contact by identifier OR email,
 * updates them, or creates a new one if no match is found.
 *
 * When an existing contact is matched by email (pre-existing contact
 * without Shopify data), we set their identifier to the Shopify
 * customer ID so future lookups are faster.
 */
export async function upsertContact(
  identifier: string,
  payload: ChatwootContactPayload,
): Promise<{ action: 'created' | 'updated' | 'skipped'; contactId?: number }> {
  // 1) Fast path: lookup by Shopify customer ID (identifier)
  let existing = await findByIdentifier(identifier);

  // 2) Fallback: lookup by email (catches pre-existing contacts)
  if (!existing && payload.email) {
    existing = await findByEmail(payload.email);
    if (existing) {
      logger.info('Matched existing Chatwoot contact by email', {
        contactId: existing.id,
        email: payload.email,
        identifier,
      });
    }
  }

  if (existing) {
    logger.info('Updating Chatwoot contact', { contactId: existing.id, identifier });
    await updateContact(existing.id, payload);
    return { action: 'updated', contactId: existing.id };
  }

  // 3) Create new contact (requires CHATWOOT_INBOX_ID)
  if (!env.chatwootInboxId) {
    logger.debug('Contact not found and CHATWOOT_INBOX_ID not set, skipping create', {
      identifier,
      email: payload.email,
    });
    return { action: 'skipped' };
  }

  logger.info('Creating new Chatwoot contact', { identifier, email: payload.email });
  const created = await createContact(payload);
  return { action: 'created', contactId: created.id };
}

/**
 * Checks whether a contact already has Shopify data populated.
 */
export function contactHasShopifyData(contact: ChatwootContact): boolean {
  const attrs = contact.custom_attributes;
  if (!attrs) return false;
  return Boolean(attrs['shopify_customer_id']);
}

import axios, { AxiosError } from 'axios';
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

function extractErrorDetail(err: unknown): string {
  if (err instanceof AxiosError && err.response) {
    const data = err.response.data as Record<string, unknown> | undefined;
    return `${err.response.status} ${JSON.stringify(data)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

interface FilterPayloadItem {
  attribute_key: string;
  filter_operator: string;
  values: string[];
  query_operator?: string;
}

interface FilterResponse {
  payload: ChatwootContact[];
  meta?: { count: number; current_page: number };
}

/**
 * Uses the /contacts/filter endpoint for exact matching.
 * Much more reliable than /contacts/search which is fuzzy.
 */
async function filterContacts(filters: FilterPayloadItem[]): Promise<ChatwootContact[]> {
  const res = await chatwootClient.post<FilterResponse>('/contacts/filter', {
    payload: filters,
  });
  return res.data.payload;
}

async function findByIdentifier(identifier: string): Promise<ChatwootContact | null> {
  const results = await filterContacts([
    { attribute_key: 'identifier', filter_operator: 'equal_to', values: [identifier] },
  ]);
  return results[0] ?? null;
}

async function findByEmail(email: string): Promise<ChatwootContact | null> {
  const results = await filterContacts([
    { attribute_key: 'email', filter_operator: 'equal_to', values: [email] },
  ]);
  return results[0] ?? null;
}

async function tryCreate(
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
 * Smart upsert with exact-match filters and 422 retry.
 *
 * 1. Filter by identifier (Shopify ID) — fast path for linked contacts.
 * 2. Filter by email — catches pre-existing contacts.
 * 3. Create new contact if no match.
 * 4. If create returns 422 (duplicate), retry the email filter and update.
 */
export async function upsertContact(
  identifier: string,
  payload: ChatwootContactPayload,
): Promise<{ action: 'created' | 'updated' | 'skipped'; contactId?: number }> {
  let existing = await findByIdentifier(identifier);

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

  if (!env.chatwootInboxId) {
    logger.debug('Contact not found and CHATWOOT_INBOX_ID not set, skipping create', {
      identifier,
      email: payload.email,
    });
    return { action: 'skipped' };
  }

  // Attempt to create — handle 422 (duplicate) gracefully
  try {
    logger.info('Creating new Chatwoot contact', { identifier, email: payload.email });
    const created = await tryCreate(payload);
    return { action: 'created', contactId: created.id };
  } catch (err) {
    if (err instanceof AxiosError && err.response?.status === 422 && payload.email) {
      logger.warn('Create returned 422 (likely duplicate), retrying email lookup', {
        identifier,
        email: payload.email,
        detail: extractErrorDetail(err),
      });

      const retryMatch = await findByEmail(payload.email);
      if (retryMatch) {
        await updateContact(retryMatch.id, payload);
        return { action: 'updated', contactId: retryMatch.id };
      }

      // 422 but email filter still finds nothing — could be a phone conflict.
      // Retry create without phone_number.
      if (payload.phone_number) {
        try {
          const { phone_number: _, ...withoutPhone } = payload;
          logger.warn('Retrying create without phone_number', { identifier });
          const created = await tryCreate(withoutPhone);
          return { action: 'created', contactId: created.id };
        } catch (retryErr) {
          logger.error('Create failed even without phone', {
            identifier,
            detail: extractErrorDetail(retryErr),
          });
          throw retryErr;
        }
      }
    }

    logger.error('Failed to create Chatwoot contact', {
      identifier,
      detail: extractErrorDetail(err),
    });
    throw err;
  }
}

export function contactHasShopifyData(contact: ChatwootContact): boolean {
  const attrs = contact.custom_attributes;
  if (!attrs) return false;
  return Boolean(attrs['shopify_customer_id']);
}

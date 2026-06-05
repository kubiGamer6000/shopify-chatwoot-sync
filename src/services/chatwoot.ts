import axios, { AxiosError } from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type {
  ChatwootContact,
  ChatwootContactPayload,
  ChatwootSearchResponse,
} from '../types/index.js';

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 2000;

const chatwootClient = axios.create({
  baseURL: `${env.chatwootBaseUrl}/api/v1/accounts/${env.chatwootAccountId}`,
  headers: {
    'Content-Type': 'application/json',
    api_access_token: env.chatwootApiToken,
  },
});

chatwootClient.interceptors.response.use(undefined, async (error: AxiosError) => {
  const config = error.config;
  if (!config || error.response?.status !== 429) throw error;

  const retryCount = ((config as unknown as Record<string, unknown>).__retryCount as number) ?? 0;
  if (retryCount >= MAX_RETRIES) throw error;

  (config as unknown as Record<string, unknown>).__retryCount = retryCount + 1;

  const retryAfter = error.response.headers['retry-after'];
  const delayMs = retryAfter
    ? Number(retryAfter) * 1000
    : BASE_DELAY_MS * Math.pow(2, retryCount);

  logger.warn('Chatwoot 429 rate limit, backing off', {
    attempt: retryCount + 1,
    delayMs,
    url: config.url,
  });

  await new Promise((r) => setTimeout(r, delayMs));
  return chatwootClient.request(config);
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

export async function findByIdentifier(identifier: string): Promise<ChatwootContact | null> {
  const results = await filterContacts([
    { attribute_key: 'identifier', filter_operator: 'equal_to', values: [identifier] },
  ]);
  return results[0] ?? null;
}

export async function findByEmail(email: string): Promise<ChatwootContact | null> {
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
  try {
    await chatwootClient.put(`/contacts/${contactId}`, payload);
  } catch (err) {
    if (err instanceof AxiosError && err.response?.status === 422 && payload.phone_number) {
      logger.warn('Update returned 422, retrying without phone_number', {
        contactId,
        detail: extractErrorDetail(err),
      });
      const { phone_number: _, ...withoutPhone } = payload;
      await chatwootClient.put(`/contacts/${contactId}`, withoutPhone);
      return;
    }
    throw err;
  }
}

/**
 * Sets the `shopify_email_link` custom attribute on a contact so future Shopify
 * lookups (AI drafts, summaries, the dashboard quick panel) resolve against the
 * customer's real account email instead of the address they happened to write
 * from. Existing custom attributes are preserved by merging them back in, since
 * Chatwoot replaces the `custom_attributes` object wholesale on update.
 * Best-effort: failures are logged and swallowed so callers never break.
 */
export async function linkShopifyEmail(
  contactId: number,
  email: string,
  existingCustomAttributes: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    const merged = {
      ...existingCustomAttributes,
      shopify_email_link: email,
    } as ChatwootContactPayload['custom_attributes'];

    await updateContact(contactId, { custom_attributes: merged });
    logger.info('Linked Shopify email to Chatwoot contact', { contactId, email });
    return true;
  } catch (err) {
    logger.warn('Failed to set shopify_email_link custom attribute', {
      contactId,
      email,
      detail: extractErrorDetail(err),
    });
    return false;
  }
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

export { chatwootClient };

export function contactHasShopifyData(contact: ChatwootContact): boolean {
  const attrs = contact.custom_attributes;
  if (!attrs) return false;
  return Boolean(attrs['shopify_customer_id']);
}

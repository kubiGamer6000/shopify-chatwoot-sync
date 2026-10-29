/**
 * Deterministic "this customer wrote from another email" suggestions.
 *
 * Replaces the old Claude tool loop that read the message and then linked the
 * contact automatically (security fix P1). Emails and order numbers found in
 * the customer's own messages are resolved to a Shopify customer and returned
 * as a SUGGESTION only; an agent confirms it in the Customer 360 tab.
 */
import { normalizeEmail } from '../security/crypto.js';
import { findCustomerByExactEmail, type LinkSuggestion } from './contactLink.js';
import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

// "#11696", or a keyword (EN/SV/FI/DA/NO/DE/NL/ES/FR/IT) followed by a number.
const HASH_ORDER_RE = /#\s?(\d{4,7})\b/g;
const KEYWORD_ORDER_RE =
  /\b(?:order|ordre|ordrenummer|order\s*(?:nr|no|number|num|id)|ordernummer|ordernr|best[äa]llning(?:snummer)?|tilaus(?:numero)?|tilausnro|bestilling(?:snummer)?|bestellung|bestellnummer|bestelnummer|pedido|commande|ordine)\b[\s.:#-]*(?:(?:nr|no|number|nummer|numero|n[ºo°])\b[\s.:#-]*)?(\d{4,7})\b/gi;

const MAX_CANDIDATES = 3;

export interface ExtractedCandidates {
  emails: string[];
  orderNumbers: string[];
}

/** Pure: pulls candidate emails and order numbers out of free text. */
export function extractCandidates(text: string, ignoreEmails: string[] = []): ExtractedCandidates {
  const ignore = new Set(ignoreEmails.map((e) => normalizeEmail(e)).filter(Boolean));
  const emails: string[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    const e = normalizeEmail(m[0]);
    if (!e || ignore.has(e) || emails.includes(e)) continue;
    // Skip our own / Chatwoot addresses that appear in quoted replies.
    if (/@(?:[a-z0-9-]+\.)*(?:scandigum\.com|scandinaviansmiles\.com|chatwoot\.com)$/.test(e)) continue;
    emails.push(e);
    if (emails.length >= MAX_CANDIDATES) break;
  }

  const orderNumbers: string[] = [];
  for (const re of [HASH_ORDER_RE, KEYWORD_ORDER_RE]) {
    for (const m of text.matchAll(re)) {
      const n = m[1];
      if (n && !orderNumbers.includes(n)) orderNumbers.push(n);
      if (orderNumbers.length >= MAX_CANDIDATES) break;
    }
  }
  return { emails, orderNumbers: orderNumbers.slice(0, MAX_CANDIDATES) };
}

export interface SuggestionDeps {
  searchCustomerByEmail: (email: string) => Promise<ShopifyCustomer | null>;
  searchOrderByName: (orderNumber: string) => Promise<ShopifyOrder | null>;
}

/** Customer-authored text to scan (incoming, non-private messages + subject). */
export interface CustomerText {
  kind: 'message' | 'subject';
  messageId?: number | null;
  createdAt?: string | null;
  content: string;
}

function excerpt(text: string, needle: string): string {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return text.slice(0, 120);
  const start = Math.max(0, i - 50);
  const end = Math.min(text.length, i + needle.length + 50);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Computes a suggestion LIVE from the customer's own messages (never from
 * stored attributes), and reports which message contained it so the agent can
 * check. Resolves to a Shopify customer; never links anything. Lookup failures
 * are swallowed.
 */
export async function findLinkSuggestion(
  texts: CustomerText[],
  contactEmail: string | null,
  deps: SuggestionDeps,
): Promise<LinkSuggestion | null> {
  const own = normalizeEmail(contactEmail);

  for (const t of texts) {
    const { emails } = extractCandidates(t.content, own ? [own] : []);
    for (const email of emails) {
      try {
        const customer = await findCustomerByExactEmail(deps, email);
        if (customer) {
          return {
            email,
            basis: 'An email address the customer wrote in this conversation matches this Shopify customer',
            source: { kind: t.kind, messageId: t.messageId ?? null, createdAt: t.createdAt ?? null, excerpt: excerpt(t.content, email) },
          };
        }
      } catch {
        // try the next candidate
      }
    }
  }

  for (const t of texts) {
    const { orderNumbers } = extractCandidates(t.content, own ? [own] : []);
    for (const n of orderNumbers) {
      try {
        const order = await deps.searchOrderByName(n);
        const email = normalizeEmail(order?.customer?.email ?? order?.email);
        if (order && email && email !== own) {
          return {
            email,
            basis: 'An order number the customer wrote in this conversation belongs to this Shopify customer',
            source: { kind: t.kind, messageId: t.messageId ?? null, createdAt: t.createdAt ?? null, excerpt: excerpt(t.content, n) },
          };
        }
      } catch {
        // try the next candidate
      }
    }
  }
  return null;
}

/** Builds the customer-authored texts from Chatwoot messages (+ subject). */
export function customerTexts(
  messages: { id: number; message_type: number; private: boolean; content: string | null; created_at: number }[],
  subject: unknown,
): CustomerText[] {
  const out: CustomerText[] = [];
  if (typeof subject === 'string' && subject.trim()) out.push({ kind: 'subject', content: subject });
  for (const m of [...messages].sort((a, b) => a.created_at - b.created_at)) {
    if (m.message_type !== 0 || m.private || !m.content) continue;
    out.push({
      kind: 'message',
      messageId: m.id,
      createdAt: new Date(m.created_at * 1000).toISOString(),
      content: m.content,
    });
  }
  return out;
}

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

/**
 * Resolves the extracted candidates to a Shopify customer. Returns the first
 * hit as a suggestion (never links anything). Lookup failures are swallowed.
 */
export async function findLinkSuggestion(
  text: string,
  contactEmail: string | null,
  deps: SuggestionDeps,
): Promise<LinkSuggestion | null> {
  const own = normalizeEmail(contactEmail);
  const { emails, orderNumbers } = extractCandidates(text, own ? [own] : []);

  for (const email of emails) {
    try {
      const customer = await findCustomerByExactEmail(deps, email);
      if (customer) return { email, basis: 'Email address mentioned in the customer’s message' };
    } catch {
      // try the next candidate
    }
  }

  for (const n of orderNumbers) {
    try {
      const order = await deps.searchOrderByName(n);
      const email = normalizeEmail(order?.customer?.email ?? order?.email);
      if (order && email && email !== own) {
        return { email, basis: `Order ${order.name} mentioned in the customer’s message` };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Who is this Chatwoot contact in Shopify, and how sure are we?
 *
 * This is the single place that decides whether a contact is linked to a
 * Shopify customer, used by the Customer 360 tab, the AI drafts and the
 * AgentBot.
 *
 * IMPORTANT: contact custom attributes are NOT trusted input. Chatwoot lets a
 * website-widget visitor update their own contact (including
 * custom_attributes) through the public widget API, even with identity
 * validation enforced. So no unsigned attribute can make a link verified or
 * even confirmable. Only these count:
 *
 * - `verified`  — (a) an agent confirmed the link in the Customer 360 tab
 *                 (HMAC signature with LINK_CONFIRMATION_SECRET), or (b) the
 *                 Shopify customer's email is exactly the contact's email AND
 *                 the contact's email is trustworthy for this conversation
 *                 (email channel, or web widget with an HMAC-verified
 *                 identity).
 * - `suggested` — a candidate the server derived itself: the contact's own
 *                 email on a channel where it isn't trustworthy, a link the old
 *                 AI matcher made BEFORE this change (signed snapshot, see
 *                 scripts/snapshotLegacyLinks.ts), or an email / order number
 *                 found live in the customer's messages (linkSuggestions.ts).
 *                 Agents confirm with one click after checking identity.
 * - `none`      — nothing found. Unsigned `shopify_email_link` /
 *                 mismatching `shopify_customer_id` values are ignored and
 *                 reported as `ignoredAttributes` so the tab can warn.
 */
import { env } from '../config/env.js';
import { hmacHex, normalizeEmail, signingKey, constantTimeEqual } from '../security/crypto.js';
import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';

export type LinkStatus = 'verified' | 'suggested' | 'none';

export type LinkBasis =
  | 'email_match'
  | 'agent_confirmed'
  | 'untrusted_email'
  | 'legacy_link'
  | 'message_suggestion'
  | null;

export interface ContactLike {
  id: number;
  email?: string | null;
  name?: string | null;
  custom_attributes?: Record<string, unknown> | null;
}

export interface SuggestionSource {
  kind: 'message' | 'subject' | 'contact_email' | 'legacy_link';
  messageId?: number | null;
  createdAt?: string | null;
  /** Short quote of the customer text containing the email / order number. */
  excerpt?: string | null;
}

export interface LinkSuggestion {
  email: string;
  /** Server-generated, fixed-template reason (never attribute text). */
  basis: string;
  source?: SuggestionSource;
}

export interface ContactResolution {
  status: LinkStatus;
  basis: LinkBasis;
  /** Verified customer, or the candidate when `suggested`. */
  customer: ShopifyCustomer | null;
  orders: ShopifyOrder[];
  /** Email of `customer` (normalised); the key for Skio lookups. */
  customerEmail: string | null;
  /** The contact's own email (normalised). */
  contactEmail: string | null;
  /** Server-derived candidate the agent can confirm. */
  suggestion: LinkSuggestion | null;
  /** Link-like attributes were present but ignored (unsigned / mismatching). */
  ignoredAttributes: boolean;
}

export interface LinkDeps {
  searchCustomerByEmail: (email: string) => Promise<ShopifyCustomer | null>;
  fetchCustomer: (id: number) => Promise<ShopifyCustomer | null>;
  fetchCustomerOrders: (id: number) => Promise<ShopifyOrder[]>;
}

// --- Channel trust -----------------------------------------------------------

export interface ConversationTrustInfo {
  meta?: { channel?: string | null; hmac_verified?: boolean | null } | null;
}

/**
 * Whether the contact's email can stand as proof of identity in this
 * conversation. Email inbox: the address mail is replied to (still spoofable
 * as a sender, so the bot never cancels there; see aiResponder). Web widget:
 * only with an HMAC-verified identity. Anything else: no.
 */
export function contactEmailTrusted(conversation: ConversationTrustInfo | null | undefined): boolean {
  const channel = conversation?.meta?.channel ?? '';
  if (channel === 'Channel::Email') return true;
  if (channel === 'Channel::WebWidget') return conversation?.meta?.hmac_verified === true;
  return false;
}

// --- Signatures ----------------------------------------------------------------

export interface LinkConfirmation {
  email: string;
  agentId: string;
  at: string;
}

function confirmationPayload(contactId: number, c: LinkConfirmation): string {
  return ['v1', env.chatwootAccountId, String(contactId), c.email, c.agentId, c.at].join('|');
}

export function signLinkConfirmation(contactId: number, c: LinkConfirmation): string {
  return hmacHex(signingKey('link-confirmation'), confirmationPayload(contactId, c));
}

/** Returns the confirmation stored on the contact if its signature is valid. */
export function readLinkConfirmation(contact: ContactLike): LinkConfirmation | null {
  const attrs = contact.custom_attributes ?? {};
  const email = normalizeEmail(attrs['shopify_email_link'] as string | undefined);
  const agentId = attrs['shopify_email_link_confirmed_by'];
  const at = attrs['shopify_email_link_confirmed_at'];
  const sig = attrs['shopify_email_link_sig'];
  if (!email || typeof agentId !== 'string' || typeof at !== 'string' || typeof sig !== 'string') {
    return null;
  }
  const c = { email, agentId, at };
  return constantTimeEqual(sig, signLinkConfirmation(contact.id, c)) ? c : null;
}

/** Custom attributes to write when an agent confirms a link. */
export function confirmationAttributes(
  contactId: number,
  email: string,
  agentId: string | number,
  now = new Date(),
): Record<string, string> {
  const c: LinkConfirmation = { email, agentId: String(agentId), at: now.toISOString() };
  return {
    shopify_email_link: c.email,
    shopify_email_link_confirmed_by: c.agentId,
    shopify_email_link_confirmed_at: c.at,
    shopify_email_link_sig: signLinkConfirmation(contactId, c),
  };
}

function legacyPayload(contactId: number, email: string): string {
  return ['legacy-v1', env.chatwootAccountId, String(contactId), email].join('|');
}

/** Signature written by the one-off snapshot of links that predate this change. */
export function signLegacyLink(contactId: number, email: string): string {
  return hmacHex(signingKey('legacy-link'), legacyPayload(contactId, email));
}

/** The pre-existing AI link, if it was captured by the signed snapshot. */
export function readLegacyLink(contact: ContactLike): string | null {
  const attrs = contact.custom_attributes ?? {};
  const email = normalizeEmail(attrs['shopify_email_link'] as string | undefined);
  const sig = attrs['shopify_email_link_legacy_sig'];
  if (!email || typeof sig !== 'string') return null;
  return constantTimeEqual(sig, signLegacyLink(contact.id, email)) ? email : null;
}

// --- Resolution ---------------------------------------------------------------

/** Shopify search is not exact: only accept a customer whose email IS `email`. */
export async function findCustomerByExactEmail(
  deps: Pick<LinkDeps, 'searchCustomerByEmail'>,
  email: string,
): Promise<ShopifyCustomer | null> {
  const wanted = normalizeEmail(email);
  if (!wanted) return null;
  const customer = await deps.searchCustomerByEmail(wanted);
  return customer && normalizeEmail(customer.email) === wanted ? customer : null;
}

export async function resolveContactCustomer(
  contact: ContactLike,
  deps: LinkDeps,
  opts: { loadOrders?: boolean; trustContactEmail: boolean },
): Promise<ContactResolution> {
  const loadOrders = opts.loadOrders ?? true;
  const attrs = contact.custom_attributes ?? {};
  const contactEmail = normalizeEmail(contact.email);
  const link = normalizeEmail(attrs['shopify_email_link'] as string | undefined);
  const confirmation = readLinkConfirmation(contact);
  const legacy = readLegacyLink(contact);
  const rawId = attrs['shopify_customer_id'];
  const shopifyId = rawId != null && String(rawId).trim() ? Number(rawId) : NaN;
  let ignoredAttributes = Boolean(link && !confirmation && !legacy && link !== contactEmail);

  const result = (
    status: LinkStatus,
    basis: LinkBasis,
    customer: ShopifyCustomer | null,
    orders: ShopifyOrder[],
    suggestion: LinkSuggestion | null,
  ): ContactResolution => ({
    status,
    basis,
    customer,
    orders,
    customerEmail: normalizeEmail(customer?.email),
    contactEmail,
    suggestion,
    ignoredAttributes,
  });

  const ordersOf = async (c: ShopifyCustomer | null) =>
    c && loadOrders ? deps.fetchCustomerOrders(c.id) : [];

  // 1. Agent-confirmed (signed) link.
  if (confirmation) {
    const customer = await findCustomerByExactEmail(deps, confirmation.email);
    if (customer) {
      return result('verified', 'agent_confirmed', customer, await ordersOf(customer), null);
    }
  }

  // 2. The contact's own email.
  if (contactEmail) {
    let customer = await findCustomerByExactEmail(deps, contactEmail);
    // Search can lag behind; the sync's customer id helps only when it points
    // at a customer with exactly this email.
    if (!customer && Number.isFinite(shopifyId) && shopifyId > 0) {
      const byId = await deps.fetchCustomer(shopifyId);
      if (byId && normalizeEmail(byId.email) === contactEmail) customer = byId;
    }
    if (customer) {
      if (opts.trustContactEmail) {
        return result('verified', 'email_match', customer, await ordersOf(customer), null);
      }
      return result('suggested', 'untrusted_email', customer, await ordersOf(customer), {
        email: contactEmail,
        basis:
          'The sender’s email matches this customer, but this channel does not prove the sender owns that email',
        source: { kind: 'contact_email' },
      });
    }
  }

  // 3. A link made by the old AI matcher before this change (signed snapshot).
  if (legacy && legacy !== contactEmail) {
    const customer = await findCustomerByExactEmail(deps, legacy);
    if (customer) {
      return result('suggested', 'legacy_link', customer, await ordersOf(customer), {
        email: legacy,
        basis: 'Linked automatically by the old AI matcher (never verified)',
        source: { kind: 'legacy_link' },
      });
    }
  }

  if (Number.isFinite(shopifyId) && shopifyId > 0) ignoredAttributes = true;
  return result('none', null, null, [], null);
}

/**
 * Emails an agent may confirm for this contact: ONLY server-derived
 * candidates (the resolution's own suggestion and a live suggestion computed
 * from the messages). Attribute values never qualify on their own.
 */
export function confirmableEmails(
  resolution: ContactResolution,
  liveSuggestion: LinkSuggestion | null,
): Set<string> {
  const out = new Set<string>();
  for (const v of [resolution.suggestion?.email, liveSuggestion?.email]) {
    const e = normalizeEmail(v);
    if (e) out.add(e);
  }
  return out;
}

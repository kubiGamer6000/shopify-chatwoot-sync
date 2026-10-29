/**
 * Who is this Chatwoot contact in Shopify, and how sure are we?
 *
 * This is the single place that decides whether a contact is linked to a
 * Shopify customer, used by the Customer 360 tab, the AI drafts and the
 * AgentBot. The rules (security fix P1):
 *
 * - `verified`  — the Shopify customer's email is exactly the contact's own
 *                 email, OR an agent confirmed the link in the Customer 360 tab
 *                 (HMAC-signed confirmation stored on the contact).
 * - `suggested` — anything else that points at a customer: a
 *                 `shopify_email_link` set by the old AI matcher (or edited by
 *                 hand / via the widget SDK), a `shopify_customer_id` whose
 *                 email differs from the contact's, or an email / order number
 *                 found in the customer's message. Shown to agents with a
 *                 one-click "confirm link"; NEVER used by automation to reveal
 *                 order details or take actions.
 * - `none`      — nothing found.
 */
import { env } from '../config/env.js';
import { hmacHex, normalizeEmail, signingKey, constantTimeEqual } from '../security/crypto.js';
import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';

export type LinkStatus = 'verified' | 'suggested' | 'none';

export type LinkBasis =
  | 'email_match'
  | 'agent_confirmed'
  | 'unverified_link'
  | 'shopify_id_mismatch'
  | 'message_suggestion'
  | null;

export interface ContactLike {
  id: number;
  email?: string | null;
  name?: string | null;
  custom_attributes?: Record<string, unknown> | null;
}

export interface LinkSuggestion {
  email: string;
  /** Human-readable reason shown to the agent (no PII beyond order numbers). */
  basis: string;
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
  /** Candidate the agent can confirm (also set alongside a verified customer with no orders). */
  suggestion: LinkSuggestion | null;
}

export interface LinkDeps {
  searchCustomerByEmail: (email: string) => Promise<ShopifyCustomer | null>;
  fetchCustomer: (id: number) => Promise<ShopifyCustomer | null>;
  fetchCustomerOrders: (id: number) => Promise<ShopifyOrder[]>;
}

// --- Agent confirmation signatures -------------------------------------------

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
    shopify_email_link_suggested: '',
    shopify_email_link_suggested_basis: '',
  };
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

export function pendingSuggestion(contact: ContactLike): LinkSuggestion | null {
  const attrs = contact.custom_attributes ?? {};
  const email = normalizeEmail(attrs['shopify_email_link_suggested'] as string | undefined);
  if (!email) return null;
  const basis = attrs['shopify_email_link_suggested_basis'];
  return {
    email,
    basis: typeof basis === 'string' && basis.trim() ? basis.trim() : 'Found in the customer’s message',
  };
}

export async function resolveContactCustomer(
  contact: ContactLike,
  deps: LinkDeps,
  opts: { loadOrders?: boolean } = {},
): Promise<ContactResolution> {
  const loadOrders = opts.loadOrders ?? true;
  const attrs = contact.custom_attributes ?? {};
  const contactEmail = normalizeEmail(contact.email);
  const link = normalizeEmail(attrs['shopify_email_link'] as string | undefined);
  const confirmation = readLinkConfirmation(contact);
  const pending = pendingSuggestion(contact);

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
  });

  const ordersOf = async (c: ShopifyCustomer | null) =>
    c && loadOrders ? deps.fetchCustomerOrders(c.id) : [];

  // 1. Explicit link to a different email.
  if (link && link !== contactEmail) {
    const customer = await findCustomerByExactEmail(deps, link);
    if (customer && confirmation && confirmation.email === link) {
      return result('verified', 'agent_confirmed', customer, await ordersOf(customer), null);
    }
    if (customer) {
      return result('suggested', 'unverified_link', customer, await ordersOf(customer), {
        email: link,
        basis: 'Linked automatically by the old AI matcher (not verified)',
      });
    }
    // The linked email has no Shopify customer: fall through to the contact.
  }

  // 2. The contact's own email.
  if (contactEmail) {
    const customer = await findCustomerByExactEmail(deps, contactEmail);
    if (customer) {
      const orders = await ordersOf(customer);
      const extra =
        orders.length === 0 && pending && pending.email !== contactEmail ? pending : null;
      return result('verified', 'email_match', customer, orders, extra);
    }
  }

  // 3. A Shopify customer id on the contact (normally written by our sync, but
  //    editable by anyone who can edit the contact): trust it only when the
  //    customer's email matches, or an agent confirmed that email.
  const rawId = attrs['shopify_customer_id'];
  const shopifyId = rawId != null && String(rawId).trim() ? Number(rawId) : NaN;
  if (Number.isFinite(shopifyId) && shopifyId > 0) {
    const customer = await deps.fetchCustomer(shopifyId);
    const customerEmail = normalizeEmail(customer?.email);
    if (customer && customerEmail) {
      if (customerEmail === contactEmail || confirmation?.email === customerEmail) {
        return result(
          'verified',
          customerEmail === contactEmail ? 'email_match' : 'agent_confirmed',
          customer,
          await ordersOf(customer),
          null,
        );
      }
      return result('suggested', 'shopify_id_mismatch', customer, await ordersOf(customer), {
        email: customerEmail,
        basis: 'Contact carries a Shopify customer id whose email differs from the sender',
      });
    }
  }

  // 4. A pending suggestion from the message text.
  if (pending && pending.email !== contactEmail) {
    const customer = await findCustomerByExactEmail(deps, pending.email);
    if (customer) {
      return result('suggested', 'message_suggestion', customer, await ordersOf(customer), pending);
    }
  }

  return result('none', null, null, [], null);
}

/** Emails an agent may confirm for this contact (prevents linking arbitrary emails). */
export function confirmableEmails(contact: ContactLike, resolution: ContactResolution): Set<string> {
  const out = new Set<string>();
  const attrs = contact.custom_attributes ?? {};
  for (const v of [
    attrs['shopify_email_link'],
    attrs['shopify_email_link_suggested'],
    resolution.suggestion?.email,
    resolution.status === 'suggested' ? resolution.customerEmail : null,
  ]) {
    const e = normalizeEmail(v as string | undefined);
    if (e) out.add(e);
  }
  return out;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveContactCustomer,
  confirmationAttributes,
  readLinkConfirmation,
  confirmableEmails,
  contactEmailTrusted,
  signLegacyLink,
  type LinkDeps,
} from '../src/services/contactLink.js';
import type { ShopifyCustomer } from '../src/types/index.js';

const anna: ShopifyCustomer = { id: 101, email: 'anna@example.com', first_name: 'Anna' };
const victim: ShopifyCustomer = { id: 202, email: 'victim@example.com', first_name: 'Vic' };
const trusted = { trustContactEmail: true };

function deps(customers: ShopifyCustomer[], fuzzy?: ShopifyCustomer): LinkDeps {
  return {
    async searchCustomerByEmail(email) {
      return customers.find((c) => c.email === email) ?? fuzzy ?? null;
    },
    async fetchCustomer(id) {
      return customers.find((c) => c.id === id) ?? null;
    },
    async fetchCustomerOrders(id) {
      return [{ id: id * 10, name: '#1001', created_at: '2026-01-01T00:00:00Z', updated_at: '', total_price: '10.00', currency: 'EUR' }];
    },
  };
}

test('channel trust: email inbox and HMAC-verified widget only', () => {
  assert.equal(contactEmailTrusted({ meta: { channel: 'Channel::Email' } }), true);
  assert.equal(contactEmailTrusted({ meta: { channel: 'Channel::WebWidget', hmac_verified: true } }), true);
  assert.equal(contactEmailTrusted({ meta: { channel: 'Channel::WebWidget', hmac_verified: false } }), false);
  assert.equal(contactEmailTrusted({ meta: { channel: 'Channel::WebWidget' } }), false);
  assert.equal(contactEmailTrusted({ meta: { channel: 'Channel::Api' } }), false);
  assert.equal(contactEmailTrusted(null), false);
});

test('own email on a trusted channel that matches exactly is verified', async () => {
  const r = await resolveContactCustomer({ id: 1, email: 'Anna@Example.com' }, deps([anna]), trusted);
  assert.equal(r.status, 'verified');
  assert.equal(r.basis, 'email_match');
  assert.equal(r.orders.length, 1);
});

test('own email on an unverified widget is only a suggestion', async () => {
  const r = await resolveContactCustomer({ id: 1, email: 'anna@example.com' }, deps([anna]), { trustContactEmail: false });
  assert.equal(r.status, 'suggested');
  assert.equal(r.basis, 'untrusted_email');
  assert.equal(r.suggestion?.email, 'anna@example.com');
});

test('a fuzzy Shopify search hit with a different email is NOT a match', async () => {
  const r = await resolveContactCustomer({ id: 1, email: 'ann@example.com' }, deps([], anna), trusted);
  assert.equal(r.status, 'none');
});

test('an unsigned shopify_email_link (AI-set after the change, or planted via the widget API) is ignored', async () => {
  const contact = { id: 5, email: 'stranger@evil.test', custom_attributes: { shopify_email_link: 'victim@example.com' } };
  const r = await resolveContactCustomer(contact, deps([victim]), trusted);
  assert.equal(r.status, 'none');
  assert.equal(r.suggestion, null);
  assert.equal(r.ignoredAttributes, true);
  assert.equal(confirmableEmails(r, null).size, 0);
});

test('planted suggestion attributes are ignored entirely', async () => {
  const contact = {
    id: 3,
    email: 'stranger@evil.test',
    custom_attributes: {
      shopify_email_link_suggested: 'victim@example.com',
      shopify_email_link_suggested_basis: 'Verified by Scandi support',
    },
  };
  const r = await resolveContactCustomer(contact, deps([victim]), trusted);
  assert.equal(r.status, 'none');
  assert.equal(confirmableEmails(r, null).has('victim@example.com'), false);
});

test('a link captured by the signed legacy snapshot is a confirmable suggestion', async () => {
  const contact = {
    id: 5,
    email: 'other@example.com',
    custom_attributes: { shopify_email_link: 'victim@example.com', shopify_email_link_legacy_sig: signLegacyLink(5, 'victim@example.com') },
  };
  const r = await resolveContactCustomer(contact, deps([victim]), trusted);
  assert.equal(r.status, 'suggested');
  assert.equal(r.basis, 'legacy_link');
  assert.ok(confirmableEmails(r, null).has('victim@example.com'));
  // the legacy signature is bound to the contact
  const moved = { ...contact, id: 6 };
  assert.equal((await resolveContactCustomer(moved, deps([victim]), trusted)).status, 'none');
});

test('an agent-confirmed (signed) link is verified, on any channel', async () => {
  const attrs = confirmationAttributes(5, 'victim@example.com', 42);
  const contact = { id: 5, email: 'other@example.com', custom_attributes: attrs };
  assert.ok(readLinkConfirmation(contact));
  const r = await resolveContactCustomer(contact, deps([victim]), { trustContactEmail: false });
  assert.equal(r.status, 'verified');
  assert.equal(r.basis, 'agent_confirmed');
  assert.equal(r.customerEmail, 'victim@example.com');
});

test('a forged or copied confirmation is rejected', async () => {
  const attrs = confirmationAttributes(5, 'victim@example.com', 42);
  const copied = { id: 6, email: 'x@evil.test', custom_attributes: attrs };
  assert.equal(readLinkConfirmation(copied), null);
  assert.equal((await resolveContactCustomer(copied, deps([victim]), trusted)).status, 'none');
  const tampered = { id: 5, email: 'x@evil.test', custom_attributes: { ...attrs, shopify_email_link_sig: 'deadbeef' } };
  assert.equal((await resolveContactCustomer(tampered, deps([victim]), trusted)).status, 'none');
  const swapped = { id: 5, email: 'x@evil.test', custom_attributes: { ...attrs, shopify_email_link: 'anna@example.com' } };
  assert.equal((await resolveContactCustomer(swapped, deps([victim, anna]), trusted)).status, 'none');
});

test('a planted shopify_customer_id never links to someone else', async () => {
  const contact = { id: 9, email: 'stranger@evil.test', custom_attributes: { shopify_customer_id: '202' } };
  const r = await resolveContactCustomer(contact, deps([victim]), trusted);
  assert.equal(r.status, 'none');
  assert.equal(r.ignoredAttributes, true);
});

test('shopify_customer_id only helps when its email is the contact’s own (search lag)', async () => {
  const contact = { id: 9, email: 'victim@example.com', custom_attributes: { shopify_customer_id: '202' } };
  const d = deps([victim]);
  d.searchCustomerByEmail = async () => null;
  assert.equal((await resolveContactCustomer(contact, d, trusted)).status, 'verified');
});

test('confirmable emails = server-derived suggestion + live suggestion only', async () => {
  const r = await resolveContactCustomer({ id: 3, email: 'anna@example.com' }, deps([anna]), trusted);
  assert.equal(confirmableEmails(r, null).size, 0);
  assert.deepEqual([...confirmableEmails(r, { email: 'victim@example.com', basis: 'x' })], ['victim@example.com']);
});

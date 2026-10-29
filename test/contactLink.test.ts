import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveContactCustomer,
  confirmationAttributes,
  readLinkConfirmation,
  confirmableEmails,
  type LinkDeps,
} from '../src/services/contactLink.js';
import type { ShopifyCustomer } from '../src/types/index.js';

const anna: ShopifyCustomer = { id: 101, email: 'anna@example.com', first_name: 'Anna' };
const victim: ShopifyCustomer = { id: 202, email: 'victim@example.com', first_name: 'Vic' };

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

test('own email that matches a Shopify customer exactly is verified', async () => {
  const r = await resolveContactCustomer({ id: 1, email: 'Anna@Example.com' }, deps([anna]));
  assert.equal(r.status, 'verified');
  assert.equal(r.basis, 'email_match');
  assert.equal(r.customer?.id, 101);
  assert.equal(r.orders.length, 1);
});

test('a fuzzy Shopify search hit with a different email is NOT a match', async () => {
  const r = await resolveContactCustomer({ id: 1, email: 'ann@example.com' }, deps([], anna));
  assert.equal(r.status, 'none');
  assert.equal(r.customer, null);
});

test('an AI-set shopify_email_link without agent confirmation is only a suggestion', async () => {
  const contact = { id: 5, email: 'stranger@evil.test', custom_attributes: { shopify_email_link: 'victim@example.com' } };
  const r = await resolveContactCustomer(contact, deps([victim]));
  assert.equal(r.status, 'suggested');
  assert.equal(r.basis, 'unverified_link');
  assert.equal(r.suggestion?.email, 'victim@example.com');
});

test('an agent-confirmed (signed) link is verified', async () => {
  const attrs = confirmationAttributes(5, 'victim@example.com', 42);
  const contact = { id: 5, email: 'other@example.com', custom_attributes: attrs };
  assert.ok(readLinkConfirmation(contact));
  const r = await resolveContactCustomer(contact, deps([victim]));
  assert.equal(r.status, 'verified');
  assert.equal(r.basis, 'agent_confirmed');
  assert.equal(r.customerEmail, 'victim@example.com');
});

test('a forged or copied confirmation is rejected', async () => {
  const attrs = confirmationAttributes(5, 'victim@example.com', 42);
  // Same attributes copied to another contact (signature binds the contact id).
  const copied = { id: 6, email: 'x@evil.test', custom_attributes: attrs };
  assert.equal(readLinkConfirmation(copied), null);
  assert.equal((await resolveContactCustomer(copied, deps([victim]))).status, 'suggested');
  // Tampered signature / email.
  const tampered = { id: 5, email: 'x@evil.test', custom_attributes: { ...attrs, shopify_email_link_sig: 'deadbeef' } };
  assert.equal((await resolveContactCustomer(tampered, deps([victim]))).status, 'suggested');
  const swapped = { id: 5, email: 'x@evil.test', custom_attributes: { ...attrs, shopify_email_link: 'anna@example.com' } };
  assert.equal((await resolveContactCustomer(swapped, deps([victim, anna]))).status, 'suggested');
});

test('shopify_customer_id whose email differs from the sender is only suggested', async () => {
  const contact = { id: 9, email: 'stranger@evil.test', custom_attributes: { shopify_customer_id: '202' } };
  const r = await resolveContactCustomer(contact, deps([victim]));
  assert.equal(r.status, 'suggested');
  assert.equal(r.basis, 'shopify_id_mismatch');
});

test('shopify_customer_id with matching email is verified', async () => {
  const contact = { id: 9, email: 'victim@example.com', custom_attributes: { shopify_customer_id: '202' } };
  // search by email finds nothing (e.g. search lag) but the id path verifies.
  const d = deps([victim]);
  d.searchCustomerByEmail = async () => null;
  const r = await resolveContactCustomer(contact, d);
  assert.equal(r.status, 'verified');
});

test('a pending suggestion from message text is suggested, never verified', async () => {
  const contact = {
    id: 3,
    email: 'new@example.com',
    custom_attributes: { shopify_email_link_suggested: 'victim@example.com', shopify_email_link_suggested_basis: 'Order #1001 mentioned' },
  };
  const r = await resolveContactCustomer(contact, deps([victim]));
  assert.equal(r.status, 'suggested');
  assert.equal(r.basis, 'message_suggestion');
  assert.deepEqual([...confirmableEmails(contact, r)], ['victim@example.com']);
});

test('confirmable emails never include arbitrary addresses', async () => {
  const contact = { id: 3, email: 'anna@example.com' };
  const r = await resolveContactCustomer(contact, deps([anna]));
  assert.equal(confirmableEmails(contact, r).has('victim@example.com'), false);
});

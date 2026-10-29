import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidates, findLinkSuggestion } from '../src/services/linkSuggestions.js';

test('extracts emails and order numbers in several languages', () => {
  const r = extractCandidates(
    'Hi, I ordered with Real.Me@Gmail.com. Order #11696. Tilausnumero 12345, beställning nr 23456',
    ['me@work.com'],
  );
  assert.deepEqual(r.emails, ['real.me@gmail.com']);
  assert.deepEqual(r.orderNumbers, ['11696', '12345', '23456']);
});

test('ignores the sender’s own email and our own domain', () => {
  const r = extractCandidates('From me@work.com, cc support@scandigum.com', ['ME@work.com']);
  assert.deepEqual(r.emails, []);
});

test('does not treat short numbers / prices as order numbers', () => {
  const r = extractCandidates('I paid 29 euros for 3 packs on 12.05');
  assert.deepEqual(r.orderNumbers, []);
});

test('an order number resolves to a suggestion only (no writes)', async () => {
  const s = await findLinkSuggestion('where is my order #11696', 'stranger@evil.test', {
    searchCustomerByEmail: async () => null,
    searchOrderByName: async (n) =>
      n === '11696'
        ? { id: 1, name: '#11696', created_at: '', updated_at: '', total_price: '1', currency: 'EUR', customer: { id: 9, email: 'Victim@Example.com' } }
        : null,
  });
  assert.deepEqual(s, { email: 'victim@example.com', basis: 'Order #11696 mentioned in the customer’s message' });
});

test('an email in the message only counts on an exact Shopify match', async () => {
  const s = await findLinkSuggestion('my email is old@example.com', null, {
    searchCustomerByEmail: async () => ({ id: 1, email: 'older@example.com' }),
    searchOrderByName: async () => null,
  });
  assert.equal(s, null);
});

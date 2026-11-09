import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lifetimeValue, toMinorUnits, fromMinorUnits, formatLifetimeValue } from '../src/utils/formatters.js';
import type { ShopifyOrder } from '../src/types/index.js';

const o = (total: string, currency: string, extra: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
  id: Math.random(),
  name: '#1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '',
  total_price: total,
  currency,
  ...extra,
});

test('money strings are parsed exactly into minor units', () => {
  assert.equal(toMinorUnits('12.5'), 1250);
  assert.equal(toMinorUnits('0.10'), 10);
  assert.equal(toMinorUnits('-3.00'), -300);
  assert.equal(toMinorUnits('abc'), 0);
  assert.equal(fromMinorUnits(1234), '12.34');
  assert.equal(fromMinorUnits(-5), '-0.05');
  // no float drift
  const many = Array.from({ length: 10 }, () => o('0.10', 'EUR'));
  assert.equal(lifetimeValue(many)[0]!.netMinor, 100);
});

test('currencies are never summed together', () => {
  const totals = lifetimeValue([o('10.00', 'EUR'), o('100.00', 'SEK'), o('5.00', 'EUR')]);
  assert.deepEqual(
    totals.map((t) => [t.currency, t.netMinor]),
    [['SEK', 10000], ['EUR', 1500]],
  );
});

test('successful refunds are subtracted; failed ones and voided orders are not counted', () => {
  const totals = lifetimeValue([
    o('30.00', 'EUR', {
      refunds: [
        { transactions: [{ kind: 'refund', status: 'success', amount: '10.00', currency: 'EUR' }] },
        { transactions: [{ kind: 'refund', status: 'failure', amount: '20.00', currency: 'EUR' }] },
      ],
    }),
    o('99.00', 'EUR', { financial_status: 'voided' }),
  ]);
  assert.deepEqual(totals, [{ currency: 'EUR', grossMinor: 3000, refundedMinor: 1000, netMinor: 2000 }]);
  assert.equal(formatLifetimeValue([o('1.00', 'EUR'), o('2.00', 'SEK')]), '2.00 SEK + 1.00 EUR');
});

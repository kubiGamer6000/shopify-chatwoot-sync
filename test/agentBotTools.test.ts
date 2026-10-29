import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResponderTools } from '../src/services/aiResponder.js';

const handlers = {
  sendReply: async () => '',
  escalate: async () => '',
  cancelSubscription: async () => '',
};

test('the bot only gets cancel_subscription for a verified account holder', () => {
  const verified = buildResponderTools(['sub-cancel'], handlers, { identityVerified: true }).map((t) => t.name);
  const unverified = buildResponderTools(['sub-cancel'], handlers, { identityVerified: false }).map((t) => t.name);
  assert.ok(verified.includes('cancel_subscription'));
  assert.ok(!unverified.includes('cancel_subscription'));
  assert.deepEqual(unverified.sort(), ['escalate_to_human', 'send_reply']);
});

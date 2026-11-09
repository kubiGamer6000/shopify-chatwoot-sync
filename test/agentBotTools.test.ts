import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResponderTools, botMayCancel } from '../src/services/aiResponder.js';

const handlers = {
  sendReply: async () => '',
  escalate: async () => '',
  cancelSubscription: async () => '',
};

test('the bot only gets cancel_subscription for a verified account holder', () => {
  const verified = buildResponderTools(['sub-cancel'], handlers, { canCancel: true }).map((t) => t.name);
  const unverified = buildResponderTools(['sub-cancel'], handlers, { canCancel: false }).map((t) => t.name);
  assert.ok(verified.includes('cancel_subscription'));
  assert.ok(!unverified.includes('cancel_subscription'));
  assert.deepEqual(unverified.sort(), ['escalate_to_human', 'send_reply']);
});

test('the bot never cancels in email conversations (spoofable From), or when unverified', () => {
  const verified = { status: 'verified' as const, hasCandidate: false };
  assert.equal(botMayCancel({ identity: verified, channel: 'Channel::WebWidget' }), true);
  assert.equal(botMayCancel({ identity: verified, channel: 'Channel::Email' }), false);
  assert.equal(botMayCancel({ identity: { status: 'suggested', hasCandidate: true }, channel: 'Channel::WebWidget' }), false);
});

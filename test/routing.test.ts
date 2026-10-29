import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRoute } from '../src/services/agentBotRouting.js';
import type { Classification } from '../src/services/classifier.js';

const cls = (labels: string[]): Classification =>
  ({ labels, currentIntents: labels, needsReply: true, isAutoReply: false, isSpam: false, language: 'en', reasoning: '' }) as unknown as Classification;

const facts = {
  cfg: { autoRespondLabels: ['order-status', 'sub-cancel'], acknowledgeLabels: ['refund'] },
  autoReplyDetected: false,
  hasPublicReply: false,
  customerHasOrders: true,
  startedByUs: false,
  latestHasText: true,
};

test('verified customers can still be answered by the bot', () => {
  assert.equal(decideRoute({ ...facts, classification: cls(['sub-cancel']) } as never).route, 'respond');
});

test('unverified sender with a possible account match goes to a human', () => {
  const d = decideRoute({ ...facts, identityNeedsAgentCheck: true, classification: cls(['sub-cancel']) } as never);
  assert.equal(d.route, 'acknowledge');
  assert.match(d.reason ?? '', /identity not verified/);
});

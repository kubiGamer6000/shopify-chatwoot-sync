import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claim, claimOnce, resetMemoryClaims } from '../src/services/cache.js';
import { countRecentBotMessages, recordSentReply, resetMemoryBotSends } from '../src/services/aiAudit.js';

// Firestore is not configured in tests, i.e. the dedupe store is "down".

test('claim reports unavailable instead of silently allowing', async () => {
  resetMemoryClaims();
  assert.equal(await claim('t', 'k1', 60_000), 'unavailable');
  // in-process dedupe still catches the redelivery
  assert.equal(await claim('t', 'k1', 60_000), 'duplicate');
});

test('claimOnce (harmless flows) proceeds once, then dedupes in-process', async () => {
  resetMemoryClaims();
  assert.equal(await claimOnce('t', 'k2', 60_000), true);
  assert.equal(await claimOnce('t', 'k2', 60_000), false);
});

test('bot reply cap is unknown (null), never 0, when the log is unavailable', async () => {
  resetMemoryBotSends();
  await recordSentReply({ conversationId: 77, message: 'hi', source: 'agent-bot' });
  assert.equal(await countRecentBotMessages(77, 0), null);
});

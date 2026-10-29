import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { env } from '../src/config/env.js';
import { checkChatwootWebhook } from '../src/middleware/chatwootWebhookAuth.js';

const original = { ...env };
afterEach(() => Object.assign(env, original));

function req(headers: Record<string, string>, body: string, query: Record<string, string> = {}) {
  return {
    header: (n: string) => headers[n.toLowerCase()],
    query,
    rawBody: Buffer.from(body),
  } as never;
}

const body = '{"event":"message_created","id":1}';
const sign = (secret: string, ts: string) => `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

test('fails closed when nothing is configured', () => {
  assert.deepEqual(checkChatwootWebhook('account', req({}, body)), { ok: false, reason: 'not-configured' });
});

test('accepts a valid Chatwoot HMAC signature', () => {
  env.chatwootWebhookSigningSecret = 's3cret';
  const now = 1_800_000_000;
  const ts = String(now);
  const r = checkChatwootWebhook('account', req({ 'x-chatwoot-timestamp': ts, 'x-chatwoot-signature': sign('s3cret', ts) }, body), now);
  assert.deepEqual(r, { ok: true, method: 'hmac' });
});

test('rejects a bad signature, a stale timestamp and a missing header', () => {
  env.chatwootAgentBotSigningSecret = 's3cret';
  const now = 1_800_000_000;
  const ts = String(now);
  assert.equal(checkChatwootWebhook('agentBot', req({ 'x-chatwoot-timestamp': ts, 'x-chatwoot-signature': sign('wrong', ts) }, body), now).ok, false);
  const old = String(now - 3600);
  assert.equal(checkChatwootWebhook('agentBot', req({ 'x-chatwoot-timestamp': old, 'x-chatwoot-signature': sign('s3cret', old) }, body), now).ok, false);
  assert.equal(checkChatwootWebhook('agentBot', req({}, body), now).ok, false);
  const future = String(now + 120);
  assert.equal(checkChatwootWebhook('agentBot', req({ 'x-chatwoot-timestamp': future, 'x-chatwoot-signature': sign('s3cret', future) }, body), now).ok, false);
  const slight = String(now + 30);
  assert.equal(checkChatwootWebhook('agentBot', req({ 'x-chatwoot-timestamp': slight, 'x-chatwoot-signature': sign('s3cret', slight) }, body), now).ok, true);
});

test('the query secret works only with the legacy flag and no signing secret', () => {
  env.chatwootWebhookSecret = 'q';
  assert.equal(checkChatwootWebhook('account', req({}, body, { secret: 'q' })).ok, false);
  env.legacyWebhookQuerySecretEnabled = true;
  assert.equal(checkChatwootWebhook('account', req({}, body, { secret: 'q' })).ok, true);
  assert.equal(checkChatwootWebhook('account', req({}, body, { secret: 'nope' })).ok, false);
  env.chatwootWebhookSigningSecret = 'sig';
  assert.equal(checkChatwootWebhook('account', req({}, body, { secret: 'q' })).ok, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintToken, verifyToken, ACCESS_TTL_MS, ABSOLUTE_TTL_MS } from '../src/security/session.js';
import { verifyAgentAccessToken } from '../src/security/chatwootIdentity.js';

const agent = { id: 12, name: 'Ruth', email: 'ruth@example.com', role: 'agent' };

test('access tokens round-trip and expire', () => {
  const t = mintToken(agent, 'access', {}, 1_000);
  assert.equal(verifyToken(t, 'access', 2_000)?.id, 12);
  assert.equal(verifyToken(t, 'access', 1_000 + ACCESS_TTL_MS + 1), null);
});

test('nothing outlives 30 days from the original connect, even when re-minted', () => {
  const authAt = 1_000;
  const late = authAt + ABSOLUTE_TTL_MS - 60_000;
  const refresh = mintToken(agent, 'refresh', { authAt }, late);
  assert.ok(verifyToken(refresh, 'refresh', late));
  assert.equal(verifyToken(refresh, 'refresh', authAt + ABSOLUTE_TTL_MS + 1), null);
  const access = mintToken(agent, 'access', { authAt }, late);
  assert.equal(verifyToken(access, 'access', authAt + ABSOLUTE_TTL_MS + 1), null);
  assert.equal(verifyToken(access, 'access', late)?.authAt, authAt);
});

test('kinds are not interchangeable', () => {
  const refresh = mintToken(agent, 'refresh');
  assert.equal(verifyToken(refresh, 'access'), null);
  assert.ok(verifyToken(refresh, 'refresh'));
});

test('tampered tokens are rejected', () => {
  const t = mintToken(agent, 'access');
  const [p, k, body, sig] = t.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), id: 1 })).toString('base64url');
  assert.equal(verifyToken(`${p}.${k}.${forgedBody}.${sig}`, 'access'), null);
  assert.equal(verifyToken(`${t}x`, 'access'), null);
  assert.equal(verifyToken('', 'access'), null);
  assert.equal(verifyToken(undefined, 'access'), null);
});

test('Chatwoot access token must belong to the configured account', async () => {
  const ok = await verifyAgentAccessToken('tok', async () => ({ id: 12, name: 'Ruth', accounts: [{ id: 7, role: 'agent', status: 'active' }] }));
  assert.equal(ok?.id, 12);
  assert.equal(ok?.role, 'agent');
  const other = await verifyAgentAccessToken('tok', async () => ({ id: 12, accounts: [{ id: 8 }] }));
  assert.equal(other, null);
  const invalid = await verifyAgentAccessToken('tok', async () => null);
  assert.equal(invalid, null);
  const suspended = await verifyAgentAccessToken('tok', async () => ({ id: 12, accounts: [{ id: 7, status: 'suspended' }] }));
  assert.equal(suspended, null);
});

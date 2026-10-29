/** SPA session handling: only a 401 drops the stored session. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
let nextStatus = 401;
(globalThis as any).window = {
  location: { href: 'https://app.test/app' },
  history: { replaceState() {} },
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};
(globalThis as any).fetch = async () =>
  new Response(JSON.stringify({ error: 'x' }), { status: nextStatus, headers: { 'Content-Type': 'application/json' } });

const seed = () =>
  store.set('c360.session.v1', JSON.stringify({ accessToken: 'a', refreshToken: 'r', agent: { id: 1, name: null, role: null } }));

test('429 / 503 keep the stored session; 401 clears it', async () => {
  const auth = await import('../web/src/lib/auth.js');
  for (const status of [429, 503]) {
    seed();
    nextStatus = status;
    const r = await auth.refreshSession();
    assert.equal(r.session, null);
    assert.equal('transient' in r && r.transient, true);
    assert.ok(auth.getSession(), `session kept on ${status}`);
  }
  seed();
  nextStatus = 401;
  const r = await auth.refreshSession();
  assert.equal('transient' in r && r.transient, false);
  assert.equal(auth.getSession(), null);
});

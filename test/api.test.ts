/**
 * End-to-end tests of the HTTP surface with every external service faked
 * (Chatwoot, Shopify, Skio). Covers auth, server-side scoping, link
 * verification, cancellations and webhook authentication.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { on, resetFake, calls, type FakeRequest } from './helpers/fakeHttp.js';
import { env } from '../src/config/env.js';
import { mintToken } from '../src/security/session.js';
import { resetMemoryClaims } from '../src/services/cache.js';
import { confirmationAttributes } from '../src/services/contactLink.js';
import app from '../src/app.js';

let server: Server;
let base = '';
const original = { ...env };

const CW = 'https://chatwoot\\.test/api/v1/accounts/7';
const SHOP = 'https://test-store\\.myshopify\\.com';

const ruth = mintToken({ id: 12, name: 'Ruth', email: 'ruth@example.com', role: 'agent' }, 'access');

interface FakeContact {
  id: number;
  email: string;
  name: string;
  custom_attributes: Record<string, unknown>;
}

const customers = [
  { id: 101, email: 'anna@example.com', first_name: 'Anna' },
  { id: 202, email: 'victim@example.com', first_name: 'Vic' },
];
const subsByEmail: Record<string, { id: string; status: string; cancelledAt: string | null }[]> = {
  'anna@example.com': [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', status: 'ACTIVE', cancelledAt: null }],
  'victim@example.com': [{ id: 'bbbbbbbb-0000-0000-0000-000000000002', status: 'ACTIVE', cancelledAt: null }],
};

let contacts: Record<number, FakeContact>;
const conversations: Record<number, number> = { 1: 501, 2: 502 }; // conversation -> contact

function installFakes(): void {
  resetFake();
  contacts = {
    501: { id: 501, email: 'stranger@evil.test', name: 'Stranger', custom_attributes: { shopify_email_link: 'victim@example.com' } },
    502: { id: 502, email: 'anna@example.com', name: 'Anna', custom_attributes: {} },
  };
  on('GET', new RegExp(`${CW}/conversations/(\\d+)$`), (req) => {
    const id = Number(/conversations\/(\d+)$/.exec(req.url)![1]);
    const contactId = conversations[id];
    if (!contactId) return { status: 404 };
    const c = contacts[contactId]!;
    return { data: { id, account_id: 7, status: 'open', additional_attributes: {}, meta: { sender: { ...c } } } };
  });
  on('GET', new RegExp(`${CW}/contacts/(\\d+)$`), (req) => {
    const id = Number(/contacts\/(\d+)$/.exec(req.url)![1]);
    return contacts[id] ? { data: { payload: contacts[id] } } : { status: 404 };
  });
  on('PUT', new RegExp(`${CW}/contacts/(\\d+)$`), (req) => {
    const id = Number(/contacts\/(\d+)$/.exec(req.url)![1]);
    const body = req.body as { custom_attributes?: Record<string, unknown> };
    contacts[id]!.custom_attributes = { ...contacts[id]!.custom_attributes, ...(body.custom_attributes ?? {}) };
    return { data: { payload: contacts[id] } };
  });
  on('GET', new RegExp(`${CW}/conversations/\\d+/messages$`), () => ({
    data: { payload: [{ id: 1, message_type: 0, private: false, content: 'please cancel', created_at: 1 }] },
  }));
  on('POST', new RegExp(`${CW}/conversations/\\d+/messages$`), () => ({ data: { id: 999 } }));
  on('GET', new RegExp(`${CW}/conversations/\\d+/labels$`), () => ({ data: { payload: [] } }));
  on('POST', new RegExp(`${CW}/conversations/\\d+/labels$`), () => ({ data: {} }));
  on('POST', new RegExp(`${CW}/conversations/\\d+/toggle_status$`), () => ({ data: {} }));
  on('GET', /https:\/\/chatwoot\.test\/api\/v1\/profile$/, (req) =>
    req.headers['api_access_token'] === 'ruth-personal-token'
      ? { data: { id: 12, name: 'Ruth', accounts: [{ id: 7, role: 'agent', status: 'active' }] } }
      : { status: 401 },
  );
  on('POST', new RegExp(`${SHOP}/admin/oauth/access_token`), () => ({
    data: { access_token: 'shop-token', scope: 'read', expires_in: 86400 },
  }));
  on('GET', new RegExp(`${SHOP}/admin/api/[^/]+/customers/search\\.json`), (req) => {
    const email = decodeURIComponent(/email:([^&]+)/.exec(req.url)![1]!);
    return { data: { customers: customers.filter((c) => c.email === email) } };
  });
  on('GET', new RegExp(`${SHOP}/admin/api/[^/]+/customers/(\\d+)\\.json`), (req) => {
    const id = Number(/customers\/(\d+)\.json/.exec(req.url)![1]);
    const c = customers.find((x) => x.id === id);
    return c ? { data: { customer: c } } : { status: 404 };
  });
  on('GET', new RegExp(`${SHOP}/admin/api/[^/]+/customers/\\d+/orders\\.json`), () => ({
    data: { orders: [{ id: 1, name: '#1001', created_at: '2026-01-01T00:00:00Z', updated_at: '', total_price: '20.00', currency: 'EUR' }] },
  }));
  on('POST', /graphql\.skio\.com/, (req) => {
    const body = req.body as { query: string; variables: { email?: string } };
    if (body.query.includes('mutation')) return { data: { data: { cancelSubscription: { ok: true } } } };
    const subs = (subsByEmail[body.variables.email ?? ''] ?? []).map((s) => ({
      ...s,
      platformId: null,
      statusContext: null,
      currencyCode: 'EUR',
      createdAt: '2026-01-01',
      nextBillingDate: null,
      cyclesCompleted: 1,
      DeliveryPolicy: null,
      SubscriptionLines: [],
    }));
    return { data: { data: { Subscriptions: subs } } };
  });
}

const skioMutations = () =>
  calls.filter((c) => /graphql\.skio\.com/.test(c.url) && String((c.body as { query?: string })?.query).includes('mutation'));

async function api(path: string, init: RequestInit & { token?: string | null; conversation?: number } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) };
  if (init.token !== null) headers['Authorization'] = `Bearer ${init.token ?? ruth}`;
  if (init.conversation) headers['X-Chatwoot-Conversation'] = String(init.conversation);
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  Object.assign(env, original);
  resetMemoryClaims();
  installFakes();
});

// --- Auth ----------------------------------------------------------------------

test('API requires a per-agent session; the shared token only works in transition mode via header', async () => {
  assert.equal((await api('/app/api/customer', { token: null, conversation: 2 })).status, 401);
  env.dashboardAppToken = 'shared-legacy';
  // flag off: legacy header rejected
  assert.equal((await api('/app/api/customer', { token: null, conversation: 2, headers: { 'x-app-token': 'shared-legacy' } })).status, 401);
  env.legacyDashboardTokenEnabled = true;
  assert.equal((await api('/app/api/customer', { token: null, conversation: 2, headers: { 'x-app-token': 'shared-legacy' } })).status, 200);
  // never via the query string
  assert.equal((await api('/app/api/customer?token=shared-legacy', { token: null, conversation: 2 })).status, 401);
});

test('connect verifies the agent with Chatwoot and returns a session', async () => {
  const bad = await api('/app/auth/connect', { method: 'POST', token: null, body: JSON.stringify({ chatwootAccessToken: 'nope' }) });
  assert.equal(bad.status, 401);
  const ok = await api('/app/auth/connect', { method: 'POST', token: null, body: JSON.stringify({ chatwootAccessToken: 'ruth-personal-token' }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.agent.id, 12);
  const me = await api('/app/api/me', { token: ok.json.accessToken });
  assert.equal(me.json.id, 12);
  assert.equal(me.json.via, 'session');
});

// --- Scope + link verification ----------------------------------------------------

test('lookup is scoped to the conversation contact; browser-supplied email is ignored', async () => {
  const r = await api('/app/api/customer?email=anna@example.com&shopifyCustomerId=101', { conversation: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.link.status, 'suggested'); // AI-only link → unverified
  assert.equal(r.json.customer.shopifyCustomerId, 202); // the contact's candidate, not "anna"
  assert.equal(r.json.link.suggestion.email, 'victim@example.com');
});

test('unknown conversation → 404, missing id → 400', async () => {
  assert.equal((await api('/app/api/customer', { conversation: 999 })).status, 404);
  assert.equal((await api('/app/api/customer')).status, 400);
});

test('cancel is refused while the link is only suggested (no Skio call)', async () => {
  const r = await api('/app/api/subscriptions/bbbbbbbb-0000-0000-0000-000000000002/cancel', {
    method: 'POST',
    conversation: 1,
    body: JSON.stringify({ reason: 'asked by email' }),
  });
  assert.equal(r.status, 409);
  assert.equal(skioMutations().length, 0);
});

test('confirm link: only pending candidates, only with a personal session; then cancel works', async () => {
  env.dashboardAppToken = 'shared-legacy';
  env.legacyDashboardTokenEnabled = true;
  const legacy = await api('/app/api/link/confirm', {
    method: 'POST', token: null, conversation: 1,
    headers: { 'x-app-token': 'shared-legacy' },
    body: JSON.stringify({ email: 'victim@example.com' }),
  });
  assert.equal(legacy.status, 403);

  const arbitrary = await api('/app/api/link/confirm', { method: 'POST', conversation: 1, body: JSON.stringify({ email: 'anna@example.com' }) });
  assert.equal(arbitrary.status, 409);

  const ok = await api('/app/api/link/confirm', { method: 'POST', conversation: 1, body: JSON.stringify({ email: 'victim@example.com' }) });
  assert.equal(ok.status, 200);
  assert.equal(contacts[501]!.custom_attributes['shopify_email_link_confirmed_by'], '12');
  assert.ok(contacts[501]!.custom_attributes['shopify_email_link_sig']);

  const after = await api('/app/api/customer', { conversation: 1 });
  assert.equal(after.json.link.status, 'verified');

  const cancel = await api('/app/api/subscriptions/bbbbbbbb-0000-0000-0000-000000000002/cancel', {
    method: 'POST', conversation: 1, body: JSON.stringify({ reason: 'customer asked' }),
  });
  assert.equal(cancel.status, 200);
});

test('verified cancel: reason required, own subscriptions only, Skio notice on, note posted', async () => {
  const noReason = await api('/app/api/subscriptions/aaaaaaaa-0000-0000-0000-000000000001/cancel', {
    method: 'POST', conversation: 2, body: JSON.stringify({}),
  });
  assert.equal(noReason.status, 400);

  const foreign = await api('/app/api/subscriptions/bbbbbbbb-0000-0000-0000-000000000002/cancel', {
    method: 'POST', conversation: 2, body: JSON.stringify({ reason: 'customer asked' }),
  });
  assert.equal(foreign.status, 403);
  assert.equal(skioMutations().length, 0);

  const ok = await api('/app/api/subscriptions/aaaaaaaa-0000-0000-0000-000000000001/cancel', {
    method: 'POST', conversation: 2, body: JSON.stringify({ reason: 'customer asked by email' }),
  });
  assert.equal(ok.status, 200);
  const [mutation] = skioMutations();
  assert.equal((mutation!.body as any).variables.input.shouldSendNotif, true);
  const note = calls.find((c: FakeRequest) => c.method === 'POST' && /messages$/.test(c.url) && (c.body as any).private === true);
  assert.match((note!.body as any).content, /Ruth \(agent #12\)[\s\S]*customer asked by email/);
});

test('a forged confirmation attribute set outside the tab does not verify', async () => {
  contacts[501]!.custom_attributes = {
    ...confirmationAttributes(999, 'victim@example.com', 12), // signed for a different contact
  };
  const r = await api('/app/api/customer', { conversation: 1 });
  assert.equal(r.json.link.status, 'suggested');
});

// --- Page headers --------------------------------------------------------------------

test('the tab page has a strict CSP framed only by our Chatwoot origin and no-referrer', async () => {
  const r = await api('/app', { token: null });
  const csp = r.headers.get('content-security-policy') ?? '';
  assert.match(csp, /frame-ancestors https:\/\/chatwoot\.test(;|$)/);
  assert.doesNotMatch(csp, /\*/);
  assert.match(csp, /script-src 'self'/);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-powered-by'), null);
});

// --- Webhooks ---------------------------------------------------------------------------

const botPayload = JSON.stringify({
  event: 'message_created', id: 4242, message_type: 'incoming', private: false, content: 'cancel pls',
  sender: { id: 502, type: 'contact' }, conversation: { id: 2, status: 'pending', inbox_id: 1 },
});

test('webhooks fail closed without a configured secret', async () => {
  const r = await fetch(`${base}/chatwoot/agent-bot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: botPayload });
  assert.equal(r.status, 401);
  const r2 = await fetch(`${base}/chatwoot?secret=anything`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: botPayload });
  assert.equal(r2.status, 401);
});

test('signed AgentBot delivery with the dedupe store down: no bot reply, handed to a human', async () => {
  env.chatwootAgentBotSigningSecret = 'bot-secret';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `sha256=${createHmac('sha256', 'bot-secret').update(`${ts}.${botPayload}`).digest('hex')}`;
  const r = await fetch(`${base}/chatwoot/agent-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chatwoot-Timestamp': ts, 'X-Chatwoot-Signature': sig },
    body: botPayload,
  });
  assert.equal(r.status, 200);
  for (let i = 0; i < 50 && !calls.some((c) => /toggle_status$/.test(c.url)); i++) {
    await new Promise((res) => setTimeout(res, 20));
  }
  const toggle = calls.find((c) => /toggle_status$/.test(c.url));
  assert.deepEqual(toggle?.body, { status: 'open' });
  const publicReplies = calls.filter((c) => c.method === 'POST' && /messages$/.test(c.url) && (c.body as any).private === false);
  assert.equal(publicReplies.length, 0);
  assert.equal(skioMutations().length, 0);
});

test('sync endpoint requires the key (constant-time, fails closed)', async () => {
  assert.equal((await fetch(`${base}/sync/customers`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/sync/customers`, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 403);
});

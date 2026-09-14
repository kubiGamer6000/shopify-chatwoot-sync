/**
 * Refund <-> label reconciliation (READ-ONLY).
 *
 * Compares Shopify refunds made by staff (primarily the support agent) with the
 * Chatwoot action labels refund-30 / refund-50 / refund-70 / refund-full.
 *
 *   Shopify side  GraphQL orders (updated_at + refunded/partially_refunded filter)
 *                 -> money refunds, % of order, bucket;
 *                 REST /orders/{id}/refunds.json -> user_id / source_name (actor)
 *   Chatwoot side GET /conversations (by last activity) -> sender email,
 *                 custom_attributes.shopify_customer_id / shopify_email_link, labels;
 *                 GET /conversations/{id}/messages -> "Scandi Gum added refund-30" events
 *   Fallbacks     GET /contacts/search?q=<email> -> GET /contacts/{id}/conversations
 *                 GET /search/messages?q=<order number> (order-number mentions)
 *                 GraphQL orders(query:"email:...") for labels with no refund nearby
 *
 * Only GraphQL queries (no mutations), REST GETs and Chatwoot GETs are sent.
 *
 * Usage:
 *   npx tsx src/scripts/analytics/refundLabelReconciliation.ts [--days=7] [--tz=Europe/Helsinki]
 *       [--out=/home/dolan/support-analytics] [--include-today] [--tolerance-hours=48]
 *
 *   --days=N             complete local days ending at local midnight today (default 7)
 *   --include-today      extend the window end to "now" (partial current day)
 *   --tolerance-hours=H  a label may be added up to H hours before/after the refund (default 48)
 *
 * Output (outside the repo by default; contains no emails or names):
 *   <out>/refund-label-reconciliation_<days>d_<endDate>.json   aggregates + one row per refund / label event
 *   <out>/refund-label-reconciliation_<days>d_<endDate>.md     markdown summary
 */
import 'dotenv/config';
import axios, { AxiosError } from 'axios';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../../config/env.js';
import { getAccessToken } from '../../services/shopifyAuth.js';
import {
  ACTOR_CLASS_ORDER,
  ALERT_NOTE_RE,
  BUCKET_TOLERANCE_PP,
  FULL_THRESHOLD_PCT,
  LABEL_BUCKET,
  REFUND_BUCKETS,
  STAFF,
  STAFF_CLASSES,
  bucketRefund,
  classifyActor,
  type ActorClass,
  type RefundBucket,
} from './lib/refundRules.js';
import { chatwootClient } from '../../services/chatwoot.js';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? 'true' : hit.slice(eq + 1);
}

const DAYS = Math.max(1, Number.parseInt(flag('days') ?? '7', 10) || 7);
const TZ = flag('tz') ?? 'Europe/Helsinki';
const OUT_DIR = flag('out') ?? '/home/dolan/support-analytics';
const INCLUDE_TODAY = flag('include-today') !== undefined;
const TOL_H = Math.max(1, Number(flag('tolerance-hours') ?? '48') || 48);
const TOL_S = TOL_H * 3600;

const API_VERSION = '2026-01';

// ---------------------------------------------------------------------------
// Configuration: actors and buckets
// ---------------------------------------------------------------------------

// Actor classes, staff ids, Chargeflow ids and buckets are canonical in lib/refundRules.ts (shared with
// shopifyRefunds.ts and refundAttribution.ts). Chargeflow app and Chargeflow, Inc. collaborators stay separate classes.
/**
 * Refund notes are free text. Only these known short codes are reported; anything else
 * becomes 'other_text' so no customer data can leak into the output.
 */
const NOTE_CODES = ['remote', 'hk', 'cust request', 'eu withdrawal', 'lost parcel', 'refunded by chargeflow'];
function noteCode(note: string | null): string {
  const n = (note ?? '').trim().toLowerCase();
  if (!n) return 'none';
  if (ALERT_NOTE_RE.test(n)) return 'alert_ref';
  return NOTE_CODES.includes(n) ? n : 'other_text';
}

const ACTOR_RANK: Record<ActorClass, number> = {
  support_agent: 0,
  call_support: 1,
  other_staff: 2,
  unknown_staff: 3,
  unknown: 4,
  other_app: 5,
  chargeflow_collaborator: 6,
  chargeflow_app: 7,
};

type Bucket = RefundBucket;

// ---------------------------------------------------------------------------
// Timezone helpers (Intl only, DST-safe)
// ---------------------------------------------------------------------------

function tzOffsetMinutes(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}
const localDate = (utcMs: number, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(utcMs),
  );
function localMidnightUtc(ymd: string, tz: string): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) guess = Date.UTC(y, m - 1, d) - tzOffsetMinutes(guess, tz) * 60000;
  return guess;
}
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Transport (read-only)
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const calls = { shopifyGql: 0, shopifyRest: 0, chatwoot: 0, chatwootFailed: 0 };
const shopBase = () => `https://${env.shopifyStoreDomain}/admin/api/${API_VERSION}`;

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (/^\s*mutation/i.test(query)) throw new Error('Read-only script: mutations are not allowed');
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    calls.shopifyGql++;
    const res = await axios.post(
      `${shopBase()}/graphql.json`,
      { query, variables },
      {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        timeout: 60000,
        validateStatus: () => true,
      },
    );
    const errors = res.data?.errors as { message: string; extensions?: { code?: string } }[] | undefined;
    const throttled = errors?.some((e) => e.extensions?.code === 'THROTTLED');
    if ((res.status === 429 || res.status >= 500 || throttled) && attempt < 8) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.status !== 200 || errors?.length) {
      throw new Error(`GraphQL ${res.status}: ${JSON.stringify(errors ?? res.data).slice(0, 500)}`);
    }
    return res.data.data as T;
  }
}

async function restGet<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    calls.shopifyRest++;
    try {
      const res = await axios.get(`${shopBase()}${path}`, {
        headers: { 'X-Shopify-Access-Token': token },
        timeout: 60000,
      });
      const [used, max] = String(res.headers['x-shopify-shop-api-call-limit'] ?? '')
        .split('/')
        .map(Number);
      if (used && max && used / max > 0.7) await sleep(1000);
      return res.data as T;
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if ((status === undefined || status === 429 || status >= 500) && attempt < 6) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Chatwoot GET with retries. 422 "request took too long" (search endpoints under load)
 * is retried twice, then returns null so the caller can fall back.
 */
async function cwGet<T>(url: string, params?: Record<string, unknown>): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    calls.chatwoot++;
    try {
      return (await chatwootClient.get<T>(url, { params, timeout: 90000 })).data;
    } catch (err) {
      const status = err instanceof AxiosError ? err.response?.status : undefined;
      const retryable = status === undefined || status === 429 || status >= 500 || status === 422;
      if (retryable && attempt < (status === 422 ? 2 : 5)) {
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      calls.chatwootFailed++;
      if (status === 422 || status === 404) return null;
      throw new Error(`GET ${url} failed: ${status ?? ''} ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T, i);
      }
    }),
  );
  return out;
}

const norm = (e: string | null | undefined) => (e ?? '').trim().toLowerCase();
const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Shopify: money refunds with customer identity
// ---------------------------------------------------------------------------

interface Money {
  amount: string;
  currencyCode: string;
}
interface GRefund {
  id: string;
  createdAt: string;
  totalRefundedSet: { shopMoney: Money; presentmentMoney: Money };
  refundLineItems?: { nodes: unknown[] };
  refundShippingLines?: { nodes: unknown[] };
}
interface GOrder {
  legacyResourceId: string;
  name: string;
  email: string | null;
  test: boolean;
  displayFinancialStatus?: string;
  customer: { legacyResourceId: string; email: string | null } | null;
  totalReceivedSet: { presentmentMoney: Money };
  currentTotalPriceSet?: { presentmentMoney: Money };
  refunds: GRefund[];
}

interface Refund {
  refundId: string;
  orderId: string;
  orderName: string;
  orderNumber: string;
  createdSec: number;
  localDate: string;
  inWindow: boolean;
  amountEur: number;
  presentmentAmount: number;
  currency: string;
  pct: number | null;
  cumPct: number | null;
  bucket: Bucket;
  actor: ActorClass;
  userId: string | null;
  /** In-memory only, never written. */
  emails: Set<string>;
  customerId: string | null;
  /** Refund note reduced to a known short code (free text is never kept). */
  noteCode: string;
}

async function fetchRefunds(fromSec: number, toSec: number, windowFrom: number, windowTo: number): Promise<Refund[]> {
  const query = `
  query O($q: String!, $after: String) {
    orders(first: 50, after: $after, query: $q, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        legacyResourceId name email test displayFinancialStatus
        customer { legacyResourceId email }
        totalReceivedSet { presentmentMoney { amount currencyCode } }
        currentTotalPriceSet { presentmentMoney { amount currencyCode } }
        refunds(first: 20) {
          id createdAt
          totalRefundedSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
          refundLineItems(first: 1) { nodes { quantity } }
          refundShippingLines(first: 1) { nodes { id } }
        }
      }
    }
  }`;
  // Parentheses matter: without them the OR binds to the updated_at term.
  const q = `updated_at:>='${new Date(fromSec * 1000).toISOString()}' AND (financial_status:refunded OR financial_status:partially_refunded)`;
  const orders: GOrder[] = [];
  let after: string | null = null;
  for (;;) {
    const data: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GOrder[] } } =
      await gql(query, { q, after });
    orders.push(...data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }

  const out: Refund[] = [];
  for (const o of orders) {
    if (o.test) continue;
    const base = Number(o.totalReceivedSet.presentmentMoney.amount);
    const money = o.refunds
      .filter((r) => Number(r.totalRefundedSet.shopMoney.amount) > 0)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    let cum = 0;
    for (const [idx, r] of money.entries()) {
      const pres = Number(r.totalRefundedSet.presentmentMoney.amount);
      cum += pres;
      const isFullNow =
        idx === money.length - 1 &&
        o.displayFinancialStatus === 'REFUNDED' &&
        (cum >= base - 0.01 || Number(o.currentTotalPriceSet?.presentmentMoney.amount ?? NaN) === 0);
      const shippingOnly = (r.refundLineItems?.nodes.length ?? 0) === 0 && (r.refundShippingLines?.nodes.length ?? 0) > 0;
      const rawPct = base > 0 ? (pres / base) * 100 : null;
      const rawCumPct = base > 0 ? (cum / base) * 100 : null;
      const createdSec = Math.floor(Date.parse(r.createdAt) / 1000);
      if (createdSec < fromSec || createdSec >= toSec) continue;
      const pct = base > 0 ? round1((pres / base) * 100) : null;
      const cumPct = base > 0 ? round1((cum / base) * 100) : null;
      const emails = new Set<string>();
      if (o.email) emails.add(norm(o.email));
      if (o.customer?.email) emails.add(norm(o.customer.email));
      out.push({
        refundId: r.id.slice(r.id.lastIndexOf('/') + 1),
        orderId: o.legacyResourceId,
        orderName: o.name,
        orderNumber: o.name.replace(/^#/, ''),
        createdSec,
        localDate: localDate(createdSec * 1000, TZ),
        inWindow: createdSec >= windowFrom && createdSec < windowTo,
        amountEur: Number(r.totalRefundedSet.shopMoney.amount),
        presentmentAmount: pres,
        currency: r.totalRefundedSet.presentmentMoney.currencyCode,
        pct,
        cumPct,
        bucket: bucketRefund({ pct: rawPct, cumPct: rawCumPct, isFullNow, shippingOnly }),
        actor: 'unknown',
        userId: null,
        emails,
        customerId: o.customer?.legacyResourceId ?? null,
        noteCode: 'unknown',
      });
    }
  }

  // Actor from REST refunds.json (user_id / source_name); one call per order.
  interface RestRefund {
    id: number;
    note: string | null;
    user_id: number | null;
    transactions: { kind: string; status: string; source_name: string | null }[];
  }
  const orderIds = [...new Set(out.map((r) => r.orderId))];
  const byOrder = new Map<string, RestRefund[]>();
  await mapPool(orderIds, 4, async (id) => {
    const res = await restGet<{ refunds: RestRefund[] }>(`/orders/${id}/refunds.json`);
    byOrder.set(id, res.refunds);
  });
  for (const r of out) {
    const rest = byOrder.get(r.orderId)?.find((x) => String(x.id) === r.refundId);
    if (!rest) continue;
    const userId = rest.user_id === null ? null : String(rest.user_id);
    const source = rest.transactions.find((t) => t.kind === 'refund')?.source_name ?? null;
    r.userId = userId;
    r.noteCode = noteCode(rest.note);
    r.actor = classifyActor({ userId, sourceName: source, note: rest.note }).cls;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chatwoot
// ---------------------------------------------------------------------------

interface CwConversation {
  id: number;
  status: string;
  labels: string[];
  inbox_id: number;
  created_at: number;
  last_activity_at: number;
  meta?: {
    sender?: {
      id?: number;
      email?: string | null;
      custom_attributes?: Record<string, unknown> | null;
    };
  };
}
interface CwMessage {
  id: number;
  message_type: number;
  private: boolean;
  created_at: number;
  content: string | null;
  conversation_id?: number;
}
interface LabelEvent {
  key: string;
  conversationId: number;
  label: string;
  bucket: Bucket;
  ts: number;
  localDate: string;
}

const LABEL_EVENT_RE = /^(.+?) (added|removed) ([a-z0-9_-]+(?:, [a-z0-9_-]+)*)$/;
const hasRefundLabel = (c: CwConversation) => c.labels.some((l) => l in LABEL_BUCKET);

async function fetchConversationsActiveSince(sinceSec: number): Promise<Map<number, CwConversation>> {
  const byId = new Map<number, CwConversation>();
  const pass = async (stopBelow: number) => {
    for (let page = 1; ; page++) {
      const res = await cwGet<{ data: { payload: CwConversation[] } }>('/conversations', {
        status: 'all',
        assignee_type: 'all',
        sort_by: 'last_activity_at_desc',
        page,
      });
      const rows = res?.data.payload ?? [];
      for (const c of rows) {
        if (c.last_activity_at < sinceSec) continue;
        const prev = byId.get(c.id);
        if (!prev || c.last_activity_at >= prev.last_activity_at) byId.set(c.id, c);
      }
      const last = rows[rows.length - 1];
      if (rows.length < 25 || !last || last.last_activity_at < stopBelow) return;
      if (page % 20 === 0) process.stderr.write(`  conversations page ${page} (${byId.size})\n`);
    }
  };
  const pullStart = Math.floor(Date.now() / 1000) - 60;
  await pass(sinceSec);
  await pass(pullStart); // the list shifts while paging; re-scan what moved to the top
  return byId;
}

async function fetchMessagesSince(conversationId: number, sinceSec: number): Promise<CwMessage[]> {
  const all: CwMessage[] = [];
  let before: number | undefined;
  for (;;) {
    const res = await cwGet<{ payload: CwMessage[] }>(
      `/conversations/${conversationId}/messages`,
      before ? { before } : undefined,
    );
    const page = res?.payload ?? [];
    all.push(...page);
    if (page.length < 20) break;
    if (Math.min(...page.map((m) => m.created_at)) < sinceSec) break;
    before = Math.min(...page.map((x) => x.id));
  }
  return all;
}

function labelEventsOf(conversationId: number, msgs: CwMessage[]): LabelEvent[] {
  const out: LabelEvent[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    if (m.message_type !== 2 || !m.content) continue;
    const hit = LABEL_EVENT_RE.exec(m.content.trim());
    if (!hit || hit[2] !== 'added') continue;
    for (const label of (hit[3] as string).split(', ')) {
      const bucket = LABEL_BUCKET[label];
      if (!bucket) continue;
      const key = `${conversationId}:${label}:${m.created_at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, conversationId, label, bucket, ts: m.created_at, localDate: localDate(m.created_at * 1000, TZ) });
    }
  }
  return out;
}

function identityKeys(c: CwConversation): string[] {
  const s = c.meta?.sender;
  const keys: string[] = [];
  if (s?.email) keys.push(`e:${norm(s.email)}`);
  const link = s?.custom_attributes?.shopify_email_link;
  if (typeof link === 'string' && link) keys.push(`e:${norm(link)}`);
  const cid = s?.custom_attributes?.shopify_customer_id;
  if (cid !== undefined && cid !== null && String(cid)) keys.push(`c:${String(cid)}`);
  return keys;
}

function refundKeys(r: Refund): string[] {
  const k = [...r.emails].map((e) => `e:${e}`);
  if (r.customerId) k.push(`c:${r.customerId}`);
  return k;
}

/** Order number mention: 5+ digit numbers with digit boundaries, shorter ones only as "#1234". */
function mentions(content: string, orderNumber: string): boolean {
  const re =
    orderNumber.length >= 5
      ? new RegExp(`(?<![\\d])${orderNumber}(?![\\d])`)
      : new RegExp(`#\\s?${orderNumber}(?![\\d])`);
  return re.test(content);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type RefundCategory =
  | 'matched'
  | 'matched_shared_label'
  | 'bucket_mismatch'
  | 'missed_label'
  | 'no_ticket_near_refund'
  | 'no_conversation';

type LabelCategory =
  | 'matched_support_refund'
  | 'bucket_mismatch_support_refund'
  | 'matched_call_support_refund'
  | 'matched_other_staff_refund'
  | 'matched_chargeflow_refund'
  | 'matched_unknown_actor_refund'
  | 'duplicate_label_refund_already_matched'
  | 'refund_outside_tolerance'
  | 'no_refund_found'
  | 'unidentified_customer';

type MatchVia = 'shopify_customer_id' | 'email' | 'contact_search' | 'order_mention' | 'none';

async function main() {
  const t0 = Date.now();
  const nowSec = Math.floor(Date.now() / 1000);
  const todayLocal = localDate(Date.now(), TZ);
  const startDate = addDays(todayLocal, -DAYS);
  const wFrom = Math.floor(localMidnightUtc(startDate, TZ) / 1000);
  const wTo = INCLUDE_TODAY ? nowSec : Math.floor(localMidnightUtc(todayLocal, TZ) / 1000);
  const endLabel = INCLUDE_TODAY ? todayLocal : addDays(todayLocal, -1);
  // Refunds are fetched with the tolerance on both sides so that labels near the window edges can pair.
  const rFrom = wFrom - TOL_S;
  const rTo = Math.min(wTo + TOL_S, nowSec + 1);
  console.error(
    `Window [${new Date(wFrom * 1000).toISOString()}, ${new Date(wTo * 1000).toISOString()}) = local ${startDate}..${endLabel} (${TZ}); tolerance ±${TOL_H}h`,
  );

  // 1. Shopify refunds
  const refunds = await fetchRefunds(rFrom, rTo, wFrom, wTo);
  console.error(`Shopify: ${refunds.length} money refunds in extended range, ${refunds.filter((r) => r.inWindow).length} in window`);

  // 2. Chatwoot conversations active since (window start - tolerance), identity index
  const convs = await fetchConversationsActiveSince(wFrom - TOL_S);
  console.error(`Chatwoot: ${convs.size} conversations active since window start - ${TOL_H}h`);
  const index = new Map<string, Set<number>>();
  const addToIndex = (c: CwConversation) => {
    for (const k of identityKeys(c)) {
      if (!index.has(k)) index.set(k, new Set());
      index.get(k)!.add(c.id);
    }
  };
  for (const c of convs.values()) addToIndex(c);

  // Per refund: candidate conversations and how they were found
  const candidates = new Map<string, { convIds: Set<number>; via: MatchVia; contactFound: boolean }>();
  for (const r of refunds) {
    const ids = new Set<number>();
    let via: MatchVia = 'none';
    for (const k of refundKeys(r)) {
      for (const id of index.get(k) ?? []) {
        ids.add(id);
        if (via === 'none' || (via === 'email' && k.startsWith('c:'))) via = k.startsWith('c:') ? 'shopify_customer_id' : 'email';
      }
    }
    candidates.set(r.refundId, { convIds: ids, via, contactFound: ids.size > 0 });
  }

  // 3. Fallbacks for STAFF refunds in the window without an identity match:
  //    contact search by email -> contact conversations; then order-number mention search.
  const needFallback = refunds.filter(
    (r) => r.inWindow && STAFF_CLASSES.includes(r.actor) && candidates.get(r.refundId)!.convIds.size === 0,
  );
  const fallbackStats = { refunds: needFallback.length, contactSearchHit: 0, contactSearchWithConversations: 0, contactSearchFailed: 0, orderMentionHit: 0 };
  const extraConvs = new Map<number, CwConversation>();
  await mapPool(needFallback, 3, async (r) => {
    const cand = candidates.get(r.refundId)!;
    for (const email of r.emails) {
      const s = await cwGet<{ payload: { id: number; email: string | null }[] }>('/contacts/search', { q: email });
      if (!s) {
        fallbackStats.contactSearchFailed++;
        continue;
      }
      for (const contact of s.payload.filter((c) => norm(c.email) === email)) {
        cand.contactFound = true;
        const cc = await cwGet<{ payload: CwConversation[] }>(`/contacts/${contact.id}/conversations`);
        for (const c of cc?.payload ?? []) {
          cand.convIds.add(c.id);
          if (!convs.has(c.id)) extraConvs.set(c.id, c);
        }
      }
    }
    if (cand.contactFound) fallbackStats.contactSearchHit++;
    if (cand.convIds.size > 0) {
      fallbackStats.contactSearchWithConversations++;
      cand.via = 'contact_search';
      return;
    }
    const sm = await cwGet<{ payload: { messages: CwMessage[] } }>('/search/messages', { q: r.orderNumber });
    const hits = (sm?.payload.messages ?? []).filter((m) => m.content && mentions(m.content, r.orderNumber));
    const ids = new Set(hits.map((m) => m.conversation_id).filter((x): x is number => typeof x === 'number'));
    if (ids.size > 0) {
      fallbackStats.orderMentionHit++;
      cand.via = 'order_mention';
      cand.contactFound = true;
      for (const id of ids) {
        cand.convIds.add(id);
        if (!convs.has(id) && !extraConvs.has(id)) {
          const c = await cwGet<CwConversation>(`/conversations/${id}`);
          if (c) extraConvs.set(id, c);
        }
      }
    }
  });
  const allConvs = new Map<number, CwConversation>([...convs, ...extraConvs]);
  console.error(
    `Fallbacks: ${needFallback.length} staff refunds; contact search found ${fallbackStats.contactSearchHit} contacts, ${fallbackStats.contactSearchWithConversations} with conversations (failed ${fallbackStats.contactSearchFailed}); order mention found ${fallbackStats.orderMentionHit}`,
  );

  // 4. Label events: messages of every conversation that currently carries a refund-% label
  const msgSince = wFrom - 2 * TOL_S;
  const labelled = [...allConvs.values()].filter(hasRefundLabel);
  const messagesByConv = new Map<number, CwMessage[]>();
  await mapPool(labelled, 6, async (c) => {
    messagesByConv.set(c.id, await fetchMessagesSince(c.id, Math.min(msgSince, c.created_at)));
  });
  const events: LabelEvent[] = [];
  for (const [id, msgs] of messagesByConv) events.push(...labelEventsOf(id, msgs));
  console.error(`Label events: ${events.length} refund-% label additions on ${labelled.length} labelled conversations`);

  // 5. Label side needs identity too: conversations with label events -> refunds via index or order mention
  const refundsByKey = new Map<string, Refund[]>();
  for (const r of refunds) {
    for (const k of refundKeys(r)) {
      if (!refundsByKey.has(k)) refundsByKey.set(k, []);
      refundsByKey.get(k)!.push(r);
    }
  }
  // Pairs (refund, event) that are allowed: same customer, |dt| <= tolerance
  interface Pair {
    r: Refund;
    e: LabelEvent;
    dt: number;
    via: MatchVia;
  }
  const pairs: Pair[] = [];
  const pairSeen = new Set<string>();
  const addPair = (r: Refund, e: LabelEvent, via: MatchVia) => {
    const dt = e.ts - r.createdSec;
    if (Math.abs(dt) > TOL_S) return;
    const k = `${r.refundId}|${e.key}`;
    if (pairSeen.has(k)) return;
    pairSeen.add(k);
    pairs.push({ r, e, dt, via });
  };
  for (const r of refunds) {
    const cand = candidates.get(r.refundId)!;
    for (const e of events) if (cand.convIds.has(e.conversationId)) addPair(r, e, cand.via);
  }
  const eventIdentity = new Map<string, MatchVia>();
  for (const e of events) {
    const c = allConvs.get(e.conversationId);
    if (!c) continue;
    for (const k of identityKeys(c)) {
      for (const r of refundsByKey.get(k) ?? []) addPair(r, e, k.startsWith('c:') ? 'shopify_customer_id' : 'email');
    }
    // Order-number mentions inside the labelled conversation
    for (const m of messagesByConv.get(e.conversationId) ?? []) {
      if (m.message_type === 2 || !m.content) continue;
      for (const r of refunds) if (mentions(m.content, r.orderNumber)) addPair(r, e, 'order_mention');
    }
    eventIdentity.set(e.key, identityKeys(c).length ? 'email' : 'none');
  }

  // 6. Greedy one-to-one assignment: same bucket first, staff before apps, closest in time
  pairs.sort(
    (a, b) =>
      Number(b.r.bucket === b.e.bucket) - Number(a.r.bucket === a.e.bucket) ||
      ACTOR_RANK[a.r.actor] - ACTOR_RANK[b.r.actor] ||
      Math.abs(a.dt) - Math.abs(b.dt),
  );
  const refundMatch = new Map<string, Pair>();
  const eventMatch = new Map<string, Pair>();
  for (const p of pairs) {
    if (refundMatch.has(p.r.refundId) || eventMatch.has(p.e.key)) continue;
    refundMatch.set(p.r.refundId, p);
    eventMatch.set(p.e.key, p);
  }

  // 7. Refund rows (window only)
  const eventsByConvLabel = new Map<string, LabelEvent[]>();
  for (const e of events) {
    const k = `${e.conversationId}:${e.label}`;
    if (!eventsByConvLabel.has(k)) eventsByConvLabel.set(k, []);
    eventsByConvLabel.get(k)!.push(e);
  }
  const refundRows = refunds
    .filter((r) => r.inWindow)
    .sort((a, b) => a.createdSec - b.createdSec)
    .map((r) => {
      const cand = candidates.get(r.refundId)!;
      const p = refundMatch.get(r.refundId);
      const near = [...cand.convIds]
        .map((id) => allConvs.get(id))
        .filter((c): c is CwConversation => !!c && c.created_at <= r.createdSec + TOL_S && c.last_activity_at >= r.createdSec - TOL_S);
      let category: RefundCategory;
      let conversationId: number | null = null;
      let labelBucket: Bucket | null = null;
      let dtHours: number | null = null;
      let otherRefundLabelOnNearConversation: string | null = null;
      if (p) {
        category = p.e.bucket === r.bucket ? 'matched' : 'bucket_mismatch';
        conversationId = p.e.conversationId;
        labelBucket = p.e.bucket;
        dtHours = round1(p.dt / 3600);
      } else {
        // A label is only logged the first time it is added. If a nearby conversation already
        // carried the right label before this refund, no new event could appear.
        const label = Object.keys(LABEL_BUCKET).find((l) => LABEL_BUCKET[l] === r.bucket);
        const existing = label
          ? near.find(
              (c) =>
                c.labels.includes(label) &&
                // added before the refund (or before the fetched message range), or within the
                // tolerance - e.g. one label for several orders refunded together in one ticket
                (eventsByConvLabel.get(`${c.id}:${label}`) ?? []).every((e) => e.ts <= r.createdSec + TOL_S),
            )
          : undefined;
        if (existing) {
          category = 'matched_shared_label';
          conversationId = existing.id;
          labelBucket = r.bucket;
        } else if (near.length > 0) {
          category = 'missed_label';
          const c0 = near.sort((a, b) => b.last_activity_at - a.last_activity_at)[0]!;
          conversationId = c0.id;
          otherRefundLabelOnNearConversation = near.flatMap((c) => c.labels.filter((l) => l in LABEL_BUCKET)).join(',') || null;
        } else if (cand.convIds.size > 0) {
          category = 'no_ticket_near_refund';
        } else {
          category = 'no_conversation';
        }
      }
      return {
        refundId: r.refundId,
        orderName: r.orderName,
        localDate: r.localDate,
        createdAtUtc: new Date(r.createdSec * 1000).toISOString(),
        actor: r.actor,
        amountEur: r.amountEur,
        presentment: `${r.presentmentAmount} ${r.currency}`,
        pct: r.pct,
        cumPct: r.cumPct,
        bucket: r.bucket,
        category,
        matchedVia: p ? p.via : cand.via,
        conversationId,
        labelBucket,
        labelMinusRefundHours: dtHours,
        candidateConversations: cand.convIds.size,
        conversationsNearRefund: near.length,
        otherRefundLabelOnNearConversation,
        contactExistsInChatwoot: cand.contactFound,
        noteCode: r.noteCode,
      };
    });

  // 8. Label rows (events added inside the window)
  const windowEvents = events.filter((e) => e.ts >= wFrom && e.ts < wTo).sort((a, b) => a.ts - b.ts);
  const unmatchedEmails = new Map<string, string[]>(); // eventKey -> emails (memory only)
  for (const e of windowEvents) {
    if (eventMatch.has(e.key)) continue;
    if (pairs.some((q) => q.e.key === e.key)) continue;
    const c = allConvs.get(e.conversationId);
    const emails = (c ? identityKeys(c) : []).filter((k) => k.startsWith('e:')).map((k) => k.slice(2));
    unmatchedEmails.set(e.key, [...new Set(emails)]);
  }
  // Nearest money refund of that customer at ANY time (Shopify orders by email)
  const nearestAnyTime = new Map<string, { hours: number; orderName: string; bucket: Bucket } | null>();
  await mapPool([...unmatchedEmails.entries()], 3, async ([key, emails]) => {
    const e = windowEvents.find((x) => x.key === key)!;
    let best: { hours: number; orderName: string; bucket: Bucket } | null = null;
    for (const email of emails) {
      const data = await gql<{ orders: { nodes: GOrder[] } }>(
        `query E($q: String!) { orders(first: 50, query: $q, sortKey: CREATED_AT, reverse: true) { nodes {
          legacyResourceId name email test customer { legacyResourceId email }
          totalReceivedSet { presentmentMoney { amount currencyCode } }
          refunds(first: 20) { id createdAt totalRefundedSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } } }
        } } }`,
        { q: `email:"${email.replace(/"/g, '')}"` },
      );
      for (const o of data.orders.nodes) {
        const base = Number(o.totalReceivedSet.presentmentMoney.amount);
        let cum = 0;
        for (const rf of [...o.refunds].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
          const pres = Number(rf.totalRefundedSet.presentmentMoney.amount);
          if (Number(rf.totalRefundedSet.shopMoney.amount) <= 0) continue;
          cum += pres;
          const hours = (e.ts - Date.parse(rf.createdAt) / 1000) / 3600;
          if (!best || Math.abs(hours) < Math.abs(best.hours)) {
            best = {
              hours: round1(hours),
              orderName: o.name,
              bucket: bucketRefund({ pct: base > 0 ? (pres / base) * 100 : null, cumPct: base > 0 ? (cum / base) * 100 : null }),
            };
          }
        }
      }
    }
    nearestAnyTime.set(key, emails.length ? best : null);
  });

  const labelRows = windowEvents.map((e) => {
    const p = eventMatch.get(e.key);
    let category: LabelCategory;
    const extra: Record<string, unknown> = {};
    if (p) {
      const byActor: Record<ActorClass, LabelCategory> = {
        support_agent: p.r.bucket === e.bucket ? 'matched_support_refund' : 'bucket_mismatch_support_refund',
        call_support: 'matched_call_support_refund',
        other_staff: 'matched_other_staff_refund',
        unknown_staff: 'matched_other_staff_refund',
        chargeflow_app: 'matched_chargeflow_refund',
        chargeflow_collaborator: 'matched_chargeflow_refund',
        other_app: 'matched_unknown_actor_refund',
        unknown: 'matched_unknown_actor_refund',
      };
      category = byActor[p.r.actor];
      Object.assign(extra, {
        refundId: p.r.refundId,
        orderName: p.r.orderName,
        refundActor: p.r.actor,
        refundBucket: p.r.bucket,
        refundPct: p.r.pct,
        refundInWindow: p.r.inWindow,
        labelMinusRefundHours: round1(p.dt / 3600),
        matchedVia: p.via,
      });
    } else {
      const emails = unmatchedEmails.get(e.key) ?? (pairs.some((q) => q.e.key === e.key) ? ['(paired)'] : []);
      const nearest = nearestAnyTime.get(e.key);
      if (emails.length === 0) category = 'unidentified_customer';
      else if (pairs.some((q) => q.e.key === e.key)) {
        const taken = pairs.filter((q) => q.e.key === e.key).map((q) => refundMatch.get(q.r.refundId)!);
        category = 'duplicate_label_refund_already_matched';
        Object.assign(extra, {
          refundOrders: [...new Set(taken.map((q) => q.r.orderName))],
          refundAlreadyMatchedToConversation: [...new Set(taken.map((q) => q.e.conversationId))],
        });
      } else if (nearest) {
        category = 'refund_outside_tolerance';
        Object.assign(extra, {
          nearestRefundOrder: nearest.orderName,
          labelMinusNearestRefundHours: nearest.hours,
          nearestRefundBucket: nearest.bucket,
        });
      } else category = 'no_refund_found';
    }
    return {
      conversationId: e.conversationId,
      label: e.label,
      localDate: e.localDate,
      addedAtUtc: new Date(e.ts * 1000).toISOString(),
      category,
      ...extra,
    };
  });

  // 9. Aggregates
  type Row = (typeof refundRows)[number];
  const summarize = (rows: Row[]) => {
    const count = (c: RefundCategory) => rows.filter((r) => r.category === c).length;
    const matched = count('matched') + count('matched_shared_label');
    const mismatch = count('bucket_mismatch');
    const missed = count('missed_label');
    const noTicket = count('no_ticket_near_refund');
    const unmatched = count('no_conversation');
    const n = rows.length;
    const rate = (a: number, b: number) => (b > 0 ? round1((a / b) * 100) : null);
    return {
      refunds: n,
      eur: round2(rows.reduce((s, r) => s + r.amountEur, 0)),
      byBucket: Object.fromEntries(
        REFUND_BUCKETS.map((b) => [
          b,
          {
            count: rows.filter((r) => r.bucket === b).length,
            eur: round2(rows.filter((r) => r.bucket === b).reduce((s, r) => s + r.amountEur, 0)),
          },
        ]),
      ),
      categories: {
        matched: count('matched'),
        matched_shared_label: count('matched_shared_label'),
        bucket_mismatch: mismatch,
        missed_label: missed,
        no_ticket_near_refund: noTicket,
        no_conversation: unmatched,
      },
      rates: {
        /** refunds with a label of the right bucket / all refunds */
        correctLabelPct: rate(matched, n),
        /** refunds with any refund-% label / all refunds */
        anyLabelPct: rate(matched + mismatch, n),
        /** refunds with any label / refunds whose customer had a Chatwoot conversation active near the refund */
        anyLabelPctWhereTicketNearRefund: rate(matched + mismatch, matched + mismatch + missed),
        /** of labelled refunds, how many have the right bucket */
        bucketAccuracyPct: rate(matched, matched + mismatch),
      },
    };
  };
  const inWin = refundRows;
  const byActor: Record<string, ReturnType<typeof summarize>> = {};
  for (const a of ACTOR_CLASS_ORDER) {
    const rows = inWin.filter((r) => r.actor === a);
    if (rows.length) byActor[a] = summarize(rows);
  }
  const days: string[] = [];
  for (let d = startDate; d <= endLabel; d = addDays(d, 1)) days.push(d);
  const byDay = days.map((d) => {
    const s = summarize(inWin.filter((r) => r.localDate === d && r.actor === 'support_agent'));
    const lab = labelRows.filter((l) => l.localDate === d);
    return {
      date: d,
      supportRefunds: s.refunds,
      supportEur: s.eur,
      ...s.categories,
      correctLabelPct: s.rates.correctLabelPct,
      anyLabelPct: s.rates.anyLabelPct,
      labelEvents: lab.length,
      labelsMatchedToSupportRefund: lab.filter((l) => l.category === 'matched_support_refund' || l.category === 'bucket_mismatch_support_refund').length,
    };
  });
  const countBy = <T extends Record<string, unknown>>(rows: T[], key: keyof T) =>
    rows.reduce<Record<string, number>>((acc, r) => {
      const k = String(r[key]);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  const mismatchMatrix = countBy(
    refundRows
      .filter((r) => r.actor === 'support_agent' && r.category === 'bucket_mismatch')
      .map((r) => ({ k: `refund ${r.bucket}${r.bucket === 'other' || r.bucket === 'shipping-only' ? ` (${r.pct}%)` : ''} -> label ${r.labelBucket}` })),
    'k',
  );

  const matchedDt = [...refundMatch.values()].map((p) => Math.abs(p.dt)).sort((a, b) => a - b);
  const timing = {
    matchedPairs: matchedDt.length,
    medianAbsSeconds: matchedDt.length ? matchedDt[Math.floor(matchedDt.length / 2)] : null,
    within60s: matchedDt.filter((x) => x <= 60).length,
    within1h: matchedDt.filter((x) => x <= 3600).length,
    within24h: matchedDt.filter((x) => x <= 86400).length,
    labelBeforeRefund: [...refundMatch.values()].filter((p) => p.dt < 0).length,
  };
  const result = {
    generatedAt: new Date().toISOString(),
    runtimeSeconds: Math.round((Date.now() - t0) / 1000),
    window: {
      tz: TZ,
      days: DAYS,
      includeToday: INCLUDE_TODAY,
      startLocal: startDate,
      endLocalInclusive: endLabel,
      fromUtc: new Date(wFrom * 1000).toISOString(),
      toUtc: new Date(wTo * 1000).toISOString(),
      toleranceHours: TOL_H,
    },
    config: {
      rules: 'lib/refundRules.ts (classifyActor, bucketRefund)',
      supportAgentUserIds: Object.entries(STAFF).filter(([, v]) => v.cls === 'support_agent').map(([k]) => k),
      callSupportUserIds: Object.entries(STAFF).filter(([, v]) => v.cls === 'call_support').map(([k]) => k),
      bucketTolerancePp: BUCKET_TOLERANCE_PP,
      fullThresholdPct: FULL_THRESHOLD_PCT,
      pctBase: 'refund presentment / order totalReceivedSet presentment; full also when cumulative % >= 99.5 or the order is fully refunded by this refund',
    },
    inputs: {
      moneyRefundsExtendedRange: refunds.length,
      moneyRefundsInWindow: refundRows.length,
      conversationsActive: convs.size,
      conversationsFromFallback: extraConvs.size,
      labelledConversationsScanned: labelled.length,
      refundLabelEventsFound: events.length,
      refundLabelEventsInWindow: windowEvents.length,
      fallback: fallbackStats,
      apiCalls: calls,
    },
    supportAgent: byActor.support_agent ?? summarize([]),
    /** Refund notes 'remote' / 'hk' mark a workflow that almost never has a ticket (see doc). */
    supportByNoteGroup: {
      remote_or_hk: summarize(inWin.filter((r) => r.actor === 'support_agent' && ['remote', 'hk'].includes(r.noteCode))),
      other_notes: summarize(inWin.filter((r) => r.actor === 'support_agent' && !['remote', 'hk'].includes(r.noteCode))),
    },
    allStaff: summarize(inWin.filter((r) => STAFF_CLASSES.includes(r.actor))),
    byActor,
    supportMatchedVia: countBy(
      refundRows.filter((r) => r.actor === 'support_agent'),
      'matchedVia',
    ),
    supportMismatches: mismatchMatrix,
    supportNoteCodesByCategory: Object.fromEntries(
      [...new Set(refundRows.map((r) => r.category))].map((c) => [
        c,
        countBy(
          refundRows.filter((r) => r.actor === 'support_agent' && r.category === c),
          'noteCode',
        ),
      ]),
    ),
    matchTiming: timing,
    labels: {
      events: windowEvents.length,
      byLabel: countBy(labelRows, 'label'),
      byCategory: countBy(labelRows, 'category'),
    },
    byDay,
    refundRows,
    labelRows,
  };

  // 10. Write
  mkdirSync(OUT_DIR, { recursive: true });
  const stem = `refund-label-reconciliation_${DAYS}d${INCLUDE_TODAY ? '_incl-today' : ''}_${endLabel}`;
  writeFileSync(join(OUT_DIR, `${stem}.json`), JSON.stringify(result, null, 2));

  const s = result.supportAgent;
  const a = result.allStaff;
  const table = (head: string[], rows: (string | number | null)[][]) =>
    [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map((x) => x ?? '').join(' | ')} |`)].join('\n');
  const catRows = (x: typeof s) => Object.entries(x.categories).map(([k, v]) => [k, v]);
  const md = [
    `# Refund <-> label reconciliation, ${startDate}..${endLabel} (${TZ})`,
    '',
    `Generated ${result.generatedAt}. Tolerance ±${TOL_H} h. Money refunds only. Actor from REST refund.user_id.`,
    '',
    `## Support agent (user ${Object.entries(STAFF).filter(([, v]) => v.cls === 'support_agent').map(([k]) => k).join(', ')})`,
    '',
    `${s.refunds} refunds, ${s.eur.toFixed(2)} EUR. Correct label ${s.rates.correctLabelPct ?? '-'}%, any refund label ${s.rates.anyLabelPct ?? '-'}%, any label where a ticket was active near the refund ${s.rates.anyLabelPctWhereTicketNearRefund ?? '-'}%, bucket accuracy ${s.rates.bucketAccuracyPct ?? '-'}%.`,
    '',
    table(['category', 'refunds'], catRows(s)),
    '',
    table(['bucket', 'refunds', 'EUR'], Object.entries(s.byBucket).map(([k, v]) => [k, v.count, v.eur.toFixed(2)])),
    '',
    `Matched via: ${JSON.stringify(result.supportMatchedVia)}. Bucket mismatches: ${JSON.stringify(mismatchMatrix)}`,
    '',
    `Refund note codes by category (support agent): ${JSON.stringify(result.supportNoteCodesByCategory)}`,
    '',
    table(
      ['support refunds by note group', 'refunds', 'EUR', 'correct label %', 'any label %', 'any label % where ticket near refund'],
      Object.entries(result.supportByNoteGroup).map(([k, v]) => [
        k,
        v.refunds,
        v.eur.toFixed(2),
        v.rates.correctLabelPct,
        v.rates.anyLabelPct,
        v.rates.anyLabelPctWhereTicketNearRefund,
      ]),
    ),
    '',
    `## All staff refunds (support + call support + other staff, no apps)`,
    '',
    `${a.refunds} refunds, ${a.eur.toFixed(2)} EUR. Correct label ${a.rates.correctLabelPct ?? '-'}%, any label ${a.rates.anyLabelPct ?? '-'}%.`,
    '',
    table(
      ['actor', 'refunds', 'EUR', ...Object.keys(s.categories), 'any label %'],
      Object.entries(byActor).map(([k, v]) => [k, v.refunds, v.eur.toFixed(2), ...Object.values(v.categories), v.rates.anyLabelPct]),
    ),
    '',
    `## Label events added in the window (${windowEvents.length})`,
    '',
    `By label: ${JSON.stringify(result.labels.byLabel)}`,
    '',
    table(['category', 'label events'], Object.entries(result.labels.byCategory)),
    '',
    '## By day (support agent refunds; label events)',
    '',
    table(
      ['date', 'refunds', 'EUR', 'matched', 'shared label', 'mismatch', 'missed', 'no ticket', 'no conversation', 'correct %', 'labels', 'labels->support refund'],
      byDay.map((d) => [
        d.date,
        d.supportRefunds,
        d.supportEur.toFixed(2),
        d.matched,
        d.matched_shared_label,
        d.bucket_mismatch,
        d.missed_label,
        d.no_ticket_near_refund,
        d.no_conversation,
        d.correctLabelPct,
        d.labelEvents,
        d.labelsMatchedToSupportRefund,
      ]),
    ),
    '',
    `Match timing (all matched pairs in the extended range): ${JSON.stringify(timing)}`,
    '',
    `API calls: ${JSON.stringify(calls)}. Runtime ${result.runtimeSeconds}s.`,
  ].join('\n');
  writeFileSync(join(OUT_DIR, `${stem}.md`), md + '\n');
  console.log(md);
  console.error(`\nWrote ${join(OUT_DIR, stem)}.json/.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

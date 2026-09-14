/**
 * Shopify refund attribution: WHO initiated each refund (READ-ONLY).
 *
 * The app has no `read_users` scope, so GraphQL Refund.staffMember and
 * OrderTransaction.user are denied. This script uses the signals that ARE
 * available:
 *
 *   1. REST  GET /orders/{id}/refunds.json
 *        refund.user_id              staff user id (null when an app refunded)
 *        transactions[].source_name  API client id of the channel
 *                                    '1830279' = Shopify admin web (a person)
 *                                    '4704285' = Chargeflow app
 *        transactions[].status       success | failure | pending
 *        note                        Chargeflow alert references (Ethoca / CDRN)
 *   2. GraphQL root `events` (action:refund_created ...)
 *        store-wide enumeration of refunds (retention ~90 days) and the actor
 *        display name ("<Actor> refunded N items.") / appTitle
 *   3. GraphQL nodes(ids) on Order -> transactions amountSet.shopMoney (EUR)
 *   4. GraphQL shopifyPaymentsAccount.disputes -> dispute overlay
 *
 * Only GraphQL queries (no mutations) and REST GETs are sent.
 *
 * Usage:
 *   npx tsx src/scripts/analytics/refundAttribution.ts [--days=7] [--tz=Europe/Helsinki]
 *       [--out=/home/dolan/support-analytics] [--include-today] [--enumerate=events|orders]
 *
 *   --days=N          number of complete local days ending at local midnight today (default 7)
 *   --include-today   extend the window end to "now" (partial current day)
 *   --enumerate       'events' (default while the window is inside the ~90 day event
 *                     retention) or 'orders' (orders search fallback for older windows)
 *
 * Output:
 *   stdout                                              summary tables
 *   <out>/refund-attribution_<days>d_<endDate>.json     aggregates + one row per refund
 *   <out>/refund-attribution_<days>d_<endDate>.md       markdown summary
 *
 * Rows contain ids, order numbers, amounts, staff first names and actor classes only.
 * Event messages, refund note text, payment_details and customer data are never stored.
 */
import 'dotenv/config';
import axios from 'axios';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../../config/env.js';
import { getAccessToken } from '../../services/shopifyAuth.js';
import {
  ACTOR_CLASS_ORDER,
  ALERT_NOTE_RE,
  APP_SOURCES,
  CHARGEFLOW_COLLABORATOR_IDS,
  SOURCE_ADMIN_WEB,
  STAFF,
  classifyActor,
  type ActorClass,
} from './lib/refundRules.js';

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
const ENUMERATE_FLAG = flag('enumerate');

const API_VERSION = '2026-01';
/** Events older than this are gone (observed rolling ~90 days); stay on the safe side. */
const EVENT_RETENTION_DAYS = 85;

// ---------------------------------------------------------------------------
// Attribution configuration (edit here, not in the logic)
// ---------------------------------------------------------------------------

// The canonical rules (actor classes, staff map, Chargeflow ids, alert-note regex) live in lib/refundRules.ts and are
// shared with shopifyRefunds.ts and refundLabelReconciliation.ts.
export type { ActorClass } from './lib/refundRules.js';
const CHARGEFLOW_NOTE_RE = /chargeflow/i;
const CLASS_ORDER: ActorClass[] = ACTOR_CLASS_ORDER;

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

function localDate(utcMs: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(utcMs),
  );
}

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
// Shopify transport (read-only)
// ---------------------------------------------------------------------------

const base = () => `https://${env.shopifyStoreDomain}/admin/api/${API_VERSION}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let restCalls = 0;
let gqlCalls = 0;

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (/^\s*mutation/i.test(query)) throw new Error('Read-only script: mutations are not allowed');
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    gqlCalls++;
    const res = await axios.post(
      `${base()}/graphql.json`,
      { query, variables },
      {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        timeout: 60000,
        validateStatus: () => true,
      },
    );
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 8) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new Error(`GraphQL HTTP ${res.status}`);
    }
    const errors = res.data?.errors as { message: string; extensions?: { code?: string } }[] | undefined;
    if (errors?.length) {
      if (errors.some((e) => e.extensions?.code === 'THROTTLED') && attempt < 8) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new Error(`GraphQL error: ${JSON.stringify(errors)}`);
    }
    const avail = res.data.extensions?.cost?.throttleStatus?.currentlyAvailable as number | undefined;
    if (avail !== undefined && avail < 300) await sleep(2000);
    return res.data.data as T;
  }
}

async function restGet<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    restCalls++;
    try {
      const res = await axios.get(`${base()}${path}`, {
        headers: { 'X-Shopify-Access-Token': token },
        timeout: 60000,
      });
      // Leaky bucket: back off when the bucket is getting full.
      const limit = String(res.headers['x-shopify-shop-api-call-limit'] ?? '');
      const [used, max] = limit.split('/').map(Number);
      if (used && max && used / max > 0.7) await sleep(1000);
      return res.data as T;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 429 && attempt < 8) {
        await sleep(Number(err.response.headers['retry-after'] ?? 2) * 1000);
        continue;
      }
      throw err;
    }
  }
}

/** Runs `fn` over items with a small concurrency limit. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

const legacyId = (gid: string) => gid.slice(gid.lastIndexOf('/') + 1);

// ---------------------------------------------------------------------------
// 1. Enumerate refund events store-wide (GraphQL root events)
// ---------------------------------------------------------------------------

interface RefundEvent {
  createdAtMs: number;
  action: string;
  orderId: string;
  orderName: string;
  appTitle: string | null;
  attributeToUser: boolean;
  /** Text before " refunded " in the message; null when the message does not name an actor. */
  actorName: string | null;
  /** arguments[0] (transaction id) for refund_success / refund_pending / refund_failure. */
  txId: string | null;
  /** arguments[1] = refund amount in shop currency (EUR) for refund_success. */
  shopAmount: number | null;
}

const EVENTS_QUERY = `
query RefundEvents($q: String!, $after: String) {
  events(first: 250, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      createdAt action appTitle attributeToUser message
      ... on BasicEvent {
        arguments
        subject { ... on Order { legacyResourceId name } }
      }
    }
  }
}`;

interface GEvent {
  createdAt: string;
  action: string;
  appTitle: string | null;
  attributeToUser: boolean;
  message: string;
  arguments?: unknown;
  subject?: { legacyResourceId?: string; name?: string } | null;
}

async function fetchRefundEvents(action: string, fromIso: string, toIso: string): Promise<RefundEvent[]> {
  const q = `action:${action} AND created_at:>='${fromIso}' AND created_at:<'${toIso}'`;
  const out: RefundEvent[] = [];
  let after: string | null = null;
  for (;;) {
    const data: { events: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GEvent[] } } =
      await gql(EVENTS_QUERY, { q, after });
    for (const n of data.events.nodes) {
      if (!n.subject?.legacyResourceId) continue;
      const args = Array.isArray(n.arguments) ? (n.arguments as unknown[]) : [];
      // Only the actor prefix is kept; the rest of the message (card digits etc.) is dropped.
      const m = /^(.+?) refunded /.exec(n.message ?? '');
      out.push({
        createdAtMs: Date.parse(n.createdAt),
        action: n.action,
        orderId: n.subject.legacyResourceId,
        orderName: n.subject.name ?? '',
        appTitle: n.appTitle,
        attributeToUser: n.attributeToUser,
        actorName: m ? (m[1] as string) : null,
        txId: args.length > 0 && args[0] !== null && args[0] !== undefined ? String(args[0]) : null,
        shopAmount: args.length > 1 && !Number.isNaN(Number(args[1])) ? Number(args[1]) : null,
      });
    }
    if (!data.events.pageInfo.hasNextPage) break;
    after = data.events.pageInfo.endCursor;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1b. Fallback enumeration beyond event retention (orders search)
// ---------------------------------------------------------------------------

async function fetchOrderIdsByOrdersSearch(fromIso: string, toMs: number, fromMs: number): Promise<string[]> {
  // Parentheses matter: without them the OR binds wrongly and ~1/3 of orders are missed.
  // Orders whose only refund FAILED can be missed (financial status unchanged) - they move no money.
  const q = `updated_at:>='${fromIso}' AND (financial_status:partially_refunded OR financial_status:refunded)`;
  const query = `
  query O($q: String!, $after: String) {
    orders(first: 100, after: $after, query: $q, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { legacyResourceId refunds(first: 20) { createdAt } }
    }
  }`;
  const ids: string[] = [];
  let after: string | null = null;
  for (;;) {
    const data: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { legacyResourceId: string; refunds: { createdAt: string }[] }[];
      };
    } = await gql(query, { q, after });
    for (const o of data.orders.nodes) {
      if (o.refunds.some((r) => Date.parse(r.createdAt) >= fromMs && Date.parse(r.createdAt) < toMs)) {
        ids.push(o.legacyResourceId);
      }
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 2. REST refunds per order (user_id, source_name, status, note)
// ---------------------------------------------------------------------------

interface RestTx {
  id: number;
  kind: string;
  status: string;
  gateway: string;
  amount: string;
  currency: string;
  user_id: number | null;
  source_name: string | null;
  parent_id: number | null;
}
interface RestRefund {
  id: number;
  order_id: number;
  created_at: string;
  note: string | null;
  user_id: number | null;
  refund_line_items: unknown[];
  transactions: RestTx[];
}

// ---------------------------------------------------------------------------
// 3. Orders via GraphQL nodes(): name, shop-currency transaction amounts
// ---------------------------------------------------------------------------

interface GOrderInfo {
  legacyResourceId: string;
  name: string;
  totalReceivedSet: { presentmentMoney: { amount: string; currencyCode: string } };
  originalTotalPriceSet: { presentmentMoney: { amount: string; currencyCode: string } };
  transactions: {
    id: string;
    kind: string;
    status: string;
    amountSet: { shopMoney: { amount: string; currencyCode: string } };
  }[];
}

async function fetchOrderInfo(orderIds: string[]): Promise<Map<string, GOrderInfo>> {
  const query = `
  query Orders($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        legacyResourceId name
        totalReceivedSet { presentmentMoney { amount currencyCode } }
        originalTotalPriceSet { presentmentMoney { amount currencyCode } }
        transactions(first: 100) { id kind status amountSet { shopMoney { amount currencyCode } } }
      }
    }
  }`;
  const out = new Map<string, GOrderInfo>();
  for (let i = 0; i < orderIds.length; i += 25) {
    const ids = orderIds.slice(i, i + 25).map((id) => `gid://shopify/Order/${id}`);
    const data: { nodes: (GOrderInfo | null)[] } = await gql(query, { ids });
    for (const n of data.nodes) if (n?.legacyResourceId) out.set(n.legacyResourceId, n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Disputes (GraphQL; REST disputes endpoint is 403 without read_shopify_payments_disputes)
// ---------------------------------------------------------------------------

interface Dispute {
  id: string;
  type: string;
  status: string;
  reason: string | null;
  initiatedAtMs: number;
  orderId: string | null;
}

async function fetchDisputes(sinceIso: string): Promise<Dispute[]> {
  const query = `
  query D($q: String!, $after: String) {
    shopifyPaymentsAccount {
      disputes(first: 100, after: $after, query: $q) {
        pageInfo { hasNextPage endCursor }
        nodes { id type status initiatedAt reasonDetails { reason } order { legacyResourceId } }
      }
    }
  }`;
  const out: Dispute[] = [];
  let after: string | null = null;
  for (;;) {
    const data: {
      shopifyPaymentsAccount: {
        disputes: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            id: string;
            type: string;
            status: string;
            initiatedAt: string;
            reasonDetails: { reason: string | null } | null;
            order: { legacyResourceId: string } | null;
          }[];
        };
      } | null;
    } = await gql(query, { q: `initiated_at:>='${sinceIso}'`, after });
    const conn = data.shopifyPaymentsAccount?.disputes;
    if (!conn) break;
    for (const d of conn.nodes) {
      out.push({
        id: legacyId(d.id),
        type: d.type,
        status: d.status,
        reason: d.reasonDetails?.reason ?? null,
        initiatedAtMs: Date.parse(d.initiatedAt),
        orderId: d.order?.legacyResourceId ?? null,
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type RefundState = 'success' | 'failed' | 'pending';

interface RefundRow {
  refundId: string;
  orderId: string;
  orderName: string;
  createdAtUtc: string;
  localDate: string;
  state: RefundState;
  userId: string | null;
  sourceName: string | null;
  actorClass: ActorClass;
  actorLabel: string;
  /** How the class was decided (for auditing). */
  rule: string;
  /** Actor prefix of the matching refund_created event, redacted when it looks like an email. */
  eventActor: string | null;
  eventAppTitle: string | null;
  txCount: number;
  /** Sum of successful refund transactions in shop currency (EUR). 0 for failed/pending. */
  amountShop: number;
  /** Amount attempted in shop currency (all refund transactions, any status). */
  attemptedShop: number;
  presentmentAmount: number;
  presentmentCurrency: string;
  /** Successful presentment refund amount / order totalReceived (presentment), in %. */
  pctOfOrderTotal: number | null;
  lineItemsRefunded: number;
  noteKind: 'none' | 'alert_ref' | 'chargeflow' | 'text';
  orderHasDispute: boolean;
  disputeBeforeRefund: boolean;
  disputeSummary: string | null;
}

function redactActor(name: string | null): string | null {
  if (!name) return null;
  if (/@/.test(name)) return '<email-named account>';
  if (/^Chargeflow/i.test(name)) return name;
  // Staff: keep first name only.
  return name.split(/\s+/)[0] ?? null;
}

function classify(
  userId: string | null,
  sourceName: string | null,
  note: string | null,
  ev: RefundEvent | undefined,
): { cls: ActorClass; label: string; rule: string } {
  return classifyActor({
    userId,
    sourceName,
    note,
    eventAppTitle: ev?.appTitle ?? null,
    // Full name only for the "Chargeflow, Inc." prefix rule; the unknown-staff label gets the redacted form.
    eventActorName: ev?.actorName && /^Chargeflow, Inc\./.test(ev.actorName) ? ev.actorName : redactActor(ev?.actorName ?? null),
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const todayLocal = localDate(Date.now(), TZ);
  const startDate = addDays(todayLocal, -DAYS);
  const fromMs = localMidnightUtc(startDate, TZ);
  const toMs = INCLUDE_TODAY ? Date.now() : localMidnightUtc(todayLocal, TZ);
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  const endLabel = INCLUDE_TODAY ? todayLocal : addDays(todayLocal, -1);

  const eventsAvailable = Date.now() - fromMs < EVENT_RETENTION_DAYS * 86400000;
  const enumerate = (ENUMERATE_FLAG ?? (eventsAvailable ? 'events' : 'orders')) as 'events' | 'orders';
  console.error(`Window [${fromIso}, ${toIso}) = local ${startDate} .. ${endLabel} (${TZ}); enumerate=${enumerate}`);

  // Shop facts
  const shop = await gql<{ shop: { currencyCode: string; ianaTimezone: string; plan: { displayName: string } } }>(
    `{ shop { currencyCode ianaTimezone plan { displayName } } }`,
  );

  // Events: margin of 10 minutes around the window so boundary refunds still find their event.
  const margin = 10 * 60000;
  const evFrom = new Date(fromMs - margin).toISOString();
  const evTo = new Date(toMs + margin).toISOString();
  let created: RefundEvent[] = [];
  let txEvents: RefundEvent[] = [];
  if (eventsAvailable) {
    created = await fetchRefundEvents('refund_created', evFrom, evTo);
    for (const action of ['refund_success', 'refund_pending', 'refund_failure']) {
      txEvents.push(...(await fetchRefundEvents(action, evFrom, evTo)));
    }
    console.error(`events: refund_created=${created.length}, tx events=${txEvents.length}`);
  } else {
    console.error('window starts beyond event retention: no event actor names / appTitles available');
  }

  let orderIds: string[];
  if (enumerate === 'events') {
    orderIds = [...new Set(created.map((e) => e.orderId))];
  } else {
    orderIds = await fetchOrderIdsByOrdersSearch(fromIso, toMs, fromMs);
  }
  console.error(`orders to inspect: ${orderIds.length}`);

  // REST refunds (concurrency 2 keeps well under the leaky bucket)
  const restByOrder = new Map<string, RestRefund[]>();
  await mapLimit(orderIds, 2, async (id) => {
    const r = await restGet<{ refunds: RestRefund[] }>(`/orders/${id}/refunds.json`);
    restByOrder.set(id, r.refunds);
  });

  const orderInfo = await fetchOrderInfo(orderIds);
  const disputes = await fetchDisputes(new Date(fromMs - 180 * 86400000).toISOString());
  const disputesByOrder = new Map<string, Dispute[]>();
  for (const d of disputes) {
    if (!d.orderId) continue;
    disputesByOrder.set(d.orderId, [...(disputesByOrder.get(d.orderId) ?? []), d]);
  }

  // Index events
  const createdByOrder = new Map<string, RefundEvent[]>();
  for (const e of created) createdByOrder.set(e.orderId, [...(createdByOrder.get(e.orderId) ?? []), e]);
  const txEventById = new Map<string, RefundEvent[]>();
  for (const e of txEvents) if (e.txId) txEventById.set(e.txId, [...(txEventById.get(e.txId) ?? []), e]);

  const rows: RefundRow[] = [];
  let zeroAmountRefunds = 0;
  const usedCreated = new Set<RefundEvent>();

  for (const orderId of orderIds) {
    const info = orderInfo.get(orderId);
    const shopTx = new Map<string, number>();
    for (const t of info?.transactions ?? []) shopTx.set(legacyId(t.id), Number(t.amountSet.shopMoney.amount));

    for (const rf of restByOrder.get(orderId) ?? []) {
      const createdMs = Date.parse(rf.created_at);
      if (createdMs < fromMs || createdMs >= toMs) continue;
      const refundTx = rf.transactions.filter((t) => t.kind === 'refund');
      if (refundTx.length === 0) {
        // Order-edit / restock-only refunds (Aftersell upsells, staff edits): no money moved.
        zeroAmountRefunds++;
        continue;
      }
      const ok = refundTx.filter((t) => t.status === 'success');
      const state: RefundState = ok.length > 0 ? 'success' : refundTx.some((t) => t.status === 'pending') ? 'pending' : 'failed';
      const userId = rf.user_id === null ? null : String(rf.user_id);
      const sourceName = refundTx[0]?.source_name ?? null;

      // Event join: exact via transaction id (actor-attributed pending/success events), else refund_created by time.
      let actorEv: RefundEvent | undefined;
      for (const t of refundTx) {
        const hit = (txEventById.get(String(t.id)) ?? []).find((e) => e.actorName && (e.attributeToUser || e.appTitle !== 'Shopify Web'));
        if (hit) {
          actorEv = hit;
          break;
        }
      }
      const candidates = (createdByOrder.get(orderId) ?? [])
        .filter((e) => Math.abs(e.createdAtMs - createdMs) <= 120000 && !usedCreated.has(e))
        .sort((a, b) => Math.abs(a.createdAtMs - createdMs) - Math.abs(b.createdAtMs - createdMs));
      const createdEv = candidates[0];
      if (createdEv) usedCreated.add(createdEv);
      const ev = createdEv ?? actorEv;
      const eventActor = ev?.actorName ?? actorEv?.actorName ?? null;

      const { cls, label, rule } = classify(userId, sourceName, rf.note, ev ? { ...ev, actorName: eventActor } : undefined);

      const shopAmountOf = (t: RestTx): number => {
        const g = shopTx.get(String(t.id));
        if (g !== undefined) return g;
        const e = (txEventById.get(String(t.id)) ?? []).find((x) => x.action === 'refund_success' && x.shopAmount !== null);
        return e?.shopAmount ?? 0;
      };
      const amountShop = round2(ok.reduce((s, t) => s + shopAmountOf(t), 0));
      const attemptedShop = round2(refundTx.reduce((s, t) => s + shopAmountOf(t), 0));
      const presentmentAmount = round2(ok.reduce((s, t) => s + Number(t.amount), 0));
      // Base = money captured (see docs/support-analytics/shopify-refunds.md); totalPriceSet is wrong on edited orders.
      const orderTotal =
        Number(info?.totalReceivedSet.presentmentMoney.amount ?? 0) ||
        Number(info?.originalTotalPriceSet.presentmentMoney.amount ?? 0);

      const ds = disputesByOrder.get(orderId) ?? [];
      const before = ds.filter((d) => d.initiatedAtMs <= createdMs);
      const note = rf.note ?? '';
      rows.push({
        refundId: String(rf.id),
        orderId,
        orderName: info?.name ?? '',
        createdAtUtc: new Date(createdMs).toISOString(),
        localDate: localDate(createdMs, TZ),
        state,
        userId,
        sourceName,
        actorClass: cls,
        actorLabel: label,
        rule,
        eventActor: redactActor(eventActor),
        eventAppTitle: ev?.appTitle ?? null,
        txCount: refundTx.length,
        amountShop,
        attemptedShop,
        presentmentAmount,
        presentmentCurrency: refundTx[0]?.currency ?? '',
        pctOfOrderTotal: orderTotal > 0 && state === 'success' ? round2((presentmentAmount / orderTotal) * 100) : null,
        lineItemsRefunded: rf.refund_line_items.length,
        noteKind: !note ? 'none' : ALERT_NOTE_RE.test(note) ? 'alert_ref' : CHARGEFLOW_NOTE_RE.test(note) ? 'chargeflow' : 'text',
        orderHasDispute: ds.length > 0,
        disputeBeforeRefund: before.length > 0,
        disputeSummary: ds.length ? ds.map((d) => `${d.type} ${d.status}${d.reason ? ` ${d.reason}` : ''}`).join('; ') : null,
      });
    }
  }
  rows.sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));

  // ---------------------------------------------------------------------------
  // Aggregates
  // ---------------------------------------------------------------------------
  const success = rows.filter((r) => r.state === 'success');
  const byClass = CLASS_ORDER.map((cls) => {
    const s = success.filter((r) => r.actorClass === cls);
    const f = rows.filter((r) => r.actorClass === cls && r.state !== 'success');
    return {
      actorClass: cls,
      refunds: s.length,
      amountShop: round2(s.reduce((x, r) => x + r.amountShop, 0)),
      failedOrPending: f.length,
      failedOrPendingAttemptedShop: round2(f.reduce((x, r) => x + r.attemptedShop, 0)),
    };
  }).filter((c) => c.refunds > 0 || c.failedOrPending > 0);

  const actorKey = (r: RefundRow) => `${r.actorClass}|${r.userId ?? `source:${r.sourceName}`}|${r.actorLabel}`;
  const byActorMap = new Map<string, { actorClass: ActorClass; userId: string | null; sourceName: string | null; label: string; eventActors: Set<string>; refunds: number; amountShop: number; failedOrPending: number }>();
  for (const r of rows) {
    const k = actorKey(r);
    const a = byActorMap.get(k) ?? {
      actorClass: r.actorClass,
      userId: r.userId,
      sourceName: r.sourceName,
      label: r.actorLabel,
      eventActors: new Set<string>(),
      refunds: 0,
      amountShop: 0,
      failedOrPending: 0,
    };
    if (r.eventActor) a.eventActors.add(r.eventActor);
    if (r.state === 'success') {
      a.refunds++;
      a.amountShop = round2(a.amountShop + r.amountShop);
    } else a.failedOrPending++;
    byActorMap.set(k, a);
  }
  const byActor = [...byActorMap.values()]
    .map((a) => ({ ...a, eventActors: [...a.eventActors] }))
    .sort((a, b) => b.refunds - a.refunds);

  const days: string[] = [];
  for (let d = startDate; d <= endLabel; d = addDays(d, 1)) days.push(d);
  const byDay = days.map((d) => {
    const s = success.filter((r) => r.localDate === d);
    const entry: Record<string, number | string> = { date: d, refunds: s.length, amountShop: round2(s.reduce((x, r) => x + r.amountShop, 0)) };
    for (const cls of CLASS_ORDER) {
      const c = s.filter((r) => r.actorClass === cls);
      if (c.length) {
        entry[`${cls}_refunds`] = c.length;
        entry[`${cls}_amountShop`] = round2(c.reduce((x, r) => x + r.amountShop, 0));
      }
    }
    return entry;
  });

  const totals = {
    refunds: success.length,
    orders: new Set(success.map((r) => r.orderId)).size,
    amountShop: round2(success.reduce((x, r) => x + r.amountShop, 0)),
    failed: rows.filter((r) => r.state === 'failed').length,
    pending: rows.filter((r) => r.state === 'pending').length,
    zeroAmountRefundsExcluded: zeroAmountRefunds,
    refundsOnDisputedOrders: success.filter((r) => r.orderHasDispute).length,
    refundsAfterDisputeOpened: success.filter((r) => r.disputeBeforeRefund).length,
    chargeflowRefundsWithAlertNote: success.filter((r) => r.noteKind === 'alert_ref').length,
    unmappedStaffIds: [...new Set(rows.filter((r) => r.actorClass === 'unknown_staff').map((r) => r.userId))],
    refundCreatedEventsWithoutRestRefund: created.filter(
      (e) => !usedCreated.has(e) && e.createdAtMs >= fromMs && e.createdAtMs < toMs,
    ).length,
  };

  const result = {
    generatedAt: new Date().toISOString(),
    window: { tz: TZ, startLocal: startDate, endLocalInclusive: endLabel, fromUtc: fromIso, toUtcExclusive: toIso, days: DAYS, includeToday: INCLUDE_TODAY },
    method: { enumerate, eventsAvailable, restCalls, gqlCalls },
    shop: { currency: shop.shop.currencyCode, timezone: shop.shop.ianaTimezone, plan: shop.shop.plan.displayName },
    config: { STAFF, CHARGEFLOW_COLLABORATOR_IDS: [...CHARGEFLOW_COLLABORATOR_IDS], APP_SOURCES, SOURCE_ADMIN_WEB },
    totals,
    byClass,
    byActor,
    byDay,
    rows,
  };

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------
  const cur = shop.shop.currencyCode;
  const classTable = [
    `| Actor class | Refunds | ${cur} | Share of ${cur} | Failed/pending (not counted) |`,
    '|---|---:|---:|---:|---:|',
    ...byClass.map(
      (c) =>
        `| ${c.actorClass} | ${c.refunds} | ${fmt(c.amountShop)} | ${totals.amountShop ? ((c.amountShop / totals.amountShop) * 100).toFixed(1) : '0.0'}% | ${c.failedOrPending}${c.failedOrPending ? ` (${fmt(c.failedOrPendingAttemptedShop)})` : ''} |`,
    ),
    `| **total** | **${totals.refunds}** | **${fmt(totals.amountShop)}** | 100% | ${totals.failed + totals.pending} |`,
  ];
  const actorTable = [
    '| Actor | Class | user_id / source | Event actor | Refunds | ' + cur + ' | Failed/pending |',
    '|---|---|---|---|---:|---:|---:|',
    ...byActor.map(
      (a) =>
        `| ${a.label} | ${a.actorClass} | ${a.userId ?? `source ${a.sourceName}`} | ${a.eventActors.join(', ') || '-'} | ${a.refunds} | ${fmt(a.amountShop)} | ${a.failedOrPending} |`,
    ),
  ];
  const dayCols = CLASS_ORDER.filter((c) => byClass.some((b) => b.actorClass === c));
  const dayTable = [
    `| Date (${TZ}) | Refunds | ${cur} | ${dayCols.join(' | ')} |`,
    `|---|---:|---:|${dayCols.map(() => '---:').join('|')}|`,
    ...byDay.map(
      (d) =>
        `| ${d.date} | ${d.refunds} | ${fmt(Number(d.amountShop))} | ${dayCols.map((c) => `${d[`${c}_refunds`] ?? 0} / ${fmt(Number(d[`${c}_amountShop`] ?? 0))}`).join(' | ')} |`,
    ),
  ];

  const md = [
    `# Refund attribution, ${startDate} .. ${endLabel} (${TZ})`,
    '',
    `Generated ${result.generatedAt} by src/scripts/analytics/refundAttribution.ts. Window [${fromIso}, ${toIso}). Shop currency ${cur}, plan ${result.shop.plan}. Enumeration: ${enumerate}.`,
    '',
    'Counted: Refund objects created in the window with at least one successful refund transaction. Amount = sum of successful refund transactions in shop currency.',
    '',
    '## By actor class',
    '',
    ...classTable,
    '',
    '## By actor',
    '',
    ...actorTable,
    '',
    '## By day (refunds / amount per class)',
    '',
    ...dayTable,
    '',
    '## Checks',
    '',
    `- Distinct orders with a counted refund: ${totals.orders}`,
    `- Failed refunds (not counted): ${totals.failed}; pending: ${totals.pending}`,
    `- Zero-amount refunds excluded (order edits, no refund transaction): ${totals.zeroAmountRefundsExcluded} (only those on enumerated orders)`,
    `- Counted refunds on orders with a Shopify Payments dispute: ${totals.refundsOnDisputedOrders} (dispute opened before the refund: ${totals.refundsAfterDisputeOpened})`,
    `- Refunds whose note carries an Ethoca/CDRN alert reference: ${totals.chargeflowRefundsWithAlertNote}`,
    `- Unmapped staff user ids: ${totals.unmappedStaffIds.length ? totals.unmappedStaffIds.join(', ') : 'none'}`,
    `- refund_created events in the window with no matching counted/failed REST refund (in orders mode, orders whose only refunds failed are not enumerated): ${totals.refundCreatedEventsWithoutRestRefund}`,
    `- API calls: REST ${restCalls}, GraphQL ${gqlCalls}`,
    '',
  ].join('\n');

  mkdirSync(OUT_DIR, { recursive: true });
  const stem = `refund-attribution_${DAYS}d${INCLUDE_TODAY ? '_incl-today' : ''}_${endLabel}`;
  writeFileSync(join(OUT_DIR, `${stem}.json`), JSON.stringify(result, null, 2));
  writeFileSync(join(OUT_DIR, `${stem}.md`), md);

  console.log(md);
  console.log(`Wrote ${join(OUT_DIR, `${stem}.json`)} and .md`);
}

main().catch((err) => {
  console.error(axios.isAxiosError(err) ? { status: err.response?.status, data: err.response?.data } : err);
  process.exit(1);
});

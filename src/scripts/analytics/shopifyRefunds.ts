/**
 * Shopify refunds analytics (READ-ONLY).
 *
 * Lists every money refund created in the last N local days (default timezone
 * Europe/Helsinki) and reports counts, EUR sums, per-currency sums, partial
 * refund percentages bucketed into full / ~30 / ~50 / ~70 / shipping-only /
 * other, and who issued each refund (staff user id or app).
 *
 * Only GraphQL queries (no mutations) and REST GETs are sent.
 *
 * Usage:
 *   npx tsx src/scripts/analytics/shopifyRefunds.ts [--days=7] [--tz=Europe/Helsinki]
 *       [--out=/home/dolan/support-analytics] [--no-rest] [--no-reconcile]
 *
 * Output:
 *   stdout                      summary tables
 *   <out>/shopify-refunds-<days>d-<YYYY-MM-DD>.json   aggregates + refund rows
 *   <out>/shopify-refunds-<days>d-<YYYY-MM-DD>.md     markdown summary
 *
 * Rows contain order numbers, amounts and ids only. Customer data and free-text
 * event messages / refund notes are never stored (they can contain PII).
 */
import 'dotenv/config';
import axios from 'axios';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../../config/env.js';
import { getAccessToken } from '../../services/shopifyAuth.js';
import {
  ACTOR_CLASS_ORDER,
  ACTOR_GROUP,
  BUCKET_TOLERANCE_PP,
  REFUND_BUCKETS,
  bucketRefund,
  classifyActor,
  type ActorClass,
  type RefundBucket,
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
const USE_REST = flag('no-rest') === undefined;
const RECONCILE = flag('no-reconcile') === undefined;

const API_VERSION = '2026-01';
// Buckets and initiator classes come from lib/refundRules.ts (shared with refundAttribution.ts and
// refundLabelReconciliation.ts): +/-5 pp tolerance, one 'full' bucket, REST user_id/source_name attribution.

// ---------------------------------------------------------------------------
// Timezone helpers (no external library; Intl handles DST)
// ---------------------------------------------------------------------------

/** Offset of `tz` from UTC at instant `utcMs`, in minutes (Helsinki summer = +180). */
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

/** Local calendar date (YYYY-MM-DD) of an instant in `tz`. */
function localDate(utcMs: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(utcMs),
  );
}

/** UTC instant of local midnight at the start of `ymd` in `tz`. */
function localMidnightUtc(ymd: string, tz: string): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  let guess = Date.UTC(y, m - 1, d);
  // Two passes converge across DST transitions.
  for (let i = 0; i < 2; i++) guess = Date.UTC(y, m - 1, d) - tzOffsetMinutes(guess, tz) * 60000;
  return guess;
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Shopify transport
// ---------------------------------------------------------------------------

const base = () => `https://${env.shopifyStoreDomain}/admin/api/${API_VERSION}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (/^\s*mutation/i.test(query)) throw new Error('Read-only script: mutations are not allowed');
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    const res = await axios.post(
      `${base()}/graphql.json`,
      { query, variables },
      { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 60000 },
    );
    const errors = res.data.errors as { message: string; extensions?: { code?: string } }[] | undefined;
    if (errors?.length) {
      if (errors.some((e) => e.extensions?.code === 'THROTTLED') && attempt < 8) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new Error(`GraphQL error: ${JSON.stringify(errors)}`);
    }
    // Stay comfortably under the cost bucket.
    const avail = res.data.extensions?.cost?.throttleStatus?.currentlyAvailable as number | undefined;
    if (avail !== undefined && avail < 500) await sleep(1500);
    return res.data.data as T;
  }
}

async function restGet<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    try {
      const res = await axios.get(`${base()}${path}`, {
        headers: { 'X-Shopify-Access-Token': token },
        timeout: 60000,
      });
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

// ---------------------------------------------------------------------------
// GraphQL types + query
// ---------------------------------------------------------------------------

interface Money {
  amount: string;
  currencyCode: string;
}
interface MoneyBag {
  shopMoney: Money;
  presentmentMoney: Money;
}
interface Conn<T> {
  nodes: T[];
}
interface GRefund {
  id: string;
  legacyResourceId: string;
  createdAt: string;
  totalRefundedSet: MoneyBag;
  refundLineItems: Conn<{ quantity: number; restockType: string }>;
  refundShippingLines: Conn<{ subtotalAmountSet: MoneyBag }>;
  orderAdjustments: Conn<{ reason: string; amountSet: MoneyBag }>;
  transactions: Conn<{ kind: string; status: string; test: boolean; gateway: string; amountSet: MoneyBag }>;
}
interface GOrder {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  test: boolean;
  displayFinancialStatus: string;
  presentmentCurrencyCode: string;
  totalPriceSet: MoneyBag;
  originalTotalPriceSet: MoneyBag;
  totalReceivedSet: MoneyBag;
  currentTotalPriceSet: MoneyBag;
  totalRefundedSet: MoneyBag;
  tags: string[];
  disputes: { status: string; initiatedAs: string }[];
  refunds: GRefund[];
}

const MONEY = 'shopMoney{amount currencyCode} presentmentMoney{amount currencyCode}';

// NOTE: never select Refund.return (needs read_returns, fails the WHOLE query)
// or Refund.staffMember (needs read_users). The initiator comes from REST
// refunds.json (user_id / source_name), never from the refund_success event.
const ORDERS_QUERY = `
query RefundOrders($q: String!, $after: String) {
  orders(first: 50, after: $after, sortKey: UPDATED_AT, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyResourceId name createdAt updatedAt cancelledAt test
      displayFinancialStatus presentmentCurrencyCode tags
      totalPriceSet { ${MONEY} }
      originalTotalPriceSet { ${MONEY} }
      totalReceivedSet { ${MONEY} }
      currentTotalPriceSet { ${MONEY} }
      totalRefundedSet { ${MONEY} }
      disputes { status initiatedAs }
      refunds(first: 20) {
        id legacyResourceId createdAt
        totalRefundedSet { ${MONEY} }
        refundLineItems(first: 50) { nodes { quantity restockType } }
        refundShippingLines(first: 5) { nodes { subtotalAmountSet { ${MONEY} } } }
        orderAdjustments(first: 10) { nodes { reason amountSet { ${MONEY} } } }
        transactions(first: 10) { nodes { kind status test gateway amountSet { ${MONEY} } } }
      }
    }
  }
}`;

async function fetchRefundedOrders(sinceUtcIso: string): Promise<GOrder[]> {
  const q = `updated_at:>=${sinceUtcIso} AND (financial_status:refunded OR financial_status:partially_refunded)`;
  const out: GOrder[] = [];
  let after: string | null = null;
  for (;;) {
    const data: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GOrder[] } } =
      await gql(ORDERS_QUERY, { q, after });
    out.push(...data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return out;
}

interface RestRefund {
  id: number;
  /** free text: classified in memory only, never written */
  note: string | null;
  user_id: number | null;
  transactions: { source_name: string | null; status: string; kind: string }[];
}

async function fetchRestRefunds(orderLegacyId: string): Promise<RestRefund[]> {
  const data = await restGet<{ refunds: RestRefund[] }>(
    `/orders/${orderLegacyId}/refunds.json?fields=id,note,user_id,transactions`,
  );
  return data.refunds;
}

async function fetchTenderRefundsEur(sinceUtcMs: number, untilUtcMs: number, tz: string) {
  // processed_at filter truncates to a date in the SHOP timezone, so ask one day
  // earlier and filter precisely on the client.
  const sinceDate = new Date(sinceUtcMs - 36 * 3600 * 1000).toISOString().slice(0, 10);
  const perDay: Record<string, { count: number; eur: number }> = {};
  let after: string | null = null;
  for (;;) {
    const data: {
      tenderTransactions: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { processedAt: string; test: boolean; amount: Money }[];
      };
    } = await gql(
      `query($q:String!,$after:String){ tenderTransactions(first:250, after:$after, query:$q){
        pageInfo{hasNextPage endCursor} nodes{ processedAt test amount{amount currencyCode} } } }`,
      { q: `processed_at:>=${sinceDate}`, after },
    );
    for (const t of data.tenderTransactions.nodes) {
      const ms = Date.parse(t.processedAt);
      const amt = Number(t.amount.amount);
      if (t.test || amt >= 0 || ms < sinceUtcMs || ms >= untilUtcMs) continue;
      const day = localDate(ms, tz);
      const d = (perDay[day] ??= { count: 0, eur: 0 });
      d.count++;
      d.eur += -amt;
    }
    if (!data.tenderTransactions.pageInfo.hasNextPage) break;
    after = data.tenderTransactions.pageInfo.endCursor;
  }
  return perDay;
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

type Bucket = RefundBucket;
const BUCKETS: Bucket[] = REFUND_BUCKETS;

interface RefundRow {
  refundId: string;
  orderId: string;
  orderName: string;
  orderCreatedAt: string;
  refundCreatedAt: string;
  localDay: string;
  orderAgeDays: number;
  eur: number;
  presentmentAmount: number;
  currency: string;
  /** refund presentment / order totalReceived presentment * 100 */
  pct: number;
  /** cumulative money refunded on the order up to and including this refund */
  cumPct: number;
  bucket: Bucket;
  /** full only because the cumulative refunds on the order reach 100 % (e.g. 95 % + 5 %) */
  fullViaCumulative: boolean;
  shippingOnly: boolean;
  hasLineItems: boolean;
  hasAdjustment: boolean;
  orderStatusNow: string;
  orderHasDispute: boolean;
  subscriptionOrder: boolean;
  actorType: 'staff' | 'app' | 'unknown';
  /** canonical initiator class (lib/refundRules.ts classifyActor); 'unknown' when run with --no-rest */
  actor: ActorClass;
  actorGroup: string;
  actorLabel: string;
  actorRule: string;
  staffUserId: string | null;
  sourceName: string | null;
}

const num = (s: string | undefined) => Number(s ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Presentment-money amount that was actually collected for the order (the % base). */
function percentBase(o: GOrder): number {
  const received = num(o.totalReceivedSet.presentmentMoney.amount);
  if (received > 0) return received;
  return num(o.originalTotalPriceSet.presentmentMoney.amount) || num(o.totalPriceSet.presentmentMoney.amount);
}


function buildRows(orders: GOrder[], sinceMs: number, untilMs: number, tz: string): RefundRow[] {
  const rows: RefundRow[] = [];
  for (const o of orders) {
    if (o.test) continue;
    const baseAmt = percentBase(o);
    // Money refunds on this order, oldest first (all time, for cumulative %).
    const money = o.refunds
      .filter((r) => num(r.totalRefundedSet.shopMoney.amount) > 0)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    let cum = 0;
    money.forEach((r, idx) => {
      const pres = num(r.totalRefundedSet.presentmentMoney.amount);
      cum += pres;
      const ms = Date.parse(r.createdAt);
      if (ms < sinceMs || ms >= untilMs) return;

      const pct = baseAmt > 0 ? (pres / baseAmt) * 100 : 0;
      const cumPct = baseAmt > 0 ? (cum / baseAmt) * 100 : 0;
      const isLatest = idx === money.length - 1;
      // Cross-check for edited orders: nothing left to refund after this refund.
      const isFullNow =
        isLatest &&
        o.displayFinancialStatus === 'REFUNDED' &&
        (cum >= baseAmt - 0.01 || num(o.currentTotalPriceSet.presentmentMoney.amount) === 0);
      const hasLineItems = r.refundLineItems.nodes.length > 0;
      const shippingOnly = !hasLineItems && r.refundShippingLines.nodes.length > 0;

      const bucket = bucketRefund({ pct, cumPct, isFullNow, shippingOnly });

      rows.push({
        refundId: r.legacyResourceId,
        orderId: o.legacyResourceId,
        orderName: o.name,
        orderCreatedAt: o.createdAt,
        refundCreatedAt: r.createdAt,
        localDay: localDate(ms, tz),
        orderAgeDays: round2((ms - Date.parse(o.createdAt)) / 86400000),
        eur: num(r.totalRefundedSet.shopMoney.amount),
        presentmentAmount: pres,
        currency: r.totalRefundedSet.presentmentMoney.currencyCode,
        pct: round2(pct),
        cumPct: round2(cumPct),
        bucket,
        fullViaCumulative: bucket === 'full' && pct < 99.5,
        shippingOnly,
        hasLineItems,
        hasAdjustment: r.orderAdjustments.nodes.length > 0,
        orderStatusNow: o.displayFinancialStatus,
        orderHasDispute: o.disputes.length > 0,
        subscriptionOrder: o.tags.some((t) => /subscription/i.test(t)),
        actorType: 'unknown',
        actor: 'unknown',
        actorGroup: ACTOR_GROUP.unknown,
        actorLabel: 'unknown (REST not read)',
        actorRule: 'none',
        staffUserId: null,
        sourceName: null,
      });
    });
  }
  return rows.sort((a, b) => a.refundCreatedAt.localeCompare(b.refundCreatedAt));
}

async function enrichWithRest(rows: RefundRow[]): Promise<void> {
  const byOrder = new Map<string, RefundRow[]>();
  for (const r of rows) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
  for (const [orderId, orderRows] of byOrder) {
    const rest = await fetchRestRefunds(orderId);
    for (const row of orderRows) {
      const rr = rest.find((x) => String(x.id) === row.refundId);
      if (!rr) continue;
      row.staffUserId = rr.user_id ? String(rr.user_id) : null;
      row.sourceName = rr.transactions.find((t) => t.kind === 'refund')?.source_name ?? null;
      const a = classifyActor({ userId: row.staffUserId, sourceName: row.sourceName, note: rr.note });
      row.actor = a.cls;
      row.actorGroup = ACTOR_GROUP[a.cls];
      row.actorLabel = a.label;
      row.actorRule = a.rule;
      row.actorType = row.staffUserId ? 'staff' : row.sourceName ? 'app' : 'unknown';
    }
  }
}

interface Agg {
  refunds: number;
  orders: number;
  eur: number;
  buckets: Record<string, { count: number; eur: number; pcts?: number[] }>;
  actors: Record<string, { count: number; eur: number; label?: string }>;
  actorGroups: Record<string, { count: number; eur: number }>;
  currencies: Record<string, { count: number; presentment: number; eur: number }>;
  byDay: Record<string, { count: number; eur: number; tenderTxCount?: number; tenderTxEur?: number }>;
  shippingOnly: number;
  onDisputedOrders: number;
  onSubscriptionOrders: number;
  medianOrderAgeDays: number | null;
}

function aggregate(rows: RefundRow[]): Agg {
  const agg: Agg = {
    refunds: rows.length,
    orders: new Set(rows.map((r) => r.orderId)).size,
    eur: 0,
    buckets: Object.fromEntries(BUCKETS.map((b) => [b, { count: 0, eur: 0 }])),
    actors: Object.fromEntries(ACTOR_CLASS_ORDER.map((c) => [c, { count: 0, eur: 0 }])),
    actorGroups: {},
    currencies: {},
    byDay: {},
    shippingOnly: 0,
    onDisputedOrders: 0,
    onSubscriptionOrders: 0,
    medianOrderAgeDays: null,
  };
  for (const r of rows) {
    agg.eur += r.eur;
    const b = agg.buckets[r.bucket]!;
    b.count++;
    b.eur += r.eur;
    if (r.bucket === 'other' || r.bucket === 'shipping-only' || r.fullViaCumulative) (b.pcts ??= []).push(r.pct);
    const a = (agg.actors[r.actor] ??= { count: 0, eur: 0 });
    a.label = a.label && a.label !== r.actorLabel ? `${a.label}; ${r.actorLabel}` : r.actorLabel;
    a.count++;
    a.eur += r.eur;
    const g = (agg.actorGroups[r.actorGroup] ??= { count: 0, eur: 0 });
    g.count++;
    g.eur += r.eur;
    const c = (agg.currencies[r.currency] ??= { count: 0, presentment: 0, eur: 0 });
    c.count++;
    c.presentment += r.presentmentAmount;
    c.eur += r.eur;
    const d = (agg.byDay[r.localDay] ??= { count: 0, eur: 0 });
    d.count++;
    d.eur += r.eur;
    if (r.shippingOnly) agg.shippingOnly++;
    if (r.orderHasDispute) agg.onDisputedOrders++;
    if (r.subscriptionOrder) agg.onSubscriptionOrders++;
  }
  const ages = rows.map((r) => r.orderAgeDays).sort((x, y) => x - y);
  if (ages.length) agg.medianOrderAgeDays = ages[Math.floor(ages.length / 2)]!;
  // Round all money for output.
  agg.eur = round2(agg.eur);
  for (const v of [
    ...Object.values(agg.buckets),
    ...Object.values(agg.actors),
    ...Object.values(agg.actorGroups),
    ...Object.values(agg.currencies),
    ...Object.values(agg.byDay),
  ]) {
    v.eur = round2(v.eur);
  }
  for (const c of Object.values(agg.currencies)) c.presentment = round2(c.presentment);
  return agg;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function table(headers: string[], rows: (string | number)[][]): string {
  const cells = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.slice(1).map(line)].join('\n');
}

function mdTable(headers: string[], rows: (string | number)[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function renderWindow(title: string, w: { from: string; to: string; agg: Agg }, md: boolean): string {
  const t = md ? mdTable : table;
  const a = w.agg;
  const out: string[] = [];
  out.push(md ? `### ${title}` : `\n=== ${title} ===`);
  out.push(`Window (local): ${w.from} -> ${w.to}`);
  out.push(
    `Money refunds: ${a.refunds} on ${a.orders} orders, ${a.eur.toFixed(2)} EUR` +
      ` | shipping-only ${a.shippingOnly} | on disputed orders ${a.onDisputedOrders}` +
      ` | on subscription orders ${a.onSubscriptionOrders} | median order age ${a.medianOrderAgeDays ?? '-'} d`,
  );
  out.push('');
  out.push(
    t(
      ['Bucket', 'Count', 'EUR', 'Percentages'],
      BUCKETS.map((b) => [b, a.buckets[b]!.count, a.buckets[b]!.eur.toFixed(2), (a.buckets[b]!.pcts ?? []).join(', ')]),
    ),
  );
  out.push('');
  out.push(
    t(
      ['Actor', 'Count', 'EUR', 'Label'],
      Object.entries(a.actors)
        .filter(([, v]) => v.count > 0)
        .sort((x, y) => y[1].eur - x[1].eur)
        .map(([k, v]) => [k, v.count, v.eur.toFixed(2), v.label ?? '']),
    ),
  );
  out.push('');
  out.push(
    t(
      ['Currency', 'Count', 'Presentment', 'EUR'],
      Object.entries(a.currencies)
        .sort((x, y) => y[1].eur - x[1].eur)
        .map(([k, v]) => [k, v.count, v.presentment.toFixed(2), v.eur.toFixed(2)]),
    ),
  );
  out.push('');
  out.push(
    t(
      ['Local day', 'Refunds', 'EUR', 'TenderTx rows', 'TenderTx EUR', 'Diff EUR'],
      Object.entries(a.byDay)
        .sort()
        .map(([k, v]) => [
          k,
          v.count,
          v.eur.toFixed(2),
          v.tenderTxCount ?? '-',
          v.tenderTxEur?.toFixed(2) ?? '-',
          v.tenderTxEur === undefined ? '-' : (v.tenderTxEur - v.eur).toFixed(2),
        ]),
    ),
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const today = localDate(started, TZ);
  const todayStart = localMidnightUtc(today, TZ);

  // Window A "complete": the N full local days before today.
  const completeFrom = localMidnightUtc(addDays(today, -DAYS), TZ);
  const completeTo = todayStart;
  // Window B "rolling": the N-1 previous full days plus today so far.
  const rollingFrom = localMidnightUtc(addDays(today, -(DAYS - 1)), TZ);
  const rollingTo = started;

  const fetchFrom = Math.min(completeFrom, rollingFrom);
  const sinceIso = new Date(fetchFrom).toISOString().replace(/\.\d{3}Z$/, 'Z');
  console.error(`[refunds] fetching orders updated since ${sinceIso} (tz ${TZ}, days ${DAYS})`);

  const orders = await fetchRefundedOrders(sinceIso);
  console.error(`[refunds] ${orders.length} refunded/partially refunded orders`);
  const allRows = buildRows(orders, fetchFrom, rollingTo, TZ);
  if (USE_REST) {
    console.error(`[refunds] REST refunds.json for ${new Set(allRows.map((r) => r.orderId)).size} orders (actor ids)`);
    await enrichWithRest(allRows);
  }

  const inWin = (from: number, to: number) =>
    allRows.filter((r) => Date.parse(r.refundCreatedAt) >= from && Date.parse(r.refundCreatedAt) < to);
  const complete = { from: new Date(completeFrom).toISOString(), to: new Date(completeTo).toISOString(), agg: aggregate(inWin(completeFrom, completeTo)) };
  const rolling = { from: new Date(rollingFrom).toISOString(), to: new Date(rollingTo).toISOString(), agg: aggregate(inWin(rollingFrom, rollingTo)) };

  if (RECONCILE) {
    const tender = await fetchTenderRefundsEur(fetchFrom, rollingTo, TZ);
    for (const w of [complete, rolling]) {
      for (const [day, v] of Object.entries(w.agg.byDay)) {
        v.tenderTxCount = tender[day]?.count ?? 0;
        v.tenderTxEur = round2(tender[day]?.eur ?? 0);
      }
    }
  }

  const localLabel = (ms: number) => `${localDate(ms, TZ)} ${new Date(ms + tzOffsetMinutes(ms, TZ) * 60000).toISOString().slice(11, 16)}`;
  const completeTitle = `Last ${DAYS} complete local day(s): ${localDate(completeFrom, TZ)} .. ${addDays(today, -1)}`;
  const rollingTitle = `Last ${DAYS} local day(s) incl. today so far: ${localDate(rollingFrom, TZ)} .. ${localLabel(rollingTo)}`;
  const displayComplete = { ...complete, from: localLabel(completeFrom), to: localLabel(completeTo) };
  const displayRolling = { ...rolling, from: localLabel(rollingFrom), to: localLabel(rollingTo) };

  const text = [renderWindow(completeTitle, displayComplete, false), renderWindow(rollingTitle, displayRolling, false)].join('\n');
  console.log(text);

  mkdirSync(OUT_DIR, { recursive: true });
  const stem = `shopify-refunds-${DAYS}d-${today}`;
  const result = {
    generatedAt: new Date(started).toISOString(),
    timezone: TZ,
    days: DAYS,
    definitions: {
      moneyRefund: 'Refund object with totalRefundedSet.shopMoney > 0 (zero-amount line removals and failed refunds excluded)',
      eur: 'refund.totalRefundedSet.shopMoney (EUR, converted by Shopify at refund time)',
      pct: 'refund.totalRefundedSet.presentmentMoney / order.totalReceivedSet.presentmentMoney * 100',
      buckets: `lib/refundRules.ts bucketRefund: full = pct>=99.5 or cumulative pct>=99.5 or order fully refunded by this refund (fullViaCumulative flags the last two); shipping-only = no line items + shipping refunded; 30/50/70 = within ${BUCKET_TOLERANCE_PP} pp; other = rest`,
      actor: 'lib/refundRules.ts classifyActor on REST refund.user_id / transactions[].source_name / note (in memory); actorGroup = dashboard grouping',
    },
    ordersScanned: orders.length,
    windows: { complete, rolling },
    rows: allRows,
    runtimeSeconds: round2((Date.now() - started) / 1000),
  };
  writeFileSync(join(OUT_DIR, `${stem}.json`), JSON.stringify(result, null, 2));
  writeFileSync(
    join(OUT_DIR, `${stem}.md`),
    [
      `# Shopify refunds, ${DAYS} day(s), generated ${result.generatedAt} (${TZ})`,
      '',
      renderWindow(completeTitle, displayComplete, true),
      '',
      renderWindow(rollingTitle, displayRolling, true),
      '',
    ].join('\n'),
  );
  console.error(`[refunds] wrote ${join(OUT_DIR, stem)}.json/.md in ${result.runtimeSeconds}s`);
}

main().catch((err) => {
  console.error(axios.isAxiosError(err) ? `${err.message} ${JSON.stringify(err.response?.data)}` : err);
  process.exit(1);
});

/**
 * Label analytics: what tickets are about (intent labels) and what was done
 * (action labels), per local calendar day.
 *
 * READ-ONLY. Only GET requests against Chatwoot (v1 + v2 reports) and read-only
 * Firestore queries. Nothing is written anywhere except the local output dir.
 *
 * Usage:
 *   npx tsx src/scripts/analytics/labelsAndActions.ts [--days=7] [--tz=Europe/Helsinki]
 *       [--out=/home/dolan/support-analytics] [--no-firestore] [--no-v2] [--concurrency=6]
 *
 * Window: the last N FULL local days ending yesterday (today is reported
 * separately as "partial"). E.g. on 2026-09-14 with --days=7 the window is
 * 2026-09-07..2026-09-13.
 *
 * Outputs (in --out): labels-and-actions_<days>d_<lastDay>.json and .md.
 * The outputs contain aggregates and conversation ids only (no customer PII).
 *
 * See docs/support-analytics/labels-and-actions.md for metric definitions.
 */
import 'dotenv/config';
import axios, { AxiosError } from 'axios';
import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { chatwootClient } from '../../services/chatwoot.js';
import { getDb } from '../../services/firestore.js';

// ---------------------------------------------------------------------------
// Label groups
// ---------------------------------------------------------------------------

/** Intents the AI classifier assigns (CLASSIFICATION_LABELS in classifier.ts) + legacy. */
const INTENT_LABELS = [
  'sub-cancel',
  'refund',
  'order-status',
  'other',
  'not-delivered',
  'business',
  'change-address',
  'missing-packs',
  'product-defect',
  'change-contact',
  'no-country',
  'discount-issue',
  // legacy, not in the label list any more; counted as intents if they appear
  'product-not-received',
  'cancel-order',
] as const;

/** Work that was done. All human except sub-cancelled-ai. */
const ACTION_LABELS = [
  'refund-30',
  'refund-50',
  'refund-70',
  'refund-full',
  'reshipped',
  'sub-cancelled',
  'sub-cancelled-ai',
  'changed-contact',
  'tp-free-pack',
] as const;

/** Added by the AgentBot when it sends a reply (ai-reply is unused; legacy ai-resolved). */
const BOT_LABELS = ['ai-response', 'ai-reply', 'ai-resolved'] as const;

const INTENT_SET = new Set<string>(INTENT_LABELS);
const ACTION_SET = new Set<string>(ACTION_LABELS);
const BOT_SET = new Set<string>(BOT_LABELS);

type Group = 'intent' | 'action' | 'bot' | 'unknown';
function groupOf(label: string): Group {
  if (INTENT_SET.has(label)) return 'intent';
  if (ACTION_SET.has(label)) return 'action';
  if (BOT_SET.has(label)) return 'bot';
  return 'unknown';
}

/** Labels shown in the action table, in display order. */
const ACTION_REPORT_LABELS = [...ACTION_LABELS, 'ai-response', 'ai-reply'];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const DAYS = Math.max(1, Number(arg('days', '7')) || 7);
const TZ = arg('tz', 'Europe/Helsinki');
const OUT_DIR = arg('out', '/home/dolan/support-analytics');
const USE_FIRESTORE = !flag('no-firestore');
const USE_V2 = !flag('no-v2');
const CONCURRENCY = Math.max(1, Number(arg('concurrency', '6')) || 6);

// ---------------------------------------------------------------------------
// Time zone helpers (DST-safe, no dependencies)
// ---------------------------------------------------------------------------

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Local calendar day 'YYYY-MM-DD' of a unix-seconds timestamp. */
function localDay(unixSec: number): string {
  return dayFmt.format(new Date(unixSec * 1000));
}

/** Offset of TZ from UTC in minutes at a given instant (Helsinki: +180 summer, +120 winter). */
function tzOffsetMinutes(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Unix seconds of local midnight starting the given 'YYYY-MM-DD'. */
function localMidnight(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMinutes(guess) * 60000;
  t = guess - tzOffsetMinutes(t) * 60000; // second pass settles DST edges
  return Math.floor(t / 1000);
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// HTTP helpers (GET only) with retry on 429 / 5xx / network errors
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let apiCalls = 0;

async function withRetry<T>(fn: () => Promise<T>, what: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      apiCalls++;
      return await fn();
    } catch (err) {
      const status = err instanceof AxiosError ? err.response?.status : undefined;
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt >= 5) {
        throw new Error(`${what} failed: ${status ?? ''} ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(1500 * 2 ** attempt);
    }
  }
}

const v1Get = async <T>(url: string, params?: Record<string, unknown>): Promise<T> =>
  withRetry(async () => (await chatwootClient.get<T>(url, { params, timeout: 60000 })).data, `GET v1 ${url}`);

const v2Base = `${env.chatwootBaseUrl}/api/v2/accounts/${env.chatwootAccountId}`;
const v2Get = async <T>(url: string, params: Record<string, unknown>): Promise<T> =>
  withRetry(
    async () =>
      (
        await axios.get<T>(`${v2Base}${url}`, {
          params,
          timeout: 60000,
          headers: { api_access_token: env.chatwootApiToken },
        })
      ).data,
    `GET v2 ${url}`,
  );

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

// ---------------------------------------------------------------------------
// Chatwoot types (only the fields we use)
// ---------------------------------------------------------------------------

interface CwLabel {
  id: number;
  title: string;
  description: string | null;
}
interface CwConversation {
  id: number;
  status: string;
  labels: string[];
  inbox_id: number;
  created_at: number;
  last_activity_at: number;
}
interface CwMessage {
  id: number;
  message_type: number; // 0 incoming, 1 outgoing, 2 activity, 3 template
  private: boolean;
  created_at: number;
  content: string | null;
}
interface LabelEvent {
  conversationId: number;
  op: 'added' | 'removed';
  actor: string;
  labels: string[];
  ts: number;
  day: string;
  messageId: number;
}

/** Activity text is exactly "<Agent name> added a, b" / "<Agent name> removed a". */
const LABEL_EVENT_RE = /^(.+?) (added|removed) ([a-z0-9_-]+(?:, [a-z0-9_-]+)*)$/;

// ---------------------------------------------------------------------------
// Data pulls
// ---------------------------------------------------------------------------

async function fetchLabels(): Promise<CwLabel[]> {
  const res = await v1Get<{ payload: CwLabel[] }>('/labels');
  return res.payload;
}

/**
 * All conversations with last_activity_at >= sinceSec. The list is sorted by
 * last activity desc and it SHIFTS while we page (a conversation that gets new
 * activity jumps to page 1). That causes duplicates (rows pushed down onto the
 * next page) and misses (rows that jump above the page we are on). So:
 * dedupe by id, then re-page from page 1 over everything active since the pull
 * started and merge it in (keeping the freshest copy).
 */
async function fetchConversationsActiveSince(
  sinceSec: number,
): Promise<{ convs: CwConversation[]; pages: number; duplicatesDropped: number; addedByRescan: number }> {
  const byId = new Map<number, CwConversation>();
  let pages = 0;
  let duplicatesDropped = 0;
  const pass = async (stopBelow: number, label: string): Promise<number> => {
    let added = 0;
    for (let page = 1; ; page++) {
      const res = await v1Get<{ data: { payload: CwConversation[] } }>('/conversations', {
        status: 'all',
        assignee_type: 'all',
        sort_by: 'last_activity_at_desc',
        page,
      });
      pages++;
      const rows = res.data.payload;
      for (const c of rows) {
        if (c.last_activity_at < sinceSec) continue;
        const prev = byId.get(c.id);
        if (!prev) added++;
        else if (label === 'main') duplicatesDropped++;
        if (!prev || c.last_activity_at >= prev.last_activity_at) byId.set(c.id, c);
      }
      const last = rows[rows.length - 1];
      if (rows.length < 25 || !last || last.last_activity_at < stopBelow) return added;
      if (page % 10 === 0) process.stderr.write(`  ${label} conversations page ${page} (${byId.size})\n`);
    }
  };
  const pullStart = Math.floor(Date.now() / 1000) - 60;
  await pass(sinceSec, 'main');
  const addedByRescan = await pass(pullStart, 'rescan');
  return { convs: [...byId.values()], pages, duplicatesDropped, addedByRescan };
}

/** Messages of a conversation newer than sinceSec (plus a bit older, harmless). */
async function fetchMessagesSince(conversationId: number, sinceSec: number): Promise<CwMessage[]> {
  const all: CwMessage[] = [];
  let before: number | undefined;
  for (;;) {
    const res = await v1Get<{ payload: CwMessage[] }>(
      `/conversations/${conversationId}/messages`,
      before ? { before } : undefined,
    );
    const page = res.payload;
    all.push(...page);
    if (page.length < 20) break; // verified: a short page is the last page
    const oldest = page.reduce((m, x) => (x.created_at < m.created_at ? x : m), page[0] as CwMessage);
    if (oldest.created_at < sinceSec) break;
    before = Math.min(...page.map((x) => x.id));
  }
  return all.sort((a, b) => a.created_at - b.created_at || a.id - b.id);
}

// ---------------------------------------------------------------------------
// Small aggregation helpers
// ---------------------------------------------------------------------------

type Counter = Record<string, number>;
const inc = (c: Counter, k: string, n = 1) => {
  c[k] = (c[k] ?? 0) + n;
};
const sortCounter = (c: Counter): Counter =>
  Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function table(headers: string[], rows: (string | number)[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (r: (string | number)[]) =>
    r.map((v, i) => (i === 0 ? String(v).padEnd(widths[i]!) : String(v).padStart(widths[i]!))).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}
function mdTable(headers: string[], rows: (string | number)[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const pulledAt = new Date();
  const nowSec = Math.floor(pulledAt.getTime() / 1000);
  const today = localDay(nowSec);
  const lastDay = addDays(today, -1);
  const firstDay = addDays(today, -DAYS);
  const days = Array.from({ length: DAYS }, (_, i) => addDays(firstDay, i));
  const windowStart = localMidnight(firstDay);
  const windowEnd = localMidnight(today); // exclusive; today is "partial"
  const inWindow = (d: string) => d >= firstDay && d <= lastDay;

  process.stderr.write(
    `Window ${firstDay}..${lastDay} (${TZ}), unix ${windowStart}..${windowEnd}; today ${today} partial\n`,
  );

  // 1) Labels
  const labels = await fetchLabels();
  const labelIdByTitle = new Map(labels.map((l) => [l.title, l.id]));

  // 2) Conversations active since window start (label events bump last_activity_at)
  const { convs, pages, duplicatesDropped, addedByRescan } = await fetchConversationsActiveSince(windowStart);
  process.stderr.write(
    `Fetched ${convs.length} conversations active since window start (${pages} pages, ${duplicatesDropped} duplicate rows dropped, ${addedByRescan} added by rescan)\n`,
  );

  // 3) Messages -> label events + timing context
  const events: LabelEvent[] = [];
  const unknownActivity: Counter = {};
  const incomingTs = new Map<number, number[]>();
  const publicOutTs = new Map<number, number[]>();
  let done = 0;
  await mapPool(convs, CONCURRENCY, async (c) => {
    const msgs = await fetchMessagesSince(c.id, windowStart);
    incomingTs.set(
      c.id,
      msgs.filter((m) => m.message_type === 0).map((m) => m.created_at),
    );
    publicOutTs.set(
      c.id,
      msgs.filter((m) => m.message_type === 1 && !m.private).map((m) => m.created_at),
    );
    for (const m of msgs) {
      if (m.message_type !== 2 || m.created_at < windowStart) continue;
      const hit = LABEL_EVENT_RE.exec((m.content ?? '').trim());
      if (!hit) {
        const pattern = (m.content ?? '').replace(/\bby .*$/, 'by <who>').slice(0, 60);
        inc(unknownActivity, pattern);
        continue;
      }
      events.push({
        conversationId: c.id,
        op: hit[2] as 'added' | 'removed',
        actor: hit[1] as string,
        labels: (hit[3] as string).split(', '),
        ts: m.created_at,
        day: localDay(m.created_at),
        messageId: m.id,
      });
    }
    if (++done % 200 === 0) process.stderr.write(`  messages ${done}/${convs.length}\n`);
  });

  // Dedupe to (conversation, label, day, op); keep the earliest event of each.
  const firstEvent = new Map<string, { ev: LabelEvent; label: string }>();
  for (const ev of events.sort((a, b) => a.ts - b.ts)) {
    for (const label of ev.labels) {
      const key = `${ev.conversationId}|${label}|${ev.day}|${ev.op}`;
      if (!firstEvent.has(key)) firstEvent.set(key, { ev, label });
    }
  }
  const labelDayEvents = [...firstEvent.values()];

  const actors: Counter = {};
  const eventComposition: Counter = {};
  for (const ev of events) {
    inc(actors, ev.actor);
    const groups = [...new Set(ev.labels.map(groupOf))].sort().join('+');
    inc(eventComposition, `${ev.op}:${groups}`);
  }

  // ---- Metric A: conversations CREATED per day, current intent labels ----
  const createdDays = [...days, today];
  const created: Record<
    string,
    { total: number; noIntent: number; status: Counter; intents: Counter; actions: Counter; combos: Counter }
  > = {};
  for (const d of createdDays) created[d] = { total: 0, noIntent: 0, status: {}, intents: {}, actions: {}, combos: {} };
  const windowCombos: Counter = {};
  const createdInWindow: CwConversation[] = [];
  for (const c of convs) {
    const d = localDay(c.created_at);
    const bucket = created[d];
    if (!bucket) continue;
    bucket.total++;
    inc(bucket.status, c.status);
    const intents = [...new Set(c.labels.filter((l) => groupOf(l) === 'intent'))].sort();
    for (const l of intents) inc(bucket.intents, l);
    for (const l of c.labels) if (groupOf(l) !== 'intent') inc(bucket.actions, l);
    const combo = intents.length ? intents.join('+') : '(no intent)';
    if (!intents.length) bucket.noIntent++;
    inc(bucket.combos, combo);
    if (inWindow(d)) {
      inc(windowCombos, combo);
      createdInWindow.push(c);
    }
  }

  // ---- Metric B: labels ADDED per day (distinct conversations) ----
  const addedByDay: Record<string, Counter> = {};
  const removedByDay: Record<string, Counter> = {};
  for (const d of createdDays) {
    addedByDay[d] = {};
    removedByDay[d] = {};
  }
  for (const { ev, label } of labelDayEvents) {
    const target = ev.op === 'added' ? addedByDay[ev.day] : removedByDay[ev.day];
    if (target) inc(target, label);
  }
  const windowAdded: Counter = {};
  const windowAddedConvs = new Map<string, Set<number>>();
  for (const { ev, label } of labelDayEvents) {
    if (ev.op !== 'added' || !inWindow(ev.day)) continue;
    if (!windowAddedConvs.has(label)) windowAddedConvs.set(label, new Set());
    windowAddedConvs.get(label)!.add(ev.conversationId);
  }
  for (const [label, set] of windowAddedConvs) windowAdded[label] = set.size;

  // ---- Action x current intents ----
  const convById = new Map(convs.map((c) => [c.id, c]));
  const actionByIntent: Record<string, Counter> = {};
  for (const label of ACTION_REPORT_LABELS) {
    const ids = windowAddedConvs.get(label);
    if (!ids) continue;
    const counter: Counter = {};
    for (const id of ids) {
      const intents = (convById.get(id)?.labels ?? []).filter((l) => groupOf(l) === 'intent').sort();
      inc(counter, intents.length ? intents.join('+') : '(no intent)');
    }
    actionByIntent[label] = sortCounter(counter);
  }
  // ---- Per-day combinations on the label-ADDED basis ----
  // addedIntentCombosByDay[D]: conversations that got at least one intent label for the first time on D, keyed by the
  // sorted set of intent labels first added on D. actionByCurrentIntentByDay[D][action]: conversations newly tagged
  // with the action on D, keyed by their current intent combination.
  const addedIntentCombosByDay: Record<string, Counter> = {};
  const actionByCurrentIntentByDay: Record<string, Record<string, Counter>> = {};
  {
    const intentsAddedPerConvDay = new Map<string, Set<string>>();
    for (const { ev, label } of labelDayEvents) {
      if (ev.op !== 'added') continue;
      if (groupOf(label) === 'intent') {
        const key = `${ev.day}|${ev.conversationId}`;
        if (!intentsAddedPerConvDay.has(key)) intentsAddedPerConvDay.set(key, new Set());
        intentsAddedPerConvDay.get(key)!.add(label);
      } else if ((ACTION_REPORT_LABELS as readonly string[]).includes(label)) {
        const intents = (convById.get(ev.conversationId)?.labels ?? []).filter((l) => groupOf(l) === 'intent').sort();
        const byAction = (actionByCurrentIntentByDay[ev.day] ??= {});
        inc((byAction[label] ??= {}), intents.length ? intents.join('+') : '(no intent)');
      }
    }
    for (const d of createdDays) addedIntentCombosByDay[d] = {};
    for (const [key, set] of intentsAddedPerConvDay) {
      const d = key.slice(0, key.indexOf('|'));
      if (addedIntentCombosByDay[d]) inc(addedIntentCombosByDay[d]!, [...set].sort().join('+'));
    }
  }

  const humanCancelConvs = windowAddedConvs.get('sub-cancelled') ?? new Set<number>();
  const aiCancelConvs = windowAddedConvs.get('sub-cancelled-ai') ?? new Set<number>();
  const cancelOverlap = [...humanCancelConvs].filter((id) => aiCancelConvs.has(id)).length;
  const refundPctConvs = new Set<number>();
  for (const l of ['refund-30', 'refund-50', 'refund-70', 'refund-full'])
    for (const id of windowAddedConvs.get(l) ?? []) refundPctConvs.add(id);

  // ---- Attribution heuristics (timing) ----
  const nearest = (arr: number[] | undefined, ts: number, lo: number, hi: number) =>
    (arr ?? []).some((t) => t >= ts + lo && t <= ts + hi);
  const attribution: Record<string, { events: number; withinWindow: number; rule: string }> = {};
  const addAttr = (key: string, rule: string, ok: boolean) => {
    attribution[key] ??= { events: 0, withinWindow: 0, rule };
    attribution[key].events++;
    if (ok) attribution[key].withinWindow++;
  };
  for (const ev of events) {
    if (ev.op !== 'added') continue;
    const groups = new Set(ev.labels.map(groupOf));
    if (groups.size === 1 && groups.has('intent')) {
      addAttr(
        'intent-only events',
        'incoming message 0-60 s before',
        nearest(incomingTs.get(ev.conversationId), ev.ts, -60, 0),
      );
    }
    for (const l of ev.labels) {
      if (l === 'ai-response')
        addAttr(
          'ai-response',
          'public outgoing message within +/-30 s',
          nearest(publicOutTs.get(ev.conversationId), ev.ts, -30, 30),
        );
      else if (l === 'sub-cancelled-ai')
        addAttr(
          'sub-cancelled-ai',
          'public outgoing message 0-120 s after',
          nearest(publicOutTs.get(ev.conversationId), ev.ts, 0, 120),
        );
      else if (groupOf(l) === 'action')
        addAttr(
          l,
          'public outgoing message within +/-120 s',
          nearest(publicOutTs.get(ev.conversationId), ev.ts, -120, 120),
        );
    }
  }

  // ---- Chatwoot v2 cross-check ----
  let v2: Record<string, unknown> | null = null;
  if (USE_V2) {
    // Offset in effect NOW for the whole range (Chatwoot resolves it DST-aware; verified live across 2026-03-29).
    // Do not split at DST changes. Bucket timestamps are asserted against local midnights below.
    const offsetHours = tzOffsetMinutes(Date.now()) / 60;
    const summary = await v2Get<
      Array<{
        id: number;
        name: string;
        conversations_count: number;
        resolved_conversations_count: number;
        avg_first_response_time: number | null;
        avg_resolution_time: number | null;
      }>
    >('/summary_reports/label', { since: windowStart, until: windowEnd, timezone_offset: offsetHours });
    const seriesLabels = ['refund', 'sub-cancel', 'sub-cancelled', 'sub-cancelled-ai', 'refund-full'];
    const series: Record<string, { v2: Record<string, number>; script: Record<string, number>; match: boolean }> = {};
    for (const title of seriesLabels) {
      const id = labelIdByTitle.get(title);
      if (!id) continue;
      const rows = await v2Get<Array<{ value: number; timestamp: number }>>('/reports', {
        metric: 'conversations_count',
        type: 'label',
        id,
        since: windowStart,
        until: windowEnd,
        group_by: 'day',
        timezone_offset: offsetHours,
      });
      const v2Days: Record<string, number> = {};
      for (const r of rows) {
        if (r.timestamp > windowStart && localDay(r.timestamp - 1) === localDay(r.timestamp)) {
          process.stderr.write(`WARNING v2 bucket ${r.timestamp} is not a local midnight: check timezone_offset\n`);
        }
        v2Days[localDay(r.timestamp + 3600)] = Number(r.value);
      }
      const scriptDays: Record<string, number> = {};
      for (const d of days) {
        const b = created[d]!;
        scriptDays[d] = (groupOf(title) === 'intent' ? b.intents[title] : b.actions[title]) ?? 0;
      }
      series[title] = { v2: v2Days, script: scriptDays, match: days.every((d) => (v2Days[d] ?? 0) === scriptDays[d]) };
    }
    v2 = {
      timezoneOffsetHours: offsetHours,
      summaryReportsLabel: summary.map((s) => ({ ...s })).sort((a, b) => b.conversations_count - a.conversations_count),
      perLabelCreatedSeries: series,
    };
  }

  // ---- Firestore cross-check (snapshot, drifts: docs are overwritten) ----
  let firestore: Record<string, unknown> | null = null;
  const db = USE_FIRESTORE ? getDb() : null;
  if (db) {
    try {
      const decisions = await db
        .collection('agentBotDecisions')
        .where('ts', '>=', windowStart * 1000)
        .get();
      const byDayAction: Record<string, Counter> = {};
      let respondedSubCancel = 0;
      let respondedSubCancelWithAiLabel = 0;
      const aiCancelDecision: Counter = {};
      const allAiCancelConvs = new Set(
        labelDayEvents
          .filter((x) => x.label === 'sub-cancelled-ai' && x.ev.op === 'added')
          .map((x) => x.ev.conversationId),
      );
      for (const doc of decisions.docs) {
        const d = doc.data() as {
          conversationId?: number;
          action?: string;
          routingLabels?: string[];
          classified?: string[];
          ts?: number;
        };
        const day = typeof d.ts === 'number' ? localDay(Math.floor(d.ts / 1000)) : 'unknown';
        byDayAction[day] ??= {};
        inc(byDayAction[day]!, d.action ?? 'unknown');
        const route = [...new Set([...(d.routingLabels ?? []), ...(d.classified ?? [])])].sort();
        const convId = Number(d.conversationId ?? doc.id);
        if (d.action === 'responded' && route.includes('sub-cancel')) {
          respondedSubCancel++;
          if (allAiCancelConvs.has(convId)) respondedSubCancelWithAiLabel++;
        }
        if (allAiCancelConvs.has(convId)) inc(aiCancelDecision, `${d.action}:${(d.routingLabels ?? []).join('+')}`);
      }
      const replies = await db
        .collection('sentReplies')
        .where('ts', '>=', windowStart * 1000)
        .get();
      const repliesByDay: Record<string, Counter> = {};
      for (const doc of replies.docs) {
        const r = doc.data() as { source?: string; ts?: number };
        const day = typeof r.ts === 'number' ? localDay(Math.floor(r.ts / 1000)) : 'unknown';
        repliesByDay[day] ??= {};
        inc(repliesByDay[day]!, r.source ?? 'unknown');
      }
      firestore = {
        note: 'Snapshot at pulledAt. agentBotDecisions keeps only the latest decision per conversation (bucketed by latest ts), so past days drift. sentReplies logs bot messages only from 2026-09-14T08:00Z.',
        agentBotDecisionsDocs: decisions.size,
        decisionsByLatestDay: Object.fromEntries(Object.entries(byDayAction).sort()),
        respondedWithSubCancel: respondedSubCancel,
        respondedWithSubCancelAndAiCancelLabel: respondedSubCancelWithAiLabel,
        latestDecisionOfAiCancelConversations: sortCounter(aiCancelDecision),
        sentRepliesByDay: Object.fromEntries(Object.entries(repliesByDay).sort()),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      process.stderr.write(`Firestore cross-check failed (continuing without it): ${message}\n`);
      firestore = { error: message };
    }
  } else if (USE_FIRESTORE) {
    process.stderr.write('Firestore not configured; skipping Firestore cross-check\n');
  }

  // ---------------------------------------------------------------------------
  // Assemble result
  // ---------------------------------------------------------------------------

  const intentOrder = [...INTENT_LABELS].filter(
    (l) =>
      sum(createdDays.map((d) => (created[d]!.intents[l] ?? 0) + (addedByDay[d]![l] ?? 0))) > 0 ||
      !['product-not-received', 'cancel-order'].includes(l),
  );
  const windowIntentCreated: Counter = {};
  for (const d of days) for (const [l, n] of Object.entries(created[d]!.intents)) inc(windowIntentCreated, l, n);

  const result = {
    meta: {
      pulledAt: pulledAt.toISOString(),
      timezone: TZ,
      days: DAYS,
      window: { firstDay, lastDay, startUnix: windowStart, endUnixExclusive: windowEnd },
      todayPartial: today,
      conversationsFetched: convs.length,
      conversationListPages: pages,
      conversationListDuplicateRowsDropped: duplicatesDropped,
      conversationsAddedByRescan: addedByRescan,
      labelEvents: events.length,
      apiCalls,
    },
    labels: labels.map((l) => ({
      id: l.id,
      title: l.title,
      description: l.description ?? '',
      group: groupOf(l.title),
    })),
    labelEventFormat: {
      actors: sortCounter(actors),
      eventComposition: sortCounter(eventComposition),
      otherActivityPatterns: sortCounter(unknownActivity),
    },
    createdByDay: Object.fromEntries(
      createdDays.map((d) => [
        d,
        {
          conversations: created[d]!.total,
          noIntent: created[d]!.noIntent,
          status: sortCounter(created[d]!.status),
          intents: sortCounter(created[d]!.intents),
          nonIntentLabelsSnapshot: sortCounter(created[d]!.actions),
          combos: sortCounter(created[d]!.combos),
        },
      ]),
    ),
    window: {
      conversationsCreated: sum(days.map((d) => created[d]!.total)),
      noIntent: sum(days.map((d) => created[d]!.noIntent)),
      intentsByCreatedDay: sortCounter(windowIntentCreated),
      intentCombos: sortCounter(windowCombos),
      labelsAddedDistinctConversations: sortCounter(windowAdded),
      conversationsWithAnyRefundPctLabel: refundPctConvs.size,
      subCancelledHuman: humanCancelConvs.size,
      subCancelledAi: aiCancelConvs.size,
      subCancelledOverlap: cancelOverlap,
      actionByCurrentIntent: actionByIntent,
    },
    addedByDay: Object.fromEntries(createdDays.map((d) => [d, sortCounter(addedByDay[d]!)])),
    addedIntentCombosByDay: Object.fromEntries(createdDays.map((d) => [d, sortCounter(addedIntentCombosByDay[d]!)])),
    actionByCurrentIntentByDay: Object.fromEntries(
      createdDays.map((d) => [
        d,
        Object.fromEntries(Object.entries(actionByCurrentIntentByDay[d] ?? {}).map(([k, v]) => [k, sortCounter(v)])),
      ]),
    ),
    removedByDay: Object.fromEntries(
      createdDays.map((d) => [d, sortCounter(removedByDay[d]!)]).filter(([, c]) => Object.keys(c as Counter).length),
    ),
    attributionTiming: attribution,
    v2,
    firestore,
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const cols = [...days, 'window', `${today}*`];
  const dayCell = (fn: (d: string) => number) => [...days.map(fn), sum(days.map(fn)), fn(today)];
  const short = (d: string) => d.slice(5);
  const headers = ['label', ...cols.map((c) => (c === 'window' ? `${DAYS}d total` : short(c)))];

  const createdRows: (string | number)[][] = [
    ['(conversations created)', ...dayCell((d) => created[d]!.total)],
    ['(no intent label)', ...dayCell((d) => created[d]!.noIntent)],
    ...intentOrder.map((l) => [l, ...dayCell((d) => created[d]!.intents[l] ?? 0)]),
  ];
  const addedIntentRows = intentOrder.map((l) => [l, ...dayCell((d) => addedByDay[d]![l] ?? 0)]);
  const actionRows = ACTION_REPORT_LABELS.map((l) => [l, ...dayCell((d) => addedByDay[d]![l] ?? 0)]);
  const actionSnapshotRows = ACTION_REPORT_LABELS.map((l) => [l, ...dayCell((d) => created[d]!.actions[l] ?? 0)]);
  const comboRows = Object.entries(sortCounter(windowCombos))
    .slice(0, 25)
    .map(([k, v]) => [k, v]);
  const lastDayCombos = Object.entries(sortCounter(created[lastDay]!.combos))
    .slice(0, 15)
    .map(([k, v]) => [k, v]);

  const topCombos = (get: (d: string) => Counter) => {
    const total: Counter = {};
    for (const d of days) for (const [k, v] of Object.entries(get(d))) inc(total, k, v);
    return Object.keys(sortCounter(total)).slice(0, 10);
  };
  const comboDayRows = (get: (d: string) => Counter) =>
    topCombos(get).map((k) => [k, ...dayCell((d) => get(d)[k] ?? 0)]);

  const sections: Array<{ title: string; headers: string[]; rows: (string | number)[][] }> = [
    { title: 'A. Intent labels by conversation CREATED day (current labels)', headers, rows: createdRows },
    {
      title: 'B. Intent labels by label-ADDED day (distinct conversations first tagged that day)',
      headers,
      rows: addedIntentRows,
    },
    { title: 'C. Action + bot labels by label-ADDED day (conversations newly tagged)', headers, rows: actionRows },
    {
      title: 'D. Action + bot labels by conversation CREATED day (snapshot; do not use for actions)',
      headers,
      rows: actionSnapshotRows,
    },
    {
      title: `E. Intent combinations, conversations created ${firstDay}..${lastDay} (top 25)`,
      headers: ['combination', 'conversations'],
      rows: comboRows,
    },
    {
      title: `F. Intent combinations, conversations created ${lastDay}`,
      headers: ['combination', 'conversations'],
      rows: lastDayCombos,
    },
    {
      title: 'F2. Top 10 intent combinations per day, conversations CREATED that day (current labels)',
      headers,
      rows: comboDayRows((d) => created[d]!.combos),
    },
    {
      title: 'F3. Top 10 intent combinations per day, label-ADDED basis (intents first added that day, per conversation)',
      headers,
      rows: comboDayRows((d) => addedIntentCombosByDay[d]!),
    },
    {
      title: 'G. Attribution timing checks (label added events since window start, incl. today)',
      headers: ['label/event', 'rule', 'events', 'matching'],
      rows: Object.entries(attribution).map(([k, v]) => [k, v.rule, v.events, v.withinWindow]),
    },
  ];

  const summaryLines = [
    `Pulled ${pulledAt.toISOString()} | ${TZ} | window ${firstDay}..${lastDay} (${DAYS}d) | * = today partial`,
    `Conversations fetched (active since window start): ${convs.length} (duplicate rows dropped ${duplicatesDropped}, added by rescan ${addedByRescan}); API calls: ${apiCalls}`,
    `Label event actors: ${JSON.stringify(result.labelEventFormat.actors)}; composition: ${JSON.stringify(result.labelEventFormat.eventComposition)}`,
    `Window: sub-cancelled (human) ${humanCancelConvs.size}, sub-cancelled-ai ${aiCancelConvs.size}, overlap ${cancelOverlap}; conversations with any refund-% label ${refundPctConvs.size}`,
  ];
  if (firestore && !('error' in firestore)) {
    summaryLines.push(
      `Firestore snapshot: responded decisions with sub-cancel ${String(firestore.respondedWithSubCancel)}, of which with sub-cancelled-ai label ${String(firestore.respondedWithSubCancelAndAiCancelLabel)}`,
    );
  } else if (firestore) {
    summaryLines.push(`Firestore cross-check unavailable: ${String(firestore.error)}`);
  }
  if (v2) {
    const s = v2.perLabelCreatedSeries as Record<string, { match: boolean }>;
    summaryLines.push(
      `v2 type=label conversations_count vs script created-day counts: ${Object.entries(s)
        .map(([k, v]) => `${k}=${v.match ? 'match' : 'MISMATCH'}`)
        .join(', ')}`,
    );
  }

  console.log(summaryLines.join('\n'));
  for (const s of sections) console.log(`\n${s.title}\n${table(s.headers, s.rows)}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = path.join(OUT_DIR, `labels-and-actions_${DAYS}d_${lastDay}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 2));
  const md = [
    `# Labels and actions, ${firstDay}..${lastDay} (${TZ})`,
    '',
    ...summaryLines.map((l) => `- ${l}`),
    ...sections.flatMap((s) => ['', `## ${s.title}`, '', mdTable(s.headers, s.rows)]),
    '',
  ].join('\n');
  fs.writeFileSync(`${base}.md`, md);
  console.log(`\nWrote ${base}.json and ${base}.md`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});

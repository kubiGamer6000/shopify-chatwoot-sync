/**
 * Ticket volume, resolution and SLA metrics computed from raw Chatwoot
 * conversations and messages, cross-checked against the v2 reports API, plus a
 * backlog snapshot. Bot vs human attribution uses message patterns and the
 * Firestore sentReplies / agentBotDecisions records.
 *
 * READ-ONLY. Chatwoot GET requests and Firestore reads only. It never sends,
 * labels, assigns or changes anything.
 *
 * Usage:
 *   npx tsx src/scripts/analytics/ticketVolume.ts               # 7 complete local days + today so far
 *   npx tsx src/scripts/analytics/ticketVolume.ts --days=1      # yesterday + today so far
 *   Options:
 *     --days=N             complete local days before today (default 7, max 30). Today-so-far is always added.
 *     --tz=Europe/Helsinki business timezone (default Europe/Helsinki)
 *     --out=<dir>          output directory (default /home/dolan/support-analytics)
 *     --no-firestore       skip Firestore (bot attribution then relies on label + timing only)
 *     --no-reports         skip the v2 reports cross-check
 *
 * Output: prints summary tables and writes
 *   <out>/ticket-volume_<days>d_<asOf>.json and .md (aggregates + conversation ids only, no PII).
 *
 * See docs/support-analytics/ticket-volume-and-sla.md for definitions and caveats.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import axios from 'axios';
import { env } from '../../config/env.js';
import { chatwootClient } from '../../services/chatwoot.js';
import { autoReplySignal } from '../../services/autoReply.js';
import { getDb } from '../../services/firestore.js';
import type { ChatwootMessage } from '../../types/chatwoot.js';

// --- Constants ---------------------------------------------------------------

const INBOX_NAMES: Record<number, string> = { 99613: 'Support', 107519: 'Hey', 128017: 'Scandi-FB' };
const inboxName = (id: number) => INBOX_NAMES[id] ?? `inbox-${id}`;

/** How far before the window we read message history, to know each conversation's state at window start. */
const LOOKBACK_S = 14 * 86_400;
const MESSAGE_WORKERS = 5;
const PAGE_SIZE_LIST = 25;
const PAGE_SIZE_MESSAGES = 20;
const DAY_S = 86_400;
const SUPPORT_INBOX_ID = 99613; // the only inbox with the AgentBot: new and reopened conversations start as pending

/** The bot's acknowledgement (holding) sends went live here; before it there are none. */
const ACK_LAUNCH_MS = Date.parse('2026-09-14T07:55:00Z');

// Activity (message_type 2) text formats. Every status change is only visible through these texts.
const RE_RESOLVED = /^Conversation was marked resolved\b/;
const RE_REOPENED = /^Conversation was reopened\b/;
const RE_MARKED_OPEN = /^Conversation was marked open\b/;
const RE_AI_LABEL = /\badded\b.*\bai-(?:response|reply|resolved)\b/;
const ACTIVITY_FORMATS: [string, RegExp][] = [
  ['Conversation was marked resolved by <user>', RE_RESOLVED],
  ['Conversation was reopened by <user>', RE_REOPENED],
  ['Conversation was marked open by system due to an error with the agent bot.', RE_MARKED_OPEN],
  ['<user> added <label>[, <label>...]', /^.+ added .+/],
  ['<user> removed <label>', /^.+ removed .+/],
  ['Assigned to <user> by Automation System', /^Assigned to .+ by Automation System/],
  ['Assigned to <user> by Default Policy', /^Assigned to .+ by Default Policy/],
  ['<user> self-assigned this conversation', /self-assigned this conversation/],
];

// --- Args --------------------------------------------------------------------

interface Args {
  days: number;
  tz: string;
  out: string;
  firestore: boolean;
  reports: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const days = Number(get('days') ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('--days must be an integer 1..30');
  const tz = get('tz') ?? 'Europe/Helsinki';
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }); // throws on an invalid zone
  return {
    days,
    tz,
    out: get('out') ?? '/home/dolan/support-analytics',
    firestore: !argv.includes('--no-firestore'),
    reports: !argv.includes('--no-reports'),
  };
}

// --- Time helpers (DST-safe, no dependency) ----------------------------------

function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return wall - Math.floor(ms / 1000) * 1000;
}

function localDay(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
}

function localMidnight(day: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz);
  return t;
}

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

const iso = (ms: number) => new Date(ms).toISOString();
const hours = (s: number) => Math.round((s / 3600) * 10) / 10;

// --- Small utils -------------------------------------------------------------

function inc(map: Record<string, number>, key: string, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

function sortDesc(map: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]));
}

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

/** Linear-interpolated percentile of an unsorted numeric array (null when empty). */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (idx - lo);
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/** API cost accounting per phase. */
const cost: Record<string, { calls: number; ms: number }> = {};
async function timed<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const c = (cost[phase] ??= { calls: 0, ms: 0 });
    c.ms += Date.now() - t0;
  }
}
function countCall(phase: string) {
  (cost[phase] ??= { calls: 0, ms: 0 }).calls++;
}

// --- Chatwoot types ----------------------------------------------------------

interface Conv {
  id: number;
  inbox_id: number;
  status: string;
  labels: string[];
  created_at: number; // epoch s
  last_activity_at: number; // epoch s
  waiting_since: number; // epoch s, 0 when nobody is waiting
  first_reply_created_at: number; // epoch s, 0 when none (lifetime value; not used for SLA)
}

interface Msg {
  id: number;
  message_type: number; // 0 incoming, 1 outgoing, 2 activity, 3 template
  private: boolean;
  content: string | null;
  created_at: number; // epoch s
  content_attributes: Record<string, unknown>;
}

function toConv(c: Record<string, any>): Conv {
  return {
    id: c.id,
    inbox_id: c.inbox_id,
    status: c.status,
    labels: c.labels ?? [],
    created_at: c.created_at,
    last_activity_at: c.last_activity_at,
    waiting_since: c.waiting_since ?? 0,
    first_reply_created_at: c.first_reply_created_at ?? 0,
  };
}

// --- Chatwoot pulls ----------------------------------------------------------

async function listPage(status: string, page: number): Promise<{ rows: Conv[]; allCount: number | null }> {
  const { data } = await chatwootClient.get('/conversations', {
    params: { status, assignee_type: 'all', sort_by: 'last_activity_at_desc', page },
    timeout: 60_000,
  });
  return {
    rows: ((data?.data?.payload ?? []) as Record<string, any>[]).map(toConv),
    allCount: data?.data?.meta?.all_count ?? null,
  };
}

/**
 * Every conversation with last_activity_at >= sinceS. The list is strictly
 * sorted by last activity, so we stop at the first older row. A conversation
 * that gets activity while we page jumps to page 1, so page 1 is re-read at the end.
 */
async function listActiveSince(sinceS: number): Promise<{ rows: Conv[]; allCount: number | null }> {
  const byId = new Map<number, Conv>();
  let allCount: number | null = null;
  for (let page = 1; page < 1000; page++) {
    countCall('list');
    const res = await listPage('all', page);
    if (page === 1) allCount = res.allCount;
    for (const c of res.rows) if (c.last_activity_at >= sinceS) byId.set(c.id, c);
    const last = res.rows[res.rows.length - 1];
    if (!last || res.rows.length < PAGE_SIZE_LIST || last.last_activity_at < sinceS) break;
  }
  countCall('list');
  for (const c of (await listPage('all', 1)).rows) if (c.last_activity_at >= sinceS) byId.set(c.id, c);
  return { rows: [...byId.values()], allCount };
}

async function listStatus(status: string): Promise<{ rows: Conv[]; allCount: number | null }> {
  const byId = new Map<number, Conv>();
  let allCount: number | null = null;
  for (let page = 1; page < 1000; page++) {
    countCall('backlog-list');
    const res = await listPage(status, page);
    if (page === 1) allCount = res.allCount;
    for (const c of res.rows) byId.set(c.id, c);
    if (res.rows.length < PAGE_SIZE_LIST) break;
  }
  return { rows: [...byId.values()], allCount };
}

interface History {
  messages: Msg[]; // sorted by (created_at, id)
  complete: boolean; // true when we reached the first message of the conversation
  pages: number;
}

/**
 * Messages of a conversation, newest pages first, until a page is short (start
 * of history) or its oldest message is older than `sinceS`.
 * `stop` can end paging early (backlog: once we have seen our last reply).
 */
async function fetchHistory(phase: string, id: number, sinceS: number, stop?: (page: Msg[]) => boolean): Promise<History> {
  const byId = new Map<number, Msg>();
  let before: number | undefined;
  let complete = false;
  let pages = 0;
  for (let i = 0; i < 50; i++) {
    countCall(phase);
    pages++;
    const { data } = await chatwootClient.get(`/conversations/${id}/messages`, {
      params: before ? { before } : {},
      timeout: 60_000,
    });
    const payload = ((data?.payload ?? []) as Record<string, any>[]).map(
      (m): Msg => ({
        id: m.id,
        message_type: m.message_type,
        private: !!m.private,
        content: m.content ?? null,
        created_at: m.created_at,
        content_attributes: m.content_attributes ?? {},
      }),
    );
    for (const m of payload) byId.set(m.id, m);
    if (payload.length < PAGE_SIZE_MESSAGES) {
      complete = true;
      break;
    }
    const minId = Math.min(...payload.map((m) => m.id));
    const minTs = Math.min(...payload.map((m) => m.created_at));
    if (minTs < sinceS || minId === before || stop?.(payload)) break;
    before = minId;
  }
  const messages = [...byId.values()].sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  return { messages, complete, pages };
}

/** v2 reports timeseries for one metric, keyed by local day. Splits the range at DST changes. */
async function reportSeries(
  metric: string,
  scope: { type: 'account' } | { type: 'inbox'; id: number },
  days: string[],
  nowMs: number,
  tz: string,
): Promise<Record<string, { value: number; count?: number }>> {
  // DST rule (verified live 2026-09-14 across 2026-03-29 and 2025-10-26): pass the offset in effect NOW for the whole
  // range. Chatwoot resolves it to a DST-aware zone, so offset 3 (summer) buckets at Helsinki midnight on both sides of a
  // DST change, while offset 2 buckets at CET/CEST midnight. Never split a range by the offset of past dates. Which number
  // gives Helsinki buckets in winter is UNVERIFIED, so every bucket timestamp is asserted against localMidnight().
  const groups: { offsetH: number; days: string[] }[] = [{ offsetH: tzOffsetMs(nowMs, tz) / 3_600_000, days }];
  const out: Record<string, { value: number; count?: number }> = {};
  for (const g of groups) {
    const since = localMidnight(g.days[0] as string, tz);
    const until = Math.min(localMidnight(addDays(g.days[g.days.length - 1] as string, 1), tz), nowMs);
    countCall('v2-reports');
    const { data } = await axios.get(`${env.chatwootBaseUrl}/api/v2/accounts/${env.chatwootAccountId}/reports`, {
      headers: { api_access_token: env.chatwootApiToken },
      params: {
        metric,
        ...scope,
        since: Math.floor(since / 1000),
        until: Math.floor(until / 1000),
        group_by: 'day',
        timezone_offset: g.offsetH,
      },
      timeout: 60_000,
    });
    for (const row of data as { value: number | string; timestamp: number; count?: number }[]) {
      const day = localDay(row.timestamp * 1000 + 3_600_000, tz); // bucket timestamp = local midnight
      if (row.timestamp * 1000 !== localMidnight(day, tz) && row.timestamp * 1000 > since) v2BucketAssertionFailures.push(`${metric}:${row.timestamp}`);
      if (g.days.includes(day)) out[day] = { value: Number(row.value), ...(row.count != null ? { count: row.count } : {}) };
    }
  }
  return out;
}

/** Bucket timestamps that are not a local midnight (a wrong timezone_offset). Reported in the output; must stay empty. */
const v2BucketAssertionFailures: string[] = [];

async function reportSummary(sinceMs: number, nowMs: number, tz: string): Promise<Record<string, unknown>> {
  countCall('v2-reports');
  const { data } = await axios.get(`${env.chatwootBaseUrl}/api/v2/accounts/${env.chatwootAccountId}/reports/summary`, {
    headers: { api_access_token: env.chatwootApiToken },
    params: {
      type: 'account',
      since: Math.floor(sinceMs / 1000),
      until: Math.floor(nowMs / 1000),
      timezone_offset: tzOffsetMs(sinceMs, tz) / 3_600_000,
    },
    timeout: 60_000,
  });
  return data as Record<string, unknown>;
}

/**
 * Raw reporting events conversation_opened, counted per local day of created_at, split by value > 0 (reopen of a
 * conversation resolved before) and value = 0. 25 rows per page. These rows use Chatwoot's internal conversation id,
 * so they cannot be joined to conversations: the script only compares daily totals with statusReplay().
 */
async function openedEventsByDay(sinceMs: number, nowMs: number, tz: string): Promise<Record<string, { valueGt0: number; value0: number }>> {
  const out: Record<string, { valueGt0: number; value0: number }> = {};
  const seen = new Set<number>();
  const params = { since: Math.floor(sinceMs / 1000), until: Math.floor(nowMs / 1000), name: 'conversation_opened' };
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    countCall('reporting-events');
    const { data } = await chatwootClient.get('/reporting_events', { params: { ...params, page }, timeout: 60_000 });
    totalPages = Number(data?.meta?.total_pages ?? 1);
    for (const e of (data?.payload ?? []) as { id: number; value: number; created_at: string }[]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const day = localDay(Date.parse(e.created_at), tz);
      const row = (out[day] ??= { valueGt0: 0, value0: 0 });
      if (Number(e.value) > 0) row.valueGt0++;
      else row.value0++;
    }
  }
  return out;
}

// --- Firestore ---------------------------------------------------------------

interface SentReply {
  conversationId: number;
  source: string; // dashboard | agent-bot | agent-bot-holding
  ts: number; // epoch ms
  prefix: string; // normalized first 25 chars, in memory only (PII)
}
interface Decision {
  conversationId: number;
  action: string;
  ts: number;
}

const norm = (s: string | null | undefined) =>
  (s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_>#`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 25);

async function readFirestore(sinceMs: number): Promise<{ sent: SentReply[]; decisions: Decision[] } | null> {
  const db = getDb();
  if (!db) return null;
  const t0 = Date.now();
  // ts is a NUMBER (epoch ms). A where() with a Date object silently returns nothing.
  // The project can hit RESOURCE_EXHAUSTED when other jobs share the read quota: retry with backoff.
  const query = async (collection: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.collection(collection).where('ts', '>=', sinceMs).get();
      } catch (e) {
        if (attempt >= 3 || !/RESOURCE_EXHAUSTED|Quota/i.test((e as Error).message)) throw e;
        await new Promise((r) => setTimeout(r, 15_000 * (attempt + 1)));
      }
    }
  };
  const sentSnap = await query('sentReplies');
  const decSnap = await query('agentBotDecisions');
  cost['firestore'] = { calls: 2, ms: Date.now() - t0 };
  return {
    sent: sentSnap.docs.map((d) => {
      const x = d.data();
      return { conversationId: Number(x.conversationId), source: String(x.source ?? ''), ts: Number(x.ts), prefix: norm(x.message) };
    }),
    decisions: decSnap.docs.map((d) => {
      const x = d.data();
      return { conversationId: Number(x.conversationId ?? d.id), action: String(x.action ?? ''), ts: Number(x.ts) };
    }),
  };
}

// --- Classification ----------------------------------------------------------

const isHumanCustomer = (m: Msg) =>
  m.message_type === 0 && !m.private && autoReplySignal(m as unknown as ChatwootMessage) === null;
const isIncomingPublic = (m: Msg) => m.message_type === 0 && !m.private;
const isPublicOutgoing = (m: Msg) => m.message_type === 1 && !m.private;
const isActivity = (m: Msg) => m.message_type === 2;
const isResolve = (m: Msg) => isActivity(m) && RE_RESOLVED.test(m.content ?? '');
const isStatusEvent = (m: Msg) =>
  isActivity(m) && (RE_RESOLVED.test(m.content ?? '') || RE_REOPENED.test(m.content ?? '') || RE_MARKED_OPEN.test(m.content ?? ''));

type ReplyKind = 'bot-label' | 'bot-sentReplies' | 'bot-timing' | 'holding' | 'human-dashboard' | 'human-other';
const isBotKind = (k: ReplyKind) => k === 'bot-label' || k === 'bot-sentReplies' || k === 'bot-timing';
const isHumanKind = (k: ReplyKind) => k === 'human-dashboard' || k === 'human-other';

/**
 * Who sent each public outgoing message. Chatwoot cannot tell (one shared user),
 * so this layers signals, strongest first:
 *  1. sentReplies source agent-bot-holding -> holding ack; agent-bot -> bot; dashboard -> human.
 *  2. '[AI HANDOFF]' private note within 60 s after -> holding ack.
 *  3. 'added ai-response|ai-reply|ai-resolved' activity within 5 s after -> bot.
 *     (Chatwoot only logs a label add the FIRST time, so repeat bot answers need rule 4.)
 *  4. Timing: sent < 60 s after the latest incoming message AND a resolve within 2 s -> bot.
 *  Otherwise human (typed in the Chatwoot UI, or unmatched).
 */
function classifyReplies(conversationId: number, msgs: Msg[], sent: SentReply[] | null): Map<number, ReplyKind> {
  const out = new Map<number, ReplyKind>();
  const mine = sent?.filter((s) => s.conversationId === conversationId) ?? [];
  let lastIncomingAt: number | null = null;
  msgs.forEach((m, i) => {
    if (isIncomingPublic(m)) lastIncomingAt = m.created_at;
    if (!isPublicOutgoing(m)) return;
    const ms = m.created_at * 1000;
    const p = norm(m.content);
    const candidates = mine.filter((s) => Math.abs(s.ts - ms) < 180_000);
    const match =
      candidates.find((s) => p.length > 0 && s.prefix === p) ??
      candidates.filter((s) => Math.abs(s.ts - ms) < 15_000).sort((a, b) => Math.abs(a.ts - ms) - Math.abs(b.ts - ms))[0];
    if (match?.source === 'agent-bot-holding') return void out.set(m.id, 'holding');
    if (match?.source === 'agent-bot') return void out.set(m.id, 'bot-sentReplies');
    const after = msgs.slice(i + 1).filter((x) => x.created_at - m.created_at <= 60);
    if (after.some((x) => x.private && (x.content ?? '').startsWith('[AI HANDOFF]')) && m.created_at * 1000 >= ACK_LAUNCH_MS - 3_600_000) {
      return void out.set(m.id, 'holding');
    }
    if (match?.source === 'dashboard') return void out.set(m.id, 'human-dashboard');
    if (after.some((x) => x.created_at - m.created_at <= 5 && isActivity(x) && RE_AI_LABEL.test(x.content ?? ''))) {
      return void out.set(m.id, 'bot-label');
    }
    const fast = lastIncomingAt !== null && m.created_at - lastIncomingAt < 60;
    const resolvedRightAway = msgs.some((x) => isResolve(x) && x.created_at - m.created_at >= 0 && x.created_at - m.created_at <= 2);
    if (fast && resolvedRightAway) return void out.set(m.id, 'bot-timing');
    out.set(m.id, 'human-other');
  });
  return out;
}

/** A resolve counts as "bot signal" when a bot reply, an ai-* label add or an '[AI] Closed without reply' note is within 10 s before it. */
function resolveHasBotSignal(msgs: Msg[], idx: number, kinds: Map<number, ReplyKind>): boolean {
  const r = msgs[idx] as Msg;
  for (let j = idx - 1; j >= 0; j--) {
    const m = msgs[j] as Msg;
    if (r.created_at - m.created_at > 10) break;
    if (isPublicOutgoing(m) && isBotKind(kinds.get(m.id) ?? 'human-other')) return true;
    if (isActivity(m) && RE_AI_LABEL.test(m.content ?? '')) return true;
    if (m.private && (m.content ?? '').startsWith('[AI] Closed without reply')) return true;
  }
  // The label activity can carry a larger id than the resolve in the same second.
  return msgs.slice(idx + 1).some((m) => m.created_at - r.created_at <= 1 && isActivity(m) && RE_AI_LABEL.test(m.content ?? ''));
}

// --- Status replay (reopen events, end-of-day backlog) ----------------------------

type ReplayStatus = 'open' | 'pending' | 'resolved' | null;
interface ReplayPoint {
  ts: number; // state is valid from this message's created_at (inclusive) on
  status: ReplayStatus;
  waitStart: number | null; // first unanswered human customer message (holding acks are not answers)
}
interface Replay {
  points: ReplayPoint[];
  /** Emulated reporting event conversation_opened with value > 0: the status becomes open on a conversation that was resolved at least once before. */
  openedAfterPriorResolve: number[];
}

/**
 * Replays a conversation's status from its messages.
 * - Creation: pending in the Support inbox (AgentBot), open elsewhere. Unknown (null) when the history is truncated.
 * - "marked resolved" -> resolved. "reopened" / "marked open" -> open.
 * - An incoming public message into a resolved conversation reopens it silently (no activity text):
 *   Support -> pending (the bot then hands off with a "reopened" text, or resolves again), other inboxes -> open.
 * Chatwoot writes conversation_opened (value = seconds since the last resolve, so > 0) whenever the status becomes
 * open and a previous resolve exists. Bot-handled reopens (resolved -> pending -> resolved) never write one.
 */
function statusReplay(c: Conv, h: History, kinds: Map<number, ReplyKind>): Replay {
  const points: ReplayPoint[] = [];
  const openedAfterPriorResolve: number[] = [];
  let status: ReplayStatus = h.complete ? (c.inbox_id === SUPPORT_INBOX_ID ? 'pending' : 'open') : null;
  let everResolved = false;
  let waitStart: number | null = null;
  for (const m of h.messages) {
    const content = m.content ?? '';
    if (isResolve(m)) {
      status = 'resolved';
      everResolved = true;
      waitStart = null;
    } else if (isActivity(m) && (RE_REOPENED.test(content) || RE_MARKED_OPEN.test(content))) {
      if (everResolved && status !== 'open') openedAfterPriorResolve.push(m.created_at);
      status = 'open';
    } else if (isIncomingPublic(m)) {
      if (status === 'resolved') {
        if (c.inbox_id === SUPPORT_INBOX_ID) status = 'pending';
        else {
          status = 'open';
          openedAfterPriorResolve.push(m.created_at);
        }
      }
      if (isHumanCustomer(m) && waitStart === null) waitStart = m.created_at;
    } else if (isPublicOutgoing(m) && kinds.get(m.id) !== 'holding') {
      waitStart = null;
    }
    points.push({ ts: m.created_at, status, waitStart });
  }
  return { points, openedAfterPriorResolve };
}

/** State just before `cutoffS` (exclusive). Null when the conversation had no message yet. */
function replayStateAt(r: Replay, cutoffS: number): ReplayPoint | null {
  let best: ReplayPoint | null = null;
  for (const p of r.points) {
    if (p.ts >= cutoffS) break;
    best = p;
  }
  return best;
}

// --- Metric structures -------------------------------------------------------

interface Counter {
  needing: Set<number>;
  new: Set<number>;
  cameBack: Set<number>;
  reopenedFromResolved: Set<number>;
  created: number;
  incomingPublic: number;
  incomingMachine: number;
  resolveEvents: number;
  resolvedConvs: Set<number>;
  resolveEventsBotSignal: number;
  reopenedActivityEvents: number;
  replies: Record<string, number>;
  /** Resolve events that closed a ticket cycle, and how many of those were late. */
  resolvedWithCycle: number;
  resolvedNoCycle: number;
  resolvedLate24h: number;
  resolvedLate48h: number;
  resolvedFirstResponseLate24h: number;
  resolvedFirstHumanReplyLate24h: number;
  /** Emulation of Chatwoot's reporting event conversation_opened with value > 0 (see statusReplay). */
  openedAfterPriorResolveEvents: number;
  openedAfterPriorResolveConvs: Set<number>;
  reopenCyclesStarted: number;
}
const newCounter = (): Counter => ({
  needing: new Set(),
  new: new Set(),
  cameBack: new Set(),
  reopenedFromResolved: new Set(),
  created: 0,
  incomingPublic: 0,
  incomingMachine: 0,
  resolveEvents: 0,
  resolvedConvs: new Set(),
  resolveEventsBotSignal: 0,
  reopenedActivityEvents: 0,
  replies: {},
  resolvedWithCycle: 0,
  resolvedNoCycle: 0,
  resolvedLate24h: 0,
  resolvedLate48h: 0,
  resolvedFirstResponseLate24h: 0,
  resolvedFirstHumanReplyLate24h: 0,
  openedAfterPriorResolveEvents: 0,
  openedAfterPriorResolveConvs: new Set(),
  reopenCyclesStarted: 0,
});

type CycleKind = 'new' | 'reopened-from-resolved' | 'follow-up-open';
interface Cycle {
  conversationId: number;
  inbox: string;
  kind: CycleKind;
  start: number; // epoch s
  startDay: string;
  firstAnyReply: number | null; // any public outgoing incl. holding ack
  firstResponse: number | null; // bot or human reply (holding acks excluded)
  firstHumanReply: number | null;
  firstBotReply: number | null;
  resolvedAt: number | null;
  resolvedBotSignal: boolean;
}

interface WaitEpisode {
  inbox: string;
  start: number; // first unanswered human customer message
  answeredAt: number | null; // public reply (not a holding ack)
  closedWithoutReplyAt: number | null; // resolve with no reply
}

// --- Main --------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { tz } = args;
  const nowMs = Date.now();
  const nowS = Math.floor(nowMs / 1000);
  const today = localDay(nowMs, tz);
  const startDay = addDays(today, -args.days);
  const days = Array.from({ length: args.days + 1 }, (_, i) => addDays(startDay, i));
  const windowStartMs = localMidnight(startDay, tz);
  const windowStartS = Math.floor(windowStartMs / 1000);
  const dayOf = (s: number) => localDay(s * 1000, tz);
  const inWindow = (s: number) => s >= windowStartS && s <= nowS;
  const log = (...a: unknown[]) => console.error('[ticketVolume]', ...a);

  log(`window ${startDay} 00:00 .. now (${iso(windowStartMs)} .. ${iso(nowMs)}), tz ${tz}`);

  // 1. Conversations touched in the window.
  const listed = await timed('list', () => listActiveSince(windowStartS));
  log(`conversations with activity in window: ${listed.rows.length} (${cost.list?.calls} list calls)`);

  // 2. Firestore attribution records (read-only).
  const fs = args.firestore
    ? await readFirestore(Math.min(windowStartMs, ACK_LAUNCH_MS) - 86_400_000).catch((e) => {
        log('Firestore unavailable:', (e as Error).message);
        return null;
      })
    : null;

  // 3. Message histories (window + 14-day lookback), 5 parallel workers.
  const histories = new Map<number, History>();
  await timed('messages', () =>
    mapLimit(listed.rows, MESSAGE_WORKERS, async (c) => {
      histories.set(c.id, await fetchHistory('messages', c.id, windowStartS - LOOKBACK_S));
    }),
  );
  log(`message calls: ${cost.messages?.calls}`);

  // 4. v2 reports (cross-check), pulled right after the raw data.
  const v2: Record<string, Record<string, { value: number; count?: number }>> = {};
  let v2Summary: Record<string, unknown> | null = null;
  let openedEvents: Record<string, { valueGt0: number; value0: number }> | null = null;
  if (args.reports) {
    await timed('v2-reports', async () => {
      for (const metric of ['conversations_count', 'incoming_messages_count', 'resolutions_count', 'avg_first_response_time', 'avg_resolution_time']) {
        v2[`account:${metric}`] = await reportSeries(metric, { type: 'account' }, days, nowMs, tz);
      }
      for (const id of Object.keys(INBOX_NAMES).map(Number)) {
        for (const metric of ['conversations_count', 'incoming_messages_count']) {
          v2[`${inboxName(id)}:${metric}`] = await reportSeries(metric, { type: 'inbox', id }, days, nowMs, tz);
        }
      }
      v2Summary = await reportSummary(windowStartMs, nowMs, tz);
    }).catch((e) => log('v2 reports failed:', (e as Error).message));
    openedEvents = await timed('reporting-events', () => openedEventsByDay(windowStartMs, nowMs, tz)).catch((e) => {
      log('reporting_events failed:', (e as Error).message);
      return null;
    });
  }

  // 5. Walk every conversation.
  const daily = new Map<string, Counter>(days.map((d) => [d, newCounter()]));
  const dailyByInbox = new Map<string, Counter>();
  const counterFor = (day: string, inbox: string) => {
    const key = `${day}|${inbox}`;
    if (!dailyByInbox.has(key)) dailyByInbox.set(key, newCounter());
    return dailyByInbox.get(key) as Counter;
  };
  const cycles: Cycle[] = [];
  const waits: WaitEpisode[] = [];
  const activityCatalog: Record<string, number> = {};
  const unknownActivityConvs = new Set<number>();
  const timingRuleConvs = new Set<number>();
  const replays = new Map<number, Replay>();
  let truncatedHistories = 0;

  for (const c of listed.rows) {
    const h = histories.get(c.id);
    if (!h) continue;
    const inbox = inboxName(c.inbox_id);
    const msgs = h.messages;
    if (!h.complete) truncatedHistories++;
    const kinds = classifyReplies(c.id, msgs, fs?.sent ?? null);
    const replay = statusReplay(c, h, kinds);
    replays.set(c.id, replay);
    for (const t of replay.openedAfterPriorResolve) {
      const d = dayOf(t);
      if (!inWindow(t) || !daily.has(d)) continue;
      for (const x of [daily.get(d) as Counter, counterFor(d, inbox)]) {
        x.openedAfterPriorResolveEvents++;
        x.openedAfterPriorResolveConvs.add(c.id);
      }
    }

    if (inWindow(c.created_at)) {
      const d = dayOf(c.created_at);
      if (daily.has(d)) {
        (daily.get(d) as Counter).created++;
        counterFor(d, inbox).created++;
      }
    }

    let lastStatus: 'resolved' | 'open' | null = null;
    let seenPublicOutgoing = false;
    let cycleCount = 0;
    let cycle: Cycle | null = null;
    let wait: WaitEpisode | null = null;
    const firstHumanMsgDaySeen = new Set<string>();

    msgs.forEach((m, idx) => {
      const d = dayOf(m.created_at);
      const counted = inWindow(m.created_at) && daily.has(d);
      const dc = counted ? (daily.get(d) as Counter) : null;
      const ic = counted ? counterFor(d, inbox) : null;
      const both = (fn: (x: Counter) => void) => {
        if (dc && ic) {
          fn(dc);
          fn(ic);
        }
      };

      if (isActivity(m) && counted) {
        const fmt = ACTIVITY_FORMATS.find(([, re]) => re.test(m.content ?? ''))?.[0] ?? 'UNCLASSIFIED';
        inc(activityCatalog, fmt);
        if (fmt === 'UNCLASSIFIED') unknownActivityConvs.add(c.id);
      }

      if (isIncomingPublic(m)) {
        both((x) => x.incomingPublic++);
        if (!isHumanCustomer(m)) both((x) => x.incomingMachine++);
      }

      if (isHumanCustomer(m)) {
        // (1) needing handling, split new / came back / reopened-from-resolved (judged at the day's first human message)
        if (counted && !firstHumanMsgDaySeen.has(d)) {
          firstHumanMsgDaySeen.add(d);
          both((x) => {
            x.needing.add(c.id);
            if (dayOf(c.created_at) === d) x.new.add(c.id);
            else {
              x.cameBack.add(c.id);
              if (lastStatus === 'resolved') x.reopenedFromResolved.add(c.id);
            }
          });
        }
        // (4) cycle start
        if (!cycle) {
          const kind: CycleKind =
            lastStatus === 'resolved'
              ? 'reopened-from-resolved'
              : !seenPublicOutgoing && cycleCount === 0 && h.complete
                ? 'new'
                : 'follow-up-open';
          cycle = {
            conversationId: c.id,
            inbox,
            kind,
            start: m.created_at,
            startDay: d,
            firstAnyReply: null,
            firstResponse: null,
            firstHumanReply: null,
            firstBotReply: null,
            resolvedAt: null,
            resolvedBotSignal: false,
          };
          cycleCount++;
          if (inWindow(m.created_at)) cycles.push(cycle);
          if (kind === 'reopened-from-resolved') both((x) => x.reopenCyclesStarted++);
        }
        if (!wait) {
          wait = { inbox, start: m.created_at, answeredAt: null, closedWithoutReplyAt: null };
          if (inWindow(m.created_at)) waits.push(wait);
        }
      }

      if (isPublicOutgoing(m)) {
        seenPublicOutgoing = true;
        const k = kinds.get(m.id) ?? 'human-other';
        both((x) => inc(x.replies, k));
        if (k === 'bot-timing') timingRuleConvs.add(c.id);
        if (cycle) {
          cycle.firstAnyReply ??= m.created_at;
          if (k !== 'holding') cycle.firstResponse ??= m.created_at;
          if (isHumanKind(k)) cycle.firstHumanReply ??= m.created_at;
          if (isBotKind(k)) cycle.firstBotReply ??= m.created_at;
        }
        if (wait && k !== 'holding') {
          wait.answeredAt = m.created_at;
          wait = null;
        }
      }

      if (isStatusEvent(m)) {
        const content = m.content ?? '';
        if (RE_RESOLVED.test(content)) {
          const bot = resolveHasBotSignal(msgs, idx, kinds);
          both((x) => {
            x.resolveEvents++;
            x.resolvedConvs.add(c.id);
            if (bot) x.resolveEventsBotSignal++;
          });
          lastStatus = 'resolved';
          const closing: Cycle | null = cycle;
          both((x) => {
            if (!closing) {
              x.resolvedNoCycle++;
              return;
            }
            const ttr = m.created_at - closing.start;
            x.resolvedWithCycle++;
            if (ttr > DAY_S) x.resolvedLate24h++;
            if (ttr > 2 * DAY_S) x.resolvedLate48h++;
            if (closing.firstResponse === null || closing.firstResponse - closing.start > DAY_S) x.resolvedFirstResponseLate24h++;
            if (closing.firstHumanReply === null || closing.firstHumanReply - closing.start > DAY_S) x.resolvedFirstHumanReplyLate24h++;
          });
          if (cycle) {
            cycle.resolvedAt = m.created_at;
            cycle.resolvedBotSignal = bot;
            cycle = null;
          }
          if (wait) {
            wait.closedWithoutReplyAt = m.created_at;
            wait = null;
          }
        } else {
          if (RE_REOPENED.test(content)) both((x) => x.reopenedActivityEvents++);
          lastStatus = 'open';
        }
      }
    });
  }

  // Firestore decisions per day (latest decision per conversation only).
  const decisionsByDay: Record<string, Record<string, number>> = {};
  for (const d of fs?.decisions ?? []) {
    if (d.ts < windowStartMs) continue;
    const day = localDay(d.ts, tz);
    inc((decisionsByDay[day] ??= {}), d.action);
  }
  const latestDecision = new Map((fs?.decisions ?? []).map((d) => [d.conversationId, d.action]));
  const timingRuleConfirmed = fs ? [...timingRuleConvs].filter((id) => latestDecision.get(id) === 'responded').length : null;

  // --- (1)(2)(3) daily rows --------------------------------------------------
  const summarizeCounter = (x: Counter) => ({
    needing: x.needing.size,
    new: x.new.size,
    cameBack: x.cameBack.size,
    reopenedFromResolved: x.reopenedFromResolved.size,
    continuing: x.cameBack.size - x.reopenedFromResolved.size,
    created: x.created,
    incomingPublic: x.incomingPublic,
    incomingMachine: x.incomingMachine,
    resolveEvents: x.resolveEvents,
    resolvedDistinctConversations: x.resolvedConvs.size,
    resolveEventsWithBotSignal: x.resolveEventsBotSignal,
    resolveEventsWithoutBotSignal: x.resolveEvents - x.resolveEventsBotSignal,
    reopenedActivityEvents: x.reopenedActivityEvents,
    reopenCyclesStarted: x.reopenCyclesStarted,
    openedAfterPriorResolveEmulated: { events: x.openedAfterPriorResolveEvents, conversations: x.openedAfterPriorResolveConvs.size },
    resolvedLate: {
      resolveEventsClosingACycle: x.resolvedWithCycle,
      resolveEventsWithoutCycle: x.resolvedNoCycle,
      onTime24h: x.resolvedWithCycle - x.resolvedLate24h,
      late24h: x.resolvedLate24h,
      late48h: x.resolvedLate48h,
      late24hPct: pct(x.resolvedLate24h, x.resolvedWithCycle),
      late48hPct: pct(x.resolvedLate48h, x.resolvedWithCycle),
      firstResponseLate24h: x.resolvedFirstResponseLate24h,
      firstHumanReplyLate24h: x.resolvedFirstHumanReplyLate24h,
    },
    publicReplies: {
      total: Object.values(x.replies).reduce((a, b) => a + b, 0),
      bot: (x.replies['bot-label'] ?? 0) + (x.replies['bot-sentReplies'] ?? 0) + (x.replies['bot-timing'] ?? 0),
      holdingAck: x.replies['holding'] ?? 0,
      human: (x.replies['human-dashboard'] ?? 0) + (x.replies['human-other'] ?? 0),
      byRule: sortDesc(x.replies),
    },
  });

  const v2Get = (key: string, day: string) => v2[key]?.[day]?.value ?? null;
  const dailyRows = days.map((day) => {
    const s = summarizeCounter(daily.get(day) as Counter);
    const byInbox = Object.fromEntries(
      Object.values(INBOX_NAMES).map((name) => {
        const x = dailyByInbox.get(`${day}|${name}`);
        const r = x ? summarizeCounter(x) : summarizeCounter(newCounter());
        return [
          name,
          {
            needing: r.needing,
            new: r.new,
            cameBack: r.cameBack,
            reopenedFromResolved: r.reopenedFromResolved,
            created: r.created,
            incomingPublic: r.incomingPublic,
            resolveEvents: r.resolveEvents,
            resolvedLate: r.resolvedLate,
            v2ConversationsCount: v2Get(`${name}:conversations_count`, day),
            v2IncomingMessagesCount: v2Get(`${name}:incoming_messages_count`, day),
          },
        ];
      }),
    );
    const afrt = v2[`account:avg_first_response_time`]?.[day];
    const art = v2[`account:avg_resolution_time`]?.[day];
    const dc = daily.get(day) as Counter;
    const reopenReconciliation = {
      messageBasedReopenedConversations: s.reopenedFromResolved,
      messageBasedReopenCycles: s.reopenCyclesStarted,
      emulatedOpenedValueGt0Events: s.openedAfterPriorResolveEmulated.events,
      emulatedOpenedValueGt0Conversations: s.openedAfterPriorResolveEmulated.conversations,
      chatwootReportingEventsOpenedValueGt0: openedEvents ? (openedEvents[day]?.valueGt0 ?? 0) : null,
      chatwootReportingEventsOpenedValue0: openedEvents ? (openedEvents[day]?.value0 ?? 0) : null,
      exampleIdsMessageBasedOnly: [...dc.reopenedFromResolved].filter((id) => !dc.openedAfterPriorResolveConvs.has(id)).sort((a, b) => a - b).slice(0, 15),
      exampleIdsEmulatedEventOnly: [...dc.openedAfterPriorResolveConvs].filter((id) => !dc.reopenedFromResolved.has(id)).sort((a, b) => a - b).slice(0, 15),
      countMessageBasedOnly: [...dc.reopenedFromResolved].filter((id) => !dc.openedAfterPriorResolveConvs.has(id)).length,
      countEmulatedEventOnly: [...dc.openedAfterPriorResolveConvs].filter((id) => !dc.reopenedFromResolved.has(id)).length,
    };
    return {
      day,
      partial: day === today,
      ...s,
      reopenReconciliation,
      byInbox,
      botDecisionsLatestByTsDay: sortDesc(decisionsByDay[day] ?? {}),
      v2: {
        conversations_count: v2Get('account:conversations_count', day),
        incoming_messages_count: v2Get('account:incoming_messages_count', day),
        resolutions_count: v2Get('account:resolutions_count', day),
        avg_first_response_time_h: afrt ? hours(afrt.value) : null,
        avg_first_response_time_count: afrt?.count ?? null,
        avg_resolution_time_h: art ? hours(art.value) : null,
        avg_resolution_time_count: art?.count ?? null,
      },
      diffRawMinusV2: {
        created: v2Get('account:conversations_count', day) === null ? null : s.created - (v2Get('account:conversations_count', day) as number),
        incoming: v2Get('account:incoming_messages_count', day) === null ? null : s.incomingPublic - (v2Get('account:incoming_messages_count', day) as number),
        resolveEvents: v2Get('account:resolutions_count', day) === null ? null : s.resolveEvents - (v2Get('account:resolutions_count', day) as number),
      },
    };
  });

  const completeRows = dailyRows.filter((r) => !r.partial);
  const sum = (rows: typeof dailyRows, f: (r: (typeof dailyRows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
  const totals = (rows: typeof dailyRows) => ({
    days: rows.map((r) => r.day),
    needingConversationDays: sum(rows, (r) => r.needing),
    new: sum(rows, (r) => r.new),
    cameBack: sum(rows, (r) => r.cameBack),
    reopenedFromResolved: sum(rows, (r) => r.reopenedFromResolved),
    created: sum(rows, (r) => r.created),
    incomingPublic: sum(rows, (r) => r.incomingPublic),
    incomingMachine: sum(rows, (r) => r.incomingMachine),
    resolveEvents: sum(rows, (r) => r.resolveEvents),
    resolvedConversationDays: sum(rows, (r) => r.resolvedDistinctConversations),
    resolveEventsWithBotSignal: sum(rows, (r) => r.resolveEventsWithBotSignal),
    reopenedActivityEvents: sum(rows, (r) => r.reopenedActivityEvents),
    reopenCyclesStarted: sum(rows, (r) => r.reopenCyclesStarted),
    emulatedOpenedValueGt0Events: sum(rows, (r) => r.openedAfterPriorResolveEmulated.events),
    chatwootReportingEventsOpenedValueGt0: openedEvents ? sum(rows, (r) => r.reopenReconciliation.chatwootReportingEventsOpenedValueGt0 ?? 0) : null,
    resolveEventsClosingACycle: sum(rows, (r) => r.resolvedLate.resolveEventsClosingACycle),
    resolvedLate24h: sum(rows, (r) => r.resolvedLate.late24h),
    resolvedLate48h: sum(rows, (r) => r.resolvedLate.late48h),
    resolvedFirstResponseLate24h: sum(rows, (r) => r.resolvedLate.firstResponseLate24h),
    resolvedFirstHumanReplyLate24h: sum(rows, (r) => r.resolvedLate.firstHumanReplyLate24h),
    publicRepliesBot: sum(rows, (r) => r.publicReplies.bot),
    publicRepliesHoldingAck: sum(rows, (r) => r.publicReplies.holdingAck),
    publicRepliesHuman: sum(rows, (r) => r.publicReplies.human),
    publicRepliesHumanDashboardMatched: sum(rows, (r) => r.publicReplies.byRule['human-dashboard'] ?? 0),
  });

  // --- (4) SLA ----------------------------------------------------------------
  const H24 = 86_400;
  type ReplyField = 'firstResponse' | 'firstHumanReply' | 'firstAnyReply';
  const waitingShare = (list: Cycle[], field: ReplyField, thresholdS: number) => {
    const aged = list.filter((c) => nowS - c.start >= thresholdS);
    const late = (c: Cycle) => c[field] === null || (c[field] as number) - c.start > thresholdS;
    // Cycles closed within the threshold without that kind of reply (spam, thanks, or bot-handled
    // when measuring human replies) are excluded from BOTH numerator and denominator.
    const closedWithout = (c: Cycle) =>
      c.resolvedAt !== null && c.resolvedAt - c.start <= thresholdS && (c[field] === null || (c[field] as number) > c.resolvedAt);
    const eligible = aged.filter((c) => !closedWithout(c));
    return {
      eligible: eligible.length,
      late: eligible.filter(late).length,
      sharePct: pct(eligible.filter(late).length, eligible.length),
      unexcluded: { aged: aged.length, late: aged.filter(late).length, sharePct: pct(aged.filter(late).length, aged.length) },
    };
  };
  const dist = (vals: number[]) => ({ n: vals.length, p50_h: vals.length ? hours(percentile(vals, 0.5) as number) : null, p90_h: vals.length ? hours(percentile(vals, 0.9) as number) : null });
  const buckets = (list: Cycle[]) => {
    const b: Record<string, number> = { '<1m': 0, '1m-1h': 0, '1h-24h': 0, '24h-48h': 0, '>48h': 0, 'no reply, still open': 0, 'resolved without reply': 0 };
    for (const c of list) {
      if (c.firstResponse === null) inc(b, c.resolvedAt === null ? 'no reply, still open' : 'resolved without reply');
      else {
        const s = c.firstResponse - c.start;
        inc(b, s < 60 ? '<1m' : s < 3600 ? '1m-1h' : s < H24 ? '1h-24h' : s < 2 * H24 ? '24h-48h' : '>48h');
      }
    }
    return b;
  };
  const slaFor = (list: Cycle[]) => ({
    cycles: list.length,
    firstResponse: dist(list.filter((c) => c.firstResponse !== null).map((c) => (c.firstResponse as number) - c.start)),
    firstHumanReply: dist(list.filter((c) => c.firstHumanReply !== null).map((c) => (c.firstHumanReply as number) - c.start)),
    firstAnyReplyInclHoldingAck: dist(list.filter((c) => c.firstAnyReply !== null).map((c) => (c.firstAnyReply as number) - c.start)),
    timeToResolve: dist(list.filter((c) => c.resolvedAt !== null).map((c) => (c.resolvedAt as number) - c.start)),
    stillOpen: list.filter((c) => c.resolvedAt === null).length,
    resolvedWithBotSignal: list.filter((c) => c.resolvedAt !== null && c.resolvedBotSignal).length,
    firstResponseBuckets: buckets(list),
    noResponseWithin24h: waitingShare(list, 'firstResponse', H24),
    noResponseWithin48h: waitingShare(list, 'firstResponse', 2 * H24),
    noHumanReplyWithin24h: waitingShare(list, 'firstHumanReply', H24),
    noHumanReplyWithin48h: waitingShare(list, 'firstHumanReply', 2 * H24),
    // A start day is right-censored when some of its cycles are younger than 48 h.
    provisional: list.some((c) => nowS - c.start < 2 * H24),
  });
  const groupBy = <K extends string>(list: Cycle[], key: (c: Cycle) => K) => {
    const g: Record<string, Cycle[]> = {};
    for (const c of list) (g[key(c)] ??= []).push(c);
    return Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, slaFor(v)]));
  };
  const completeDayCycles = cycles.filter((c) => c.startDay !== today);
  const sla = {
    note: 'Cycles = customer contact that starts when no cycle is open and ends at the next resolve. Cohorted by start day. Times in hours, wall clock.',
    allInWindow: slaFor(cycles),
    completeDaysOnly: slaFor(completeDayCycles),
    todayOnly: slaFor(cycles.filter((c) => c.startDay === today)),
    byKind: groupBy(cycles, (c) => c.kind),
    byInbox: groupBy(cycles, (c) => c.inbox),
    byStartDay: groupBy(cycles, (c) => c.startDay),
  };

  const waitStats = (list: WaitEpisode[]) => ({
    episodes: list.length,
    answered: list.filter((w) => w.answeredAt !== null).length,
    closedWithoutReply: list.filter((w) => w.closedWithoutReplyAt !== null).length,
    stillWaiting: list.filter((w) => w.answeredAt === null && w.closedWithoutReplyAt === null).length,
    timeToReply: dist(list.filter((w) => w.answeredAt !== null).map((w) => (w.answeredAt as number) - w.start)),
  });
  const waitEpisodes = {
    note: 'One episode per streak of unanswered human customer messages (the waiting_since definition): starts at the first one, ends at our next public reply (holding acks ignored) or a resolve.',
    all: waitStats(waits),
    byInbox: Object.fromEntries(Object.values(INBOX_NAMES).map((n) => [n, waitStats(waits.filter((w) => w.inbox === n))])),
  };

  // --- (5) Backlog snapshot --------------------------------------------------
  const open = await timed('backlog-list', () => listStatus('open'));
  const pending = await timed('backlog-list', () => listStatus('pending'));
  countCall('backlog-list');
  const snoozedCount = (await listPage('snoozed', 1)).allCount;

  // Message-based overdue needs each open conversation's latest messages. Reuse window histories;
  // fetch the rest only until we see our last public reply or resolve.
  const missing = open.rows.filter((c) => !histories.has(c.id));
  await timed('backlog-messages', () =>
    mapLimit(missing, MESSAGE_WORKERS, async (c) => {
      histories.set(
        c.id,
        await fetchHistory('backlog-messages', c.id, 0, (page) => page.some((m) => isPublicOutgoing(m) || isResolve(m))),
      );
    }),
  );
  const sentForBacklog = fs?.sent ?? null;
  let exactOverdue24 = 0;
  let exactOverdue48 = 0;
  let wsAgree = 0;
  let wsDisagree = 0;
  let holdingAckMasked = 0;
  const lastSpeaker: Record<string, number> = {};
  const exactOverdueIds: number[] = [];
  const oldestUnanswered: { id: number; since: number } | null = open.rows.reduce<{ id: number; since: number } | null>((best, c) => {
    const h = histories.get(c.id);
    if (!h) return best;
    const msgs = h.messages;
    const kinds = classifyReplies(c.id, msgs, sentForBacklog);
    // Last "answer" = public reply that is not a holding ack, or a resolve.
    let lastAnswerIdx = -1;
    let lastAnswerInclHolding = -1;
    msgs.forEach((m, i) => {
      if (isResolve(m) || (isPublicOutgoing(m) && kinds.get(m.id) !== 'holding')) lastAnswerIdx = i;
      if (isResolve(m) || isPublicOutgoing(m)) lastAnswerInclHolding = i;
    });
    const after = msgs.slice(lastAnswerIdx + 1);
    const firstHuman = after.find(isHumanCustomer);
    if (firstHuman) {
      inc(lastSpeaker, 'customer waiting (human message unanswered)');
      const age = nowS - firstHuman.created_at;
      if (age > H24) exactOverdue24++;
      if (age > 2 * H24) {
        exactOverdue48++;
      }
      if (age > H24) exactOverdueIds.push(c.id);
      if (lastAnswerInclHolding > lastAnswerIdx) holdingAckMasked++;
      if (c.waiting_since > 0 && Math.abs(c.waiting_since - firstHuman.created_at) <= 2) wsAgree++;
      else wsDisagree++;
      if (!best || firstHuman.created_at < best.since) return { id: c.id, since: firstHuman.created_at };
    } else if (after.some(isIncomingPublic)) inc(lastSpeaker, 'only machine mail since our last reply');
    else inc(lastSpeaker, 'we replied or resolved last');
    return best;
  }, null);

  const ageBuckets = (rows: Conv[]) => {
    const b = { '<24h': 0, '24-48h': 0, '>48h': 0 };
    for (const c of rows) {
      const age = nowS - c.created_at;
      if (age < H24) b['<24h']++;
      else if (age < 2 * H24) b['24-48h']++;
      else b['>48h']++;
    }
    return b;
  };
  const byInboxCount = (rows: Conv[]) => {
    const m: Record<string, number> = {};
    for (const c of rows) inc(m, inboxName(c.inbox_id));
    return sortDesc(m);
  };
  const labelCounts = (rows: Conv[]) => {
    const m: Record<string, number> = {};
    for (const c of rows) {
      if (c.labels.length === 0) inc(m, '(none)');
      for (const l of c.labels) inc(m, l);
    }
    return Object.fromEntries(Object.entries(sortDesc(m)).slice(0, 12));
  };
  const oldestBy = (rows: Conv[], f: (c: Conv) => number) => {
    const r = rows.filter((c) => f(c) > 0).sort((a, b) => f(a) - f(b))[0];
    return r ? { conversationId: r.id, inbox: inboxName(r.inbox_id), at: iso(f(r) * 1000), ageHours: hours(nowS - f(r)) } : null;
  };
  const wsOpen = open.rows.filter((c) => c.waiting_since > 0);
  const wsPending = pending.rows.filter((c) => c.waiting_since > 0);
  const backlog = {
    asOf: iso(Date.now()),
    open: {
      count: open.rows.length,
      metaAllCount: open.allCount,
      byInbox: byInboxCount(open.rows),
      createdAge: ageBuckets(open.rows),
      oldestByCreatedAt: oldestBy(open.rows, (c) => c.created_at),
      oldestByWaitingSince: oldestBy(open.rows, (c) => c.waiting_since),
      waitingSinceProxy: {
        waiting: wsOpen.length,
        overdue24h: wsOpen.filter((c) => nowS - c.waiting_since > H24).length,
        overdue48h: wsOpen.filter((c) => nowS - c.waiting_since > 2 * H24).length,
        overdue24hByInbox: byInboxCount(wsOpen.filter((c) => nowS - c.waiting_since > H24)),
        caveat: 'From 2026-09-14 08:00Z a bot holding acknowledgement resets waiting_since, so this undercounts. Prefer the message-based numbers.',
      },
      messageBased: {
        lastSpeaker: sortDesc(lastSpeaker),
        overdue24h: exactOverdue24,
        overdue48h: exactOverdue48,
        overdue24hConversationIds: exactOverdueIds.sort((a, b) => a - b),
        oldestUnansweredHuman: oldestUnanswered
          ? { conversationId: oldestUnanswered.id, since: iso(oldestUnanswered.since * 1000), ageHours: hours(nowS - oldestUnanswered.since) }
          : null,
        waitingOnlyMaskedByHoldingAck: holdingAckMasked,
        waitingSinceAgreesWithin2s: wsAgree,
        waitingSinceDisagrees: wsDisagree,
      },
      topLabels: labelCounts(open.rows),
    },
    pending: {
      count: pending.rows.length,
      metaAllCount: pending.allCount,
      byInbox: byInboxCount(pending.rows),
      createdAge: ageBuckets(pending.rows),
      activityLast48h: pending.rows.filter((c) => nowS - c.last_activity_at < 2 * H24).length,
      oldestByCreatedAt: oldestBy(pending.rows, (c) => c.created_at),
      withWaitingSince: wsPending.length,
      waitingSinceAgeDays: wsPending.length
        ? {
            min: Math.round((nowS - Math.max(...wsPending.map((c) => c.waiting_since))) / 86_400),
            max: Math.round((nowS - Math.min(...wsPending.map((c) => c.waiting_since))) / 86_400),
          }
        : null,
      topLabels: labelCounts(pending.rows),
      note: 'Pending is the AgentBot state, not the human queue. Customers with waiting_since > 0 here are invisible to the open queue.',
    },
    snoozedCount,
  };

  // --- (6) End-of-day backlog, reconstructed from the status replay ------------
  // Population: every conversation active in the window (replayed from messages) plus open/pending conversations
  // with no activity since the window start (their state has not changed since before the window, so it is constant).
  const listedIds = new Set(listed.rows.map((c) => c.id));
  const constantState = new Map<number, { inbox: string; status: ReplayStatus; waitStart: number | null }>();
  for (const c of [...open.rows, ...pending.rows]) {
    if (listedIds.has(c.id)) continue;
    const h = histories.get(c.id);
    let waitStart: number | null = c.waiting_since > 0 ? c.waiting_since : null;
    if (h) waitStart = replayStateAt(statusReplay(c, h, classifyReplies(c.id, h.messages, sentForBacklog)), nowS + 1)?.waitStart ?? waitStart;
    constantState.set(c.id, { inbox: inboxName(c.inbox_id), status: c.status as ReplayStatus, waitStart });
  }
  const eodSnapshot = (cutoffS: number) => {
    const agg = {
      open: 0,
      pending: 0,
      unknownStatus: 0,
      openWaiting: 0,
      openOverdue24h: 0,
      openOverdue48h: 0,
      pendingWaiting: 0,
      pendingOverdue48h: 0,
      oldestOpenWaiting: null as null | { conversationId: number; inbox: string; ageHours: number },
      openByInbox: {} as Record<string, number>,
      openOverdue24hByInbox: {} as Record<string, number>,
    };
    const take = (id: number, inbox: string, status: ReplayStatus, waitStart: number | null) => {
      if (status === 'resolved') return;
      if (status === null) {
        agg.unknownStatus++;
        return;
      }
      const age = waitStart === null ? null : cutoffS - waitStart;
      if (status === 'open') {
        agg.open++;
        inc(agg.openByInbox, inbox);
        if (age !== null) {
          agg.openWaiting++;
          if (age > DAY_S) {
            agg.openOverdue24h++;
            inc(agg.openOverdue24hByInbox, inbox);
          }
          if (age > 2 * DAY_S) agg.openOverdue48h++;
          if (!agg.oldestOpenWaiting || age / 3600 > agg.oldestOpenWaiting.ageHours) agg.oldestOpenWaiting = { conversationId: id, inbox, ageHours: hours(age) };
        }
      } else if (status === 'pending') {
        agg.pending++;
        if (age !== null) {
          agg.pendingWaiting++;
          if (age > 2 * DAY_S) agg.pendingOverdue48h++;
        }
      }
    };
    for (const c of listed.rows) {
      const r = replays.get(c.id);
      const st = r ? replayStateAt(r, cutoffS) : null;
      if (!st) continue; // no message before the cutoff (created later)
      take(c.id, inboxName(c.inbox_id), st.status, st.waitStart);
    }
    for (const [id, x] of constantState) take(id, x.inbox, x.status, x.waitStart);
    return agg;
  };
  let replayStatusMismatch = 0;
  const replayStatusMismatchIds: number[] = [];
  for (const c of listed.rows) {
    const r = replays.get(c.id);
    const st = r ? replayStateAt(r, nowS + 1) : null;
    if (st && st.status !== null && st.status !== c.status) {
      replayStatusMismatch++;
      if (replayStatusMismatchIds.length < 15) replayStatusMismatchIds.push(c.id);
    }
  }
  const endOfDayBacklog = {
    note:
      'Reconstructed state at each local midnight (end of day D = 00:00 of D+1; the partial row uses the run time). open/pending from the status replay; waiting = unanswered human customer message (holding acks ignored). Compare the "now" row with backlog (live) to judge accuracy.',
    days: days.map((day) => {
      const cutoffS = day === today ? nowS : Math.floor(localMidnight(addDays(day, 1), tz) / 1000);
      return { day, partial: day === today, cutoffUtc: iso(cutoffS * 1000), ...eodSnapshot(cutoffS) };
    }),
    validation: {
      replayStatusMismatchesVsListStatus: replayStatusMismatch,
      replayStatusMismatchExampleIds: replayStatusMismatchIds,
      constantStateConversations: constantState.size,
      liveOpen: open.rows.length,
      livePending: pending.rows.length,
      liveOverdue24h: exactOverdue24,
      liveOverdue48h: exactOverdue48,
    },
  };

  // --- Output -----------------------------------------------------------------
  const totalCalls = Object.values(cost).reduce((a, c) => a + c.calls, 0);
  const result = {
    generatedAt: iso(nowMs),
    timezone: tz,
    window: {
      completeDays: args.days,
      firstDay: startDay,
      today,
      startUtc: iso(windowStartMs),
      nowUtc: iso(nowMs),
    },
    dataPull: {
      conversationsInWindow: listed.rows.length,
      accountAllCount: listed.allCount,
      historiesTruncatedByLookback: truncatedHistories,
      lookbackDays: LOOKBACK_S / 86_400,
      firestore: fs ? { sentReplies: fs.sent.length, agentBotDecisions: fs.decisions.length } : 'skipped/unavailable',
      apiCost: { ...cost, totalCalls },
    },
    daily: dailyRows,
    totals: { completeDays: totals(completeRows), today: totals(dailyRows.filter((r) => r.partial)) },
    attribution: {
      timingRuleReplies: sum(dailyRows, (r) => r.publicReplies.byRule['bot-timing'] ?? 0),
      timingRuleConversations: timingRuleConvs.size,
      timingRuleConversationsWhoseLatestBotDecisionIsResponded: timingRuleConfirmed,
      agentBotDecisionsSinceWindowStart: sortDesc(
        (fs?.decisions ?? []).filter((d) => d.ts >= windowStartMs).reduce<Record<string, number>>((m, d) => (inc(m, d.action), m), {}),
      ),
    },
    sla,
    waitEpisodes,
    backlog,
    endOfDayBacklog,
    activityCatalogInWindow: sortDesc(activityCatalog),
    unclassifiedActivityConversationIds: [...unknownActivityConvs].sort((a, b) => a - b),
    v2Summary,
    v2BucketAssertionFailures,
  };

  mkdirSync(args.out, { recursive: true });
  const base = join(args.out, `ticket-volume_${args.days}d_${today}`);
  writeFileSync(`${base}.json`, JSON.stringify(result, null, 2));
  const md = renderMarkdown(result);
  writeFileSync(`${base}.md`, md);
  console.log(md);
  log(`wrote ${base}.json and ${base}.md; ${totalCalls} API calls`);
  process.exit(0);
}

// --- Rendering ---------------------------------------------------------------

type Result = Record<string, any>;

function table(headers: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => (v === null || v === undefined ? '-' : String(v));
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

function renderMarkdown(r: Result): string {
  const out: string[] = [];
  const d = r.daily as Result[];
  out.push(`# Ticket volume and SLA, ${r.window.firstDay} .. ${r.window.today} (today partial)`);
  out.push(`Generated ${r.generatedAt}, timezone ${r.timezone}. Window start ${r.window.startUtc}.`);
  out.push(
    `Pull: ${r.dataPull.conversationsInWindow} conversations, ${r.dataPull.apiCost.totalCalls} API calls ` +
      `(list ${r.dataPull.apiCost.list?.calls ?? 0} / ${Math.round((r.dataPull.apiCost.list?.ms ?? 0) / 1000)} s, ` +
      `messages ${r.dataPull.apiCost.messages?.calls ?? 0} / ${Math.round((r.dataPull.apiCost.messages?.ms ?? 0) / 1000)} s).`,
  );

  out.push('\n## Tickets needing handling (distinct conversations with a human customer message)');
  out.push(
    table(
      ['day', 'needing', 'new', 'came back', 'reopened from resolved', 'continuing', 'Support', 'Hey', 'FB'],
      d.map((x) => [x.day + (x.partial ? ' *' : ''), x.needing, x.new, x.cameBack, x.reopenedFromResolved, x.continuing, x.byInbox.Support.needing, x.byInbox.Hey.needing, x.byInbox['Scandi-FB'].needing]),
    ),
  );

  out.push('\n## Resolutions, replies and v2 cross-check');
  out.push(
    table(
      ['day', 'created (v2)', 'incoming public (v2)', 'machine', 'resolve events (v2)', 'resolved convs', 'resolve w/ bot signal', "'reopened' texts", 'bot replies', 'holding acks', 'human replies'],
      d.map((x) => [
        x.day + (x.partial ? ' *' : ''),
        `${x.created} (${x.v2.conversations_count ?? '-'})`,
        `${x.incomingPublic} (${x.v2.incoming_messages_count ?? '-'})`,
        x.incomingMachine,
        `${x.resolveEvents} (${x.v2.resolutions_count ?? '-'})`,
        x.resolvedDistinctConversations,
        x.resolveEventsWithBotSignal,
        x.reopenedActivityEvents,
        x.publicReplies.bot,
        x.publicReplies.holdingAck,
        x.publicReplies.human,
      ]),
    ),
  );

  const t = r.totals.completeDays;
  out.push(
    `\nComplete days total: needing ${t.needingConversationDays} (new ${t.new}, came back ${t.cameBack}, reopened ${t.reopenedFromResolved}); ` +
      `created ${t.created}; resolve events ${t.resolveEvents} (${t.resolvedConversationDays} conversation-days); ` +
      `replies bot ${t.publicRepliesBot} / holding ${t.publicRepliesHoldingAck} / human ${t.publicRepliesHuman} (dashboard-matched ${t.publicRepliesHumanDashboardMatched}).`,
  );
  out.push(
    `Timing-rule bot replies: ${r.attribution.timingRuleReplies} in ${r.attribution.timingRuleConversations} conversations, ` +
      (r.attribution.timingRuleConversationsWhoseLatestBotDecisionIsResponded === null
        ? 'agentBotDecisions not checked (Firestore unavailable).'
        : `${r.attribution.timingRuleConversationsWhoseLatestBotDecisionIsResponded} of those conversations have latest agentBotDecision 'responded'.`),
  );

  out.push('\n## Resolved on time vs late (per resolve day; cycle start -> resolve)');
  out.push(
    table(
      ['day', 'resolve events', 'closing a cycle', 'late >24h', 'late >48h', 'first response >24h', 'first human reply >24h', 'Support late >24h', 'Hey late >24h', 'FB late >24h'],
      d.map((x) => [
        x.day + (x.partial ? ' *' : ''),
        x.resolveEvents,
        x.resolvedLate.resolveEventsClosingACycle,
        `${x.resolvedLate.late24h} (${x.resolvedLate.late24hPct ?? '-'}%)`,
        `${x.resolvedLate.late48h} (${x.resolvedLate.late48hPct ?? '-'}%)`,
        x.resolvedLate.firstResponseLate24h,
        x.resolvedLate.firstHumanReplyLate24h,
        `${x.byInbox.Support.resolvedLate.late24h}/${x.byInbox.Support.resolvedLate.resolveEventsClosingACycle}`,
        `${x.byInbox.Hey.resolvedLate.late24h}/${x.byInbox.Hey.resolvedLate.resolveEventsClosingACycle}`,
        `${x.byInbox['Scandi-FB'].resolvedLate.late24h}/${x.byInbox['Scandi-FB'].resolvedLate.resolveEventsClosingACycle}`,
      ]),
    ),
  );

  out.push('\n## Reopen reconciliation (canonical = message-based reopened conversations)');
  out.push(
    table(
      ['day', 'reopened convs (canonical)', 'reopen cycles', 'emulated opened>0 events (convs)', 'Chatwoot opened value>0', 'Chatwoot opened value=0', 'message-only convs', 'event-only convs'],
      d.map((x) => [
        x.day + (x.partial ? ' *' : ''),
        x.reopenReconciliation.messageBasedReopenedConversations,
        x.reopenReconciliation.messageBasedReopenCycles,
        `${x.reopenReconciliation.emulatedOpenedValueGt0Events} (${x.reopenReconciliation.emulatedOpenedValueGt0Conversations})`,
        x.reopenReconciliation.chatwootReportingEventsOpenedValueGt0,
        x.reopenReconciliation.chatwootReportingEventsOpenedValue0,
        x.reopenReconciliation.countMessageBasedOnly,
        x.reopenReconciliation.countEmulatedEventOnly,
      ]),
    ),
  );

  out.push('\n## End-of-day backlog (reconstructed)');
  out.push(
    table(
      ['day (state at end)', 'open', 'open waiting', 'open overdue >24h', 'open overdue >48h', 'oldest open waiting', 'pending', 'pending waiting', 'unknown status'],
      (r.endOfDayBacklog.days as Result[]).map((x) => [
        x.day + (x.partial ? ' * (now)' : ''),
        x.open,
        x.openWaiting,
        x.openOverdue24h,
        x.openOverdue48h,
        x.oldestOpenWaiting ? `#${x.oldestOpenWaiting.conversationId} ${x.oldestOpenWaiting.ageHours} h` : null,
        x.pending,
        x.pendingWaiting,
        x.unknownStatus,
      ]),
    ),
  );
  out.push(`Validation: ${JSON.stringify(r.endOfDayBacklog.validation)}`);

  out.push('\n## SLA per ticket cycle (hours, wall clock)');
  const slaRow = (name: string, s: Result) => [
    name + (s.provisional ? ' (prov.)' : ''),
    s.cycles,
    `${s.firstResponse.p50_h ?? '-'} / ${s.firstResponse.p90_h ?? '-'} (n ${s.firstResponse.n})`,
    `${s.firstHumanReply.p50_h ?? '-'} / ${s.firstHumanReply.p90_h ?? '-'} (n ${s.firstHumanReply.n})`,
    `${s.timeToResolve.p50_h ?? '-'} / ${s.timeToResolve.p90_h ?? '-'} (n ${s.timeToResolve.n})`,
    `${s.noResponseWithin24h.late}/${s.noResponseWithin24h.eligible} (${s.noResponseWithin24h.sharePct ?? '-'}%)`,
    `${s.noResponseWithin48h.late}/${s.noResponseWithin48h.eligible} (${s.noResponseWithin48h.sharePct ?? '-'}%)`,
    `${s.noHumanReplyWithin24h.late}/${s.noHumanReplyWithin24h.eligible} (${s.noHumanReplyWithin24h.sharePct ?? '-'}%)`,
  ];
  const slaHeaders = ['group', 'cycles', 'first response p50/p90', 'first human reply p50/p90', 'resolve p50/p90', 'no response >24h', 'no response >48h', 'no human reply >24h'];
  const slaRows = [
    slaRow('all in window', r.sla.allInWindow),
    slaRow('complete days', r.sla.completeDaysOnly),
    slaRow('today', r.sla.todayOnly),
    ...Object.entries(r.sla.byKind).map(([k, s]) => slaRow(`kind: ${k}`, s as Result)),
    ...Object.entries(r.sla.byInbox).map(([k, s]) => slaRow(`inbox: ${k}`, s as Result)),
    ...Object.entries(r.sla.byStartDay).map(([k, s]) => slaRow(`start ${k}`, s as Result)),
  ];
  out.push(table(slaHeaders, slaRows));
  out.push(`\nFirst response buckets (all in window): ${JSON.stringify(r.sla.allInWindow.firstResponseBuckets)}`);
  const w = r.waitEpisodes.all;
  out.push(`Wait episodes: ${w.episodes}, answered ${w.answered} (p50 ${w.timeToReply.p50_h} h, p90 ${w.timeToReply.p90_h} h), closed without reply ${w.closedWithoutReply}, still waiting ${w.stillWaiting}.`);

  const b = r.backlog;
  out.push(`\n## Backlog snapshot ${b.asOf}`);
  out.push(
    table(
      ['metric', 'value'],
      [
        ['open', `${b.open.count} ${JSON.stringify(b.open.byInbox)}`],
        ['open created age', JSON.stringify(b.open.createdAge)],
        ['oldest open by created_at', b.open.oldestByCreatedAt ? `#${b.open.oldestByCreatedAt.conversationId} ${b.open.oldestByCreatedAt.ageHours} h` : null],
        ['oldest open by waiting_since', b.open.oldestByWaitingSince ? `#${b.open.oldestByWaitingSince.conversationId} ${b.open.oldestByWaitingSince.ageHours} h` : null],
        ['oldest unanswered human message (messages)', b.open.messageBased.oldestUnansweredHuman ? `#${b.open.messageBased.oldestUnansweredHuman.conversationId} ${b.open.messageBased.oldestUnansweredHuman.ageHours} h` : null],
        ['open, last speaker', JSON.stringify(b.open.messageBased.lastSpeaker)],
        ['overdue >24h / >48h (messages, holding acks ignored)', `${b.open.messageBased.overdue24h} / ${b.open.messageBased.overdue48h}`],
        ['overdue >24h / >48h (waiting_since proxy)', `${b.open.waitingSinceProxy.overdue24h} / ${b.open.waitingSinceProxy.overdue48h}`],
        ['waiting only hidden by a holding ack', b.open.messageBased.waitingOnlyMaskedByHoldingAck],
        ['pending', `${b.pending.count} ${JSON.stringify(b.pending.byInbox)}, created >48h ${b.pending.createdAge['>48h']}, activity <48h ${b.pending.activityLast48h}`],
        ['pending with waiting_since > 0', `${b.pending.withWaitingSince} (${b.pending.waitingSinceAgeDays ? `${b.pending.waitingSinceAgeDays.min}-${b.pending.waitingSinceAgeDays.max} days` : '-'})`],
        ['snoozed', b.snoozedCount],
      ],
    ),
  );
  out.push(`\nActivity formats in window: ${JSON.stringify(r.activityCatalogInWindow)}`);
  if (r.v2Summary) out.push(`v2 /reports/summary: ${JSON.stringify(r.v2Summary)}`);
  return out.join('\n') + '\n';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

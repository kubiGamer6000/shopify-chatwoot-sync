/**
 * AI support agent (AgentBot) metrics: what the bot did, what it cost, and what
 * share of new customer tickets it fully handled.
 *
 * READ-ONLY. Firestore reads (agentBotDecisions, sentReplies,
 * responderGuardEvents, aiUsage) and Chatwoot GET requests only. It never sends,
 * labels or changes anything.
 *
 * Usage:
 *   npx tsx src/scripts/analytics/aiAgentMetrics.ts                 # last 7 local days (today included, to now)
 *   npx tsx src/scripts/analytics/aiAgentMetrics.ts --days=1        # today so far
 *   Options:
 *     --days=N            number of local calendar days, today included (default 7)
 *     --tz=Europe/Helsinki business timezone (default Europe/Helsinki)
 *     --out=<dir>         output directory (default /home/dolan/support-analytics)
 *     --complete-days     end the window at local midnight today (exclude today)
 *     --no-chatwoot       skip the Chatwoot part (ticket share, AI cancellations)
 *     --firestore-snapshot=<file>  reuse the Firestore rows saved by an earlier run
 *                         (<out>/raw/ai-agent-firestore_*.json) instead of reading Firestore;
 *                         "now" becomes the snapshot's fetch time. Chatwoot is still read live.
 *
 * Output: prints a summary and writes
 *   <out>/ai-agent-metrics_<days>d_<asOf>.json and .md (aggregates + conversation ids only, no PII).
 *
 * See docs/support-analytics/ai-agent-metrics.md for definitions and caveats.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import axios from 'axios';
import { env } from '../../config/env.js';
import { chatwootClient } from '../../services/chatwoot.js';
import type { DocumentData } from 'firebase-admin/firestore';
import { getDb } from '../../services/firestore.js';

// --- Constants ---------------------------------------------------------------

/** Acknowledgement/intent routing went live at this instant (route/intents/sentReplies bot rows exist only after it). */
const LAUNCH_MS = Date.parse('2026-09-14T07:55:00Z');

/** Only this inbox has the AgentBot attached (GET /inboxes/99613/agent_bot -> bot 8501). */
const BOT_INBOX_ID = 99613;

/**
 * ASSUMED PRICE TABLE, USD per 1M tokens (Anthropic first-party list prices, as
 * cached in the claude-api skill on 2026-06-24). NOT the account's invoice.
 * Cache read/write tokens are not recorded in aiUsage, so costs are a lower bound.
 */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-5': { input: 5, output: 25 },
};

/** Labels a human adds when they take an action (their presence means "not AI-only"). */
const HUMAN_ACTION_LABELS = new Set([
  'sub-cancelled',
  'refund-30',
  'refund-50',
  'refund-70',
  'refund-full',
  'reshipped',
  'changed-contact',
  'changed-address',
  'tp-free-pack',
]);

/** aiUsage kinds by pipeline. `classify` and `resolver` serve both pipelines. */
const KIND_PIPELINE: Record<string, 'agentbot' | 'human-assist' | 'shared'> = {
  responder: 'agentbot',
  acknowledge: 'agentbot',
  'acknowledge-shadow': 'agentbot',
  holding: 'agentbot',
  classify: 'shared',
  resolver: 'shared',
  structured: 'shared',
  completion: 'shared',
  draft: 'human-assist',
  'draft-manual': 'human-assist',
  summary: 'human-assist',
};

const isToolingKind = (kind: string) => kind.endsWith('-replay') || kind === 'smoke';

// --- Args --------------------------------------------------------------------

interface Args {
  days: number;
  tz: string;
  out: string;
  completeDays: boolean;
  chatwoot: boolean;
  snapshot: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const days = Number(get('days') ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 60) {
    throw new Error('--days must be an integer between 1 and 60');
  }
  const tz = get('tz') ?? 'Europe/Helsinki';
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }); // throws on an invalid zone
  return {
    days,
    tz,
    out: get('out') ?? '/home/dolan/support-analytics',
    completeDays: argv.includes('--complete-days'),
    chatwoot: !argv.includes('--no-chatwoot'),
    snapshot: get('firestore-snapshot') ?? null,
  };
}

// --- Time helpers (DST-safe, no dependency) ----------------------------------

/** Offset of `tz` from UTC at instant `ms`, in ms (e.g. +3h for Helsinki in summer). */
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

/** Local calendar date (YYYY-MM-DD) of an instant. */
function localDay(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
}

/** UTC instant of local midnight for a YYYY-MM-DD date in `tz`. */
function localMidnight(day: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz); // second pass handles a DST change near midnight
  return t;
}

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

const iso = (ms: number) => new Date(ms).toISOString();

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

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const usd = (n: number) => Math.round(n * 100) / 100;

// --- Firestore types ---------------------------------------------------------

interface Decision {
  conversationId: number;
  action: string;
  route: string | null;
  intents: string[] | null;
  reason: string | null;
  ts: number;
}
interface SentReply {
  conversationId: number;
  source: string;
  ts: number;
}
interface GuardEvent {
  conversationId: number;
  outcome: string;
  source: string;
  violations: string[];
  ts: number;
}
interface Usage {
  kind: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ts: number;
}

interface FirestoreSnapshot {
  fetchedAt: number;
  sinceMs: number;
  decisions: Decision[];
  replies: SentReply[];
  guard: GuardEvent[];
  usage: Usage[];
}

/** Reads every doc of `collection` with ts >= sinceMs. Only the fields listed are kept (no PII). */
async function readSince<T>(collection: string, sinceMs: number, pick: (d: DocumentData, id: string) => T): Promise<T[]> {
  const db = getDb();
  if (!db) throw new Error('Firestore is not configured (FIREBASE_BASE64_SERVICE_ACCOUNT)');
  try {
    const snap = await db.collection(collection).where('ts', '>=', sinceMs).get();
    return snap.docs.map((doc) => pick(doc.data(), doc.id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('RESOURCE_EXHAUSTED')) {
      throw new Error(
        `Firestore quota exhausted while reading ${collection} (${msg}). The project's daily read quota is shared with production; ` +
          'retry after the quota resets or rerun with --firestore-snapshot=<file> from an earlier run.',
      );
    }
    throw err;
  }
}

// --- Chatwoot ----------------------------------------------------------------

interface ConversationRow {
  id: number;
  inbox_id: number;
  status: string;
  labels: string[];
  created_at: number; // epoch s
  last_activity_at: number; // epoch s
  first_reply_created_at: number | null;
}
interface MessageRow {
  id: number;
  message_type: number; // 0 incoming, 1 outgoing, 2 activity, 3 template
  private: boolean;
  content: string | null;
  created_at: number;
}

/** All conversations with last_activity_at >= sinceMs (newest activity first), deduped by id. */
async function listConversationsActiveSince(sinceMs: number): Promise<{ rows: ConversationRow[]; pages: number }> {
  const byId = new Map<number, ConversationRow>();
  let pages = 0;
  for (let page = 1; page < 400; page++) {
    const { data } = await chatwootClient.get('/conversations', {
      params: { status: 'all', assignee_type: 'all', sort_by: 'last_activity_at_desc', page },
    });
    pages++;
    const payload = (data?.data?.payload ?? []) as ConversationRow[];
    for (const c of payload) {
      byId.set(c.id, {
        id: c.id,
        inbox_id: c.inbox_id,
        status: c.status,
        labels: c.labels ?? [],
        created_at: c.created_at,
        last_activity_at: c.last_activity_at,
        first_reply_created_at: c.first_reply_created_at ?? null,
      });
    }
    const last = payload[payload.length - 1];
    if (!last || payload.length < 25 || last.last_activity_at * 1000 < sinceMs) break;
  }
  // Rows can shift between pages under live traffic; re-read page 1 to catch movers.
  const { data } = await chatwootClient.get('/conversations', {
    params: { status: 'all', assignee_type: 'all', sort_by: 'last_activity_at_desc', page: 1 },
  });
  for (const c of (data?.data?.payload ?? []) as ConversationRow[]) {
    if (!byId.has(c.id)) byId.set(c.id, { ...c, labels: c.labels ?? [], first_reply_created_at: c.first_reply_created_at ?? null });
  }
  return { rows: [...byId.values()].filter((c) => c.last_activity_at * 1000 >= sinceMs), pages: pages + 1 };
}

/** Messages of a conversation back to (at least) `sinceMs`, paginating with ?before=<smallest id>. */
async function messagesSince(conversationId: number, sinceMs: number, maxPages = 30): Promise<MessageRow[]> {
  const byId = new Map<number, MessageRow>();
  let before: number | undefined;
  for (let i = 0; i < maxPages; i++) {
    const { data } = await chatwootClient.get(`/conversations/${conversationId}/messages`, {
      params: before ? { before } : {},
    });
    const payload = (data?.payload ?? []) as MessageRow[];
    if (payload.length === 0) break;
    for (const m of payload) byId.set(m.id, m);
    const minId = Math.min(...payload.map((m) => m.id));
    const minTs = Math.min(...payload.map((m) => m.created_at)) * 1000;
    if (minTs < sinceMs || minId === before) break;
    before = minId;
  }
  return [...byId.values()];
}

/** Daily conversations_count from the v2 reports API (cross-check of the ticket denominator). */
async function reportConversationsCount(sinceMs: number, untilMs: number, tz: string): Promise<Record<string, number>> {
  // Offset in effect NOW (Chatwoot resolves it to a DST-aware zone); see README "Timezone rule". Buckets are asserted below.
  const offsetHours = tzOffsetMs(Date.now(), tz) / 3_600_000;
  const { data } = await axios.get(
    `${env.chatwootBaseUrl}/api/v2/accounts/${env.chatwootAccountId}/reports`,
    {
      headers: { api_access_token: env.chatwootApiToken },
      params: {
        metric: 'conversations_count',
        type: 'account',
        since: Math.floor(sinceMs / 1000),
        until: Math.floor(untilMs / 1000),
        group_by: 'day',
        timezone_offset: offsetHours,
      },
      timeout: 60_000,
    },
  );
  const out: Record<string, number> = {};
  for (const row of data as { value: number; timestamp: number }[]) {
    const day = localDay(row.timestamp * 1000 + 3_600_000, tz); // +1h: bucket starts at local midnight
    if (row.timestamp * 1000 > sinceMs && localDay(row.timestamp * 1000 - 1000, tz) === day) {
      console.error(`[aiAgentMetrics] WARNING v2 bucket ${row.timestamp} is not a ${tz} midnight: check timezone_offset`);
    }
    out[day] = row.value;
  }
  return out;
}

const addedLabelRe = (label: string) =>
  new RegExp(`\\badded\\b.*(?:^|[\\s,])${label.replace(/-/g, '\\-')}(?![\\w-])`, 'i');

// --- Computation -------------------------------------------------------------

interface DecisionStats {
  conversations: number;
  byOutcome: Record<string, number>;
  escalatedAckConfirmed: number;
  escalatedNoAckRecord: number;
  intentMentions: Record<string, number>;
  conversationsWithIntents: number;
}

/** Human-readable outcome bucket for a latest decision. */
function outcomeKey(d: Decision): string {
  if (d.ts < LAUNCH_MS || !d.route) {
    if (d.action === 'failed' || d.action === 'swept-open') return d.action;
    return `pre-launch:${d.action}`;
  }
  switch (`${d.route}/${d.action}`) {
    case 'respond/responded':
      return 'answered (respond/responded)';
    case 'acknowledge/escalated':
      return 'handoff with acknowledgement (acknowledge/escalated)';
    case 'respond/escalated':
      return 'responder escalated (respond/escalated)';
    case 'close/closed':
      return 'closed silently (close/closed)';
    default:
      return d.action === 'handed-off' ? `handed off silently (${d.route}/handed-off)` : `${d.route}/${d.action}`;
  }
}

function decisionStats(decisions: Decision[], replies: SentReply[]): DecisionStats {
  const holdingByConv = new Map<number, number[]>();
  for (const r of replies) {
    if (r.source !== 'agent-bot-holding') continue;
    holdingByConv.set(r.conversationId, [...(holdingByConv.get(r.conversationId) ?? []), r.ts]);
  }
  const s: DecisionStats = {
    conversations: decisions.length,
    byOutcome: {},
    escalatedAckConfirmed: 0,
    escalatedNoAckRecord: 0,
    intentMentions: {},
    conversationsWithIntents: 0,
  };
  for (const d of decisions) {
    inc(s.byOutcome, outcomeKey(d));
    const postLaunchRouted = d.ts >= LAUNCH_MS && d.route && d.action !== 'failed' && d.action !== 'swept-open';
    if (postLaunchRouted && d.action === 'escalated') {
      // The acknowledgement is sent ~10-30 s before the decision is written.
      const acked = (holdingByConv.get(d.conversationId) ?? []).some(
        (t) => t >= d.ts - 15 * 60_000 && t <= d.ts + 2 * 60_000,
      );
      if (acked) s.escalatedAckConfirmed++;
      else s.escalatedNoAckRecord++;
    }
    if (postLaunchRouted && d.intents && d.intents.length > 0) {
      s.conversationsWithIntents++;
      for (const i of d.intents) inc(s.intentMentions, i);
    }
  }
  s.byOutcome = sortDesc(s.byOutcome);
  s.intentMentions = sortDesc(s.intentMentions);
  return s;
}

function replyStats(replies: SentReply[]) {
  const bySource: Record<string, { messages: number; conversations: number }> = {};
  const convs: Record<string, Set<number>> = {};
  for (const r of replies) {
    bySource[r.source] ??= { messages: 0, conversations: 0 };
    bySource[r.source]!.messages++;
    (convs[r.source] ??= new Set()).add(r.conversationId);
  }
  for (const k of Object.keys(bySource)) bySource[k]!.conversations = convs[k]!.size;
  return bySource;
}

function guardStats(events: GuardEvent[]) {
  const byOutcome: Record<string, number> = {};
  const byOutcomeSource: Record<string, number> = {};
  const byViolation: Record<string, number> = {};
  for (const e of events) {
    inc(byOutcome, e.outcome);
    inc(byOutcomeSource, `${e.outcome}/${e.source}`);
    for (const v of e.violations) inc(byViolation, v);
  }
  return {
    total: events.length,
    byOutcome: sortDesc(byOutcome),
    byOutcomeSource: sortDesc(byOutcomeSource),
    byViolation: sortDesc(byViolation),
    conversationIds: [...new Set(events.map((e) => e.conversationId))],
  };
}

function usageStats(rows: Usage[]) {
  type Agg = { calls: number; inputTokens: number; outputTokens: number; estCostUsd: number; unpricedCalls: number };
  const blank = (): Agg => ({ calls: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0, unpricedCalls: 0 });
  const byKindModel: Record<string, Agg> = {};
  const byPipeline: Record<string, Agg> = {};
  const tooling = blank();
  const production = blank();
  const add = (a: Agg, u: Usage, cost: number | null) => {
    a.calls++;
    a.inputTokens += u.inputTokens;
    a.outputTokens += u.outputTokens;
    if (cost === null) a.unpricedCalls++;
    else a.estCostUsd += cost;
  };
  for (const u of rows) {
    const price = PRICES_PER_MTOK[u.model];
    const cost = price ? (u.inputTokens * price.input + u.outputTokens * price.output) / 1e6 : null;
    if (isToolingKind(u.kind)) {
      add(tooling, u, cost);
      continue;
    }
    add(production, u, cost);
    add((byKindModel[`${u.kind} / ${u.model}`] ??= blank()), u, cost);
    add((byPipeline[KIND_PIPELINE[u.kind] ?? 'other'] ??= blank()), u, cost);
  }
  const round = (a: Agg) => ({ ...a, estCostUsd: usd(a.estCostUsd) });
  return {
    production: round(production),
    toolingExcluded: round(tooling),
    byPipeline: Object.fromEntries(Object.entries(byPipeline).map(([k, v]) => [k, round(v)])),
    byKindModel: Object.fromEntries(
      Object.entries(byKindModel)
        .sort((a, b) => b[1].estCostUsd - a[1].estCostUsd)
        .map(([k, v]) => [k, round(v)]),
    ),
    runs: {
      responderRuns: rows.filter((u) => u.kind === 'responder').length,
      acknowledgementsGenerated: rows.filter((u) => u.kind === 'acknowledge').length,
    },
  };
}

type TicketBucket =
  | 'ai-fully-handled:answered'
  | 'ai-fully-handled:closed-silently'
  | 'ai-final-but-human-involved'
  | 'ai-answered-not-resolved-yet'
  | 'handed-to-human:dashboard-replied'
  | 'handed-to-human:no-dashboard-reply'
  | 'bot-did-not-run'
  | 'outbound-no-customer-message'
  | 'not-bot-routed-inbox'
  | 'other';

interface TicketRow {
  id: number;
  createdMs: number;
  bucket: TicketBucket;
}

function ticketBucket(
  c: ConversationRow,
  decision: Decision | undefined,
  hasDashboardReply: boolean,
  hasIncoming: boolean | undefined,
): TicketBucket {
  if (hasIncoming === false) return 'outbound-no-customer-message';
  if (c.inbox_id !== BOT_INBOX_ID) return 'not-bot-routed-inbox';
  if (!decision) return 'bot-did-not-run';
  const humanActed = c.labels.some((l) => HUMAN_ACTION_LABELS.has(l));
  if (decision.action === 'responded' || decision.action === 'closed') {
    if (humanActed || hasDashboardReply) return 'ai-final-but-human-involved';
    if (c.status !== 'resolved') return 'ai-answered-not-resolved-yet';
    return decision.action === 'closed' ? 'ai-fully-handled:closed-silently' : 'ai-fully-handled:answered';
  }
  if (['escalated', 'handed-off', 'failed', 'swept-open'].includes(decision.action)) {
    return hasDashboardReply ? 'handed-to-human:dashboard-replied' : 'handed-to-human:no-dashboard-reply';
  }
  return 'other';
}

function summarizeTickets(rows: TicketRow[]) {
  const buckets: Record<string, number> = {};
  for (const r of rows) inc(buckets, r.bucket);
  const created = rows.length;
  const outbound = buckets['outbound-no-customer-message'] ?? 0;
  const customerTickets = created - outbound;
  const aiFully = (buckets['ai-fully-handled:answered'] ?? 0) + (buckets['ai-fully-handled:closed-silently'] ?? 0);
  const toHuman =
    (buckets['handed-to-human:dashboard-replied'] ?? 0) + (buckets['handed-to-human:no-dashboard-reply'] ?? 0);
  const botInbox = customerTickets - (buckets['not-bot-routed-inbox'] ?? 0);
  return {
    conversationsCreated: created,
    customerTickets,
    botInboxTickets: botInbox,
    buckets: sortDesc(buckets),
    aiFullyHandled: aiFully,
    handedToHuman: toHuman,
    aiFullyHandledPctOfCustomerTickets: pct(aiFully, customerTickets),
    handedToHumanPctOfCustomerTickets: pct(toHuman, customerTickets),
    aiFullyHandledPctOfBotInbox: pct(aiFully, botInbox),
  };
}

// --- Main --------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

interface NamedWindow {
  name: string;
  start: number;
  end: number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = args.snapshot ? (JSON.parse(readFileSync(args.snapshot, 'utf8')) as FirestoreSnapshot) : null;
  const asOf = snapshot?.fetchedAt ?? Date.now();
  const tz = args.tz;
  const today = localDay(asOf, tz);
  const todayStart = localMidnight(today, tz);

  // N complete local days ending yesterday, plus today so far (unless --complete-days).
  const completeDays = Array.from({ length: args.days }, (_, i) => addDays(today, i - args.days));
  const days = args.completeDays ? completeDays : [...completeDays, today];
  const windowStart = localMidnight(completeDays[0]!, tz);
  const dataEnd = args.completeDays ? todayStart : asOf;
  // A snapshot that starts after the window start clips the data (reported in the output).
  const dataStart = snapshot ? Math.max(windowStart, snapshot.sinceMs) : windowStart;
  const inData = (ms: number) => ms >= dataStart && ms < dataEnd;

  const windows: NamedWindow[] = [{ name: `complete ${args.days}d`, start: windowStart, end: todayStart }];
  if (!args.completeDays) {
    windows.push({ name: 'today so far', start: todayStart, end: asOf });
    windows.push({ name: `rolling ${args.days * 24}h`, start: asOf - args.days * DAY_MS, end: asOf });
  }
  if (dataEnd > LAUNCH_MS) windows.push({ name: 'since launch', start: Math.max(LAUNCH_MS, windowStart), end: dataEnd });
  const dayWindows: NamedWindow[] = days.map((d) => ({
    name: d,
    start: localMidnight(d, tz),
    end: Math.min(localMidnight(addDays(d, 1), tz), dataEnd),
  }));

  console.error(`[ai-agent-metrics] data ${iso(windowStart)} .. ${iso(dataEnd)} (${tz} ${days[0]} .. ${days[days.length - 1]})`);

  // 1. Firestore (all ts-range queries; single-field index, no composite needed).
  //    Every returned doc is a billed read (~1.3k/day across the four collections),
  //    so the picked rows are saved and can be reused with --firestore-snapshot.
  if (dataStart > windowStart) {
    console.error(`[ai-agent-metrics] WARNING: snapshot starts at ${iso(dataStart)}, after the window start ${iso(windowStart)}; earlier data is missing`);
  }
  const [decisionsAll, repliesAll, guardAll, usageAll] = snapshot
    ? [snapshot.decisions, snapshot.replies, snapshot.guard, snapshot.usage]
    : await Promise.all([
        readSince<Decision>('agentBotDecisions', windowStart, (d, id) => ({
          conversationId: Number(d.conversationId ?? id),
          action: String(d.action ?? 'unknown'),
          route: (d.route as string | undefined) ?? null,
          intents: Array.isArray(d.intents) ? (d.intents as string[]) : null,
          reason: (d.reason as string | undefined) ?? null,
          ts: Number(d.ts),
        })),
        readSince<SentReply>('sentReplies', windowStart, (d) => ({
          conversationId: Number(d.conversationId),
          source: String(d.source ?? 'unknown'),
          ts: Number(d.ts),
        })),
        readSince<GuardEvent>('responderGuardEvents', windowStart, (d) => ({
          conversationId: Number(d.conversationId),
          outcome: String(d.outcome),
          source: String(d.source),
          violations: Array.isArray(d.violations) ? (d.violations as string[]) : [],
          ts: Number(d.ts),
        })),
        readSince<Usage>('aiUsage', windowStart, (d) => ({
          kind: String(d.kind ?? 'unknown'),
          model: String(d.model ?? 'unknown'),
          inputTokens: Number(d.inputTokens ?? 0),
          outputTokens: Number(d.outputTokens ?? 0),
          ts: Number(d.ts),
        })),
      ]);
  if (!snapshot) {
    mkdirSync(join(args.out, 'raw'), { recursive: true });
    const snapPath = join(args.out, 'raw', `ai-agent-firestore_${iso(asOf).replace(/[:.]/g, '-')}_${args.days}d.json`);
    const snap: FirestoreSnapshot = { fetchedAt: asOf, sinceMs: windowStart, decisions: decisionsAll, replies: repliesAll, guard: guardAll, usage: usageAll };
    writeFileSync(snapPath, JSON.stringify(snap));
    console.error(`[ai-agent-metrics] firestore snapshot saved: ${snapPath}`);
  }
  console.error(
    `[ai-agent-metrics] firestore${snapshot ? ' (snapshot)' : ''}: decisions ${decisionsAll.length}, sentReplies ${repliesAll.length}, guard ${guardAll.length}, aiUsage ${usageAll.length}`,
  );

  const decisions = decisionsAll.filter((d) => inData(d.ts));
  const replies = repliesAll.filter((r) => inData(r.ts));
  const guard = guardAll.filter((g) => inData(g.ts));
  const usage = usageAll.filter((u) => inData(u.ts));
  const decisionByConv = new Map(decisionsAll.filter((d) => d.ts < dataEnd).map((d) => [d.conversationId, d]));
  const dashboardConvs = new Set(replies.filter((r) => r.source === 'dashboard').map((r) => r.conversationId));
  const firstBotReplyTs = repliesAll.reduce((m, r) => (r.source.startsWith('agent-bot') ? Math.min(m, r.ts) : m), Infinity);

  const sliceFor = (w: NamedWindow) => {
    const inW = (ms: number) => ms >= w.start && ms < w.end;
    return {
      startUtc: iso(w.start),
      endUtc: iso(w.end),
      decisionsLatestOnly: decisionStats(decisions.filter((d) => inW(d.ts)), replies),
      sentReplies: replyStats(replies.filter((r) => inW(r.ts))),
      botRepliesTracked: w.end > LAUNCH_MS,
      guard: guardStats(guard.filter((g) => inW(g.ts))),
      aiUsage: usageStats(usage.filter((u) => inW(u.ts))),
    };
  };

  // 2. Chatwoot: ticket denominator + outcome join, and subscription cancellations.
  let tickets: Result['tickets'] = null;
  let cancellations: Result['subscriptionCancellations'] = null;

  if (args.chatwoot) {
    const { rows, pages } = await listConversationsActiveSince(windowStart);
    console.error(`[ai-agent-metrics] chatwoot: ${rows.length} conversations active since window start (${pages} list pages)`);
    const created = rows.filter((c) => inData(c.created_at * 1000));

    // Incoming-message check only where the bot did not run (a decision implies a customer message).
    const needCheck = created.filter((c) => c.inbox_id !== BOT_INBOX_ID || !decisionByConv.has(c.id));
    const incoming = new Map<number, boolean>();
    await mapLimit(needCheck, 4, async (c) => {
      const msgs = await messagesSince(c.id, 0, 5);
      incoming.set(c.id, msgs.some((m) => m.message_type === 0));
    });

    const ticketRows: TicketRow[] = created.map((c) => ({
      id: c.id,
      createdMs: c.created_at * 1000,
      bucket: ticketBucket(c, decisionByConv.get(c.id), dashboardConvs.has(c.id), incoming.get(c.id)),
    }));
    const ticketsIn = (w: NamedWindow) =>
      summarizeTickets(ticketRows.filter((t) => t.createdMs >= w.start && t.createdMs < w.end));

    let v2: Record<string, number> = {};
    try {
      v2 = await reportConversationsCount(windowStart, dataEnd, tz);
    } catch (err) {
      console.error('[ai-agent-metrics] v2 report cross-check failed:', err instanceof Error ? err.message : err);
    }
    tickets = {
      windows: Object.fromEntries(windows.map((w) => [w.name, ticketsIn(w)])),
      perDay: Object.fromEntries(dayWindows.map((w) => [w.name, { ...ticketsIn(w), v2ConversationsCount: v2[w.name] ?? null }])),
      listPages: pages,
    };

    // Cancellations: timestamp of the "added sub-cancelled(-ai)" activity message.
    const aiRe = addedLabelRe('sub-cancelled-ai');
    const humanRe = addedLabelRe('sub-cancelled');
    const labelled = rows.filter((c) => c.labels.includes('sub-cancelled-ai') || c.labels.includes('sub-cancelled'));
    const aiEvents: { id: number; ms: number }[] = [];
    const humanEvents: { id: number; ms: number }[] = [];
    await mapLimit(labelled, 4, async (c) => {
      const msgs = await messagesSince(c.id, windowStart);
      for (const m of msgs) {
        const ms = m.created_at * 1000;
        if (m.message_type !== 2 || !inData(ms) || !m.content) continue;
        if (aiRe.test(m.content)) aiEvents.push({ id: c.id, ms });
        else if (humanRe.test(m.content)) humanEvents.push({ id: c.id, ms });
      }
    });
    const countIn = (ev: { id: number; ms: number }[], w: NamedWindow) => {
      const hits = ev.filter((e) => e.ms >= w.start && e.ms < w.end);
      return { events: hits.length, conversations: new Set(hits.map((e) => e.id)).size };
    };
    const cancelCounts = (w: NamedWindow): CancelCounts => {
      const ai = countIn(aiEvents, w);
      const human = countIn(humanEvents, w);
      return { ai: ai.events, aiConversations: ai.conversations, human: human.events, humanConversations: human.conversations };
    };
    const aiIds = [...new Set(aiEvents.map((e) => e.id))].sort((a, b) => a - b);
    cancellations = {
      windows: Object.fromEntries(windows.map((w) => [w.name, cancelCounts(w)])),
      perDay: Object.fromEntries(dayWindows.map((w) => [w.name, cancelCounts(w)])),
      aiConversationIds: aiIds,
      conversationsCarryingAiLabel: rows.filter((c) => c.labels.includes('sub-cancelled-ai')).length,
      conversationsCarryingHumanLabel: rows.filter((c) => c.labels.includes('sub-cancelled')).length,
      aiCancelledButLatestActionNotResponded: aiIds.filter((id) => {
        const a = decisionByConv.get(id)?.action;
        return a !== undefined && a !== 'responded';
      }),
    };
  }

  const result: Result = {
    generatedAt: iso(asOf),
    timezone: tz,
    firestoreSource: snapshot ? `snapshot fetched ${iso(snapshot.fetchedAt)}` : 'live',
    data: {
      startUtc: iso(dataStart),
      endUtc: iso(dataEnd),
      localDays: days,
      coverageWarning: dataStart > windowStart ? `Firestore data missing for [${iso(windowStart)}, ${iso(dataStart)})` : null,
    },
    launch: { utc: iso(LAUNCH_MS), firstBotSentReplyInData: Number.isFinite(firstBotReplyTs) ? iso(firstBotReplyTs) : null },
    priceTableAssumption: {
      note: 'ASSUMED Anthropic list prices USD/1M tokens (claude-api skill cache 2026-06-24); cache tokens not recorded; lower-bound estimate',
      prices: PRICES_PER_MTOK,
    },
    caveats: [
      'agentBotDecisions keeps only the latest decision per conversation; counts are by latest decision ts and change when a conversation is processed again. Snapshot daily.',
      'route/intents exist only from launch; pre-launch decisions are bucketed as pre-launch:<action>.',
      'sentReplies agent-bot/agent-bot-holding exist only from launch; pre-launch bot messages are not tracked (not zero).',
      'dashboard = replies sent from the custom dashboard only; replies typed in the Chatwoot UI are invisible and indistinguishable from the bot.',
      'aiUsage has no cache tokens; customerResolver records final-turn usage only; cost is a lower bound.',
      'Ticket outcomes are provisional: they use the current Chatwoot status and latest decision at generation time.',
    ],
    windows: Object.fromEntries(windows.map((w) => [w.name, sliceFor(w)])),
    perDay: Object.fromEntries(dayWindows.map((w) => [w.name, sliceFor(w)])),
    tickets,
    subscriptionCancellations: cancellations,
  };

  // 3. Output.
  mkdirSync(args.out, { recursive: true });
  const base = join(args.out, `ai-agent-metrics_${args.days}d_${iso(asOf).replace(/[:.]/g, '-')}`);
  writeFileSync(`${base}.json`, JSON.stringify(result, null, 2));
  const md = renderMarkdown(result);
  writeFileSync(`${base}.md`, md);
  console.log(md);
  console.error(`[ai-agent-metrics] wrote ${base}.json and ${base}.md`);
}

// --- Rendering ---------------------------------------------------------------

type SliceOut = {
  startUtc: string;
  endUtc: string;
  decisionsLatestOnly: DecisionStats;
  sentReplies: ReturnType<typeof replyStats>;
  botRepliesTracked: boolean;
  guard: ReturnType<typeof guardStats>;
  aiUsage: ReturnType<typeof usageStats>;
};
type TicketSummary = ReturnType<typeof summarizeTickets>;
type CancelCounts = { ai: number; aiConversations: number; human: number; humanConversations: number };

interface Result {
  generatedAt: string;
  timezone: string;
  firestoreSource: string;
  data: { startUtc: string; endUtc: string; localDays: string[]; coverageWarning: string | null };
  launch: { utc: string; firstBotSentReplyInData: string | null };
  priceTableAssumption: { note: string; prices: typeof PRICES_PER_MTOK };
  caveats: string[];
  windows: Record<string, SliceOut>;
  perDay: Record<string, SliceOut>;
  tickets: {
    windows: Record<string, TicketSummary>;
    perDay: Record<string, TicketSummary & { v2ConversationsCount: number | null }>;
    listPages: number;
  } | null;
  subscriptionCancellations: {
    windows: Record<string, CancelCounts>;
    perDay: Record<string, CancelCounts>;
    aiConversationIds: number[];
    conversationsCarryingAiLabel: number;
    conversationsCarryingHumanLabel: number;
    aiCancelledButLatestActionNotResponded: number[];
  } | null;
}

function table(headers: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => (v === null ? '-' : String(v));
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

function renderMarkdown(r: Result): string {
  const L: string[] = [];
  const firstWindow = Object.keys(r.windows)[0]!;
  L.push(`# AI agent metrics (${r.data.localDays[0]} .. ${r.data.localDays[r.data.localDays.length - 1]}, ${r.timezone})`);
  L.push('');
  L.push(
    `Generated ${r.generatedAt} (Firestore: ${r.firestoreSource}). Data [${r.data.startUtc}, ${r.data.endUtc}). ` +
      'Costs use an ASSUMED list-price table and are a lower bound.',
  );
  if (r.data.coverageWarning) L.push(`\n**Coverage warning:** ${r.data.coverageWarning}.`);
  L.push('');
  L.push(table(['slice', 'start (UTC)', 'end (UTC)'], Object.entries(r.windows).map(([k, s]) => [k, s.startUtc, s.endUtc])));

  const slices: [string, SliceOut][] = [...Object.entries(r.windows), ...Object.entries(r.perDay)];

  L.push('\n## AgentBot decisions (latest decision per conversation, bucketed by decision ts)\n');
  const outcomes = [...new Set(slices.flatMap(([, s]) => Object.keys(s.decisionsLatestOnly.byOutcome)))];
  L.push(
    table(
      ['slice', 'conversations', ...outcomes, 'escalated: ack sent', 'escalated: no ack record'],
      slices.map(([name, s]) => [
        name,
        s.decisionsLatestOnly.conversations,
        ...outcomes.map((o) => s.decisionsLatestOnly.byOutcome[o] ?? 0),
        s.decisionsLatestOnly.escalatedAckConfirmed,
        s.decisionsLatestOnly.escalatedNoAckRecord,
      ]),
    ),
  );

  L.push('\n## Routing intents (post-launch decisions; mentions, a conversation can have several)\n');
  const intentSlices = slices.filter(([, s]) => s.decisionsLatestOnly.conversationsWithIntents > 0);
  const intents = [...new Set(intentSlices.flatMap(([, s]) => Object.keys(s.decisionsLatestOnly.intentMentions)))];
  L.push(
    intentSlices.length === 0
      ? 'No post-launch decisions in range.'
      : table(
          ['slice', 'conversations with intents', ...intents],
          intentSlices.map(([name, s]) => [
            name,
            s.decisionsLatestOnly.conversationsWithIntents,
            ...intents.map((i) => s.decisionsLatestOnly.intentMentions[i] ?? 0),
          ]),
        ),
  );

  L.push('\n## Public messages sent (sentReplies) and append-only run proxies (aiUsage)\n');
  L.push(
    table(
      ['slice', 'agent-bot msgs (convs)', 'agent-bot-holding msgs (convs)', 'dashboard msgs (convs)', 'responder runs', 'acknowledgements generated'],
      slices.map(([name, s]) => {
        const f = (k: string) => {
          const v = s.sentReplies[k];
          if (v) return `${v.messages} (${v.conversations})`;
          return s.botRepliesTracked || k === 'dashboard' ? '0' : 'not tracked';
        };
        return [name, f('agent-bot'), f('agent-bot-holding'), f('dashboard'), s.aiUsage.runs.responderRuns, s.aiUsage.runs.acknowledgementsGenerated];
      }),
    ),
  );
  L.push('\nBot sources are only logged from 2026-09-14T08:00Z; slices ending before launch show "not tracked". Pre-launch responder runs are real aiUsage rows.');

  L.push('\n## Guard interventions (responderGuardEvents)\n');
  L.push(
    table(
      ['slice', 'total', 'outcome/source', 'violations'],
      slices.map(([name, s]) => [
        name,
        s.guard.total,
        Object.entries(s.guard.byOutcomeSource).map(([k, v]) => `${k} ${v}`).join(', ') || '-',
        Object.entries(s.guard.byViolation).map(([k, v]) => `${k} ${v}`).join(', ') || '-',
      ]),
    ),
  );

  L.push('\n## AI usage and estimated cost (production kinds; *-replay and smoke excluded)\n');
  L.push(
    table(
      ['slice', 'calls', 'input tok', 'output tok', 'est. USD', 'agentbot USD', 'shared USD', 'human-assist USD', 'other USD', 'tooling excluded USD'],
      slices.map(([name, s]) => [
        name,
        s.aiUsage.production.calls,
        s.aiUsage.production.inputTokens,
        s.aiUsage.production.outputTokens,
        s.aiUsage.production.estCostUsd,
        s.aiUsage.byPipeline['agentbot']?.estCostUsd ?? 0,
        s.aiUsage.byPipeline['shared']?.estCostUsd ?? 0,
        s.aiUsage.byPipeline['human-assist']?.estCostUsd ?? 0,
        s.aiUsage.byPipeline['other']?.estCostUsd ?? 0,
        s.aiUsage.toolingExcluded.estCostUsd,
      ]),
    ),
  );
  for (const name of Object.keys(r.windows)) {
    const s = r.windows[name]!;
    if (s.aiUsage.production.calls === 0) continue;
    L.push(`\nBy kind and model, ${name}:\n`);
    L.push(
      table(
        ['kind / model', 'calls', 'input tok', 'output tok', 'avg out tok', 'est. USD'],
        Object.entries(s.aiUsage.byKindModel).map(([k, v]) => [
          k,
          v.calls,
          v.inputTokens,
          v.outputTokens,
          Math.round(v.outputTokens / v.calls),
          v.unpricedCalls ? `${v.estCostUsd} (+${v.unpricedCalls} unpriced)` : v.estCostUsd,
        ]),
      ),
    );
  }

  if (r.subscriptionCancellations) {
    const c = r.subscriptionCancellations;
    L.push('\n## Subscription cancellations (Chatwoot "added sub-cancelled(-ai)" activity messages)\n');
    L.push(
      table(
        ['slice', 'AI label adds (conversations)', 'human label adds (conversations)'],
        [...Object.entries(c.windows), ...Object.entries(c.perDay)].map(([k, v]) => [k, `${v.ai} (${v.aiConversations})`, `${v.human} (${v.humanConversations})`]),
      ),
    );
    L.push(`\nAI cancellation conversations: ${c.aiConversationIds.join(', ') || 'none'}. Of these, latest decision not 'responded': ${c.aiCancelledButLatestActionNotResponded.join(', ') || 'none'}.`);
    L.push(`Conversations active since window start carrying the label now: sub-cancelled-ai ${c.conversationsCarryingAiLabel}, sub-cancelled ${c.conversationsCarryingHumanLabel}.`);
  }

  if (r.tickets) {
    const t = r.tickets;
    L.push('\n## New conversations: AI fully handled vs handed to human (provisional, as of generation time)\n');
    const bucketNames: TicketBucket[] = [
      'ai-fully-handled:answered',
      'ai-fully-handled:closed-silently',
      'ai-final-but-human-involved',
      'ai-answered-not-resolved-yet',
      'handed-to-human:dashboard-replied',
      'handed-to-human:no-dashboard-reply',
      'bot-did-not-run',
      'not-bot-routed-inbox',
      'outbound-no-customer-message',
      'other',
    ];
    const rows: [string, TicketSummary, number | null][] = [
      ...Object.entries(t.windows).map(([k, s]) => [k, s, null] as [string, TicketSummary, number | null]),
      ...Object.entries(t.perDay).map(([k, s]) => [k, s, s.v2ConversationsCount] as [string, TicketSummary, number | null]),
    ];
    L.push(
      table(
        ['slice', 'created', 'v2 count', 'customer tickets', 'AI fully handled', 'AI %', 'to human', 'human %', 'AI % of bot inbox', ...bucketNames],
        rows.map(([name, s, v2]) => [
          name,
          s.conversationsCreated,
          v2,
          s.customerTickets,
          s.aiFullyHandled,
          s.aiFullyHandledPctOfCustomerTickets,
          s.handedToHuman,
          s.handedToHumanPctOfCustomerTickets,
          s.aiFullyHandledPctOfBotInbox,
          ...bucketNames.map((b) => s.buckets[b] ?? 0),
        ]),
      ),
    );
    L.push(`\n${firstWindow}: percentages use customer tickets (created minus outbound threads with no customer message) as the denominator.`);
  }
  L.push('');
  return L.join('\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[ai-agent-metrics] failed:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });

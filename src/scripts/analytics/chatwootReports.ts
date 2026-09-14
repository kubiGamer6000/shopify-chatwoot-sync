/**
 * Chatwoot built-in reporting APIs: one pass over every report endpoint that is
 * useful on this instance, for a window of local calendar days.
 *
 * READ-ONLY. Only HTTP GET requests against Chatwoot (v2 reports, v2
 * summary_reports, v2 live_reports, v1 reporting_events, v1 conversations/meta,
 * v1 labels/inboxes). It never sends, labels or changes anything.
 *
 * Usage:
 *   npx tsx src/scripts/analytics/chatwootReports.ts                  # last 7 local days (today included, to now)
 *   npx tsx src/scripts/analytics/chatwootReports.ts --days=1         # today so far
 *   npx tsx src/scripts/analytics/chatwootReports.ts --days=1 --complete-days   # yesterday (full local day)
 *   Options:
 *     --days=N             number of local calendar days (default 7)
 *     --tz=Europe/Helsinki business timezone (default Europe/Helsinki)
 *     --out=<dir>          output directory (default /home/dolan/support-analytics)
 *     --complete-days      end the window at local midnight today (exclude today)
 *     --no-events          skip paging the raw reporting_events log (about 34 requests per day)
 *
 * Output: prints a summary and writes
 *   <out>/chatwoot-reports_<days>d[_complete]_<asOf>.json and .md
 *   (aggregates, entity ids and label names only, no PII).
 *
 * See docs/support-analytics/chatwoot-reports-api.md for definitions and caveats.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import axios from 'axios';
import { env } from '../../config/env.js';
import { chatwootClient } from '../../services/chatwoot.js';

// --- CLI ---------------------------------------------------------------------

interface Args {
  days: number;
  tz: string;
  out: string;
  completeDays: boolean;
  events: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    days: 7,
    tz: 'Europe/Helsinki',
    out: '/home/dolan/support-analytics',
    completeDays: false,
    events: true,
  };
  for (const a of argv) {
    const [k, v] = a.split('=', 2);
    if (k === '--days' && v) args.days = Math.max(1, Number.parseInt(v, 10) || 7);
    else if (k === '--tz' && v) args.tz = v;
    else if (k === '--out' && v) args.out = v;
    else if (k === '--complete-days') args.completeDays = true;
    else if (k === '--no-events') args.events = false;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// --- Timezone helpers (no tz library needed) ---------------------------------

/** Offset of `tz` from UTC at instant `ms`, in minutes (Helsinki summer = +180). */
function tzOffsetMinutes(ms: number, tz: string): number {
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
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Local calendar date (YYYY-MM-DD) of instant `ms` in `tz`. */
function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(ms),
  );
}

/** Epoch ms of local 00:00 on `ymd` in `tz` (DST-correct). */
function localMidnightMs(ymd: string, tz: string): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) guess = Date.UTC(y, m - 1, d) - tzOffsetMinutes(guess, tz) * 60000;
  return guess;
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// --- HTTP --------------------------------------------------------------------

/** v2 reports client. Same token as the v1 client (administrator user token). */
const v2 = axios.create({
  baseURL: `${env.chatwootBaseUrl}/api/v2/accounts/${env.chatwootAccountId}`,
  headers: { api_access_token: env.chatwootApiToken },
  timeout: 90_000, // a cold 1-year summary once took 15 s
});

let requestCount = 0;

/**
 * Chatwoot Cloud throttles per token/IP: after roughly 300 GETs inside a minute it
 * answers HTTP 429 with body "Retry later" and NO Retry-After header; it clears within
 * about a minute. Retry 429s with a linear 15 s backoff.
 */
async function withRetry<T>(fn: () => Promise<T>, what: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      requestCount++;
      return await fn();
    } catch (err) {
      if (!axios.isAxiosError(err) || err.response?.status !== 429 || attempt >= 8) throw err;
      const waitMs = 15_000 * attempt;
      console.error(`429 on ${what}, retrying in ${waitMs / 1000} s (attempt ${attempt})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function getV2<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  return withRetry(async () => (await v2.get<T>(path, { params })).data, path);
}

async function getV1<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  return withRetry(async () => (await chatwootClient.get<T>(path, { params, timeout: 90_000 })).data, path);
}

/** Run async jobs with bounded concurrency, preserving order. */
async function mapLimit<I, O>(items: I[], limit: number, fn: (item: I) => Promise<O>): Promise<O[]> {
  const out = new Array<O>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as I);
      }
    }),
  );
  return out;
}

// --- Response types ----------------------------------------------------------

interface Bucket {
  value: number;
  timestamp: number;
  count?: number;
}

interface SummaryCore {
  conversations_count: number;
  incoming_messages_count: number;
  outgoing_messages_count: number;
  avg_first_response_time: number | null;
  avg_resolution_time: number | null;
  resolutions_count: number;
  reply_time: number | null;
}
interface Summary extends SummaryCore {
  previous: SummaryCore;
}

interface EntitySummaryRow {
  id: number;
  name?: string;
  conversations_count: number;
  resolved_conversations_count: number;
  avg_resolution_time: number | null;
  avg_first_response_time: number | null;
  avg_reply_time: number | null;
}

type ChannelSummary = Record<string, { open: number; resolved: number; pending: number; snoozed: number; total: number }>;
type FrtDistribution = Record<string, Record<string, number>>;

interface LiveMetrics {
  open: number;
  unattended: number;
  unassigned: number;
  pending: number;
}

interface ReportingEvent {
  id: number;
  name: string;
  value: number;
  value_in_business_hours: number;
  event_start_time: string;
  event_end_time: string;
  inbox_id: number;
  user_id: number | null;
  conversation_id: number;
  created_at: string;
}

interface Label {
  id: number;
  title: string;
}
interface Inbox {
  id: number;
  name: string;
  channel_type: string;
}

// --- Stats -------------------------------------------------------------------

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

interface ValueStats {
  events: number;
  uniqueConversations: number;
  meanSec: number | null;
  medianSec: number | null;
  p90Sec: number | null;
  under60s: number;
  under1h: number;
}

function valueStats(events: ReportingEvent[]): ValueStats {
  const vals = events.map((e) => e.value).sort((a, b) => a - b);
  return {
    events: events.length,
    uniqueConversations: new Set(events.map((e) => e.conversation_id)).size,
    meanSec: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null,
    medianSec: quantile(vals, 0.5),
    p90Sec: quantile(vals, 0.9),
    under60s: vals.filter((v) => v < 60).length,
    under1h: vals.filter((v) => v < 3600).length,
  };
}

function hours(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return 'n/a';
  if (sec < 120) return `${Math.round(sec)} s`;
  return `${(sec / 3600).toFixed(1)} h`;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}
function lpad(s: string | number, n: number): string {
  return String(s).padStart(n);
}

// --- Main --------------------------------------------------------------------

const TIME_SERIES_METRICS = [
  'conversations_count',
  'incoming_messages_count',
  'outgoing_messages_count',
  'resolutions_count',
  'avg_first_response_time',
  'avg_resolution_time',
  'reply_time',
  'bot_resolutions_count',
  'bot_handoffs_count',
] as const;
type Metric = (typeof TIME_SERIES_METRICS)[number];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const nowMs = Date.now();
  const today = localDate(nowMs, args.tz);
  const firstDay = addDays(today, args.completeDays ? -args.days : -(args.days - 1));
  const sinceMs = localMidnightMs(firstDay, args.tz);
  const untilMs = args.completeDays ? localMidnightMs(today, args.tz) : nowMs;
  const since = Math.floor(sinceMs / 1000);
  const until = Math.floor(untilMs / 1000);

  // The /reports endpoint resolves timezone_offset to a DST-aware zone chosen by the
  // offset that is current at request time, so pass today's offset (not per-date offsets)
  // and then assert that the returned buckets fall on local midnights.
  const offsetHours = tzOffsetMinutes(nowMs, args.tz) / 60;
  const dayList: string[] = [];
  for (let d = firstDay; localMidnightMs(d, args.tz) < untilMs; d = addDays(d, 1)) dayList.push(d);

  const windowLabel = `${new Date(sinceMs).toISOString()} .. ${new Date(untilMs).toISOString()} (${firstDay} 00:00 to ${
    args.completeDays ? `${today} 00:00` : `now`
  } ${args.tz})`;
  console.log(`Chatwoot reports, window ${windowLabel}, timezone_offset=${offsetHours}`);

  const base = { since, until };
  const seriesParams = { ...base, type: 'account', group_by: 'day', timezone_offset: offsetHours };

  // 1) Reference data: labels (numeric ids are required by type=label) and inboxes.
  const [labelsRes, inboxesRes] = await Promise.all([
    getV1<{ payload: Label[] }>('/labels'),
    getV1<{ payload: Inbox[] }>('/inboxes'),
  ]);
  const labels = labelsRes.payload.map((l) => ({ id: l.id, title: l.title }));
  const inboxes = inboxesRes.payload.map((i) => ({ id: i.id, name: i.name, channel_type: i.channel_type }));
  const inboxName = new Map(inboxes.map((i) => [i.id, i.name]));

  // 2) Account KPI summary with previous-period comparison (timezone_offset is ignored here).
  const summary = await getV2<Summary>('/reports/summary', { ...base, type: 'account' });

  // 3) Daily time series for every metric.
  const series = {} as Record<Metric, Bucket[]>;
  await mapLimit([...TIME_SERIES_METRICS], 4, async (metric) => {
    const data = await getV2<Bucket[] | Record<string, never>>('/reports', { ...seriesParams, metric });
    series[metric] = Array.isArray(data) ? data : [];
  });

  // Bucket alignment check: every bucket timestamp should be a local midnight in args.tz.
  const misaligned = (series.conversations_count ?? []).filter(
    (b) => localMidnightMs(localDate(b.timestamp * 1000, args.tz), args.tz) !== b.timestamp * 1000,
  );

  // 4) Hour-of-day volume (conversations created), summed over the window.
  const hourly = await getV2<Bucket[]>('/reports', { ...seriesParams, group_by: 'hour', metric: 'conversations_count' });
  const byLocalHour = new Array<number>(24).fill(0);
  for (const b of hourly) {
    const h = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: args.tz, hour: '2-digit', hourCycle: 'h23' }).format(
        new Date(b.timestamp * 1000),
      ),
    );
    byLocalHour[h] = (byLocalHour[h] ?? 0) + b.value;
  }

  // 5) Per-entity summaries, channel split, FRT histogram, inbox x label matrix.
  const [labelSummary, inboxSummary, agentSummary, teamSummary, channelSummary, frtDistribution, matrix] =
    await Promise.all([
      getV2<EntitySummaryRow[]>('/summary_reports/label', base),
      getV2<EntitySummaryRow[]>('/summary_reports/inbox', base),
      getV2<EntitySummaryRow[]>('/summary_reports/agent', base),
      getV2<EntitySummaryRow[]>('/summary_reports/team', base),
      getV2<ChannelSummary>('/summary_reports/channel', base),
      getV2<FrtDistribution>('/reports/first_response_time_distribution', base),
      getV2<{ inboxes: { id: number; name: string }[]; labels: { id: number; title: string }[]; matrix: number[][] }>(
        '/reports/inbox_label_matrix',
        base,
      ),
    ]);

  // 6) Per-label daily series (conversations created per day that currently carry the label).
  const labelSeries: Record<string, number[]> = {};
  await mapLimit(labels, 4, async (l) => {
    const data = await getV2<Bucket[] | Record<string, never>>('/reports', {
      ...seriesParams,
      type: 'label',
      id: l.id,
      metric: 'conversations_count',
    });
    labelSeries[l.title] = Array.isArray(data) ? data.map((b) => b.value) : [];
  });

  // 7) Native bot metrics (expected all-zero on this instance: the bot acts via the user token).
  const [botSummary, botMetrics] = await Promise.all([
    getV2<Record<string, unknown>>('/reports/bot_summary', { ...base, type: 'account' }),
    getV2<Record<string, unknown>>('/reports/bot_metrics', base),
  ]);

  // 8) Live snapshot (point-in-time; since/until ignored).
  const statuses = ['all', 'open', 'pending', 'resolved', 'snoozed'] as const;
  const [live, liveLegacy, grouped, ...metas] = await Promise.all([
    getV2<LiveMetrics>('/live_reports/conversation_metrics'),
    getV2<LiveMetrics>('/reports/conversations', { type: 'account' }),
    getV2<Array<LiveMetrics & { assignee_id: number | null }>>('/live_reports/grouped_conversation_metrics', {
      group_by: 'assignee_id',
    }),
    ...statuses.map((s) =>
      getV1<{ meta: { mine_count: number; assigned_count: number; unassigned_count: number; all_count: number } }>(
        '/conversations/meta',
        { status: s },
      ),
    ),
  ]);
  const conversationMeta = Object.fromEntries(statuses.map((s, i) => [s, metas[i]?.meta]));
  const liveSnapshotAt = new Date().toISOString();

  // 9) Raw reporting_events log -> exact counts, medians, p90, re-resolution dedup, reopens.
  let eventsBlock: Record<string, unknown> | null = null;
  const crossChecks: Array<{ check: string; a: number | null; b: number | null; ok: boolean }> = [];
  if (args.events) {
    const first = await getV1<{ payload: ReportingEvent[]; meta: { count: number; total_pages: number } }>(
      '/reporting_events',
      { ...base, page: 1 },
    );
    const pages = Array.from({ length: Math.max(0, first.meta.total_pages - 1) }, (_, i) => i + 2);
    const rest = await mapLimit(pages, 6, async (page) => {
      const r = await getV1<{ payload: ReportingEvent[] }>('/reporting_events', { ...base, page });
      return r.payload;
    });
    const byId = new Map<number, ReportingEvent>();
    for (const e of [first.payload, ...rest].flat()) byId.set(e.id, e);
    const events = [...byId.values()];

    const byName = (n: string) => events.filter((e) => e.name === n);
    const opened = byName('conversation_opened');
    const resolved = byName('conversation_resolved');
    const firstResp = byName('first_response');
    const replies = byName('reply_time');
    const userIdCounts: Record<string, number> = {};
    for (const e of events) userIdCounts[String(e.user_id)] = (userIdCounts[String(e.user_id)] ?? 0) + 1;
    const nameCounts: Record<string, number> = {};
    for (const e of events) nameCounts[e.name] = (nameCounts[e.name] ?? 0) + 1;

    eventsBlock = {
      reportedCount: first.meta.count,
      fetchedUnique: events.length,
      pages: first.meta.total_pages,
      nameCounts,
      userIdCounts,
      firstResponse: valueStats(firstResp),
      replyTime: valueStats(replies),
      resolution: valueStats(resolved),
      reopens: opened.filter((e) => e.value > 0).length,
      openedFromPendingOrNew: opened.filter((e) => e.value === 0).length,
      valueInBusinessHoursNonZero: events.filter((e) => e.value_in_business_hours > 0).length,
    };

    const sum = (b: Bucket[] | undefined) => (b ?? []).reduce((s, x) => s + x.value, 0);
    crossChecks.push(
      { check: 'events fetched == meta.count', a: events.length, b: first.meta.count, ok: events.length === first.meta.count },
      {
        check: 'resolutions_count (summary) == conversation_resolved events',
        a: summary.resolutions_count,
        b: resolved.length,
        ok: summary.resolutions_count === resolved.length,
      },
      {
        check: 'sum(daily resolutions_count) == summary.resolutions_count',
        a: sum(series.resolutions_count),
        b: summary.resolutions_count,
        ok: sum(series.resolutions_count) === summary.resolutions_count,
      },
      {
        check: 'avg_first_response_time (summary) == mean(first_response.value)',
        a: summary.avg_first_response_time === null ? null : Math.round(summary.avg_first_response_time),
        b: firstResp.length ? Math.round(valueStats(firstResp).meanSec ?? 0) : null,
        ok:
          firstResp.length === 0 ||
          Math.abs((summary.avg_first_response_time ?? 0) - (valueStats(firstResp).meanSec ?? 0)) < 1,
      },
    );
  }
  {
    const sum = (b: Bucket[] | undefined) => (b ?? []).reduce((s, x) => s + x.value, 0);
    const agentConv = agentSummary.reduce((s, r) => s + r.conversations_count, 0);
    const channelTotal = Object.values(channelSummary).reduce((s, c) => s + c.total, 0);
    const inboxTotal = inboxSummary.reduce((s, r) => s + r.conversations_count, 0);
    crossChecks.push(
      {
        check: 'sum(daily conversations_count) == summary.conversations_count',
        a: sum(series.conversations_count),
        b: summary.conversations_count,
        ok: sum(series.conversations_count) === summary.conversations_count,
      },
      {
        check: 'sum(inbox conversations) == summary.conversations_count',
        a: inboxTotal,
        b: summary.conversations_count,
        ok: inboxTotal === summary.conversations_count,
      },
      {
        check: 'sum(channel totals) == summary.conversations_count',
        a: channelTotal,
        b: summary.conversations_count,
        ok: channelTotal === summary.conversations_count,
      },
      {
        check: 'agent conversations <= account (difference = unassigned)',
        a: agentConv,
        b: summary.conversations_count,
        ok: agentConv <= summary.conversations_count,
      },
      { check: 'day buckets aligned to local midnight', a: misaligned.length, b: 0, ok: misaligned.length === 0 },
    );
  }

  // --- Derived tables --------------------------------------------------------

  const daily = dayList.map((day, i) => {
    const row: Record<string, string | number | null> = { day };
    for (const m of TIME_SERIES_METRICS) {
      const b = series[m]?.[i];
      row[m] = b ? b.value : null;
      if (b && b.count !== undefined) row[`${m}__events`] = b.count;
    }
    return row;
  });

  const labelRows = [...labelSummary]
    .filter((r) => r.conversations_count > 0 || r.resolved_conversations_count > 0)
    .sort((a, b) => b.conversations_count - a.conversations_count);

  const result = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    window: {
      tz: args.tz,
      days: args.days,
      completeDays: args.completeDays,
      firstLocalDay: firstDay,
      since,
      until,
      sinceIso: new Date(sinceMs).toISOString(),
      untilIso: new Date(untilMs).toISOString(),
      timezoneOffsetParam: offsetHours,
      localDays: dayList,
    },
    reference: { inboxes, labels },
    summary,
    daily,
    rawSeries: series,
    hourOfDayCreated: byLocalHour,
    summaryReports: {
      label: labelSummary,
      inbox: inboxSummary.map((r) => ({ ...r, name: inboxName.get(r.id) ?? null })),
      agent: agentSummary,
      team: teamSummary,
      channel: channelSummary,
    },
    firstResponseTimeDistribution: frtDistribution,
    inboxLabelMatrix: matrix,
    labelDailyConversations: labelSeries,
    nativeBot: { botSummary, botMetrics },
    live: {
      snapshotAt: liveSnapshotAt,
      liveReportsConversationMetrics: live,
      reportsConversationsLegacy: liveLegacy,
      groupedByAssignee: grouped,
      conversationMeta,
    },
    reportingEvents: eventsBlock,
    crossChecks,
    requests: requestCount,
    durationMs: Date.now() - startedAt,
  };

  // --- Output ----------------------------------------------------------------

  const lines: string[] = [];
  const p = (s = '') => lines.push(s);
  p(`# Chatwoot reports: ${args.days} local day(s)${args.completeDays ? ' (complete days)' : ' (today included)'}`);
  p();
  p(`Window: ${windowLabel}. Generated ${result.generatedAt}. ${requestCount} GET requests, ${result.durationMs} ms.`);
  p();
  p('## KPI summary (/reports/summary, previous = preceding equal-length window)');
  p();
  p('| Metric | Window | Previous |');
  p('|---|---:|---:|');
  const kv: Array<[string, (s: SummaryCore) => string]> = [
    ['Conversations created', (s) => String(s.conversations_count)],
    ['Incoming messages', (s) => String(s.incoming_messages_count)],
    ['Outgoing messages (incl. private notes)', (s) => String(s.outgoing_messages_count)],
    ['Resolve events', (s) => String(s.resolutions_count)],
    ['Avg first response time', (s) => hours(s.avg_first_response_time)],
    ['Avg resolution time', (s) => hours(s.avg_resolution_time)],
    ['Avg reply time', (s) => hours(s.reply_time)],
  ];
  for (const [name, f] of kv) p(`| ${name} | ${f(summary)} | ${f(summary.previous)} |`);
  p();
  p('## Daily (/reports group_by=day)');
  p();
  p('| Local day | Created | Incoming | Outgoing | Resolve events | Avg FRT | FRT events | Avg resolution | Avg reply |');
  p('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const d of daily) {
    p(
      `| ${d.day} | ${d.conversations_count} | ${d.incoming_messages_count} | ${d.outgoing_messages_count} | ${
        d.resolutions_count
      } | ${hours(d.avg_first_response_time as number | null)} | ${d['avg_first_response_time__events'] ?? ''} | ${hours(
        d.avg_resolution_time as number | null,
      )} | ${hours(d.reply_time as number | null)} |`,
    );
  }
  p();
  if (eventsBlock) {
    const e = eventsBlock as {
      nameCounts: Record<string, number>;
      firstResponse: ValueStats;
      replyTime: ValueStats;
      resolution: ValueStats;
      reopens: number;
      openedFromPendingOrNew: number;
      userIdCounts: Record<string, number>;
    };
    p('## Raw reporting_events (exact statistics)');
    p();
    p(`Event counts: ${Object.entries(e.nameCounts).map(([k, v]) => `${k} ${v}`).join(', ')}. Events per user_id: ${Object.entries(e.userIdCounts).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
    p();
    p('| Event | Events | Unique conversations | Mean | Median | P90 | < 60 s | < 1 h |');
    p('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const [n, s] of [
      ['first_response', e.firstResponse],
      ['reply_time', e.replyTime],
      ['conversation_resolved', e.resolution],
    ] as const) {
      p(`| ${n} | ${s.events} | ${s.uniqueConversations} | ${hours(s.meanSec)} | ${hours(s.medianSec)} | ${hours(s.p90Sec)} | ${s.under60s} | ${s.under1h} |`);
    }
    p();
    p(`Reopens (conversation_opened value > 0): ${e.reopens}. Opened with value 0 (new or pending -> open): ${e.openedFromPendingOrNew}.`);
    p();
  }
  p('## Inboxes (/summary_reports/inbox)');
  p();
  p('| Inbox | Created | Resolve events | Avg FRT | Avg resolution | Avg reply |');
  p('|---|---:|---:|---:|---:|---:|');
  for (const r of result.summaryReports.inbox) {
    p(`| ${r.name ?? r.id} (${r.id}) | ${r.conversations_count} | ${r.resolved_conversations_count} | ${hours(r.avg_first_response_time)} | ${hours(r.avg_resolution_time)} | ${hours(r.avg_reply_time)} |`);
  }
  p();
  p('## Channel by current status (/summary_reports/channel, conversations created in window)');
  p();
  p('| Channel | Open | Pending | Resolved | Snoozed | Total |');
  p('|---|---:|---:|---:|---:|---:|');
  for (const [ch, c] of Object.entries(channelSummary)) p(`| ${ch} | ${c.open} | ${c.pending} | ${c.resolved} | ${c.snoozed} | ${c.total} |`);
  p();
  p('## Labels (/summary_reports/label)');
  p();
  p('Created = conversations created in window that currently carry the label. Resolve events = resolve events in window on conversations that currently carry the label (any creation date). Different cohorts: do not divide one by the other.');
  p();
  p('| Label | Created | Resolve events | Avg FRT | Avg resolution | Daily created |');
  p('|---|---:|---:|---:|---:|---|');
  for (const r of labelRows) {
    p(`| ${r.name} | ${r.conversations_count} | ${r.resolved_conversations_count} | ${hours(r.avg_first_response_time)} | ${hours(r.avg_resolution_time)} | ${(labelSeries[r.name ?? ''] ?? []).join(', ')} |`);
  }
  p();
  p('## First response time distribution (/reports/first_response_time_distribution)');
  p();
  for (const [ch, b] of Object.entries(frtDistribution)) p(`- ${ch}: ${Object.entries(b).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  p();
  p(`## Hour of day created (${args.tz}, summed over window)`);
  p();
  p(byLocalHour.map((v, h) => `${String(h).padStart(2, '0')}h ${v}`).join(', '));
  p();
  p(`## Live snapshot at ${liveSnapshotAt}`);
  p();
  p(`- live_reports/conversation_metrics: open ${live.open}, unattended ${live.unattended}, unassigned ${live.unassigned}, pending ${live.pending}`);
  p(`- reports/conversations (legacy, pending is wrong): ${JSON.stringify(liveLegacy)}`);
  p(`- conversations/meta all_count: ${statuses.map((s) => `${s} ${conversationMeta[s]?.all_count}`).join(', ')}`);
  p();
  p('## Native bot metrics (expected zero: bot acts via the user token)');
  p();
  p(`- bot_summary: ${JSON.stringify(botSummary)}`);
  p(`- bot_metrics: ${JSON.stringify(botMetrics)}`);
  p();
  p('## Cross-checks');
  p();
  for (const c of crossChecks) p(`- [${c.ok ? 'ok' : 'MISMATCH'}] ${c.check}: ${c.a} vs ${c.b}`);
  const md = lines.join('\n') + '\n';

  mkdirSync(args.out, { recursive: true });
  const stem = `chatwoot-reports_${args.days}d${args.completeDays ? '_complete' : ''}_${today}`;
  const jsonPath = join(args.out, `${stem}.json`);
  const mdPath = join(args.out, `${stem}.md`);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  writeFileSync(mdPath, md);

  // Console summary
  console.log();
  console.log(pad('Metric', 42) + lpad('Window', 12) + lpad('Previous', 12));
  for (const [name, f] of kv) console.log(pad(name, 42) + lpad(f(summary), 12) + lpad(f(summary.previous), 12));
  console.log();
  console.log(pad('Local day', 12) + lpad('Created', 9) + lpad('In', 7) + lpad('Out', 7) + lpad('Resolv', 8) + lpad('AvgFRT', 10));
  for (const d of daily) {
    console.log(
      pad(String(d.day), 12) +
        lpad(String(d.conversations_count), 9) +
        lpad(String(d.incoming_messages_count), 7) +
        lpad(String(d.outgoing_messages_count), 7) +
        lpad(String(d.resolutions_count), 8) +
        lpad(hours(d.avg_first_response_time as number | null), 10),
    );
  }
  if (eventsBlock) {
    const fr = eventsBlock.firstResponse as ValueStats;
    console.log();
    console.log(
      `first_response events ${fr.events}: mean ${hours(fr.meanSec)}, median ${hours(fr.medianSec)}, p90 ${hours(fr.p90Sec)}, under 60 s ${fr.under60s}`,
    );
    console.log(`reopens ${eventsBlock.reopens}; resolve events ${(eventsBlock.resolution as ValueStats).events} on ${(eventsBlock.resolution as ValueStats).uniqueConversations} conversations`);
  }
  console.log();
  console.log('Top labels (created in window / resolve events):');
  for (const r of labelRows.slice(0, 12)) console.log(`  ${pad(r.name ?? r.id, 20)}${lpad(r.conversations_count, 6)}${lpad(r.resolved_conversations_count, 7)}`);
  console.log();
  console.log(`Live: open ${live.open}, pending ${live.pending}, unattended ${live.unattended}, unassigned ${live.unassigned}`);
  console.log();
  for (const c of crossChecks) console.log(`[${c.ok ? 'ok' : 'MISMATCH'}] ${c.check}: ${c.a} vs ${c.b}`);
  console.log();
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(`${requestCount} GET requests in ${result.durationMs} ms`);
}

main().catch((err: unknown) => {
  if (axios.isAxiosError(err)) {
    console.error(`HTTP ${err.response?.status} for ${err.config?.url}: ${JSON.stringify(err.response?.data)?.slice(0, 300)}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

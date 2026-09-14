/**
 * Skio subscription cancellations vs Chatwoot cancellation labels (sub-cancelled = human, sub-cancelled-ai = AI).
 *
 * READ-ONLY. Skio GraphQL queries (no mutations), Chatwoot GET requests. Emails are used as the join key in memory
 * only; the output holds aggregates, conversation ids and Skio subscription ids, never emails or names.
 *
 * Usage:
 *   npx tsx src/scripts/analytics/skioCancellations.ts --days=7
 *   Options:
 *     --days=N            complete Europe/Helsinki days ending at local midnight today (default 7)
 *     --include-today     extend the window to now
 *     --match-minutes=M   max gap between a Skio cancelledAt and a label event of the same customer (default 30)
 *     --tz=Europe/Helsinki --out=/home/dolan/support-analytics
 *
 * Output: <out>/skio-cancellations_<N>d[_incl-today]_<lastDay>.json and .md
 *
 * See docs/support-analytics/README.md ("AI vs human subscription cancellations").
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import axios from 'axios';
import { env } from '../../config/env.js';
import { chatwootClient } from '../../services/chatwoot.js';
import { localDay, localMidnightUtc } from './lib/refundRules.js';

// ---------------------------------------------------------------------------
// Args
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
const MATCH_S = (Number(flag('match-minutes') ?? 30) || 30) * 60;
const NEAR_CONVERSATION_S = 48 * 3600;

const addDays = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (e: unknown) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
const inc = (m: Record<string, number>, k: string, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};
let chatwootCalls = 0;
let skioCalls = 0;

/** GET with a retry policy that does not depend on Retry-After (Chatwoot Cloud sends 429 without it). */
async function cwGet<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      chatwootCalls++;
      const { data } = await chatwootClient.get(path, { params, timeout: 60_000 });
      return data as T;
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt >= 8) throw err;
      await sleep(15_000 * attempt);
    }
  }
}

// ---------------------------------------------------------------------------
// Skio (read-only GraphQL queries)
// ---------------------------------------------------------------------------

const skio = axios.create({
  baseURL: 'https://graphql.skio.com/v1/graphql',
  headers: { 'Content-Type': 'application/json', authorization: `API ${env.skioApiKey}` },
  timeout: 90_000,
});

async function skioQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (/^\s*mutation\b/i.test(query)) throw new Error('read-only script: mutations are not allowed');
  for (let attempt = 1; ; attempt++) {
    try {
      skioCalls++;
      const res = await skio.post('', { query, variables });
      if (res.data.errors?.length) throw new Error(`Skio GraphQL errors: ${JSON.stringify(res.data.errors).slice(0, 300)}`);
      return res.data.data as T;
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(5_000 * attempt);
    }
  }
}

interface SkioSub {
  id: string;
  status: string;
  statusContext: string | null;
  cancelledAt: string;
  StorefrontUser: { email: string | null } | null;
}

async function skioCancelledBetween(fromIso: string, toIso: string): Promise<SkioSub[]> {
  const out: SkioSub[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const data = await skioQuery<{ Subscriptions: SkioSub[] }>(
      `query C($a: timestamptz!, $b: timestamptz!, $limit: Int!, $offset: Int!) {
        Subscriptions(where: { cancelledAt: { _gte: $a, _lt: $b } }, order_by: { cancelledAt: asc }, limit: $limit, offset: $offset) {
          id status statusContext cancelledAt StorefrontUser { email }
        }
      }`,
      { a: fromIso, b: toIso, limit: pageSize, offset },
    );
    out.push(...data.Subscriptions);
    if (data.Subscriptions.length < pageSize) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chatwoot
// ---------------------------------------------------------------------------

interface Conv {
  id: number;
  inbox_id: number;
  labels: string[];
  created_at: number;
  last_activity_at: number;
  meta?: { sender?: { email?: string | null; custom_attributes?: Record<string, unknown> | null } };
}
interface Msg {
  id: number;
  message_type: number;
  content: string | null;
  created_at: number;
}

async function conversationsActiveSince(sinceS: number): Promise<Conv[]> {
  const byId = new Map<number, Conv>();
  const pullStart = Math.floor(Date.now() / 1000) - 60;
  for (const stopBelow of [sinceS, pullStart]) {
    for (let page = 1; page < 1000; page++) {
      const data = await cwGet<{ data: { payload: Conv[] } }>('/conversations', {
        status: 'all',
        assignee_type: 'all',
        sort_by: 'last_activity_at_desc',
        page,
      });
      const rows = data.data.payload;
      for (const c of rows) if (c.last_activity_at >= sinceS) byId.set(c.id, c);
      const last = rows.at(-1);
      if (!last || rows.length < 25 || last.last_activity_at < stopBelow) break;
    }
  }
  return [...byId.values()];
}

async function messagesSince(id: number, sinceS: number): Promise<Msg[]> {
  const all = new Map<number, Msg>();
  let before: number | undefined;
  for (let i = 0; i < 50; i++) {
    const data = await cwGet<{ payload: Msg[] }>(`/conversations/${id}/messages`, before ? { before } : {});
    for (const m of data.payload) all.set(m.id, m);
    if (data.payload.length < 20) break;
    const minId = Math.min(...data.payload.map((m) => m.id));
    if (Math.min(...data.payload.map((m) => m.created_at)) < sinceS || minId === before) break;
    before = minId;
  }
  return [...all.values()];
}

const LABEL_EVENT_RE = /^(.+?) (added|removed) ([a-z0-9_-]+(?:, [a-z0-9_-]+)*)$/;
const CANCEL_LABELS = { 'sub-cancelled': 'human', 'sub-cancelled-ai': 'ai' } as const;

async function mapPool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++] as T); }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const today = localDay(started, TZ);
  const firstDay = addDays(today, -DAYS);
  const lastDay = INCLUDE_TODAY ? today : addDays(today, -1);
  const fromMs = localMidnightUtc(firstDay, TZ);
  const toMs = INCLUDE_TODAY ? started : localMidnightUtc(today, TZ);
  const fromS = Math.floor(fromMs / 1000);
  const toS = Math.floor(toMs / 1000);
  const days: string[] = [];
  for (let d = firstDay; d <= lastDay; d = addDays(d, 1)) days.push(d);
  console.error(`[skio] window ${firstDay}..${lastDay} [${new Date(fromMs).toISOString()}, ${new Date(toMs).toISOString()})`);

  // 1. Skio cancellations, padded by the match window so label events at the edges can pair.
  const subs = await skioCancelledBetween(new Date(fromMs - MATCH_S * 1000).toISOString(), new Date(toMs + MATCH_S * 1000).toISOString());
  console.error(`[skio] ${subs.length} cancelled subscriptions (padded range)`);

  // 2. Chatwoot conversations and cancellation label events.
  const convs = await conversationsActiveSince(fromS - NEAR_CONVERSATION_S);
  const convsByEmail = new Map<string, Conv[]>();
  const emailsOf = (c: Conv) => {
    const s = c.meta?.sender;
    return [norm(s?.email), norm(s?.custom_attributes?.shopify_email_link)].filter(Boolean);
  };
  for (const c of convs) for (const e of emailsOf(c)) convsByEmail.set(e, [...(convsByEmail.get(e) ?? []), c]);
  const labelled = convs.filter((c) => c.labels.some((l) => l in CANCEL_LABELS));
  console.error(`[skio] ${convs.length} Chatwoot conversations, ${labelled.length} carry a cancellation label`);

  interface LabelEvent {
    conversationId: number;
    kind: 'human' | 'ai';
    ts: number;
    emails: string[];
    matchedSubIds: string[];
    gapS: number | null;
  }
  const events: LabelEvent[] = [];
  await mapPool(labelled, 5, async (c) => {
    const msgs = await messagesSince(c.id, fromS - MATCH_S);
    const seen = new Set<string>();
    for (const m of msgs.sort((a, b) => a.created_at - b.created_at || a.id - b.id)) {
      if (m.message_type !== 2) continue;
      const hit = LABEL_EVENT_RE.exec((m.content ?? '').trim());
      if (!hit || hit[2] !== 'added') continue;
      for (const label of (hit[3] as string).split(', ')) {
        const kind = CANCEL_LABELS[label as keyof typeof CANCEL_LABELS];
        if (!kind || seen.has(label)) continue;
        seen.add(label);
        events.push({ conversationId: c.id, kind, ts: m.created_at, emails: emailsOf(c), matchedSubIds: [], gapS: null });
      }
    }
  });

  // 3. Match: each Skio cancellation to the nearest cancellation label event of the same email within MATCH_S.
  //    One label event may cover several subscriptions (the tools cancel every active subscription of the email).
  type SubCategory = 'ai_label' | 'human_label' | 'support_conversation_no_cancel_label' | 'no_support_contact' | 'no_email';
  const subRows = subs.map((s) => {
    const ts = Math.floor(Date.parse(s.cancelledAt) / 1000);
    const email = norm(s.StorefrontUser?.email);
    const cands = email ? events.filter((e) => e.emails.includes(email) && Math.abs(e.ts - ts) <= MATCH_S) : [];
    const best = cands.sort((a, b) => Math.abs(a.ts - ts) - Math.abs(b.ts - ts))[0];
    let category: SubCategory;
    if (!email) category = 'no_email';
    else if (best) {
      category = best.kind === 'ai' ? 'ai_label' : 'human_label';
      best.matchedSubIds.push(s.id);
      if (best.gapS === null || Math.abs(ts - best.ts) < Math.abs(best.gapS)) best.gapS = best.ts - ts;
    } else {
      const near = (convsByEmail.get(email) ?? []).some(
        (c) => c.created_at <= ts + NEAR_CONVERSATION_S && c.last_activity_at >= ts - NEAR_CONVERSATION_S,
      );
      category = near ? 'support_conversation_no_cancel_label' : 'no_support_contact';
    }
    return {
      subscriptionId: s.id,
      cancelledAtUtc: s.cancelledAt,
      ts,
      localDate: localDay(ts * 1000, TZ),
      inWindow: ts >= fromS && ts < toS,
      dunning: s.statusContext === 'DUNNING',
      statusContext: s.statusContext,
      category,
    };
  });

  const inWin = subRows.filter((r) => r.inWindow);
  const winEvents = events.filter((e) => e.ts >= fromS && e.ts < toS);
  const summarize = (rows: typeof subRows, evs: LabelEvent[]) => {
    const nonDunning = rows.filter((r) => !r.dunning);
    const cats: Record<string, number> = {};
    for (const r of nonDunning) inc(cats, r.category);
    const ev = (kind: 'ai' | 'human') => {
      const list = evs.filter((e) => e.kind === kind);
      const matched = list.filter((e) => e.matchedSubIds.length > 0);
      const gaps = matched.map((e) => Math.abs(e.gapS as number)).sort((a, b) => a - b);
      return {
        labelEvents: list.length,
        withSkioCancellation: matched.length,
        withoutSkioCancellation: list.length - matched.length,
        matchRatePct: list.length ? Math.round((matched.length / list.length) * 1000) / 10 : null,
        subscriptionsCancelled: matched.reduce((a, e) => a + e.matchedSubIds.length, 0),
        medianGapSeconds: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
        noEmailOnConversation: list.filter((e) => e.emails.length === 0).length,
      };
    };
    return {
      skioCancelled: rows.length,
      dunning: rows.length - nonDunning.length,
      nonDunning: nonDunning.length,
      nonDunningByCategory: cats,
      aiLabels: ev('ai'),
      humanLabels: ev('human'),
    };
  };

  const result = {
    generatedAt: new Date(started).toISOString(),
    timezone: TZ,
    window: { firstDay, lastDay, fromUtc: new Date(fromMs).toISOString(), toUtc: new Date(toMs).toISOString(), includeToday: INCLUDE_TODAY },
    method: {
      skio: 'Subscriptions(where cancelledAt in window) { id status statusContext cancelledAt StorefrontUser.email }. Skio exposes no cancelledBy / source field; AuditLogs only say "Subscription cancelled" with StorefrontUser null; CancelFlowSessions returns [] for this API key.',
      chatwoot: 'first "added sub-cancelled" / "added sub-cancelled-ai" activity per conversation (Chatwoot logs a label only once per conversation).',
      joinKey: 'lower-cased Skio StorefrontUser.email = Chatwoot contact email or custom_attributes.shopify_email_link (in memory only)',
      matchWindowMinutes: MATCH_S / 60,
      categories: {
        ai_label: 'a sub-cancelled-ai label event of the same email within the match window',
        human_label: 'a sub-cancelled label event of the same email within the match window',
        support_conversation_no_cancel_label: 'no cancellation label nearby, but the customer had a Chatwoot conversation active within 48 h',
        no_support_contact: 'no Chatwoot conversation of that email active within 48 h (customer portal, Skio merchant UI, or an unlinked email)',
        no_email: 'Skio subscription without a storefront user email',
      },
    },
    apiCalls: { skio: skioCalls, chatwoot: chatwootCalls },
    totals: summarize(inWin, winEvents),
    byDay: days.map((d) => ({
      date: d,
      ...summarize(
        inWin.filter((r) => r.localDate === d),
        winEvents.filter((e) => localDay(e.ts * 1000, TZ) === d),
      ),
    })),
    unmatchedLabelEvents: winEvents
      .filter((e) => e.matchedSubIds.length === 0)
      .map((e) => ({ conversationId: e.conversationId, kind: e.kind, addedAtUtc: new Date(e.ts * 1000).toISOString(), conversationHasEmail: e.emails.length > 0 })),
    runtimeSeconds: Math.round((Date.now() - started) / 1000),
  };

  const t = result.totals;
  const md = [
    `# Skio cancellations vs Chatwoot cancellation labels, ${firstDay}..${lastDay} (${TZ})`,
    '',
    `Generated ${result.generatedAt}. Match window ±${MATCH_S / 60} min, join by email in memory. API calls: Skio ${skioCalls}, Chatwoot ${chatwootCalls}.`,
    '',
    '| day | Skio cancelled | dunning | non-dunning | with AI label | with human label | support conv, no label | no support contact | AI labels (matched) | human labels (matched) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...[...result.byDay, { date: 'total', ...t }].map(
      (r) =>
        `| ${r.date} | ${r.skioCancelled} | ${r.dunning} | ${r.nonDunning} | ${r.nonDunningByCategory.ai_label ?? 0} | ${r.nonDunningByCategory.human_label ?? 0} | ${r.nonDunningByCategory.support_conversation_no_cancel_label ?? 0} | ${r.nonDunningByCategory.no_support_contact ?? 0} | ${r.aiLabels.labelEvents} (${r.aiLabels.withSkioCancellation}) | ${r.humanLabels.labelEvents} (${r.humanLabels.withSkioCancellation}) |`,
    ),
    '',
    `AI label events: ${JSON.stringify(t.aiLabels)}`,
    `Human label events: ${JSON.stringify(t.humanLabels)}`,
    '',
  ].join('\n');
  console.log(md);
  mkdirSync(OUT_DIR, { recursive: true });
  const stem = join(OUT_DIR, `skio-cancellations_${DAYS}d${INCLUDE_TODAY ? '_incl-today' : ''}_${lastDay}`);
  writeFileSync(`${stem}.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${stem}.md`, md);
  console.error(`[skio] wrote ${stem}.json/.md in ${result.runtimeSeconds}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error(axios.isAxiosError(err) ? `${err.message} ${JSON.stringify(err.response?.data)?.slice(0, 500)}` : err);
  process.exit(1);
});

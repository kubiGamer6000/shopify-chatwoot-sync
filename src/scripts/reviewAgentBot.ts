/**
 * AgentBot quality review: collects what the bot did and has Claude grade each
 * conversation against a support-quality rubric, then writes a report.
 *
 * Read-only against Chatwoot, Shopify and Firestore (it never sends, labels or
 * changes status). Costs one Claude call per conversation plus a summary.
 *
 * Usage:
 *   npm run review:agentbot                        # last 24h of live decisions
 *   npm run review:agentbot -- --hours=48
 *   npm run review:agentbot -- --replay --ids=11264,11410   # pre-launch: replay
 *                                                  # conversations as of the
 *                                                  # customer's latest message
 *   Options: --out=<dir> (default ~/agentbot-reviews), --limit=N, --concurrency=N,
 *            --overrides='<json>' (replay only: test unsaved config)
 *
 * Reports contain customer data: keep them out of the repository.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { env } from '../config/env.js';
import { chatwootClient } from '../services/chatwoot.js';
import { getDb } from '../services/firestore.js';
import { getConversationDetails } from '../services/chatwootConversation.js';
import { gatherContextWithMatching } from '../services/aiDraft.js';
import { runReplay } from '../services/aiReplay.js';
import { buildPrompt } from '../utils/promptBuilder.js';
import { inlineEmailImageCount } from '../services/attachments.js';
import type { ChatwootMessage } from '../types/chatwoot.js';

const REVIEW_MODEL = 'claude-opus-5';
const client = new Anthropic({ apiKey: env.anthropicApiKey });

// --- Args --------------------------------------------------------------------

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';
}

const HOURS = Number(arg('hours') ?? 24);
const REPLAY = arg('replay') === 'true';
const IDS = (arg('ids') ?? '').split(',').map(Number).filter((n) => n > 0);
const LIMIT = arg('limit') ? Number(arg('limit')) : null;
const CONCURRENCY = Number(arg('concurrency') ?? 4);
const OUT_DIR = arg('out') ?? join(homedir(), 'agentbot-reviews');
// Replay only: unsaved config overrides as JSON, e.g. --overrides='{"acknowledgeMode":"live"}'.
const OVERRIDES = arg('overrides') ? (JSON.parse(arg('overrides')!) as Record<string, unknown>) : undefined;

// --- Case collection ---------------------------------------------------------

/** Everything the reviewer needs about one conversation. */
interface ReviewCase {
  conversationId: number;
  /** What the bot decided and did (live) or would do (replay). */
  decision: Record<string, unknown>;
  /** Customer-facing messages the bot sent / would send. */
  botMessages: string[];
  /** Internal handoff note, when any. */
  handoffNote: string | null;
  /** The conversation as the reviewer should read it. */
  transcript: string;
  /** Customer + order + tracking context (current state). */
  context: string;
}

function conversationUrl(id: number): string {
  return `${env.chatwootBaseUrl}/app/accounts/${env.chatwootAccountId}/conversations/${id}`;
}

async function allMessages(conversationId: number): Promise<ChatwootMessage[]> {
  const out: ChatwootMessage[] = [];
  let before: number | undefined;
  for (let i = 0; i < 10; i++) {
    const res = await chatwootClient.get<{ payload: ChatwootMessage[] }>(
      `/conversations/${conversationId}/messages`,
      { params: before ? { before } : {} },
    );
    const batch = res.data.payload ?? [];
    if (batch.length === 0) break;
    out.push(...batch);
    const minId = Math.min(...batch.map((m) => m.id));
    if (batch.length < 20 || minId === before) break;
    before = minId;
  }
  const seen = new Set<number>();
  return out
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .sort((a, b) => a.created_at - b.created_at);
}

function renderTranscript(messages: ChatwootMessage[], botSent: Set<string>): string {
  return messages
    .map((m) => {
      const time = new Date(m.created_at * 1000).toISOString().slice(0, 16).replace('T', ' ');
      const content = (m.content ?? '').trim().slice(0, 2500) || '[no text]';
      const inline = m.message_type === 0 ? inlineEmailImageCount(m) : 0;
      const count = (m.attachments?.length ?? 0) + inline;
      const atts = count ? ` [${count} attachment(s)/inline image(s)]` : '';
      if (m.message_type === 2) return `${time} · activity: ${content.slice(0, 160)}`;
      if (m.message_type === 0) return `${time} CUSTOMER${atts}: ${content}`;
      if (m.private) return `${time} [PRIVATE NOTE]: ${content.slice(0, 1500)}`;
      const who = botSent.has((m.content ?? '').trim()) ? 'BOT' : 'AGENT';
      return `${time} ${who}${atts}: ${content}`;
    })
    .join('\n');
}

async function contextFor(conversationId: number): Promise<string> {
  const details = await getConversationDetails(conversationId);
  const contactId = details.meta?.sender?.id;
  if (!contactId) return '(no contact)';
  const { context } = await gatherContextWithMatching(
    { conversationId, contactId, email: details.meta?.sender?.email ?? null },
    { dryRun: true },
  );
  // Only the customer/order/tracking part: the transcript is rendered separately.
  const prompt = buildPrompt(context);
  const cut = prompt.indexOf('--- CURRENT CONVERSATION ---');
  return cut > 0 ? prompt.slice(0, cut).trim() : prompt;
}

async function collectLive(): Promise<ReviewCase[]> {
  const db = getDb();
  if (!db) throw new Error('Firestore is not configured (FIREBASE_BASE64_SERVICE_ACCOUNT).');
  const since = Date.now() - HOURS * 60 * 60 * 1000;

  const decisions = await db.collection('agentBotDecisions').where('ts', '>=', since).get();
  let docs = decisions.docs.map((d) => ({
    ...(d.data() as Record<string, unknown>),
    id: Number(d.id),
    ts: Number(d.data().ts ?? 0),
  }));
  docs.sort((a, b) => Number(b.ts) - Number(a.ts));
  if (LIMIT) docs = docs.slice(0, LIMIT);
  console.log(`Found ${decisions.size} decisions in the last ${HOURS}h; reviewing ${docs.length}.`);

  return mapPool(docs, CONCURRENCY, async (decision) => {
    const conversationId = decision.id;
    const [sent, classification, messages, context] = await Promise.all([
      db.collection('sentReplies').where('conversationId', '==', conversationId).get(),
      db.collection('classifications').doc(String(conversationId)).get(),
      allMessages(conversationId),
      contextFor(conversationId).catch((err) => `(context unavailable: ${err.message})`),
    ]);
    const botMessages = sent.docs
      .map((d) => d.data() as { source?: string; message?: string; ts?: number })
      .filter((d) => (d.source ?? '').startsWith('agent-bot') && (d.ts ?? 0) >= since)
      .map((d) => d.message ?? '');
    const handoffNote =
      [...messages].reverse().find((m) => m.private && (m.content ?? '').includes('[AI HANDOFF]'))
        ?.content ?? null;
    return {
      conversationId,
      decision: {
        ...decision,
        classification: classification.exists ? classification.data() : null,
      },
      botMessages,
      handoffNote,
      transcript: renderTranscript(messages, new Set(botMessages.map((m) => m.trim()))),
      context,
    };
  });
}

async function collectReplay(): Promise<ReviewCase[]> {
  if (IDS.length === 0) throw new Error('--replay needs --ids=1,2,3');
  return mapPool(IDS, CONCURRENCY, async (conversationId) => {
    const ack = await runReplay({ conversationId, kind: 'acknowledge', overrides: OVERRIDES });
    const ctx = ack.context as Record<string, any>;
    const out = ack.output as Record<string, any>;
    const decision: Record<string, unknown> = {
      mode: 'replay',
      route: ctx.route,
      intents: ctx.intents,
      reason: ctx.routeReason,
      classification: ctx.classification,
      autoReplyDetected: ctx.autoReplyDetected,
    };
    let botMessages: string[] = [];
    let handoffNote: string | null = null;

    if (ctx.route === 'acknowledge') {
      botMessages = out.wouldSend ? [out.wouldSend] : [];
      handoffNote = out.handoffNote ?? null;
      decision.acknowledgementGuardOk = out.guard?.ok;
      decision.askedFor = out.askedFor;
    } else if (ctx.route === 'respond') {
      const responder = await runReplay({ conversationId, kind: 'responder', overrides: OVERRIDES });
      const r = responder.output as Record<string, any>;
      decision.responderTools = (r.toolInvocations ?? []).map((t: { name: string }) => t.name);
      const escalation = (r.toolInvocations ?? []).find(
        (t: { name: string }) => t.name === 'escalate_to_human',
      );
      if (escalation) {
        // Live, this hands off with an acknowledgement (previewed above).
        decision.responderOutcome = 'escalated (acknowledgement sent)';
        decision.escalationReason = escalation.input?.reason;
        botMessages = out.wouldSend ? [out.wouldSend] : [];
        handoffNote = out.handoffNote ?? null;
      } else {
        decision.responderOutcome = r.guard?.ok ? 'answered' : 'blocked by guard (would hand off)';
        botMessages = r.guard?.wouldSend ? [r.guard.wouldSend] : [];
      }
    }

    // The transcript as the bot saw it: up to the customer's latest message.
    const messages = await allMessages(conversationId);
    const lastCustomer = Math.max(0, ...messages.filter((m) => m.message_type === 0).map((m) => m.created_at));
    const seen = messages.filter((m) => m.created_at <= lastCustomer);
    return {
      conversationId,
      decision,
      botMessages,
      handoffNote,
      transcript: renderTranscript(seen, new Set()),
      context: await contextFor(conversationId).catch((err) => `(context unavailable: ${err.message})`),
    };
  });
}

// --- Review ------------------------------------------------------------------

const ISSUE_CATEGORIES = [
  'wrong-route',
  'misclassified',
  'false-promise-or-claim',
  'wrong-facts',
  'asked-for-known-info',
  'missed-needed-info',
  'should-have-replied',
  'should-not-have-replied',
  'replied-to-machine',
  'language',
  'tone',
  'formatting',
  'policy',
  'other',
] as const;

const CaseReviewSchema = z.object({
  summary: z.string().describe('One or two sentences: what the customer wanted and what the bot did.'),
  expectedRoute: z
    .enum(['respond', 'acknowledge', 'handoff', 'close'])
    .describe('The route a careful support lead would have chosen.'),
  routeCorrect: z.boolean(),
  intentsCorrect: z.boolean(),
  customerMessageVerdict: z
    .enum(['good', 'acceptable', 'poor', 'harmful', 'none-sent', 'none-needed'])
    .describe('Quality of what the customer received (or would receive).'),
  handoffNoteUseful: z.boolean().nullable().describe('Null when there was no handoff note.'),
  issues: z.array(
    z.object({
      severity: z.enum(['critical', 'major', 'minor']),
      category: z.enum(ISSUE_CATEGORIES),
      description: z.string(),
      evidence: z.string().describe('Quote or cite the exact text involved.'),
    }),
  ),
  suggestedFix: z
    .string()
    .describe('Concrete prompt, routing or config change that would prevent the issues. Empty if none.'),
});
type CaseReview = z.infer<typeof CaseReviewSchema>;

const REVIEW_SYSTEM = `You are a senior customer-support quality lead for Scandi Gum (teeth-whitening chewing gum, subscriptions via Skio, support in Chatwoot). You audit an AI AgentBot that handles incoming customer messages.

How the bot works:
- Routes: "respond" = the bot answers directly (only subscription cancellation and order status); "acknowledge" = the conversation is handed to a human agent and the customer gets an instant acknowledgement that asks for the information the agent will need; "handoff" = handed to a human with no customer message; "close" = resolved without a reply (auto-replies, bounces, spam, a closing "thanks").
- Acknowledgements must never promise or predict outcomes (refunds, reships, cancellations, dates), never claim an action was taken, never state causes or policy, never invent facts, never claim to be human, must be in the customer's language, and should ask only for information that is genuinely missing.
- Direct answers must be factually consistent with the order and tracking context, never say "on its way" for unfulfilled orders, and escalate stale or disputed orders.
- The system appends a localized sign-off ("Kind regards, Scandi Support Team" or equivalent) to every message; the messages shown include it. That is expected, not an issue.

Judge strictly but fairly. A missed opportunity is minor; a wrong fact, false promise, reply to a machine, or wrong language is major; anything that could cause a chargeback, legal exposure, a leaked internal note, or real customer harm is critical. Note that the order/tracking context is the CURRENT state, which may have changed since the bot acted. Cite evidence.`;

async function reviewCase(c: ReviewCase): Promise<CaseReview | null> {
  const user = [
    `Conversation #${c.conversationId}`,
    '',
    '--- BOT DECISION ---',
    JSON.stringify(c.decision, null, 2),
    '',
    '--- MESSAGES THE BOT SENT (or would send) TO THE CUSTOMER ---',
    c.botMessages.length ? c.botMessages.map((m, i) => `[${i + 1}]\n${m}`).join('\n\n') : '(none)',
    '',
    '--- HANDOFF NOTE FOR THE AGENT ---',
    c.handoffNote ?? '(none)',
    '',
    '--- CUSTOMER, ORDER AND TRACKING CONTEXT ---',
    c.context,
    '',
    '--- CONVERSATION TRANSCRIPT ---',
    c.transcript,
  ].join('\n');

  try {
    const res = await client.messages.parse({
      model: REVIEW_MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: zodOutputFormat(CaseReviewSchema) },
      system: [{ type: 'text', text: REVIEW_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    });
    if (res.stop_reason === 'refusal' || !res.parsed_output) {
      console.warn(`#${c.conversationId}: review returned no result (${res.stop_reason})`);
      return null;
    }
    return res.parsed_output;
  } catch (err) {
    console.warn(`#${c.conversationId}: review failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function summarize(rows: { c: ReviewCase; r: CaseReview }[]): Promise<string> {
  const digest = rows
    .map(({ c, r }) =>
      JSON.stringify({
        id: c.conversationId,
        route: c.decision.route,
        expectedRoute: r.expectedRoute,
        verdict: r.customerMessageVerdict,
        issues: r.issues,
        suggestedFix: r.suggestedFix,
      }),
    )
    .join('\n');
  const res = await client.messages.create({
    model: REVIEW_MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system:
      'You turn per-conversation AI support audits into a concise action report for the team that maintains the bot prompts and routing. Plain markdown. No preamble.',
    messages: [
      {
        role: 'user',
        content: `Per-conversation audits (one JSON per line):\n${digest}\n\nWrite: 1) the 3-6 most important problems, each with how often it occurred and example conversation ids; 2) concrete, prioritized fixes (prompt wording, routing rules, config values), deduplicated; 3) what is working well and should not change.`,
      },
    ],
  });
  return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
}

// --- Report ------------------------------------------------------------------

function renderReport(rows: { c: ReviewCase; r: CaseReview | null }[], summary: string): string {
  const reviewed = rows.filter((x): x is { c: ReviewCase; r: CaseReview } => x.r !== null);
  const count = <T extends string>(values: T[]) =>
    Object.entries(values.reduce<Record<string, number>>((acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc), {}))
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ') || '(none)';

  const issues = reviewed.flatMap(({ c, r }) => r.issues.map((i) => ({ ...i, id: c.conversationId })));
  const bySeverity = (s: string) => issues.filter((i) => i.severity === s).length;

  const lines = [
    `# AgentBot review: ${REPLAY ? `replay of ${IDS.length} conversations` : `last ${HOURS}h`}`,
    '',
    `Generated ${new Date().toISOString()} with ${REVIEW_MODEL}. Reviewed ${reviewed.length} of ${rows.length}.`,
    '',
    '## Numbers',
    '',
    `- Routes taken: ${count(reviewed.map(({ c }) => String(c.decision.route ?? 'unknown')))}`,
    `- Route correct: ${reviewed.filter(({ r }) => r.routeCorrect).length}/${reviewed.length}`,
    `- Intents correct: ${reviewed.filter(({ r }) => r.intentsCorrect).length}/${reviewed.length}`,
    `- Customer message verdicts: ${count(reviewed.map(({ r }) => r.customerMessageVerdict))}`,
    `- Issues: ${bySeverity('critical')} critical, ${bySeverity('major')} major, ${bySeverity('minor')} minor`,
    `- Issue categories: ${count(issues.map((i) => i.category))}`,
    '',
    '## Summary and fixes',
    '',
    summary || '(summary unavailable)',
    '',
    '## Critical and major issues',
    '',
    ...(issues.filter((i) => i.severity !== 'minor').length
      ? issues
          .filter((i) => i.severity !== 'minor')
          .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1))
          .map((i) => `- **${i.severity}** [${i.category}] [#${i.id}](${conversationUrl(i.id)}): ${i.description}\n  > ${i.evidence.replace(/\n/g, ' ')}`)
      : ['(none)']),
    '',
    '## Per conversation',
    '',
  ];

  for (const { c, r } of rows) {
    lines.push(`### [#${c.conversationId}](${conversationUrl(c.conversationId)}): ${String(c.decision.route ?? '?')} (${String(c.decision.action ?? c.decision.responderOutcome ?? '')})`);
    if (!r) {
      lines.push('Review failed.', '');
      continue;
    }
    lines.push(
      r.summary,
      '',
      `Expected route: ${r.expectedRoute} (${r.routeCorrect ? 'correct' : 'WRONG'}). Intents ${r.intentsCorrect ? 'correct' : 'WRONG'}. Message: **${r.customerMessageVerdict}**.`,
    );
    if (c.botMessages.length) lines.push('', 'Sent:', ...c.botMessages.map((m) => `> ${m.replace(/\n/g, '\n> ')}`));
    for (const i of r.issues) lines.push(`- ${i.severity} [${i.category}]: ${i.description} (evidence: "${i.evidence.replace(/\n/g, ' ')}")`);
    if (r.suggestedFix) lines.push('', `Fix: ${r.suggestedFix}`);
    lines.push('');
  }
  return lines.join('\n');
}

// --- Main --------------------------------------------------------------------

async function mapPool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  const cases = REPLAY ? await collectReplay() : await collectLive();
  if (cases.length === 0) {
    console.log('Nothing to review.');
    return;
  }
  console.log(`Reviewing ${cases.length} conversation(s) with ${REVIEW_MODEL}...`);
  let done = 0;
  const reviews = await mapPool(cases, CONCURRENCY, async (c) => {
    const r = await reviewCase(c);
    console.log(`  [${++done}/${cases.length}] #${c.conversationId}: ${r ? `${r.customerMessageVerdict}, ${r.issues.length} issue(s)` : 'failed'}`);
    return r;
  });
  const rows = cases.map((c, i) => ({ c, r: reviews[i] ?? null }));
  const reviewed = rows.filter((x): x is { c: ReviewCase; r: CaseReview } => x.r !== null);
  const summary = reviewed.length ? await summarize(reviewed).catch((e) => `(summary failed: ${e.message})`) : '';

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = join(OUT_DIR, `agentbot-review-${REPLAY ? 'replay' : `${HOURS}h`}-${stamp}`);
  writeFileSync(`${base}.md`, renderReport(rows, summary));
  writeFileSync(`${base}.json`, JSON.stringify(rows, null, 2));
  console.log(`\nReport: ${base}.md\nData:   ${base}.json`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Review failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });

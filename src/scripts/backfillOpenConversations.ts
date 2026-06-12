/**
 * One-time backfill for OPEN conversations that predate the AgentBot.
 *
 * For every OPEN conversation (never `pending`/`resolved`), this:
 *   1. Runs the same classification as the AgentBot and adds labels (add-only).
 *   2. ONLY if the conversation's labels are a non-empty subset of
 *      {sub-cancel, order-status}, runs the autonomous responder, sends the
 *      reply, and resolves the ticket.
 *   3. EVERYTHING else is skipped entirely — no holding reply, no escalation
 *      draft, no status change. The conversation is left untouched (it keeps any
 *      labels added in step 1). This also applies if the responder itself
 *      decides the case actually needs a human: it is skipped, not escalated.
 *
 * Usage (via tsx):
 *   npm run backfill -- --dry-run            # classify + report only, NO changes
 *   npm run backfill -- --test               # process only the latest 10 open (REAL actions)
 *   npm run backfill -- --test --dry-run     # preview the latest 10
 *   npm run backfill -- --limit=50           # process latest 50 (REAL actions)
 *   npm run backfill                         # process ALL open (REAL actions, asks to confirm)
 *   npm run backfill -- --yes                # skip the confirmation prompt
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { listConversations } from '../services/chatwootConversation.js';
import {
  processAgentBotConversation,
  type AgentBotRunResult,
} from '../services/aiResponder.js';
import { logger } from '../utils/logger.js';
import type { ChatwootConversation } from '../types/chatwoot.js';

interface Args {
  dryRun: boolean;
  limit: number | null;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let limit: number | null = null;
  let yes = false;

  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '--dryrun') dryRun = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--test') limit = 10;
    else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
    }
  }

  return { dryRun, limit, yes };
}

const PAGE_SAFETY_CAP = 200; // hard stop so a bug can't loop forever (~5000 convos)

/** Fetches OPEN conversations across all pages, sorted newest-activity first. */
async function fetchOpenConversations(limit: number | null): Promise<ChatwootConversation[]> {
  const all: ChatwootConversation[] = [];

  for (let page = 1; page <= PAGE_SAFETY_CAP; page += 1) {
    const batch = await listConversations({ status: 'open', page, assigneeType: 'all' });
    if (batch.length === 0) break;
    all.push(...batch);
    logger.info('Fetched open conversations page', { page, count: batch.length, total: all.length });

    // When we only need the latest N, we still fetch a couple of pages then sort,
    // because the API page order isn't guaranteed to be newest-first.
    if (limit !== null && all.length >= limit * 3) break;
  }

  // Only OPEN (defensive), then newest activity first.
  const open = all.filter((c) => c.status === 'open');
  open.sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0));

  // De-dupe by id (pagination can overlap if conversations shift between pages).
  const seen = new Set<number>();
  const deduped = open.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  return limit !== null ? deduped.slice(0, limit) : deduped;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('--- AgentBot backfill for OPEN conversations ---');
  console.log(
    `Mode: ${args.dryRun ? 'DRY RUN (no changes)' : 'LIVE (labels + replies/resolves ONLY sub-cancel/order-status; skips everything else)'}` +
      `  |  Scope: ${args.limit === null ? 'ALL open' : `latest ${args.limit} open`}`,
  );

  console.log('\nFetching open conversations...');
  const conversations = await fetchOpenConversations(args.limit);
  console.log(`Found ${conversations.length} open conversation(s) to process.\n`);

  if (conversations.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Confirm before a LIVE run that mutates conversations.
  if (!args.dryRun && !args.yes) {
    const ok = await confirm(
      `This will SEND replies and RESOLVE up to ${conversations.length} conversation(s). Continue? (y/N) `,
    );
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  const results: Array<{
    conversationId: number;
    contactId: number | null;
    result?: AgentBotRunResult;
    error?: string;
  }> = [];

  let index = 0;
  for (const conv of conversations) {
    index += 1;
    const conversationId = conv.id;
    const contactId = conv.meta?.sender?.id ?? null;
    const email = conv.meta?.sender?.email ?? null;

    const prefix = `[${index}/${conversations.length}] conv #${conversationId}`;

    if (contactId == null) {
      console.log(`${prefix} — SKIPPED (no contact/sender id)`);
      results.push({ conversationId, contactId, error: 'no sender id' });
      continue;
    }

    try {
      const result = await processAgentBotConversation(
        { conversationId, contactId, email },
        { dryRun: args.dryRun, backfill: true },
      );
      console.log(
        `${prefix} — ${result.action.toUpperCase()} | labels: [${result.routingLabels.join(', ') || '—'}]` +
          `${result.classified === null ? ' (classification FAILED)' : ''}`,
      );
      results.push({ conversationId, contactId, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${prefix} — ERROR: ${msg}`);
      results.push({ conversationId, contactId, error: msg });
    }

    // Gentle pacing to avoid hammering Chatwoot / Anthropic / Shopify.
    await new Promise((r) => setTimeout(r, 400));
  }

  // Summary.
  const tally: Record<string, number> = {};
  for (const r of results) {
    const key = r.error ? 'error' : (r.result?.action ?? 'unknown');
    tally[key] = (tally[key] ?? 0) + 1;
  }

  console.log('\n--- Summary ---');
  for (const [action, count] of Object.entries(tally)) {
    console.log(`  ${action}: ${count}`);
  }
  console.log(`  total: ${results.length}`);

  if (args.dryRun) {
    console.log(
      '\nDry run complete — no conversations were modified. Re-run without --dry-run to apply.',
    );
  } else {
    console.log('\nBackfill complete.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('Backfill script failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });

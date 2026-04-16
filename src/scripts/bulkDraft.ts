/**
 * Bulk draft generator — fetches all open (and optionally pending) conversations
 * from Chatwoot, gathers full context (Shopify orders, tracking, conversation
 * history), sends each to Claude with a custom prompt, and posts the AI response
 * as a private note.
 *
 * Usage:
 *   npx tsx src/scripts/bulkDraft.ts [--prompt "your custom prompt"]
 *                                     [--prompt-file ./path/to/prompt.txt]
 *                                     [--include-pending]
 *                                     [--dry-run]
 *                                     [--concurrency 3]
 *                                     [--inbox-id 5]
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chatwootClient } from '../services/chatwoot.js';
import {
  getConversationMessages,
  getConversationDetails,
  postPrivateNote,
} from '../services/chatwootConversation.js';
import { fetchCustomerOrders, searchCustomerByEmail } from '../services/shopify.js';
import { getTrackingStatus } from '../services/tracking.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { ChatwootConversation, ChatwootMessage } from '../types/chatwoot.js';
import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';
import type { TrackingSummary } from '../types/tracking.js';
import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    prompt: { type: 'string', short: 'p' },
    'prompt-file': { type: 'string', short: 'f' },
    'include-pending': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '2' },
    'inbox-id': { type: 'string' },
    after: { type: 'string' },
  },
  strict: true,
});

function loadCustomPrompt(): string {
  if (args.prompt) return args.prompt;
  if (args['prompt-file']) {
    const p = resolve(args['prompt-file']);
    return readFileSync(p, 'utf-8').trim();
  }
  return readFileSync(
    resolve(__dirname, '..', 'config', 'prompts', 'responder.txt'),
    'utf-8',
  ).trim();
}

const CUSTOM_PROMPT = loadCustomPrompt();
const DRY_RUN = args['dry-run'] ?? false;
const INCLUDE_PENDING = args['include-pending'] ?? false;
const CONCURRENCY = Math.max(1, Number(args.concurrency) || 2);
const FILTER_INBOX_ID = args['inbox-id'] ? Number(args['inbox-id']) : null;
const AFTER_DATE = args.after ? new Date(args.after).getTime() / 1000 : null;

// ---------------------------------------------------------------------------
// Chatwoot: fetch open conversations (paginated)
// ---------------------------------------------------------------------------

interface ConversationListResponse {
  data: {
    meta: { all_count: number; mine_count: number; unassigned_count: number };
    payload: ChatwootConversation[];
  };
}

async function fetchConversationsByStatus(status: string): Promise<ChatwootConversation[]> {
  const all: ChatwootConversation[] = [];
  let page = 1;

  while (true) {
    const res = await chatwootClient.get<ConversationListResponse>(
      `/conversations`,
      { params: { status, assignee_type: 'all', page } },
    );
    const convos = res.data.data.payload ?? [];
    if (convos.length === 0) break;
    all.push(...convos);
    page++;
  }

  return all;
}

async function fetchAllOpenConversations(): Promise<ChatwootConversation[]> {
  const statuses = INCLUDE_PENDING ? ['open', 'pending'] : ['open'];
  const results: ChatwootConversation[] = [];

  for (const status of statuses) {
    const convos = await fetchConversationsByStatus(status);
    results.push(...convos);
  }

  let filtered = results;

  if (FILTER_INBOX_ID) {
    filtered = filtered.filter((c) => c.inbox_id === FILTER_INBOX_ID);
  }

  if (AFTER_DATE) {
    filtered = filtered.filter((c) => c.created_at >= AFTER_DATE);
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// Context builder (simplified version for bulk — no classifier/responder split)
// ---------------------------------------------------------------------------

function buildBulkContext(opts: {
  conversation: ChatwootConversation;
  messages: ChatwootMessage[];
  customerName?: string;
  customerEmail?: string;
  shopifyCustomer: ShopifyCustomer | null;
  orders: ShopifyOrder[];
  trackingByNumber: Map<string, TrackingSummary>;
}): string {
  const sections: string[] = [];
  const { conversation, messages, customerName, customerEmail, orders, trackingByNumber } = opts;

  sections.push(
    `Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`,
  );

  // Customer
  const name = customerName || 'Unknown';
  const email = customerEmail || 'Unknown';
  const totalOrders = orders.length;
  const totalSpent = orders.reduce((s, o) => s + parseFloat(o.total_price || '0'), 0).toFixed(2);
  const currency = orders[0]?.currency ?? 'EUR';
  sections.push(
    `--- CUSTOMER ---\nCustomer: ${name} (${email})\nConversation #${conversation.id} | Status: ${conversation.status}\nTotal orders: ${totalOrders} | Lifetime value: ${totalSpent} ${currency}`,
  );

  // Orders
  if (orders.length > 0) {
    const sorted = [...orders].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    const orderLines = sorted.map((order) => {
      const date = order.created_at?.split('T')[0] ?? 'N/A';
      const fulfillment = order.fulfillment_status ?? 'unfulfilled';
      const daysSince = Math.floor(
        (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60 * 24),
      );
      const items =
        order.line_items
          ?.map((li) => `${li.title} x${li.quantity}`)
          .join(', ') ?? 'No items';
      const cancelled = order.cancelled_at ? ' [CANCELLED]' : '';
      return `Order ${order.name} | ${date} (${daysSince}d ago) | ${order.total_price} ${order.currency} | ${order.financial_status ?? 'unknown'} / ${fulfillment}${cancelled}\n  Items: ${items}`;
    });
    sections.push(`--- ORDER HISTORY ---\n${orderLines.join('\n---\n')}`);
  } else {
    sections.push('--- ORDER HISTORY ---\nNo orders found.');
  }

  // Tracking
  const trackingLines: string[] = [];
  for (const order of orders.slice(0, 3)) {
    for (const f of order.fulfillments ?? []) {
      const tn = f.tracking_number || f.tracking_numbers?.[0];
      if (!tn) continue;
      const summary = trackingByNumber.get(tn);
      if (summary) {
        trackingLines.push(
          `${order.name} | Tracking: ${tn} | Status: ${summary.status}${summary.subStatus ? ` (${summary.subStatus})` : ''}`,
          summary.lastEvent ? `  Last event: ${summary.lastEvent}` : '',
          summary.lastUpdate ? `  Last update: ${summary.lastUpdate}` : '',
        );
      }
    }
  }
  if (trackingLines.length > 0) {
    sections.push(`--- TRACKING ---\n${trackingLines.filter(Boolean).join('\n')}`);
  }

  // Conversation
  const sorted = [...messages].sort((a, b) => a.created_at - b.created_at);
  const msgLines = sorted
    .filter((m) => !m.private)
    .map((m) => {
      const role = m.message_type === 0 ? 'CUSTOMER' : 'AGENT';
      const time = new Date(m.created_at * 1000).toISOString();
      return `[${time}] ${role}: ${m.content || '[no text]'}`;
    });
  sections.push(`--- CONVERSATION ---\n${msgLines.join('\n')}`);

  return sections.filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// Claude call (plain text, not structured — we just want a draft reply)
// ---------------------------------------------------------------------------

const claude = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 3 });

async function generateDraft(systemPrompt: string, context: string): Promise<string | null> {
  try {
    const response = await claude.messages.create({
      model: env.claudeModel,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: context }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return null;

    logger.info('Claude draft generated', {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    return textBlock.text;
  } catch (err) {
    logger.error('Claude API error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Process a single conversation
// ---------------------------------------------------------------------------

async function processConversation(conversation: ChatwootConversation): Promise<void> {
  const conversationId = conversation.id;
  const contactMeta = conversation.meta?.sender;
  const email = contactMeta?.email;
  const name = contactMeta?.name;

  logger.info(`Processing conversation #${conversationId}`, { name, email });

  // Fetch messages
  const messagesRes = await getConversationMessages(conversationId);
  const messages = messagesRes.payload;

  if (messages.length === 0) {
    console.log(`  ⏭  #${conversationId} — no messages, skipping`);
    return;
  }

  // Real messages = not private notes, not activity events (message_type 2)
  const realMessages = messages.filter((m) => !m.private && m.message_type !== 2);
  const customerMessages = realMessages.filter((m) => m.message_type === 0);
  const agentReplies = realMessages.filter((m) => m.message_type === 1);

  if (customerMessages.length === 0) {
    console.log(`  ⏭  #${conversationId} — no customer messages, skipping`);
    return;
  }

  // Find the last REAL message (not private note, not activity)
  const lastReal = [...realMessages].sort((a, b) => b.created_at - a.created_at)[0];

  // Only skip if the last real message is a public agent reply
  if (lastReal && lastReal.message_type === 1) {
    console.log(`  ⏭  #${conversationId} — last real message is agent reply, skipping`);
    return;
  }

  console.log(`  ✏️  #${conversationId} | ${name ?? 'Unknown'} | ${customerMessages.length} customer msgs, ${agentReplies.length} public agent replies, ${messages.filter((m) => m.private).length} private notes`);

  // Fetch Shopify data
  let shopifyCustomer: ShopifyCustomer | null = null;
  let orders: ShopifyOrder[] = [];

  const shopifyId = contactMeta?.custom_attributes?.['shopify_customer_id'] as string | undefined;
  if (shopifyId) {
    try {
      orders = await fetchCustomerOrders(Number(shopifyId));
      shopifyCustomer = { id: Number(shopifyId) } as ShopifyCustomer;
    } catch {
      /* continue without */
    }
  }

  if (orders.length === 0 && email) {
    try {
      shopifyCustomer = await searchCustomerByEmail(email);
      if (shopifyCustomer) {
        orders = await fetchCustomerOrders(shopifyCustomer.id);
      }
    } catch {
      /* continue without */
    }
  }

  // Fetch tracking
  let trackingByNumber = new Map<string, TrackingSummary>();
  const trackingNumbers: string[] = [];
  for (const order of orders.slice(0, 3)) {
    for (const f of order.fulfillments ?? []) {
      const tn = f.tracking_number || f.tracking_numbers?.[0];
      if (tn && !trackingNumbers.includes(tn)) trackingNumbers.push(tn);
    }
  }
  if (trackingNumbers.length > 0) {
    try {
      trackingByNumber = await getTrackingStatus(trackingNumbers);
    } catch {
      /* continue without */
    }
  }

  // Build context
  const context = buildBulkContext({
    conversation,
    messages,
    customerName: name,
    customerEmail: email,
    shopifyCustomer,
    orders,
    trackingByNumber,
  });

  // Generate draft
  const draft = await generateDraft(CUSTOM_PROMPT, context);
  if (!draft) {
    logger.error(`Failed to generate draft for #${conversationId}`);
    return;
  }

  const noteContent = `AI DRAFT\n---\n${draft}`;

  if (DRY_RUN) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Conversation #${conversationId} | ${name} (${email})`);
    console.log(`${'='.repeat(60)}`);
    console.log(noteContent);
    console.log(`${'='.repeat(60)}\n`);
    return;
  }

  await postPrivateNote(conversationId, noteContent);
  logger.info(`Draft posted to #${conversationId}`);
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

async function processWithConcurrency(
  conversations: ChatwootConversation[],
  limit: number,
): Promise<void> {
  let index = 0;
  const total = conversations.length;

  async function worker(): Promise<void> {
    while (index < total) {
      const current = index++;
      const convo = conversations[current]!;
      try {
        await processConversation(convo);
        console.log(`[${current + 1}/${total}] Done: #${convo.id}`);
      } catch (err) {
        console.error(
          `[${current + 1}/${total}] Error on #${convo.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, total) }, () => worker());
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Bulk Draft Generator');
  console.log('--------------------');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no notes posted)' : 'LIVE (posting private notes)'}`);
  console.log(`Statuses: open${INCLUDE_PENDING ? ' + pending' : ''}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Inbox filter: ${FILTER_INBOX_ID ?? 'all'}`);
  console.log(`After: ${args.after ?? 'all time'}`);
  console.log(`Prompt: ${args.prompt ? 'CLI arg' : args['prompt-file'] ? args['prompt-file'] : 'default responder.txt'}`);
  console.log('');

  const conversations = await fetchAllOpenConversations();
  console.log(`Found ${conversations.length} conversations\n`);

  if (conversations.length === 0) {
    console.log('Nothing to process.');
    return;
  }

  await processWithConcurrency(conversations, CONCURRENCY);

  console.log('\nDone!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

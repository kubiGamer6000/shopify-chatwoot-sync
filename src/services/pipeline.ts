import { env } from '../config/env.js';
import type { AiMode } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  getConversationMessages,
  getConversationDetails,
  getContactConversations,
  postPrivateNote,
  sendOutgoingMessage,
  toggleConversationStatus,
  applyLabels,
} from './chatwootConversation.js';
import { fetchCustomerOrders, searchCustomerByEmail } from './shopify.js';
import { getTrackingStatus } from './tracking.js';
import { checkHardRules } from './hardRules.js';
import { classify } from './classifier.js';
import { generateResponse } from './responder.js';
import { getHandoffTemplate, getIntentTopicLabel } from '../config/templates.js';
import type { PipelineContext } from '../utils/promptBuilder.js';
import type { ChatwootWebhookPayload } from '../types/chatwoot.js';
import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';
import type { TrackingSummary } from '../types/tracking.js';
import type { Classification, AiResponse } from '../types/ai.js';
import { AI_SOLVABLE_INTENTS, CONFIDENCE_THRESHOLD, MAX_AI_TURNS } from '../types/ai.js';

// In-memory turn counter: conversationId → number of bot replies sent
const turnCounter = new Map<number, number>();

export function getTurnCount(conversationId: number): number {
  return turnCounter.get(conversationId) ?? 0;
}

function incrementTurn(conversationId: number): number {
  const current = getTurnCount(conversationId) + 1;
  turnCounter.set(conversationId, current);
  return current;
}

export function clearTurnCount(conversationId: number): void {
  turnCounter.delete(conversationId);
}

export async function handleIncomingMessage(
  payload: ChatwootWebhookPayload,
): Promise<void> {
  const mode = env.aiMode;
  if (mode === 'off') {
    logger.debug('AI pipeline disabled (AI_MODE=off)');
    return;
  }

  const conversationId = payload.conversation.id;
  const contactId = payload.sender.id;
  const contactEmail = payload.sender.email;

  logger.info('Pipeline: processing message', { conversationId, contactId, mode });

  // --- Phase 1: Fetch Chatwoot context (parallel) ---
  const [messagesRes, conversationDetails, contactConversations] = await Promise.all([
    getConversationMessages(conversationId),
    getConversationDetails(conversationId),
    getContactConversations(contactId),
  ]);

  const currentMessages = messagesRes.payload;
  const customerName = conversationDetails.meta?.sender?.name;
  const email = conversationDetails.meta?.sender?.email || contactEmail;

  const incomingCount = currentMessages.filter((m) => m.message_type === 0 && !m.private).length;
  const isNewConversation = incomingCount <= 1;

  // --- Phase 2: Fetch Shopify data ---
  let shopifyCustomer: ShopifyCustomer | null = null;
  let orders: ShopifyOrder[] = [];

  const shopifyCustomerId = conversationDetails.meta?.sender?.custom_attributes?.[
    'shopify_customer_id'
  ] as string | undefined;

  if (shopifyCustomerId) {
    try {
      orders = await fetchCustomerOrders(Number(shopifyCustomerId));
      shopifyCustomer = { id: Number(shopifyCustomerId) } as ShopifyCustomer;
    } catch (err) {
      logger.warn('Failed to fetch orders by Shopify ID', {
        shopifyCustomerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (orders.length === 0 && email) {
    try {
      shopifyCustomer = await searchCustomerByEmail(email);
      if (shopifyCustomer) {
        orders = await fetchCustomerOrders(shopifyCustomer.id);
      }
    } catch (err) {
      logger.warn('Failed to search Shopify customer by email', {
        email,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Phase 2.5: Hard rules check ---
  const hardRuleResult = checkHardRules(orders);
  if (hardRuleResult.triggered) {
    await executeHardRuleAction(conversationId, hardRuleResult, mode);
    return;
  }

  // --- Phase 3: Fetch tracking ---
  let trackingByNumber = new Map<string, TrackingSummary>();
  const trackingNumbers = extractTrackingNumbers(orders);
  if (trackingNumbers.length > 0) {
    try {
      trackingByNumber = await getTrackingStatus(trackingNumbers);
    } catch (err) {
      logger.warn('Failed to fetch tracking status', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Build pipeline context ---
  const ctx: PipelineContext = {
    customerName,
    customerEmail: email,
    shopifyCustomer,
    orders,
    trackingByNumber,
    currentMessages,
    previousConversations: contactConversations,
    conversationId,
    isNewConversation,
    aiTurnCount: getTurnCount(conversationId),
  };

  // --- Phase 4: Classify ---
  const classification = await classify(ctx);
  if (!classification) {
    logger.error('Classification failed, falling back to handoff', { conversationId });
    await executeHandoff(conversationId, 'other', null, 'Classification failed — AI could not process this message.', mode);
    return;
  }

  // --- Phase 5: Route ---
  if (classification.customer_wants_human) {
    await executeHandoff(
      conversationId,
      classification.intent,
      classification,
      'customer_wants_human',
      mode,
    );
    return;
  }

  if (classification.sentiment === 'hostile') {
    await executeHandoff(conversationId, classification.intent, classification, 'hostile_sentiment', mode);
    return;
  }

  if (classification.confidence < CONFIDENCE_THRESHOLD) {
    await executeHandoff(conversationId, 'other', classification, 'low_confidence', mode);
    return;
  }

  const currentTurn = getTurnCount(conversationId);
  if (currentTurn >= MAX_AI_TURNS) {
    await executeHandoff(conversationId, classification.intent, classification, 'max_turns_reached', mode);
    return;
  }

  if (!AI_SOLVABLE_INTENTS.has(classification.intent)) {
    await executeHandoff(conversationId, classification.intent, classification, 'handoff_intent', mode);
    return;
  }

  // --- Phase 6: Generate response ---
  const response = await generateResponse(ctx, classification);
  if (!response) {
    logger.error('Responder failed, falling back to handoff', { conversationId });
    await executeHandoff(conversationId, classification.intent, classification, 'responder_failed', mode);
    return;
  }

  // --- Phase 7: Execute actions ---
  await executeAiResponse(conversationId, classification, response, mode);
}

// ---------------------------------------------------------------------------
// Action executors — these branch on shadow vs. live mode
// ---------------------------------------------------------------------------

async function executeHardRuleAction(
  conversationId: number,
  result: { reason?: string; labels?: string[]; privateNote?: string },
  mode: AiMode,
): Promise<void> {
  if (mode === 'shadow') {
    const note = [
      'SHADOW MODE — Hard Rule Triggered',
      '---',
      result.privateNote ?? '',
      '',
      `WOULD HAVE APPLIED: labels [${(result.labels ?? []).join(', ')}], status → open`,
    ].join('\n');
    await postPrivateNote(conversationId, note);
    return;
  }

  // Live mode
  if (result.privateNote) await postPrivateNote(conversationId, result.privateNote);
  if (result.labels) await applyLabels(conversationId, [...result.labels, 'escalated']);
  await toggleConversationStatus(conversationId, 'open');
}

async function executeHandoff(
  conversationId: number,
  intent: string,
  classification: Classification | null,
  reason: string,
  mode: AiMode,
): Promise<void> {
  const topicLabel = getIntentTopicLabel(intent as import('../types/ai.js').Intent);
  const templateReason = reason === 'customer_wants_human' ? 'customer_wants_human'
    : reason === 'max_turns_reached' ? 'force_handoff'
    : undefined;
  const template = getHandoffTemplate(intent as import('../types/ai.js').Intent, templateReason);

  const noteLines = ['AI HANDOFF NOTE', '---'];
  if (classification) {
    noteLines.push(
      `Intent: ${classification.intent} (confidence: ${classification.confidence.toFixed(2)})`,
      `Sentiment: ${classification.sentiment}`,
      `Escalation reason: ${reason}`,
    );
    if (classification.reasoning) noteLines.push(`Reasoning: ${classification.reasoning}`);
  } else {
    noteLines.push(`Escalation reason: ${reason}`);
  }
  const privateNoteContent = noteLines.join('\n');

  if (mode === 'shadow') {
    const noteParts = [
      'SHADOW MODE — AI Pipeline Result',
      '---',
      classification
        ? `Classification: ${classification.intent} (confidence: ${classification.confidence.toFixed(2)})`
        : 'Classification: FAILED',
      classification ? `Sentiment: ${classification.sentiment}` : '',
      `Route: Handoff (${reason})`,
      '',
    ];
    if (template) {
      noteParts.push('WOULD HAVE SENT TO CUSTOMER:', `"${template}"`, '');
    } else {
      noteParts.push('Customer message: NONE (silent handoff)', '');
    }
    noteParts.push(
      'WOULD HAVE POSTED AS PRIVATE NOTE:',
      privateNoteContent,
      '',
      `WOULD HAVE APPLIED: labels [${topicLabel}, escalated], status → open`,
    );
    await postPrivateNote(conversationId, noteParts.filter(Boolean).join('\n'));
    return;
  }

  // Live mode
  if (template) {
    await sendOutgoingMessage(conversationId, template);
  }
  await postPrivateNote(conversationId, privateNoteContent);
  await applyLabels(conversationId, [topicLabel, 'escalated']);
  await toggleConversationStatus(conversationId, 'open');

  logger.info('Handoff executed', { conversationId, intent, reason, silent: !template });
}

async function executeAiResponse(
  conversationId: number,
  classification: Classification,
  response: AiResponse,
  mode: AiMode,
): Promise<void> {
  const topicLabel = getIntentTopicLabel(classification.intent);
  const turn = incrementTurn(conversationId);

  const privateNoteContent = [
    'AI NOTE',
    '---',
    `Intent: ${classification.intent} (confidence: ${classification.confidence.toFixed(2)})`,
    `Sentiment: ${classification.sentiment} | Turn: ${turn} of ${MAX_AI_TURNS}`,
    '',
    response.private_note,
    response.discount_applied ? 'Discount code SMILE5 offered.' : '',
    response.resolved ? 'Marked as likely resolved.' : '',
  ].filter(Boolean).join('\n');

  if (mode === 'shadow') {
    const note = [
      'SHADOW MODE — AI Pipeline Result',
      '---',
      `Classification: ${classification.intent} (confidence: ${classification.confidence.toFixed(2)})`,
      `Sentiment: ${classification.sentiment}`,
      `Route: AI-solvable → Responder`,
      '',
      'WOULD HAVE SENT TO CUSTOMER:',
      `"${response.customer_reply}"`,
      '',
      'WOULD HAVE POSTED AS PRIVATE NOTE:',
      privateNoteContent,
      '',
      `WOULD HAVE APPLIED: labels [${topicLabel}]${response.resolved ? ', would resolve after 24h silence' : ''}`,
    ].join('\n');
    await postPrivateNote(conversationId, note);
    return;
  }

  // Live mode
  await sendOutgoingMessage(conversationId, response.customer_reply);
  await postPrivateNote(conversationId, privateNoteContent);
  await applyLabels(conversationId, [topicLabel]);

  if (response.resolved) {
    await applyLabels(conversationId, ['ai-resolved']);
  }

  logger.info('AI response sent', {
    conversationId,
    intent: classification.intent,
    turn,
    resolved: response.resolved,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTrackingNumbers(orders: ShopifyOrder[]): string[] {
  const sorted = [...orders].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const numbers: string[] = [];
  const fulfilled = sorted.filter((o) => o.fulfillments && o.fulfillments.length > 0);

  for (const order of fulfilled.slice(0, 2)) {
    for (const f of order.fulfillments ?? []) {
      if (f.tracking_number && !numbers.includes(f.tracking_number)) {
        numbers.push(f.tracking_number);
      } else if (f.tracking_numbers) {
        for (const tn of f.tracking_numbers) {
          if (tn && !numbers.includes(tn)) {
            numbers.push(tn);
          }
        }
      }
    }
  }

  return numbers;
}

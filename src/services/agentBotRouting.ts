/**
 * Pure routing decision for the AgentBot: given the classifier's verdict and a
 * few deterministic facts, decide what happens to the conversation. Shared by
 * the live pipeline and the admin prompt tester so both always agree.
 */
import type { AiConfig } from '../types/config.js';
import type { Classification, ClassificationLabel } from './classifier.js';

export type RouteKind =
  /** The responder agent answers (and may still hand off itself). */
  | 'respond'
  /** Hand off to a human with an intent-specific acknowledgement. */
  | 'acknowledge'
  /** Hand off to a human without any customer-facing message. */
  | 'handoff'
  /** Nothing needs a reply (auto-reply, spam, "thanks"): resolve silently. */
  | 'close';

export interface RouteDecision {
  route: RouteKind;
  intents: ClassificationLabel[];
  reason: string | null;
}

const NON_CUSTOMER_INTENTS = new Set<string>(['business', 'other']);

export function decideRoute(params: {
  classification: Classification | null;
  cfg: Pick<AiConfig, 'autoRespondLabels' | 'acknowledgeLabels'>;
  /** Every unanswered customer message is machine-generated (headers/subject). */
  autoReplyDetected: boolean;
  /** We have already replied publicly in this conversation. */
  hasPublicReply: boolean;
  /** The contact matched a Shopify customer with orders (never spam). */
  customerHasOrders: boolean;
  /** The conversation began with our outbound email (proactive outreach). */
  startedByUs: boolean;
}): RouteDecision {
  const decision = baseRoute(params);
  // Replies to our own outreach (address checks, customs IDs) only make sense
  // with the outreach context a human has, and bulk outreach threads can mix
  // customers: never auto-answer or silently close them.
  if (params.startedByUs && (decision.route === 'respond' || decision.route === 'close') && !params.autoReplyDetected && !params.classification?.isAutoReply) {
    return { ...decision, route: 'acknowledge', reason: 'reply to our outreach email' };
  }
  return decision;
}

function baseRoute(params: Parameters<typeof decideRoute>[0]): RouteDecision {
  const { classification: c, cfg, autoReplyDetected, hasPublicReply, customerHasOrders } = params;

  if (autoReplyDetected) {
    return { route: 'close', intents: [], reason: 'automatic reply (email headers/subject)' };
  }
  // Unclear cases still get a generic acknowledgement: a person will look.
  if (!c) return { route: 'acknowledge', intents: [], reason: 'classification failed' };

  const intents = c.currentIntents.length > 0 ? c.currentIntents : c.labels;

  if (c.isAutoReply) {
    return { route: 'close', intents, reason: 'automatic reply (classifier)' };
  }
  // Only close as spam when nothing customer-related is in play.
  if (c.isSpam && !customerHasOrders && intents.every((i) => NON_CUSTOMER_INTENTS.has(i))) {
    return { route: 'close', intents, reason: 'unsolicited outreach' };
  }
  if (!c.needsReply) {
    // A closing "thanks" after our reply needs nothing. A first message that
    // needs no reply is unusual, so a human takes a look.
    return hasPublicReply
      ? { route: 'close', intents, reason: 'no reply needed' }
      : { route: 'handoff', intents, reason: 'no reply needed, but nothing answered yet' };
  }
  if (intents.length === 0) {
    return { route: 'acknowledge', intents, reason: 'no intents identified' };
  }

  const autoRespond = new Set(cfg.autoRespondLabels);
  const needsHuman = intents.filter((i) => !autoRespond.has(i));
  if (needsHuman.length === 0) return { route: 'respond', intents, reason: null };

  const acknowledge = new Set(cfg.acknowledgeLabels);
  const reason = `needs a human: ${needsHuman.join(', ')}`;
  return needsHuman.every((i) => acknowledge.has(i))
    ? { route: 'acknowledge', intents, reason }
    : { route: 'handoff', intents, reason };
}

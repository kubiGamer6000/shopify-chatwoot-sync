import type { Intent } from '../types/ai.js';

const HANDOFF_TEMPLATES: Record<string, string> = {
  change_address:
    'Of course! Let me forward your request to one of our specialists who can update your delivery details. They\'ll get back to you shortly!',

  customer_wants_human:
    'Of course! Let me connect you with one of our team members right away. They\'ll be with you shortly!',

  force_handoff:
    'Let me connect you with one of our specialists who can help you further. They\'ll follow up with you shortly!',
};

/**
 * Returns a customer-facing handoff message, or null for silent handoffs.
 * Only `change_address`, `customer_wants_human`, and `force_handoff` (max turns)
 * produce a customer message. All other handoffs are silent — just private note + escalate.
 */
export function getHandoffTemplate(intent: Intent, reason?: 'customer_wants_human' | 'force_handoff'): string | null {
  if (reason) return HANDOFF_TEMPLATES[reason] ?? null;
  return HANDOFF_TEMPLATES[intent] ?? null;
}

export function getIntentTopicLabel(intent: Intent): string {
  const INTENT_TO_LABEL: Record<Intent, string> = {
    order_status: 'order-status',
    subscription_cancel: 'subscription',
    subscription_cancel_and_refund: 'subscription',
    subscription_change: 'subscription',
    refund_request: 'refund',
    change_address: 'change-address',
    product_not_received: 'product-not-received',
    product_defect: 'product-defect',
    other: 'other',
  };
  return INTENT_TO_LABEL[intent];
}

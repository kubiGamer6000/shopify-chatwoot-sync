import type { Intent } from '../types/ai.js';

const HANDOFF_TEMPLATES: Record<string, string> = {
  refund_request:
    'Thank you for reaching out. Let me connect you with one of our specialists who can assist you with this right away. They\'ll be with you shortly!',

  change_address:
    'Of course! Let me forward your request to one of our specialists who can update your delivery details. They\'ll get back to you shortly!',

  product_not_received:
    'I\'m sorry to hear that. Let me connect you with one of our specialists right away to look into this for you. They\'ll follow up shortly!',

  product_defect:
    'I\'m sorry to hear your product arrived damaged. Let me connect you with one of our specialists who can help resolve this for you right away.',

  subscription_cancel_and_refund:
    'Thank you for reaching out. Let me connect you with one of our specialists who can help with your subscription and order. They\'ll be with you shortly!',

  other:
    'Thank you for reaching out! Let me forward your message to one of our specialists who can best assist you. They\'ll get back to you shortly!',

  customer_wants_human:
    'Of course! Let me connect you with one of our team members right away. They\'ll be with you shortly!',

  force_handoff:
    'Let me connect you with one of our specialists who can help you further. They\'ll follow up with you shortly!',
};

export function getHandoffTemplate(intent: Intent, reason?: 'customer_wants_human' | 'force_handoff'): string {
  if (reason) return HANDOFF_TEMPLATES[reason] ?? HANDOFF_TEMPLATES['other']!;
  return HANDOFF_TEMPLATES[intent] ?? HANDOFF_TEMPLATES['other']!;
}

export function getIntentTopicLabel(intent: Intent): string {
  const INTENT_TO_LABEL: Record<Intent, string> = {
    order_status: 'order-status',
    subscription_cancel: 'subscription',
    subscription_cancel_and_refund: 'subscription',
    subscription_change: 'subscription',
    refund_request: 'refund',
    change_address: 'change-address',
    product_not_received: 'product-issue',
    product_defect: 'product-issue',
    other: 'other',
  };
  return INTENT_TO_LABEL[intent];
}

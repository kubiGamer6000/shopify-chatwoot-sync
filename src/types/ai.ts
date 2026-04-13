import { z } from 'zod';

export const INTENTS = [
  'order_status',
  'subscription_cancel',
  'subscription_cancel_and_refund',
  'subscription_change',
  'refund_request',
  'change_address',
  'product_not_received',
  'product_defect',
  'business',
  'other',
] as const;

export type Intent = (typeof INTENTS)[number];

export const AI_SOLVABLE_INTENTS: ReadonlySet<Intent> = new Set([
  'order_status',
  'subscription_cancel',
  'subscription_change',
]);

export const HANDOFF_INTENTS: ReadonlySet<Intent> = new Set([
  'subscription_cancel_and_refund',
  'refund_request',
  'change_address',
  'product_not_received',
  'product_defect',
  'business',
  'other',
]);

export const SENTIMENTS = ['positive', 'neutral', 'negative', 'hostile'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const ClassificationSchema = z.object({
  intents: z.array(z.enum(INTENTS)).min(1),
  primary_intent: z.enum(INTENTS),
  sentiment: z.enum(SENTIMENTS),
  confidence: z.number(),
  customer_wants_human: z.boolean(),
  involves_refund: z.boolean(),
  reasoning: z.string(),
});

export type Classification = z.infer<typeof ClassificationSchema>;

export const ResponseSchema = z.object({
  customer_reply: z.string(),
  private_note: z.string(),
  resolved: z.boolean(),
  discount_applied: z.boolean(),
});

export type AiResponse = z.infer<typeof ResponseSchema>;

export const MAX_AI_TURNS = 3;
export const CONFIDENCE_THRESHOLD = 0.5;

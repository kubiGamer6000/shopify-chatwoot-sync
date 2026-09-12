/** Claude `output_config.effort` levels (thinking depth / token spend). */
export const AI_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORT_LEVELS)[number];

/**
 * Acknowledgement rollout: `off` = legacy handoff only; `shadow` = legacy
 * handoff, plus the acknowledgement is generated and recorded (never sent);
 * `live` = the acknowledgement is sent to the customer on handoff.
 */
export const ACKNOWLEDGE_MODES = ['off', 'shadow', 'live'] as const;
export type AcknowledgeMode = (typeof ACKNOWLEDGE_MODES)[number];

/** Full, resolved AI configuration used across the AI services. */
export interface AiConfig {
  // Prompts
  draftSystemPrompt: string;
  responderSystemPrompt: string;
  classifierSystemPrompt: string;
  summarySystemPrompt: string;
  resolverSystemPromptTemplate: string;
  holdingSystemPrompt: string;
  acknowledgeSystemPrompt: string;
  // Models
  draftModel: string;
  responderModel: string;
  classifierModel: string;
  summaryModel: string;
  resolverModel: string;
  holdingModel: string;
  acknowledgeModel: string;
  // Effort (adaptive thinking depth) per task
  draftEffort: AiEffort;
  responderEffort: AiEffort;
  classifierEffort: AiEffort;
  summaryEffort: AiEffort;
  resolverEffort: AiEffort;
  holdingEffort: AiEffort;
  acknowledgeEffort: AiEffort;
  // Routing / behaviour
  autoRespondLabels: string[];
  backfillAutoRespondLabels: string[];
  holdingReplyEnabled: boolean;
  acknowledgeMode: AcknowledgeMode;
  /** Intents that get an acknowledgement on handoff (others hand off silently). */
  acknowledgeLabels: string[];
  // AgentBot safety / pacing
  /** Wait this long after a message so bursts are handled as one. */
  agentBotDebounceSeconds: number;
  /** Max bot-sent public messages per conversation in 24h; beyond, hand off silently. */
  maxBotRepliesPer24h: number;
  pendingSweepEnabled: boolean;
  pendingSweepIntervalMinutes: number;
  /** An unanswered customer message must be at least this old to be swept. */
  pendingSweepMinAgeMinutes: number;
  /** Up to this age the bot processes it; older ones are opened for a human. */
  pendingSweepReplyMaxAgeHours: number;
  /** Older than this, the sweeper leaves the conversation alone. */
  pendingSweepMaxAgeDays: number;
  // Numeric knobs
  draftMaxTokens: number;
  classifierMaxTokens: number;
  summaryMaxTokens: number;
  holdingMaxTokens: number;
  acknowledgeMaxTokens: number;
  responderMaxTokens: number;
  responderMaxIterations: number;
  resolverMaxTokens: number;
  resolverMaxIterations: number;
}

/** Partial overrides persisted in Firestore (`systemConfig/ai`). */
export type AiConfigOverrides = Partial<AiConfig>;

/** Metadata stored alongside the overrides document. */
export interface AiConfigMeta {
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface StoredAiConfigDoc {
  config: AiConfigOverrides;
  meta: AiConfigMeta;
}

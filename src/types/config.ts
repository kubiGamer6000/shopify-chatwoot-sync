/** Claude `output_config.effort` levels (thinking depth / token spend). */
export const AI_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORT_LEVELS)[number];

/** Full, resolved AI configuration used across the AI services. */
export interface AiConfig {
  // Prompts
  draftSystemPrompt: string;
  responderSystemPrompt: string;
  classifierSystemPrompt: string;
  summarySystemPrompt: string;
  resolverSystemPromptTemplate: string;
  holdingSystemPrompt: string;
  // Models
  draftModel: string;
  responderModel: string;
  classifierModel: string;
  summaryModel: string;
  resolverModel: string;
  holdingModel: string;
  // Effort (adaptive thinking depth) per task
  draftEffort: AiEffort;
  responderEffort: AiEffort;
  classifierEffort: AiEffort;
  summaryEffort: AiEffort;
  resolverEffort: AiEffort;
  holdingEffort: AiEffort;
  // Routing / behaviour
  autoRespondLabels: string[];
  backfillAutoRespondLabels: string[];
  holdingReplyEnabled: boolean;
  // Numeric knobs
  draftMaxTokens: number;
  classifierMaxTokens: number;
  summaryMaxTokens: number;
  holdingMaxTokens: number;
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

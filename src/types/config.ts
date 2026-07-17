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

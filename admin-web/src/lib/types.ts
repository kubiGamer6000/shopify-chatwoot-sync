export interface AiConfig {
  draftSystemPrompt: string;
  responderSystemPrompt: string;
  classifierSystemPrompt: string;
  summarySystemPrompt: string;
  resolverSystemPromptTemplate: string;
  holdingSystemPrompt: string;
  draftModel: string;
  responderModel: string;
  classifierModel: string;
  summaryModel: string;
  resolverModel: string;
  holdingModel: string;
  autoRespondLabels: string[];
  backfillAutoRespondLabels: string[];
  holdingReplyEnabled: boolean;
  draftMaxTokens: number;
  classifierMaxTokens: number;
  summaryMaxTokens: number;
  holdingMaxTokens: number;
  responderMaxTokens: number;
  responderMaxIterations: number;
  resolverMaxTokens: number;
  resolverMaxIterations: number;
}

export type AiConfigKey = keyof AiConfig;
export type AiConfigOverrides = Partial<AiConfig>;

export interface ConfigResponse {
  defaults: AiConfig;
  overrides: AiConfigOverrides;
  effective: AiConfig;
  meta: { updatedBy: string | null; updatedAt: string | null };
}

export interface ConfigVersion {
  config: AiConfigOverrides;
  updatedBy: string | null;
  updatedAt: string | null;
  recordedAt: number;
}

export type UserRole = 'admin' | 'pending';

export interface MeResponse {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
}

export interface UserRecord {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ReplayKind = 'draft' | 'classifier' | 'responder';

export interface ReplayImage {
  mediaType: string;
  bytes: number;
  dataUrl: string;
}

export interface ReplayResult {
  kind: ReplayKind;
  conversationId: number;
  contactId: number | null;
  email: string | null;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  images: ReplayImage[];
  context: Record<string, unknown>;
  output: Record<string, unknown>;
}

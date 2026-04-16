import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const required = [
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
  'CHATWOOT_BASE_URL',
  'CHATWOOT_API_TOKEN',
  'CHATWOOT_ACCOUNT_ID',
  'ANTHROPIC_API_KEY',
  'SEVENTEENTRACK_API_KEY',
] as const;

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export type AiMode = 'shadow' | 'live' | 'off';

function parseAiMode(value: string | undefined): AiMode {
  if (value === 'live' || value === 'off') return value;
  return 'shadow';
}

function loadPromptFile(filename: string): string {
  try {
    const promptPath = resolve(__dirname, '..', '..', 'src', 'config', 'prompts', filename);
    return readFileSync(promptPath, 'utf-8').trim();
  } catch {
    return '';
  }
}

export const env = {
  shopifyStoreDomain: process.env.SHOPIFY_STORE_DOMAIN!,
  shopifyClientId: process.env.SHOPIFY_CLIENT_ID!,
  shopifyClientSecret: process.env.SHOPIFY_CLIENT_SECRET!,
  chatwootBaseUrl: process.env.CHATWOOT_BASE_URL!,
  chatwootApiToken: process.env.CHATWOOT_API_TOKEN!,
  chatwootAccountId: process.env.CHATWOOT_ACCOUNT_ID!,
  chatwootInboxId: process.env.CHATWOOT_INBOX_ID || '',
  chatwootBotToken: process.env.CHATWOOT_BOT_TOKEN || '',
  syncApiKey: process.env.SYNC_API_KEY || '',
  syncIntervalHours: Number(process.env.SYNC_INTERVAL_HOURS) || 0,
  port: Number(process.env.PORT) || 8080,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6-20260320',
  classifierPrompt: process.env.CLASSIFIER_PROMPT || loadPromptFile('classifier.txt'),
  responderPrompt: process.env.RESPONDER_PROMPT || loadPromptFile('responder.txt'),
  handoffDraftPrompt: process.env.HANDOFF_DRAFT_PROMPT || loadPromptFile('handoff-draft.txt'),
  seventeentrackApiKey: process.env.SEVENTEENTRACK_API_KEY!,
  chatwootWebhookSecret: process.env.CHATWOOT_WEBHOOK_SECRET || '',
  aiMode: parseAiMode(process.env.AI_MODE),
};

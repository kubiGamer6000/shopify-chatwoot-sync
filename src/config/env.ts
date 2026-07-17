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
  'SKIO_API_KEY',
] as const;

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

function loadPromptFile(fileName: string): string {
  try {
    // Works from both src/ (dev with tsx) and dist/ (production build)
    const promptPath = resolve(__dirname, '..', '..', 'src', 'config', fileName);
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
  syncApiKey: process.env.SYNC_API_KEY || '',
  syncIntervalHours: Number(process.env.SYNC_INTERVAL_HOURS) || 0,
  port: Number(process.env.PORT) || 8080,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
  claudeSystemPrompt: process.env.CLAUDE_SYSTEM_PROMPT || loadPromptFile('systemPrompt.txt'),
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
  // Cheaper model for the per-message conversation classifier (labels/routing).
  claudeClassifierModel: process.env.CLAUDE_CLASSIFIER_MODEL || 'claude-haiku-4-5',
  // System prompt for the autonomous AgentBot responder (sent directly to customers).
  responderSystemPrompt:
    process.env.CLAUDE_RESPONDER_PROMPT || loadPromptFile('responderPrompt.txt'),
  // Optional shared secret for the AgentBot webhook (?secret=... query param).
  agentBotWebhookSecret: process.env.CHATWOOT_AGENT_BOT_SECRET || '',
  // When false, escalations send NO holding reply to the customer — the bot just
  // hands the conversation off to a human (sets it open) and generates a draft.
  // Defaults to true. Set AGENT_BOT_HOLDING_REPLY=false to disable.
  agentBotHoldingReplyEnabled:
    (process.env.AGENT_BOT_HOLDING_REPLY || 'true').toLowerCase() !== 'false',
  seventeentrackApiKey: process.env.SEVENTEENTRACK_API_KEY!,
  chatwootWebhookSecret: process.env.CHATWOOT_WEBHOOK_SECRET || '',
  skioApiKey: process.env.SKIO_API_KEY!,
  dashboardAppToken: process.env.DASHBOARD_APP_TOKEN || '',
  firebaseServiceAccountBase64: process.env.FIREBASE_BASE64_SERVICE_ACCOUNT || '',
  // Comma-separated Google account emails that are always admins in the Admin
  // Control Dashboard. Bootstraps the first admin; they can then approve others.
  adminBootstrapEmails: (process.env.ADMIN_BOOTSTRAP_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
};

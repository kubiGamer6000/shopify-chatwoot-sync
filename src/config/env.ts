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
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-5',
  // Model for the per-message conversation classifier (labels/routing) and
  // holding replies.
  claudeClassifierModel: process.env.CLAUDE_CLASSIFIER_MODEL || 'claude-sonnet-5',
  // System prompt for the autonomous AgentBot responder (sent directly to customers).
  responderSystemPrompt:
    process.env.CLAUDE_RESPONDER_PROMPT || loadPromptFile('responderPrompt.txt'),
  // System prompt for intent-specific acknowledgements sent on handoff.
  acknowledgeSystemPrompt:
    process.env.CLAUDE_ACKNOWLEDGE_PROMPT || loadPromptFile('acknowledgePrompt.txt'),
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

  // --- Security hardening (see docs/security.md) ---

  // Secret for signing agent sessions and agent-confirmed contact links. When
  // unset, a key is derived from CHATWOOT_API_TOKEN (so the app keeps working),
  // but setting a dedicated random value is strongly recommended.
  appSessionSecret: process.env.APP_SESSION_SECRET || '',
  // Transition only: lets the old `/app?token=<DASHBOARD_APP_TOKEN>` URL keep
  // working. Default OFF. Turn on only while the Chatwoot Dashboard App URL is
  // being switched, then turn off and rotate DASHBOARD_APP_TOKEN.
  legacyDashboardTokenEnabled: flag(process.env.LEGACY_DASHBOARD_TOKEN_ENABLED, false),
  // Chatwoot webhook HMAC secrets (the "Secret" Chatwoot shows for the account
  // webhook / agent bot). Verified against X-Chatwoot-Signature.
  chatwootWebhookSigningSecret: process.env.CHATWOOT_WEBHOOK_SIGNING_SECRET || '',
  chatwootAgentBotSigningSecret: process.env.CHATWOOT_AGENT_BOT_SIGNING_SECRET || '',
  // Transition only: accept the old `?secret=` query string when no signing
  // secret is configured (constant-time compare). Default OFF.
  legacyWebhookQuerySecretEnabled: flag(process.env.LEGACY_WEBHOOK_QUERY_SECRET_ENABLED, false),
  // Optional Slack-compatible incoming webhook URL for operational alerts
  // (dedupe store down, audit writes failing, ...). Alerts are always logged.
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || '',
};

function flag(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

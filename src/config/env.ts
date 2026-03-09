import 'dotenv/config';

const required = [
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
  'CHATWOOT_BASE_URL',
  'CHATWOOT_API_TOKEN',
  'CHATWOOT_ACCOUNT_ID',
] as const;

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
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
};

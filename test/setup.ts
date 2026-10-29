/**
 * Test bootstrap (loaded with `--import` before any test file): dummy env so
 * src/config/env.ts loads, and a fake axios adapter so NO test can reach a
 * real service. Firestore is left unconfigured (getDb() returns null).
 */
import axios from 'axios';
import { fakeAdapter } from './helpers/fakeHttp.js';

const dummy: Record<string, string> = {
  SHOPIFY_STORE_DOMAIN: 'test-store.myshopify.com',
  SHOPIFY_CLIENT_ID: 'test-client',
  SHOPIFY_CLIENT_SECRET: 'test-shopify-secret',
  CHATWOOT_BASE_URL: 'https://chatwoot.test',
  CHATWOOT_API_TOKEN: 'test-chatwoot-token',
  CHATWOOT_ACCOUNT_ID: '7',
  ANTHROPIC_API_KEY: 'test-anthropic',
  SEVENTEENTRACK_API_KEY: 'test-17track',
  SKIO_API_KEY: 'test-skio',
  APP_SESSION_SECRET: 'test-session-secret',
  SYNC_API_KEY: 'test-sync-key',
};
for (const [k, v] of Object.entries(dummy)) process.env[k] = v;
for (const k of [
  'FIREBASE_BASE64_SERVICE_ACCOUNT',
  'DASHBOARD_APP_TOKEN',
  'LEGACY_DASHBOARD_TOKEN_ENABLED',
  'CHATWOOT_WEBHOOK_SECRET',
  'CHATWOOT_AGENT_BOT_SECRET',
  'CHATWOOT_WEBHOOK_SIGNING_SECRET',
  'CHATWOOT_AGENT_BOT_SIGNING_SECRET',
  'LEGACY_WEBHOOK_QUERY_SECRET_ENABLED',
  'ALERT_WEBHOOK_URL',
]) {
  delete process.env[k];
}
process.env.DOTENV_CONFIG_PATH = '/nonexistent/.env';

axios.defaults.adapter = fakeAdapter;

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { env, assertSecuritySecrets } from '../src/config/env.js';

const original = { ...env };
const originalMode = process.env.NODE_ENV;
afterEach(() => {
  Object.assign(env, original);
  process.env.NODE_ENV = originalMode;
});

test('startup fails in production without dedicated, distinct secrets (no fallback)', () => {
  process.env.NODE_ENV = 'production';
  env.linkConfirmationSecret = '';
  assert.throws(() => assertSecuritySecrets(), /LINK_CONFIRMATION_SECRET is not set/);
  env.linkConfirmationSecret = env.appSessionSecret;
  assert.throws(() => assertSecuritySecrets(), /must differ/);
  env.linkConfirmationSecret = 'short';
  assert.throws(() => assertSecuritySecrets(), /at least 32/);
  env.linkConfirmationSecret = original.linkConfirmationSecret;
  assert.doesNotThrow(() => assertSecuritySecrets());
});

test('an unset NODE_ENV counts as production', () => {
  delete process.env.NODE_ENV;
  env.appSessionSecret = '';
  assert.throws(() => assertSecuritySecrets(), /APP_SESSION_SECRET/);
});

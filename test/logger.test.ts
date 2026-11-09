import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/utils/logger.js';

test('logs never contain emails or secret values', () => {
  const out = JSON.stringify(
    redact({ email: 'anna@example.com', note: 'from bob@example.org', apiKey: 'k', token: 't', inputTokens: 5, nested: { secret: 's' } }),
  );
  assert.doesNotMatch(out, /anna@example\.com|bob@example\.org/);
  assert.doesNotMatch(out, /"apiKey":"k"|"token":"t"|"secret":"s"/);
  assert.match(out, /"inputTokens":5/);
});

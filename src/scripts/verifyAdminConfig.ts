/**
 * Read-only smoke test for the admin AI config layer:
 *  - Firestore connectivity
 *  - getDefaultAiConfig() shape
 *  - getAiConfig() falls back to defaults when no override doc is present
 *  - mergeAiConfig() per-field fallback contract (empty/invalid -> default)
 *
 * Does NOT write anything (no config saves), so it's safe against a live store.
 * Run: npx tsx src/scripts/verifyAdminConfig.ts
 */
import { isFirestoreEnabled } from '../services/firestore.js';
import {
  getDefaultAiConfig,
  getStoredOverrides,
  getAiConfig,
  mergeAiConfig,
} from '../services/appConfig.js';

function assert(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log('--- Firestore ---');
  console.log('enabled:', isFirestoreEnabled());

  console.log('\n--- Defaults ---');
  const defaults = getDefaultAiConfig();
  const keys = Object.keys(defaults);
  console.log('field count:', keys.length);
  assert('defaults has draft prompt', defaults.draftSystemPrompt.length > 0);
  assert('defaults has classifier prompt', defaults.classifierSystemPrompt.length > 0);
  assert('resolver template has {{email}}', defaults.resolverSystemPromptTemplate.includes('{{email}}'));
  assert('autoRespondLabels non-empty', defaults.autoRespondLabels.length > 0);

  console.log('\n--- Stored overrides ---');
  const { config: overrides, meta } = await getStoredOverrides();
  console.log('override keys:', Object.keys(overrides));
  console.log('meta:', meta);

  console.log('\n--- Effective config (fallback) ---');
  const effective = await getAiConfig();
  assert('effective has all fields', Object.keys(effective).length === keys.length);
  if (Object.keys(overrides).length === 0) {
    const same = JSON.stringify(effective) === JSON.stringify(defaults);
    assert('no overrides -> effective === defaults', same);
  } else {
    console.log('(store has overrides; skipping strict equality check)');
  }

  console.log('\n--- mergeAiConfig per-field rules ---');
  const merged = mergeAiConfig(defaults, {
    draftModel: 'test-model-xyz', // valid string -> applied
    draftMaxTokens: 0, // invalid (<=0) -> ignored
    classifierMaxTokens: 999, // valid number -> applied
    holdingReplyEnabled: !defaults.holdingReplyEnabled, // boolean -> applied
    autoRespondLabels: [], // empty array -> ignored
    responderSystemPrompt: '   ', // whitespace -> ignored
  });
  assert('valid string override applied', merged.draftModel === 'test-model-xyz');
  assert('zero number override ignored', merged.draftMaxTokens === defaults.draftMaxTokens);
  assert('valid number override applied', merged.classifierMaxTokens === 999);
  assert('boolean override applied', merged.holdingReplyEnabled === !defaults.holdingReplyEnabled);
  assert('empty array override ignored', merged.autoRespondLabels.length === defaults.autoRespondLabels.length);
  assert('whitespace string override ignored', merged.responderSystemPrompt === defaults.responderSystemPrompt);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('verifyAdminConfig failed:', err);
  process.exit(1);
});

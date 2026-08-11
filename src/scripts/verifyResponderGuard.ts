/**
 * Verifies the AgentBot customer-safety guard: internal reasoning, prompt
 * scaffolding and agent notes must never survive into a sent reply, while
 * ordinary replies must pass untouched.
 *
 * Pure functions only — no credentials, no network:
 *
 *   npx tsx src/scripts/verifyResponderGuard.ts
 */
import {
  vetResponderReply,
  vetHoldingReply,
  RESPONDER_SIGNATURE,
} from '../utils/responderFormat.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** The exact leak from conversation #7775: reasoning followed by the reply. */
const LEAK_7775 = `Looking at this conversation, Lars is asking two things: (1) where is his order, and (2) he wants to cancel his subscription. I can handle both of these — order status is Case 2, and subscription cancellation is Case 1.

For the order: it's fulfilled, in transit, cleared customs in Helsinki (HEL) on Aug 6. Not delivered yet, no issues flagged.

For the subscription cancellation: this is his first message in this conversation asking to cancel, so I send the self-service link only (Step 1). I should not offer to do it for him.

Hi Lars,

Your order #26736 has shipped and is currently on its way to you. It cleared customs in Helsinki on August 6th, so it should be with you very soon. You should have received a tracking confirmation by email, so please check your spam folder as well.

Regarding your subscription, you can cancel it easily by logging into your account using the same email address you used for your purchase: https://scandigum.com/a/account/login`;

const CLEAN_REPLY = `Hi Lars,

Your order #26736 has shipped and is on its way to you. It cleared customs in Helsinki on August 6th, so it should be with you very soon. You should have received a tracking confirmation by email, so please check your spam folder as well.

Regarding your subscription, you can cancel it by logging into your account with the same email you used for your purchase: https://scandigum.com/a/account/login`;

function main() {
  console.log('\n=== 1. The #7775 leak ===');
  const leak = vetResponderReply(LEAK_7775);
  check('reasoning preamble is detected and removed', leak.strippedPreamble);
  check('the salvaged reply is safe to send', leak.ok, leak.violations.join(', '));
  check(
    'no reasoning survives into the sent message',
    !/Looking at this conversation|Case 2|Step 1|I should not/i.test(leak.content),
  );
  check(
    'the customer-facing reply is preserved',
    leak.content.includes('#26736') && leak.content.includes('scandigum.com/a/account/login'),
  );
  check('signature is appended once', leak.content.endsWith(RESPONDER_SIGNATURE));

  console.log('\n=== 2. Reasoning that cannot be salvaged is blocked ===');
  const blocked: [string, string][] = [
    ['no greeting to cut back to', 'The customer is asking about their order, which is in transit. I will let them know it has shipped.'],
    ['reasoning after the reply', 'Hi Lars,\n\nYour order has shipped and is on its way.\n\nNote to agent: check whether this is Case 2 before resolving.'],
    ['prompt scaffolding echoed', 'Hi Lars,\n\n--- ORDER HISTORY ---\n#26736 fulfilled'],
    ['pipeline vocabulary', 'Hi Lars,\n\nI have escalated this to a human agent who will review the sub-cancel label.'],
    ['AI self-disclosure', 'Hi Lars,\n\nAs an AI assistant I cannot cancel that for you.'],
    ['empty output', '   '],
  ];
  for (const [name, text] of blocked) {
    const vetted = vetResponderReply(text);
    check(name, !vetted.ok && vetted.content === '', `violations=[${vetted.violations.join(', ')}]`);
  }

  console.log('\n=== 3. Ordinary replies pass untouched ===');
  const clean = vetResponderReply(CLEAN_REPLY);
  check('clean reply is accepted', clean.ok, clean.violations.join(', '));
  check('nothing was stripped', !clean.strippedPreamble);
  check(
    'body is unchanged apart from the signature',
    clean.content === `${CLEAN_REPLY}\n\n${RESPONDER_SIGNATURE}`,
  );

  const withSignoff = vetResponderReply(
    'Hi Lars,\n\nYour order is on its way.\n\nKind regards,\nAndrew',
  );
  check(
    'model sign-off is replaced by the fixed signature',
    withSignoff.ok && withSignoff.content === `Hi Lars,\n\nYour order is on its way.\n\n${RESPONDER_SIGNATURE}`,
  );

  console.log('\n=== 4. Holding replies fall back instead of leaking ===');
  const badHolding = vetHoldingReply(
    'The customer wants a refund, so I will escalate this to a human.',
    'Lars',
  );
  check('unsafe holding reply uses the canned fallback', badHolding.usedFallback);
  check(
    'fallback greets the customer and promises no outcome',
    badHolding.content.startsWith('Hi Lars,') && !/refund/i.test(badHolding.content),
  );

  const goodHolding = vetHoldingReply(
    'Hi Lars,\n\nThanks for reaching out! One of our team members will be in touch shortly to take care of this for you.',
    'Lars',
  );
  check('safe holding reply is kept', !goodHolding.usedFallback);

  const emptyHolding = vetHoldingReply('', 'Lars');
  check('empty generation falls back', emptyHolding.usedFallback);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();

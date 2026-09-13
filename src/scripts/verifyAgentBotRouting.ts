/**
 * Verifies the AgentBot's deterministic pieces: routing decisions and
 * machine-generated message detection. Pure functions only — no credentials,
 * no network:
 *
 *   npx tsx src/scripts/verifyAgentBotRouting.ts
 */
import { decideRoute } from '../services/agentBotRouting.js';
import {
  autoReplySignal,
  onlyAutoRepliesUnanswered,
  startedByUs,
} from '../services/autoReply.js';
import type { Classification } from '../services/classifier.js';
import type { ChatwootMessage } from '../types/chatwoot.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const cfg = {
  autoRespondLabels: ['sub-cancel', 'order-status', 'other'],
  acknowledgeLabels: ['refund', 'missing-packs', 'business', 'other', 'sub-cancel', 'order-status'],
};

function cls(over: Partial<Classification>): Classification {
  return {
    reasoning: '',
    labels: ['other'],
    currentIntents: ['other'],
    needsReply: true,
    isAutoReply: false,
    isSpam: false,
    language: 'English',
    ...over,
  };
}

const facts = { autoReplyDetected: false, hasPublicReply: false, customerHasOrders: true, startedByUs: false, latestHasText: true };

console.log('\n=== Routing ===');
check('order-status answered', decideRoute({ ...facts, cfg, classification: cls({ labels: ['order-status'], currentIntents: ['order-status'] }) }).route === 'respond');
check('refund acknowledged', decideRoute({ ...facts, cfg, classification: cls({ labels: ['refund'], currentIntents: ['refund'] }) }).route === 'acknowledge');
check('stale refund label does not block a new order-status question',
  decideRoute({ ...facts, cfg, classification: cls({ labels: ['refund', 'order-status'], currentIntents: ['order-status'] }) }).route === 'respond');
check('mixed sub-cancel + refund acknowledged', decideRoute({ ...facts, cfg, classification: cls({ labels: ['sub-cancel', 'refund'], currentIntents: ['sub-cancel', 'refund'] }) }).route === 'acknowledge');
check('intent outside both lists is a silent handoff',
  decideRoute({ ...facts, cfg, classification: cls({ labels: ['no-country'], currentIntents: ['no-country'] }) }).route === 'handoff');
check('classification failure acknowledged', decideRoute({ ...facts, cfg, classification: null }).route === 'acknowledge');
check('header auto-reply closed', decideRoute({ ...facts, cfg, autoReplyDetected: true, classification: null }).route === 'close');
check('classifier auto-reply closed', decideRoute({ ...facts, cfg, classification: cls({ isAutoReply: true, needsReply: false }) }).route === 'close');
check('thanks after our reply closed', decideRoute({ ...facts, cfg, hasPublicReply: true, classification: cls({ needsReply: false, currentIntents: [] }) }).route === 'close');
check('no-reply-needed message closed even without an earlier reply', decideRoute({ ...facts, cfg, classification: cls({ needsReply: false, currentIntents: [] }) }).route === 'close');
check('spam without orders closed', decideRoute({ ...facts, cfg, customerHasOrders: false, classification: cls({ isSpam: true, labels: ['business'], currentIntents: ['business'] }) }).route === 'close');
check('spam flag ignored for a customer with orders', decideRoute({ ...facts, cfg, classification: cls({ isSpam: true, labels: ['business'], currentIntents: ['business'] }) }).route !== 'close');
check('spam flag ignored when a customer intent is present', decideRoute({ ...facts, cfg, customerHasOrders: false, classification: cls({ isSpam: true, labels: ['refund'], currentIntents: ['refund'] }) }).route === 'acknowledge');
check('reply to our outreach is never auto-answered', decideRoute({ ...facts, cfg, startedByUs: true, classification: cls({ labels: ['order-status'], currentIntents: ['order-status'] }) }).route === 'acknowledge');
check('closing thanks to our outreach is closed', decideRoute({ ...facts, cfg, startedByUs: true, hasPublicReply: true, classification: cls({ needsReply: false }) }).route === 'close');
check('empty customer message is never auto-answered', decideRoute({ ...facts, cfg, latestHasText: false, classification: cls({ labels: ['sub-cancel'], currentIntents: ['sub-cancel'] }) }).route === 'acknowledge');
check('auto-reply to our outreach still closed', decideRoute({ ...facts, cfg, startedByUs: true, autoReplyDetected: true, classification: null }).route === 'close');

console.log('\n=== Machine-generated detection ===');
let nextId = 1;
function msg(over: Partial<ChatwootMessage> & { email?: Record<string, unknown> }): ChatwootMessage {
  const { email, ...rest } = over;
  return {
    id: nextId++, content: 'hello', account_id: 1, inbox_id: 1, conversation_id: 1,
    message_type: 0, created_at: nextId, updated_at: nextId, private: false, status: 'sent',
    source_id: null, content_type: 'text', sender_type: 'contact', sender_id: 1,
    content_attributes: email ? { email } : {},
    ...rest,
  } as ChatwootMessage;
}

check('chatwoot auto_reply flag', autoReplySignal(msg({ email: { auto_reply: true } })) !== null);
check('Auto-Submitted header', autoReplySignal(msg({ email: { auto_reply: false, headers: { 'Auto-Submitted': 'auto-replied' } } })) !== null);
check('Auto-Submitted: no is human', autoReplySignal(msg({ email: { auto_reply: false, headers: { 'auto-submitted': 'no' } } })) === null);
check('Outlook "Automatic reply:" subject (#11415)', autoReplySignal(msg({ email: { subject: 'Automatic reply: A shipment from order #45211 is on the way' } })) !== null);
check('Danish autosvar subject', autoReplySignal(msg({ email: { subject: 'Autosvar: Din ordre' } })) !== null);
check('bounce subject', autoReplySignal(msg({ email: { subject: 'Delivery Status Notification (Failure)' } })) !== null);
check('our own outbound echo', autoReplySignal(msg({ email: { from: ['hey@scandigum.com'], subject: 'Address Verification Needed' } })) !== null);
check('Gmail reaction body', autoReplySignal(msg({ content: '👍 Anna reacted via Gmail' })) !== null);
check('customer "I was away on holiday" is human (#10899)', autoReplySignal(msg({ content: 'I was away on holiday, can you resend them?', email: { subject: 'Re: my order' } })) === null);
check('subject about absence of tracking is human', autoReplySignal(msg({ email: { subject: 'Absence of tracking for my order' } })) === null);
check('outgoing messages are never auto-replies', autoReplySignal(msg({ message_type: 1, email: { auto_reply: true } })) === null);

const ours = msg({ message_type: 1, content: 'Please confirm your address', sender_type: 'agent' });
const ooo = msg({ email: { subject: 'Out of Office' } });
const real = msg({ content: 'Here is my address' });
check('only auto-replies unanswered', onlyAutoRepliesUnanswered([ours, ooo]).auto === true);
check('a real message alongside an auto-reply needs handling', onlyAutoRepliesUnanswered([ours, ooo, real]).auto === false);
check('nothing unanswered is not auto', onlyAutoRepliesUnanswered([real, ours]).auto === false);
check('startedByUs for outreach threads', startedByUs([ours, real]) === true);
const firstQuestion = msg({ content: 'Where is my order?' });
const ourAnswer = msg({ message_type: 1, content: 'It has shipped', sender_type: 'agent' });
check('startedByUs false for customer-initiated threads', startedByUs([ourAnswer, firstQuestion]) === false);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

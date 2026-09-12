/**
 * Deterministic detection of machine-generated inbound messages (out-of-office
 * notices, auto-acknowledgements, bounces) so the AgentBot never replies to a
 * machine and never loops with another auto-responder.
 *
 * Signals, strongest first:
 * 1. Chatwoot's own `content_attributes.email.auto_reply` flag (header-based).
 * 2. Standard headers: `Auto-Submitted` (anything but "no"), `X-Autoreply`,
 *    `X-Autorespond`, `Precedence: auto_reply|bulk|junk`. (`X-Auto-Response-Suppress`
 *    is deliberately ignored: Outlook sets it on ordinary mail too.)
 * 3. Bounce senders (mailer-daemon / postmaster) and our own domain (bulk
 *    outreach sent To: our inbox echoes back as a "customer" message).
 * 4. Subject prefixes used by mail clients for automatic replies and bounces.
 * 5. A few exact system phrases (bounce diagnostics, Gmail reactions, one-time
 *    codes) at the start of the message.
 *
 * Vacation wording is deliberately NOT used: real customers write "I was away"
 * too. The classifier's `isAutoReply` judgement is the fallback.
 */
import type { ChatwootMessage } from '../types/chatwoot.js';

const AUTO_SUBJECT =
  /^\s*(?:(?:automatic|auto)[\s-]*(?:reply|response|answer)|autoreply|out of (?:the )?office|ooo\b|abwesenheitsnotiz|automatische antwort|autosvar|automatisk svar|frånvaro|fravær|poissa|automaattinen vastaus|réponse automatique|respuesta automática|fuera de la oficina|risposta automatica|fuori sede|automatisch antwoord|afwezig|odpowiedź automatyczna|automatická odpověď|resposta automática|undeliverable|undelivered mail|delivery status notification|mail delivery failed|returned mail|failure notice|automatiskt svar|fraværsmelding)\b/i;

const BOUNCE_SENDER = /\b(?:mailer-daemon|postmaster)@/i;

/** Mail from our own domains is our outbound echoing back, never a customer. */
const OWN_SENDER = /@scandigum\.com\b/i;

/** Exact machine phrases, checked only near the start of the message. */
const SYSTEM_PHRASES = [
  '** address not found **',
  '** recipient inbox full **',
  "wasn't delivered to",
  "couldn't be delivered to",
  'the response from the remote server was',
  'reacted via gmail',
  'is your 6-digit code',
  'do not share this code',
];

function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) return value.map(String).join(', ');
    return value == null ? '' : String(value);
  }
  return null;
}

/** Returns why an inbound message looks machine-generated, or null. */
export function autoReplySignal(message: ChatwootMessage): string | null {
  if (message.message_type !== 0) return null;
  return (
    autoReplySignalFromAttributes(message.content_attributes) ??
    systemPhraseSignal(message.content)
  );
}

/** Strong machine phrases near the start of a message body. */
export function systemPhraseSignal(content: string | null | undefined): string | null {
  const head = (content ?? '').slice(0, 400).toLowerCase();
  const phrase = SYSTEM_PHRASES.find((p) => head.includes(p));
  return phrase ? `system phrase: ${phrase}` : null;
}

/**
 * Same check from a message's `content_attributes` alone (webhook payloads use
 * a different `message_type` encoding than the REST API).
 */
export function autoReplySignalFromAttributes(contentAttributes: unknown): string | null {
  const email = (contentAttributes as Record<string, any> | undefined)?.email;
  if (!email || typeof email !== 'object') return null;

  if (email.auto_reply === true) return 'chatwoot auto_reply flag';

  const headers = email.headers;
  const autoSubmitted = headerValue(headers, 'Auto-Submitted');
  if (autoSubmitted !== null && autoSubmitted.trim().toLowerCase() !== 'no') {
    return `Auto-Submitted: ${autoSubmitted}`;
  }
  for (const name of ['X-Autoreply', 'X-Autorespond']) {
    if (headerValue(headers, name) !== null) return `${name} header`;
  }
  const precedence = headerValue(headers, 'Precedence')?.toLowerCase();
  if (precedence && /auto_reply|bulk|junk/.test(precedence)) return `Precedence: ${precedence}`;

  const from = Array.isArray(email.from) ? email.from.join(', ') : String(email.from ?? '');
  if (BOUNCE_SENDER.test(from)) return 'bounce sender';
  if (OWN_SENDER.test(from)) return 'our own outbound email';

  const subject = typeof email.subject === 'string' ? email.subject : '';
  if (AUTO_SUBJECT.test(subject.replace(/^\s*(?:re|aw|sv|vs|fw|fwd)\s*:\s*/i, ''))) {
    return `subject: ${subject.slice(0, 80)}`;
  }
  return null;
}

/**
 * The customer messages that arrived after our last public reply (the ones the
 * bot is being asked to answer), oldest first.
 */
export function unansweredCustomerMessages(messages: ChatwootMessage[]): ChatwootMessage[] {
  const sorted = [...messages].sort((a, b) => a.created_at - b.created_at);
  let lastOutgoing = -1;
  sorted.forEach((m, i) => {
    if (m.message_type === 1 && !m.private) lastOutgoing = i;
  });
  return sorted.slice(lastOutgoing + 1).filter((m) => m.message_type === 0 && !m.private);
}

/**
 * True when every unanswered customer message is machine-generated (and there
 * is at least one), i.e. there is nothing a human wrote that needs a reply.
 */
export function onlyAutoRepliesUnanswered(messages: ChatwootMessage[]): {
  auto: boolean;
  signals: string[];
} {
  const pending = unansweredCustomerMessages(messages);
  if (pending.length === 0) return { auto: false, signals: [] };
  const signals = pending.map(autoReplySignal);
  return {
    auto: signals.every((s) => s !== null),
    signals: signals.filter((s): s is string => s !== null),
  };
}

/**
 * True when the conversation was started by us (proactive outreach): the first
 * public message is outgoing. Replies to these need a person.
 */
export function startedByUs(messages: ChatwootMessage[]): boolean {
  const first = [...messages]
    .filter((m) => (m.message_type === 0 || m.message_type === 1) && !m.private)
    .sort((a, b) => a.created_at - b.created_at)[0];
  return first?.message_type === 1;
}

/** True when the conversation already has at least one public reply from us. */
export function hasPublicReply(messages: ChatwootMessage[]): boolean {
  return messages.some((m) => m.message_type === 1 && !m.private);
}

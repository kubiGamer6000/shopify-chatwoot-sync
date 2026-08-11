/** Appended to every autonomous AgentBot reply sent to the customer. */
export const RESPONDER_SIGNATURE = 'Kind regards,\nScandi Support Team';

/**
 * Strips a trailing sign-off the model may have included despite instructions.
 */
function stripTrailingSignature(body: string): string {
  return body
    .replace(
      /\n*(Kind regards|Best regards|Warm regards|Thanks|Regards)[,\s]*(\n(?:Andrew|Scandi Support(?: Team)?).*)*$/i,
      '',
    )
    .trim();
}

/**
 * Formats an AgentBot reply body for sending: trims the model output, strips any
 * accidental sign-off, and appends the fixed signature block.
 *
 * This only formats — it does NOT vet the text. Anything that originates from a
 * model and is sent to a customer must go through `vetResponderReply` /
 * `vetHoldingReply` first.
 */
export function formatResponderMessage(body: string): string {
  const trimmed = stripTrailingSignature(body.trim());
  return `${trimmed}\n\n${RESPONDER_SIGNATURE}`;
}

/**
 * Phrases that belong to the model's own deliberation, to our prompt
 * scaffolding, or to agent-only notes, and never to a reply written for a
 * customer. A single hit disqualifies the text from being sent.
 *
 * Deliberately broad: a false positive costs one escalation to a human, while a
 * false negative means internal reasoning reaches the customer (conversation
 * #7775).
 */
const INTERNAL_MARKERS: readonly { id: string; pattern: RegExp }[] = [
  {
    id: 'deliberation',
    pattern:
      /\b(?:looking at (?:this|the) (?:conversation|message|context|order|thread)|based on (?:the|my) (?:context|conversation|instructions|prompt)|let me (?:check|look|see|think|start|handle)|i(?:'ll| will| should| need to| am going to| can) (?:handle|escalate|reply|respond|send|check|use|call|treat|go with)|two things)\b/i,
  },
  {
    id: 'third-person-customer',
    pattern:
      /\bthe customer(?:'s)? (?:is|was|has|wants|needs|asked|asks|says|said|claims|mentioned)\b|\b(?:is|are|was|were) asking\b/i,
  },
  {
    id: 'playbook-reference',
    pattern:
      /\bcase\s*[0-9]\b|\bstep\s*[0-9]\b|\bsystem prompt\b|\b(?:my|the) instructions\b|\bper the (?:prompt|instructions|playbook)\b/i,
  },
  {
    id: 'pipeline-vocabulary',
    pattern:
      /\b(?:escalat(?:e|es|ed|ing|ion)|holding reply|classif(?:y|ies|ied|ication)|routing label|send_reply|escalate_to_human|cancel_subscription|sub-cancel|order-status|not-delivered|missing-packs|ai-response)\b/i,
  },
  {
    id: 'agent-note',
    pattern:
      /\b(?:note to agent|internal note|for the agent|agent-only)\b|\[[^\]\n]{0,40}(?:note|internal|translated)[^\]\n]{0,40}\]/i,
  },
  {
    id: 'prompt-scaffolding',
    pattern:
      /---\s*(?:order history|tracking|current conversation|previous conversations|customer not matched|just escalated)/i,
  },
  {
    id: 'ai-self-disclosure',
    pattern:
      /\b(?:as an? (?:ai|bot|assistant|language model)|i(?:'m| am) an? (?:ai|bot|language model))\b/i,
  },
  {
    id: 'tool-talk',
    pattern:
      /\b(?:tool call|call(?:ing)? the tool|use the tool|the tool (?:reports|returned|confirms|says))\b/i,
  },
];

/** A greeting on its own line — where the customer-facing reply really starts. */
const GREETING_LINE =
  /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^\n]{0,80}$/im;

function findMarkers(text: string): string[] {
  return INTERNAL_MARKERS.filter((m) => m.pattern.test(text)).map((m) => m.id);
}

export interface VettedReply {
  /** True when `content` is safe to send to the customer. */
  ok: boolean;
  /** Send-ready message (vetted body + signature). Empty when `ok` is false. */
  content: string;
  /** Marker ids still present after any preamble was removed. */
  violations: string[];
  /** A reasoning preamble was found before the greeting and removed. */
  strippedPreamble: boolean;
}

/**
 * Vets model-authored text before it is sent to a customer.
 *
 * Two stages: if the text opens with internal commentary followed by a real
 * greeting, the preamble is dropped; whatever remains must then be free of
 * every internal marker. Anything that still looks like reasoning, prompt
 * scaffolding, or an agent note is rejected outright — the caller escalates to
 * a human rather than sending it.
 */
export function vetResponderReply(raw: string): VettedReply {
  let body = raw.trim();
  let strippedPreamble = false;

  const greeting = GREETING_LINE.exec(body);
  if (greeting && greeting.index > 0) {
    const preamble = body.slice(0, greeting.index);
    if (findMarkers(preamble).length > 0) {
      body = body.slice(greeting.index).trim();
      strippedPreamble = true;
    }
  }

  if (!body) {
    return { ok: false, content: '', violations: ['empty'], strippedPreamble };
  }

  const violations = findMarkers(body);
  if (violations.length > 0) {
    return { ok: false, content: '', violations, strippedPreamble };
  }

  return {
    ok: true,
    content: formatResponderMessage(body),
    violations: [],
    strippedPreamble,
  };
}

/** Fixed, always-safe holding reply used when the generated one is rejected. */
export function holdingFallbackBody(name?: string): string {
  return [
    `Hi ${name || 'there'},`,
    '',
    'Thanks for reaching out! We need a bit of extra help to resolve this for you, so one of our team members will be in touch shortly to take care of everything.',
  ].join('\n');
}

export interface VettedHoldingReply {
  /** Send-ready message: the vetted reply, or the canned fallback. */
  content: string;
  /** True when the generated reply was rejected and the fallback is used. */
  usedFallback: boolean;
  /** Marker ids that caused the fallback. */
  violations: string[];
}

/**
 * Vets a generated holding reply. Unlike a normal reply there is no need to
 * escalate on failure (the conversation is already being handed to a human), so
 * a rejected message is replaced with the fixed fallback.
 */
export function vetHoldingReply(raw: string, name?: string): VettedHoldingReply {
  const vetted = vetResponderReply(raw);
  if (vetted.ok) {
    return { content: vetted.content, usedFallback: false, violations: [] };
  }
  return {
    content: formatResponderMessage(holdingFallbackBody(name)),
    usedFallback: true,
    violations: vetted.violations,
  };
}

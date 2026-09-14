/**
 * Canonical refund rules shared by every refund analytics script:
 *   - classifyActor(): who initiated a Shopify refund (REST refund.user_id / transactions[].source_name / note)
 *   - bucketRefund(): the policy bucket of a money refund (full / 30 / 50 / 70 / shipping-only / other)
 *   - localDay() / localMidnightUtc(): Europe/Helsinki calendar days, DST-safe, no dependency
 *
 * shopifyRefunds.ts, refundAttribution.ts and refundLabelReconciliation.ts import this file, so the refund page and
 * the label-compliance page of a dashboard always agree. A dashboard should implement these three functions once
 * (same rules, same order) and keep STAFF / CHARGEFLOW_COLLABORATOR_IDS / APP_SOURCES as editable config.
 *
 * See docs/support-analytics/README.md ("Canonical definitions") and refund-attribution.md.
 * Pure functions, no I/O.
 */

// ---------------------------------------------------------------------------
// Actor classes (config: edit here, not in the scripts)
// ---------------------------------------------------------------------------

export type ActorClass =
  | 'support_agent' // Ruth, in the Shopify admin
  | 'call_support' // Jan, the call-support agent (confirmed by the owner 2026-09-14)
  | 'chargeflow_app' // automatic refunds by the Chargeflow app (source_name 4704285, no user)
  | 'chargeflow_collaborator' // Chargeflow, Inc. employees refunding through collaborator staff accounts
  | 'other_staff' // a known staff account with another role (owner, former staff)
  | 'unknown_staff' // a staff user id that is not in the map: surface it as an "unmapped id" alert
  | 'other_app' // an app other than Chargeflow
  | 'unknown';

export const ACTOR_CLASS_ORDER: ActorClass[] = [
  'support_agent',
  'call_support',
  'chargeflow_app',
  'chargeflow_collaborator',
  'other_staff',
  'unknown_staff',
  'other_app',
  'unknown',
];

/** Dashboard grouping of the classes into the initiators the owner asked for. */
export const ACTOR_GROUP: Record<ActorClass, 'Ruth (support)' | 'Jan (call support)' | 'Chargeflow' | 'Other staff' | 'Other / unknown'> = {
  support_agent: 'Ruth (support)',
  call_support: 'Jan (call support)',
  chargeflow_app: 'Chargeflow',
  chargeflow_collaborator: 'Chargeflow',
  other_staff: 'Other staff',
  unknown_staff: 'Other staff',
  other_app: 'Other / unknown',
  unknown: 'Other / unknown',
};

export const STAFF_CLASSES: ActorClass[] = ['support_agent', 'call_support', 'other_staff', 'unknown_staff'];

/** REST transactions[].source_name of the Shopify admin web app (a person logged in to the admin). */
export const SOURCE_ADMIN_WEB = '1830279';

export const APP_SOURCES: Record<string, { app: string; cls: ActorClass }> = {
  '4704285': { app: 'Chargeflow', cls: 'chargeflow_app' },
};

/**
 * Staff user ids (REST refund.user_id). `verified` stays false until the owner confirms the mapping.
 * Evidence: the refund_created event message starts with the actor's display name (events are kept ~90 days).
 */
export const STAFF: Record<string, { label: string; cls: ActorClass; verified: boolean; note: string }> = {
  '135220658524': {
    label: 'Ruth',
    cls: 'support_agent',
    verified: true,
    note: 'Ruth Mae De Guzman, support agent (staffMember name; confirmed by the owner 2026-09-14)',
  },
  '135617184092': {
    label: 'Jan',
    cls: 'call_support',
    verified: true,
    note: 'Jan, call-support agent (Shopify account named by its email; confirmed by the owner 2026-09-14)',
  },
  '127271076188': { label: 'Velislav', cls: 'other_staff', verified: false, note: 'historical, role unknown' },
  '125029613916': { label: 'Elias', cls: 'other_staff', verified: false, note: 'historical, role unknown' },
  '129970569564': { label: 'Sophia', cls: 'other_staff', verified: false, note: 'historical, role unknown' },
};

/** Chargeflow, Inc. collaborator staff accounts seen so far. The list is known to be incomplete. */
export const CHARGEFLOW_COLLABORATOR_IDS = new Set([
  '134634242396',
  '134269862236',
  '134897140060',
  '134886326620',
  '136891072860',
]);

/** Pre-dispute alert references written in refund notes by Chargeflow staff. */
export const ALERT_NOTE_RE = /\b(ethoca|cdrn|verifi|rdr)\b/i;

export interface ActorInput {
  /** REST refund.user_id as a string, null for apps */
  userId: string | null;
  /** REST transactions[kind=refund].source_name */
  sourceName: string | null;
  /** REST refund.note. Classified in memory only; never store it (free text, may hold customer data). */
  note: string | null;
  /** Optional: GraphQL refund_created event appTitle and redacted actor name (only within ~90 days). */
  eventAppTitle?: string | null;
  eventActorName?: string | null;
}

export interface ActorResult {
  cls: ActorClass;
  label: string;
  rule: string;
}

/**
 * Canonical initiator classification. First matching rule wins. The staff map is checked before the alert-note rule
 * on purpose: if Ruth refunds an alert and writes "Ethoca" in the note, the refund is still hers.
 * Never use the refund_success event actor: it is often authored by "Shopify" and failed refunds emit one too.
 */
export function classifyActor(x: ActorInput): ActorResult {
  const app = x.sourceName ? APP_SOURCES[x.sourceName] : undefined;
  if (app && x.userId === null) return { cls: app.cls, label: app.app, rule: `source_name=${x.sourceName}` };
  if (x.userId === null && x.eventAppTitle === 'Chargeflow') {
    return { cls: 'chargeflow_app', label: 'Chargeflow', rule: 'event appTitle=Chargeflow' };
  }
  if (x.userId !== null) {
    const staff = STAFF[x.userId];
    if (staff) return { cls: staff.cls, label: staff.label, rule: `user_id map (${x.userId})` };
    if (CHARGEFLOW_COLLABORATOR_IDS.has(x.userId)) {
      return { cls: 'chargeflow_collaborator', label: 'Chargeflow, Inc.', rule: 'known collaborator user_id' };
    }
    if (x.eventActorName && /^Chargeflow, Inc\./.test(x.eventActorName)) {
      return { cls: 'chargeflow_collaborator', label: 'Chargeflow, Inc.', rule: 'event actor "Chargeflow, Inc."' };
    }
    if (x.note && ALERT_NOTE_RE.test(x.note)) {
      return { cls: 'chargeflow_collaborator', label: 'Chargeflow, Inc.', rule: 'note has alert reference' };
    }
    return {
      cls: 'unknown_staff',
      label: `staff ${x.userId} (${x.eventActorName ?? 'name unknown'})`,
      rule: 'unmapped user_id',
    };
  }
  if (x.sourceName && x.sourceName !== SOURCE_ADMIN_WEB) {
    return { cls: 'other_app', label: x.eventAppTitle ?? `app source ${x.sourceName}`, rule: `unknown source_name=${x.sourceName}` };
  }
  return { cls: 'unknown', label: 'unknown', rule: 'no user_id and no app source' };
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

export type RefundBucket = 'full' | '30' | '50' | '70' | 'shipping-only' | 'other';
export const REFUND_BUCKETS: RefundBucket[] = ['full', '30', '50', '70', 'shipping-only', 'other'];

/** Partial refunds within this many percentage points of 30 / 50 / 70 get that bucket (27.8 -> 30, 45.5 -> 50). */
export const BUCKET_TOLERANCE_PP = 5;
export const FULL_THRESHOLD_PCT = 99.5;

/** Chatwoot action label -> bucket it claims. */
export const LABEL_BUCKET: Record<string, RefundBucket> = {
  'refund-30': '30',
  'refund-50': '50',
  'refund-70': '70',
  'refund-full': 'full',
};

export interface BucketInput {
  /** this refund's presentment amount / order.totalReceivedSet.presentmentMoney * 100 (unrounded), null if no base */
  pct: number | null;
  /** all money refunds on the order up to and including this one, same base */
  cumPct: number | null;
  /** optional: this is the order's latest money refund, the order is REFUNDED now and nothing is left to refund */
  isFullNow?: boolean;
  /** optional: refundLineItems empty and refundShippingLines not empty */
  shippingOnly?: boolean;
}

/**
 * Canonical bucket, rules in order:
 *   full          pct >= 99.5, or cumPct >= 99.5, or isFullNow (a 95 % refund followed by a 5 % refund is full twice)
 *   shipping-only only shipping was refunded (typically 18-23 %)
 *   30 / 50 / 70  |pct - target| <= 5 pp
 *   other         everything else (no label bucket exists for it)
 */
export function bucketRefund(x: BucketInput): RefundBucket {
  if ((x.pct !== null && x.pct >= FULL_THRESHOLD_PCT) || (x.cumPct !== null && x.cumPct >= FULL_THRESHOLD_PCT) || x.isFullNow) {
    return 'full';
  }
  if (x.shippingOnly) return 'shipping-only';
  if (x.pct === null) return 'other';
  for (const t of [30, 50, 70] as const) {
    if (Math.abs(x.pct - t) <= BUCKET_TOLERANCE_PP) return String(t) as RefundBucket;
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Local days (Intl only, DST-safe)
// ---------------------------------------------------------------------------

export function tzOffsetMinutes(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** YYYY-MM-DD of an instant in `tz`. */
export function localDay(utcMs: number, tz = 'Europe/Helsinki'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(utcMs));
}

/** UTC epoch ms of 00:00 local time on `ymd` in `tz`. */
export function localMidnightUtc(ymd: string, tz = 'Europe/Helsinki'): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMinutes(guess, tz) * 60000;
  t = guess - tzOffsetMinutes(t, tz) * 60000;
  return t;
}

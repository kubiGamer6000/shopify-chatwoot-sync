# Ticket volume, resolution and SLA metrics

Implementation guide for the support analytics dashboard. It covers how many tickets needed handling, how many got resolved, how fast customers got a reply, and what the queue looks like right now. Everything is computed from raw Chatwoot conversations and messages and checked against the Chatwoot v2 reports API. Bot and human attribution comes from message patterns plus Firestore records.

- Reference implementation: `src/scripts/analytics/ticketVolume.ts` (read-only)
- Sample output: `/home/dolan/support-analytics/ticket-volume_<N>d_<YYYY-MM-DD>.json` and `.md` (outside the repo)
- All numbers below were verified against live APIs on 2026-09-14. Anything that could not be verified is marked **UNVERIFIED**.

```bash
npx tsx src/scripts/analytics/ticketVolume.ts            # 7 complete local days + today so far
npx tsx src/scripts/analytics/ticketVolume.ts --days=1   # yesterday + today so far
# flags: --days=N (1..30, default 7) --tz=Europe/Helsinki --out=/home/dolan/support-analytics --no-firestore --no-reports
```

`--days=N` means N **complete** local days before today. A today-so-far bucket (marked `partial: true`) is always added, so `--days=7` gives 8 day rows.

---

## 1. Context you need first

| Fact | Consequence |
| --- | --- |
| Chatwoot has one agent user, "Scandi Gum" (id 165591). Ruth (the human agent) and the AgentBot both act through it. | Chatwoot cannot say who replied or resolved. The v2 `bot_*` metrics are always 0, and agent reports only show that one user. |
| Inboxes: Support (email, 99613), Hey (email, 107519), Scandi (Facebook, 128017). | Only **Support** has the AgentBot attached. |
| Status semantics: `pending` = AgentBot state, `open` = human queue, `resolved`, `snoozed` (0 in use). | The open list is the human backlog. Pending mostly holds months-old legacy threads, but it hides some waiting customers (section 7). |
| Business timezone Europe/Helsinki: UTC+3 until 2026-10-25 03:00 local, then UTC+2. | Compute day boundaries with a real tz library or `Intl`, never a fixed offset. The v2 `timezone_offset` parameter has to change across DST (section 3.5). |
| The acknowledgement (holding reply) system went live 2026-09-14T07:55Z. | From then on, a public holding ack arrives seconds after a customer message. Chatwoot's `waiting_since` and `first_reply_created_at` treat it as a reply, so they are misleading from that point. |

---

## 2. Metric definitions

Notation: *local day D* = [00:00, 24:00) Europe/Helsinki. Timestamps are Chatwoot epoch seconds.

### 2.1 Message classifiers

| Name | Rule |
| --- | --- |
| `humanCustomerMsg` | `message_type === 0 && !private && autoReplySignal(m) === null` (`src/services/autoReply.ts`: OOO, bounces, our own outbound echoes, one-time codes...) |
| `machineIncoming` | `message_type === 0 && !private && autoReplySignal(m) !== null` |
| `publicOutgoing` | `message_type === 1 && !private` |
| `privateNote` | `private === true` (drafts, translations, `[AI HANDOFF]`, `[AI] Closed without reply`) |
| `activity` | `message_type === 2`. The content is the ONLY record of status changes. |
| `resolveEvent` | activity matching `/^Conversation was marked resolved\b/` |
| `statusEvent` | activity matching `/^Conversation was (marked resolved|reopened|marked open)\b/` |

**Activity text formats** seen in the 8-day window (2026-09-07..14; counts are window-only, lookback history excluded):

| Format (exact text, `<user>` = "Scandi Gum") | Count | Meaning |
| --- | --- | --- |
| `<user> added <label>[, <label>...]` | 2099 | Label added. It is logged only the **first** time a label is added to a conversation. |
| `Conversation was marked resolved by <user>` | 1781 | Resolve. Equals v2 `resolutions_count`. |
| `Assigned to <user> by Automation System` | 1215 | Automation rule assignment |
| `Conversation was reopened by <user>` | 1108 | pending/resolved to open **by the AgentBot handoff**. This is NOT a customer reopen (see below). |
| `<user> self-assigned this conversation` | 17 | |
| `Assigned to <user> by Default Policy` | 14 | |
| `Conversation was marked open by system due to an error with the agent bot.` | 1 | Bot error fallback |
| `<user> removed <label>` | a few | (2 in window plus lookback) |

No "marked pending" or "snoozed" text was ever observed (UNVERIFIED that Chatwoot never emits them). Treat any activity text that matches none of these as `UNCLASSIFIED`. The script counts those and lists their conversation ids.

**Detecting a reopen.** When a customer writes into a resolved conversation, Chatwoot changes the status silently: no activity message is written, in any inbox. In the Support inbox the conversation goes to `pending`, and about 10 s later the AgentBot hands off to `open`, which writes `Conversation was reopened by Scandi Gum`. The bot writes the same text for brand-new conversations too (conv 12011 got it 47 s after creation). In the Hey inbox (no bot), none of the 38 customer messages written into resolved conversations was followed by any status text. So:

> **reopened-from-resolved** = the most recent `statusEvent` before the customer message is a `resolveEvent`. Never count the "reopened" text.

### 2.2 Bot vs human reply attribution (`publicOutgoing` only)

Chatwoot cannot tell them apart, so the script layers signals, strongest first:

| # | Rule | Kind |
| --- | --- | --- |
| 1 | Firestore `sentReplies` doc with the same `conversationId`, \|Δts\| < 180 s and the same normalized first 25 characters (fallback: nearest doc within 15 s). `agent-bot-holding` gives holding ack, `agent-bot` gives bot, `dashboard` gives human (human-dashboard). | holding / bot-sentReplies / human-dashboard |
| 2 | A private note starting `[AI HANDOFF]` within 60 s after the message (only from the ack launch on) | holding |
| 3 | Activity `added ... ai-response|ai-reply|ai-resolved` within 5 s after the message | bot-label |
| 4 | **Timing rule:** sent < 60 s after the latest incoming message AND a `resolveEvent` within 0-2 s after it | bot-timing |
| - | none of the above | human-other (typed in the Chatwoot UI, or unmatched) |

Rule 4 exists because of rule 3's blind spot. Chatwoot logs `added ai-response` only once per conversation, so when the bot answers a later cycle of a conversation that already has the label, no activity appears. Without rule 4 bot replies are undercounted by about 22% (103 timing-rule replies in 8 days on top of 365 label-based, 337 + 28, in the 7-day run: 103 of 468). In the 1-day run with Firestore, 15 of the 21 timing-rule conversations had a latest `agentBotDecisions.action` of `responded`. The other 6 are probably conversations whose later decision overwrote it (UNVERIFIED).

`sentReplies` history: `dashboard` docs go back to at least 2026-07-17. `agent-bot` and `agent-bot-holding` exist only from 2026-09-14T08:00Z. When Firestore is not available, rules 2-4 still identify bot replies and holding acks. The only change is that human replies cannot be split into dashboard vs Chatwoot UI.

**Bot-signal resolve:** a `resolveEvent` with a bot reply, an `ai-*` label add, or a `[AI] Closed without reply` private note within the 10 s before it (or an `ai-*` label add in the same second after it). Everything else is "resolve without bot signal". That includes Ruth resolving spam or thank-you mails, so do not call it "resolved by human". The false-positive rate is UNVERIFIED.

### 2.3 Volume (per local day D)

| Metric | Definition |
| --- | --- |
| `needing` | Distinct conversations with at least 1 `humanCustomerMsg` on D |
| `new` | ...whose `conversation.created_at` is on D |
| `cameBack` | `needing - new` (conversation created before D) |
| `reopenedFromResolved` | cameBack conversations whose last `statusEvent` before their **first** human message on D is a resolve |
| `continuing` | `cameBack - reopenedFromResolved` (the thread was still open or pending) |
| `created` | Conversations with `created_at` on D. Equals v2 `conversations_count`. Includes outbound outreach threads. |
| `incomingPublic` / `incomingMachine` | Public incoming messages on D. `incomingPublic` equals v2 `incoming_messages_count`. |

Summing `needing` over days gives **conversation-days**, not distinct tickets. A conversation active on 3 days counts 3 times.

### 2.4 Resolution (per local day D)

| Metric | Definition |
| --- | --- |
| `resolveEvents` | Count of `resolveEvent`s on D. Equals v2 `resolutions_count` exactly. |
| `resolvedDistinctConversations` | Distinct conversations with at least 1 resolve on D. It is lower because conversations get resolved, reopened and re-resolved the same day. |
| `resolveEventsWithBotSignal` / `withoutBotSignal` | Split per section 2.2 |
| `reopenedActivityEvents` | Count of "reopened" texts. Only shown so you can explain why it must not be used. |
| `publicReplies.{bot, holdingAck, human, byRule}` | Split per section 2.2 |

### 2.5 SLA

**Unit: the ticket cycle.** A cycle starts at a `humanCustomerMsg` when no cycle is open (the first contact, or the first message after a resolve). It ends at the next `resolveEvent`. Machine mail never opens a cycle.

| Cycle field | Definition |
| --- | --- |
| `kind` | `new` = first cycle, no public outgoing before it, full history fetched. `reopened-from-resolved` = the previous status was resolved. `follow-up-open` = anything else (e.g. we started the thread with outreach, or history was truncated). |
| `firstResponse` | First bot **or** human public reply after start. **Holding acks are excluded.** Recommended headline. |
| `firstHumanReply` | First reply of kind human-* |
| `firstAnyReplyInclHoldingAck` | First public outgoing message of any kind |
| `timeToResolve` | resolveEvent - start |

Reported per group (all, complete days, today, by kind, by inbox, by start day): n, p50, p90 (linear interpolation), still open, a first-response bucket histogram, and the waiting shares:

> **no response within T** (T = 24 h, 48 h), computed over cycles that started at least T ago. Cycles resolved within T **without** that kind of reply (spam, "thanks", or bot-handled cycles when measuring human replies) are removed from **both** numerator and denominator. `late` = no reply of that kind within T. The JSON also has an `unexcluded` variant (aged / late with no exclusion).

The first-response distribution is **bimodal**: bot replies arrive in under a minute, human replies after 1-3 days. The dashboard should show buckets, or bot and human series separately. A single median hides this.

Per-day cohorts are **right-censored**. Any group with cycles younger than 48 h is flagged `provisional`. Its median only covers the cycles that already got a reply.

**Wait episodes (alternative unit).** A cycle ignores waits inside a long open thread: we reply, the customer writes again, the thread stays open. A wait episode starts at the first unanswered human customer message (after our last non-holding public reply or resolve) and ends at the next such reply (`answered`) or at a resolve (`closedWithoutReply`). This is Chatwoot's `waiting_since` definition, with holding acks ignored.

**Do not use** `conversation.first_reply_created_at` for SLA. It is a lifetime value (the first public outgoing message ever), it equals `created_at` for outreach threads, it ignores reopen cycles, and since launch it is set by holding acks. Chatwoot's `avg_first_response_time` / `avg_resolution_time` are means credited to the day of the reply or resolve, using Chatwoot's own reporting-event rules (UNVERIFIED exact definition). Show them only as reference.

### 2.6 Backlog snapshot (now)

| Metric | Definition |
| --- | --- |
| `open.count`, `pending.count`, snoozed | `meta.all_count` from `status=<x>` list calls |
| `open.createdAge` | <24 h / 24-48 h / >48 h by `created_at` |
| `oldestByCreatedAt` | Misleading: long-lived threads are old but may be answered |
| `oldestByWaitingSince` | Smallest `waiting_since > 0`. The oldest unanswered customer. |
| `messageBased.overdue24h/48h` | Open conversations whose first human customer message after our last non-holding public reply or resolve is older than 24 h / 48 h. **Recommended.** |
| `waitingSinceProxy.overdue24h/48h` | Same, using `now - waiting_since`. Needs 0 message calls, but a holding ack resets `waiting_since`, so from 2026-09-14 08:00Z it undercounts (19-20 of 186 waiting open conversations already disagree for this reason). |
| `messageBased.lastSpeaker` | customer waiting / only machine mail since our reply / we replied or resolved last |
| `pending.withWaitingSince` | Pending conversations with `waiting_since > 0`. These customers are invisible to the open queue. |

Do not use `last_non_activity_message` to find the last speaker: 189 of 190 open conversations have a bot private note there. Do not use `/api/v2/.../reports/conversations`: it returned `pending: 0` while 130 conversations were pending (unexplained, UNVERIFIED why).

### 2.7 By inbox

Every metric above is grouped by `conversation.inbox_id` (99613 Support, 107519 Hey, 128017 Scandi-FB). The v2 reports accept `type=inbox&id=<inbox id>` for the cross-check.

---

## 3. API calls

All Chatwoot calls are GET with header `api_access_token: <CHATWOOT_API_TOKEN>`. Use `chatwootClient` (`src/services/chatwoot.ts`, base `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}`, retries 429 with backoff) or plain axios with the env accessors in `src/config/env.ts`.

### 3.1 List conversations by last activity

```
GET /api/v1/accounts/{account}/conversations?status=all&assignee_type=all&sort_by=last_activity_at_desc&page=N
```

- 25 per page, strictly sorted by `last_activity_at` desc (0 out-of-order values across 63 pages). Response: `data.meta {mine_count, assigned_count, unassigned_count, all_count}`, `data.payload[]`.
- Conversation fields used: `id, inbox_id, status, labels[], created_at, last_activity_at, waiting_since (0 = nobody waiting), first_reply_created_at (0 = none), last_non_activity_message, messages[last only]`. `meta.sender` contains PII (name, email): do not persist it.
- Filtering by labels (GET `labels[]` or POST `/conversations/filter`) **times out** (422 "request took too long"). Filter labels client-side.
- Every bot label or status action bumps `last_activity_at`, so the window set (1564 conversations in 8 days) includes conversations with no human customer message in the window. Do not compare it with `needing`: that is summed per day (conversation-days, 1463 + 163 = 1626 over the same 8 days), so it can exceed the number of distinct conversations.

```ts
import { chatwootClient } from '../../services/chatwoot.js';

async function listActiveSince(sinceS: number) {
  const byId = new Map<number, any>();
  for (let page = 1; ; page++) {
    const { data } = await chatwootClient.get('/conversations', {
      params: { status: 'all', assignee_type: 'all', sort_by: 'last_activity_at_desc', page },
    });
    const rows = data.data.payload as any[];
    for (const c of rows) if (c.last_activity_at >= sinceS) byId.set(c.id, c);
    const last = rows[rows.length - 1];
    if (!last || rows.length < 25 || last.last_activity_at < sinceS) break;
  }
  // A conversation that gets activity while you page jumps to page 1, which you already read.
  const { data } = await chatwootClient.get('/conversations', {
    params: { status: 'all', assignee_type: 'all', sort_by: 'last_activity_at_desc', page: 1 },
  });
  for (const c of data.data.payload) if (c.last_activity_at >= sinceS) byId.set(c.id, c);
  return [...byId.values()];
}
```

### 3.2 List by status (backlog)

```
GET /api/v1/accounts/{account}/conversations?status=open|pending|snoozed&assignee_type=all&sort_by=last_activity_at_desc&page=N
```

Same shape. `data.meta.all_count` is the total for that status (1 call if you only need counts). Page until a page has fewer than 25 rows.

### 3.3 Messages

```
GET /api/v1/accounts/{account}/conversations/{id}/messages            # newest 20
GET /api/v1/accounts/{account}/conversations/{id}/messages?before=<smallest id seen>
```

- `payload[]` (at most 20): `id, content, message_type (0 incoming, 1 outgoing, 2 activity, 3 template), private, created_at, content_attributes.email {auto_reply, headers, subject, from}, sender {type contact|user, id}`.
- Page until a page has fewer than 20 messages (start of history) or its oldest message is older than what you need. Dedupe by id. Sort by `(created_at, id)`: a reply, its label and its resolve often share one second, and ids are not always in causal order.
- `content` and `sender` contain PII. Keep them in memory only.

```ts
async function fetchHistory(id: number, sinceS: number) {
  const byId = new Map<number, any>();
  let before: number | undefined;
  let complete = false;
  for (;;) {
    const { data } = await chatwootClient.get(`/conversations/${id}/messages`, { params: before ? { before } : {} });
    const page = data.payload as any[];
    for (const m of page) byId.set(m.id, m);
    if (page.length < 20) { complete = true; break; }
    const minId = Math.min(...page.map((m) => m.id));
    if (Math.min(...page.map((m) => m.created_at)) < sinceS || minId === before) break;
    before = minId;
  }
  return { complete, messages: [...byId.values()].sort((a, b) => a.created_at - b.created_at || a.id - b.id) };
}
```

### 3.4 Firestore (read-only)

```ts
import { getDb } from '../../services/firestore.js';
const db = getDb()!;
// ts is a NUMBER (epoch ms). where('ts', '>=', new Date(...)) silently returns 0 docs.
const sent = await db.collection('sentReplies').where('ts', '>=', sinceMs).get();
// {conversationId, message (PII), source: 'dashboard'|'agent-bot'|'agent-bot-holding', at, ts}
const decisions = await db.collection('agentBotDecisions').where('ts', '>=', sinceMs).get();
// doc id = conversationId; LATEST decision only (overwritten):
// {conversationId, action: responded|escalated|closed|handed-off|skipped|failed|swept-open, classified[], routingLabels[], route?, reason?, intents?, at, ts}
```

The Firestore project shares a read quota with other jobs. On 2026-09-14 the 7-day run got `8 RESOURCE_EXHAUSTED: Quota exceeded` even after retries, so the script retries 3 times with backoff and then continues without Firestore. A dashboard should cache these reads (they are small: about 570 sentReplies and 460 decisions per 2 days).

### 3.5 v2 reports (cross-check and headline counts)

```
GET {CHATWOOT_BASE_URL}/api/v2/accounts/{account}/reports
    ?metric=conversations_count|incoming_messages_count|outgoing_messages_count|resolutions_count|avg_first_response_time|avg_resolution_time|reply_time
    &type=account                (or type=inbox&id=99613)
    &since=<unix local midnight>&until=<unix now>&group_by=day&timezone_offset=3
  -> [{ value, timestamp (local midnight, unix), count? }]

GET {CHATWOOT_BASE_URL}/api/v2/accounts/{account}/reports/summary?type=account&since&until&timezone_offset=3
  -> {conversations_count, incoming_messages_count, outgoing_messages_count, avg_first_response_time,
      avg_resolution_time, resolutions_count, reply_time, previous{...same for previous period}}
```

```ts
import axios from 'axios';
import { env } from '../../config/env.js';
const { data } = await axios.get(`${env.chatwootBaseUrl}/api/v2/accounts/${env.chatwootAccountId}/reports`, {
  headers: { api_access_token: env.chatwootApiToken },
  params: { metric: 'resolutions_count', type: 'account', since, until, group_by: 'day', timezone_offset: 3 },
});
```

`timezone_offset` must be the offset in effect for those days: +3 through 2026-10-24, +2 from 2026-10-26 (the change happens 2026-10-25 04:00 local). A range that spans the change cannot be requested with one offset, so split it (the script groups days by offset). Avoid `bot_resolutions_count`, `bot_handoffs_count`, `/reports/bot_summary` and `/reports/bot_metrics`: they are always 0 or meaningless here. Avoid `/reports/conversations` for pending.

---

## 4. Computation recipe

1. **Window.** `today = localDay(now)`. `startDay = today - N days`. `windowStart = localMidnight(startDay)` (Europe/Helsinki, DST-safe). Day rows = startDay..today, and today is partial.
2. **Enumerate** conversations with `last_activity_at >= windowStart` (section 3.1), then re-read page 1 and dedupe by id.
3. **Firestore** `sentReplies` and `agentBotDecisions` with `ts >= min(windowStart, ackLaunch) - 1 day` (optional; degrade gracefully).
4. **Messages** for every conversation back to `windowStart - 14 days` (section 3.3), with 5 parallel workers. The lookback shows each conversation's state (resolved or not) when the window starts. When the history is truncated (29 of 1564 conversations), assume the prior state is not resolved, which can slightly undercount reopens.
5. **v2 reports** right after the raw pull, to limit drift in today's numbers.
6. **Walk each conversation's sorted messages once**, tracking `lastStatus` (resolved/open/null), whether a public outgoing message was seen, the current cycle and the current wait episode:
   - Human customer message: if it is the first one on day D, add the conversation to `needing[D]` and classify it new / cameBack / reopenedFromResolved using `lastStatus`. If no cycle is open, start one (kind from `lastStatus`, previous outgoing, history completeness). If no wait episode is open, start one.
   - Public outgoing: classify it (section 2.2), count it on its day, fill the cycle's first-reply fields, and close the wait episode as answered unless it is a holding ack.
   - Resolve: count the event and the distinct conversation, compute the bot signal, close the cycle and the wait episode, and set `lastStatus = resolved`.
   - "reopened" / "marked open": set `lastStatus = open` (and count the "reopened" text for reference only).
   - Count created conversations by the local day of `created_at`.
   - Only count events and cycles whose timestamp is inside [windowStart, now]. Lookback messages only update state.
7. **Aggregate** per day, per inbox, per cycle group. Compute percentiles and waiting shares (section 2.5).
8. **Backlog:** list `open` and `pending` (all pages) and `snoozed` page 1. For open conversations not already fetched, fetch message pages until one contains a public outgoing message or a resolve. Compute the message-based overdue counts and compare with `waiting_since`.
9. **Cross-check:** the raw `created`, `incomingPublic` and `resolveEvents` per day must equal the v2 values. Show the differences. For past days they are 0.

**Incremental refresh (for a dashboard):** cache messages per conversation keyed by `last_activity_at`, and refetch only conversations whose `last_activity_at` changed since the last run. List paging stays cheap (1 call per 25 recently touched conversations).

---

## 5. Performance and rate limits

| Step | 1 complete day + today (718 conv.) | 7 complete days + today (1564 conv.) |
| --- | --- | --- |
| List (sequential) | 30 calls, 44 s | 64 calls, 63 s |
| Messages (5 workers) | 745 calls, 48 s | 1638 calls, 96 s |
| v2 reports (5 account metrics + 2 per inbox) | 12 calls, 2 s | 12 calls, 5 s |
| Backlog lists + missing messages | 15 + 0 calls, 13 s | 15 + 1 calls, 15 s |
| Firestore | 2 queries, 0.8 s | failed (quota) |
| **Total** | 804 calls, about 1 m 50 s | 1730 calls, about 3 m 30 s |

- List pages take about 1-1.5 s each. Message calls: p50 about 200 ms, p90 about 350 ms. Across several runs, 5 parallel workers never received a 429. `chatwootClient` retries 429 honouring `Retry-After`.
- Most conversations need a single message page (1489 of 1561 in one probe; the maximum was 3).
- A dashboard should not recompute on every page view. Run this on a schedule (e.g. every 15-30 min) with the incremental cache, and serve stored aggregates.

---

## 6. Caveats and what is impossible

- **Per-person attribution is impossible** in Chatwoot. Ruth, the call-support agent and the bot are all user 165591. A human reply is only "not bot". `human-dashboard` means it was sent through the admin app, and `human-other` means it was typed in the Chatwoot UI or unmatched.
- **Bot attribution before 2026-09-14** depends on the label rule and the timing rule. Bot replies that neither added a new label nor resolved within 2 s would be counted as human (UNVERIFIED how many; probably few).
- **agentBotDecisions keeps only the latest decision** per conversation. It cannot give bot decisions per day historically, and a conversation handled twice shows only its last outcome. Labels on a conversation (`ai-response`, `sub-cancelled-ai`, `escalated`) are a lifetime union and do not tell you which cycle they belong to.
- **Wall-clock time.** SLA uses 24/7 hours. Business hours are not modelled (open question).
- **Pending is not a live queue** (130 conversations, 128 created more than 48 h ago, oldest 2026-03-21, only 2 with activity in the last 48 h). But 37 of them have `waiting_since > 0`: those customers have waited 38-177 days with no public reply and never appear in the open queue.
- **Today and recent days change on re-run.** The list is a snapshot, and cycles younger than 48 h are right-censored.
- **Outreach threads** (first message from us) count in `created` and v2 `conversations_count`. They only enter SLA as `follow-up-open` cycles when the customer replies.
- **Facebook inbox**: same logic, tiny sample (12 cycles in 8 days). Messenger-specific machine messages were not examined (UNVERIFIED).
- The "no human reply within 24 h" numerator is identical to "no response within 24 h". That is expected, not a bug: every cycle with no response at all also has no human reply, and cycles that the bot answered and resolved within 24 h are excluded from the human denominator.

---

## 7. Real example (pulled 2026-09-14, about 10:56-11:07Z, Europe/Helsinki +3)

Two runs of the script:

- `--days=1`: 2026-09-13 (complete) + 2026-09-14 until 13:56 local. Firestore available.
- `--days=7`: 2026-09-07..13 (complete) + 2026-09-14 until 14:02 local. **Firestore hit its quota**, so human replies are not split into dashboard vs UI. Bot and holding-ack counts are the same as in the Firestore run (09-13 bot 59 in both runs). The day rows shared by both runs are identical, apart from about 1-2 more conversations today in the later run.

### 7.1 Last 1 local day (2026-09-13) and today so far

| Metric | 2026-09-13 | 2026-09-14 (to 13:56) |
| --- | --- | --- |
| Tickets needing handling | 221 | 162 |
| of which new / came back | 160 / 61 | 107 / 55 |
| came back: reopened from resolved / continuing | 60 / 1 | 54 / 1 |
| by inbox Support / Hey / FB | 207 / 11 / 3 | 153 / 8 / 1 |
| Conversations created (v2) | 163 (163) | 107 (107) |
| Public incoming messages (v2) / machine | 257 (257) / 7 | 186 (186) / 2 |
| Resolve events (v2) / distinct conversations | 378 (378) / 356 | 270 (270) / 255 |
| Resolve events with bot signal | 60 | 42 (8 after `[AI] Closed without reply`, per the research pull) |
| "reopened" activity texts (not reopens) | 167 | 122 |
| Public replies: bot / holding ack / human | 59 / 0 / 249 | 34 / 17 / 195 |
| Bot rules: label / timing / sentReplies | 45 / 14 / 0 | 22 / 7 / 5 |
| Human: dashboard-matched / other | 242 / 7 | 188 / 7 |
| agentBotDecisions (latest, by ts day) | escalated 149, responded 45 | escalated 120, responded 25, closed 8 |
| v2 avg_first_response_time (count) | 48.8 h (213) | 24.9 h (162) |
| v2 avg_resolution_time | 122.8 h | 74.5 h |

SLA, cycles started on 2026-09-13 (233 cycles, provisional because they are under 48 h old):

| | n | p50 | p90 |
| --- | --- | --- | --- |
| First response (bot or human) | 146 | 14.1 h | 28.7 h |
| First human reply | 88 | 25.4 h | 30.4 h |
| Time to resolve | 169 | 15.5 h | 28.7 h |

- First-response buckets: under 1 min 59, 1 min-1 h 1, 1-24 h 37, 24-48 h 49, no reply and still open 64, resolved without reply 23.
- No response within 24 h: 76 of 137 eligible (55.5%); unexcluded 84 of 145 (57.9%).
- Today's cycles (171): first response p50 0 h / p90 7.1 h (n 44, mostly bot), 115 with no reply yet.

### 7.2 Last 7 local days (2026-09-07..13) and today

| Day | Needing | New | Came back | Reopened | Support | Hey | FB | Created = v2 | Incoming = v2 | Machine | Resolve events = v2 | Resolved convs | Bot-signal resolves | Bot replies | Human replies |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 09-07 | 178 | 148 | 30 | 26 | 170 | 7 | 1 | 155 | 229 | 11 | 118 | 99 | 69 | 69 | 55 |
| 09-08 | 272 | 198 | 74 | 66 | 205 | 64 | 3 | 199 | 309 | 1 | 233 | 218 | 71 | 70 | 130 |
| 09-09 | 207 | 156 | 51 | 44 | 182 | 24 | 1 | 157 | 253 | 1 | 232 | 212 | 56 | 56 | 126 |
| 09-10 | 243 | 201 | 42 | 38 | 227 | 15 | 1 | 205 | 270 | 3 | 170 | 155 | 78 | 78 | 77 |
| 09-11 | 201 | 158 | 43 | 41 | 181 | 19 | 1 | 161 | 239 | 7 | 188 | 175 | 64 | 63 | 122 |
| 09-12 | 141 | 99 | 42 | 39 | 132 | 8 | 1 | 100 | 159 | 3 | 192 | 183 | 38 | 38 | 122 |
| 09-13 | 221 | 160 | 61 | 60 | 207 | 11 | 3 | 163 | 257 | 7 | 378 | 356 | 60 | 59 | 249 |
| **7 days** | **1463** | **1120** | **343** | **314** | 1304 | 148 | 11 | **1140** | **1716** | 33 | **1511** | 1398 | 436 | 433 | 881 |
| 09-14 (to 14:02) | 163 | 108 | 55 | 54 | 154 | 8 | 1 | 108 | 187 | 2 | 271 | 256 | 43 | 35 (+17 holding acks) | 195 |

- The raw minus v2 difference is 0 for created, incoming and resolve events on every day, today included.
- `/reports/summary` for 09-07 00:00 to now: conversations 1248, incoming 1903, outgoing 2988, resolutions 1781, avg first response 33.3 h, avg resolution 95.7 h. The previous 8-day period: 980 / 1571 / 2398 / 1432.
- "reopened" activity texts per day: 122, 144, 147, 168, 132, 106, 167, today 122. That is 986 in 7 days against 314 true reopens.
- Bot reply rules over the 7 days: label 337, timing 96. Human replies are all `human-other` in this run because Firestore was unavailable. In the 1-day run with Firestore, 242 of 249 human replies on 09-13 matched a dashboard send.

SLA per ticket cycle, cycles started 09-07 00:00 until now (1738 cycles, 185 still open):

| Group | Cycles | First response p50 / p90 | First human reply p50 / p90 | Resolve p50 / p90 | No response >24 h | No response >48 h | No human reply >24 h |
| --- | --- | --- | --- | --- | --- | --- | --- |
| All | 1738 | 39.3 / 71.3 h (n 1293) | 51.6 / 72.9 h (n 832) | 41.8 / 71.3 h (n 1553) | 967/1441 (67.1%) | 598/1174 (50.9%) | 967/1031 (93.8%) |
| kind new | 1220 | 31.0 / 71.0 | 52.8 / 72.9 | 38.8 / 71.3 | 679/1039 (65.4%) | 430/829 (51.9%) | 679/727 |
| kind reopened-from-resolved | 507 | 42.6 / 71.8 | 48.2 / 72.7 | 42.9 / 71.8 | 280/394 (71.1%) | 162/338 (47.9%) | 280/296 |
| kind follow-up-open | 11 | 64.8 / 94.2 | 64.8 / 94.2 | 57.9 / 89.2 | 8/8 | 6/7 | 8/8 |
| Support | 1569 | 29.7 / 71.0 | 49.5 / 72.9 | 36.6 / 71.3 | 831/1296 (64.1%) | 487/1041 (46.8%) | 831/886 |
| Hey | 157 | 54.6 / 72.2 | 54.6 / 72.2 | 54.4 / 72.4 | 128/136 (94.1%) | 104/125 (83.2%) | 128/136 |
| Scandi-FB | 12 | 59.3 / 78.8 | 59.3 / 78.8 | 59.3 / 78.8 | 8/9 | 7/8 | 8/9 |

Unexcluded shares: no response over 24 h 1004/1478 (67.9%), over 48 h 701/1277 (54.9%); no human reply over 24 h 1414/1478 (95.7%), over 48 h 1055/1277 (82.6%). Excluded human share over 48 h: 598/820 (72.9%).

By cycle start day (first response p50 / p90 h; no response over 24 h; over 48 h):

| Start day | Cycles | First response p50 / p90 | >24 h | >48 h |
| --- | --- | --- | --- | --- |
| 09-07 | 198 | 23.8 / 51.7 | 112/194 | 52/171 |
| 09-08 | 282 | 43.9 / 68.5 | 197/272 | 107/246 |
| 09-09 | 226 | 62.4 / 73.6 | 157/219 | 139/214 |
| 09-10 | 260 | 68.8 / 74.0 | 172/258 | 166/253 |
| 09-11 | 216 | 54.0 / 60.6 | 142/210 | 130/202 |
| 09-12 (provisional) | 151 | 37.3 / 46.3 | 111/151 | 4/88 |
| 09-13 (provisional) | 233 | 14.1 / 28.7 | 76/137 | n/a |
| 09-14 (provisional) | 172 | 0 / 7.1 (n 45) | n/a | n/a |

First-response buckets (all 1738 cycles): under 1 min **464**, 1 min-1 h 14, 1-24 h 77, 24-48 h 262, over 48 h **476**, no reply and still open 185, resolved without reply 260. The distribution is bimodal: bot vs human.

Wait episodes: in this window every episode coincided with a cycle (1738; answered 1293, p50 39.3 h / p90 71.3 h; closed without reply 260; still waiting 185). They only diverge in threads with several customer-to-us exchanges before a resolve.

v2 daily avg_first_response_time (h, count): 9.2 (75), 33.0 (123), 32.4 (116), 14.6 (105), 32.7 (130), 52.4 (108), 48.8 (213), today 24.7 (163). avg_resolution_time (h): 76.4, 119.5, 78.8, 80.5, 89.8, 95.3, 122.8, today 74.2. These are means credited to the reply or resolve day, so they are not comparable to cohort medians.

### 7.3 Backlog snapshot (2026-09-14T11:07Z)

| Metric | Value |
| --- | --- |
| Open | 192 (Support 170, Hey 19, Scandi-FB 3) |
| Open created age | under 24 h 97, 24-48 h 20, over 48 h 75 |
| Oldest open by created_at | conv 6765, created 2026-07-28, 1148.7 h |
| Oldest open by waiting_since = oldest unanswered human message | conv 11409, since 2026-09-10T10:59Z, 96.0 h |
| Open, last speaker | customer waiting 186, only machine mail since our reply 3, we replied or resolved last 3 |
| **Overdue over 24 h / over 48 h** (message-based, holding acks ignored) | **25 / 4** (all Support) |
| Overdue via waiting_since proxy | 25 / 4 (same today, because holding acks are under 24 h old; 20 of 186 waiting conversations already disagree with waiting_since, 17 of them because of a holding ack) |
| Open top labels | refund 136, sub-cancel 95, sub-cancelled 21, other 20, order-status 19, not-delivered 14, change-address 11, missing-packs 10, ai-response 9 |
| Pending | 130 (all Support); created over 48 h ago 128; activity in the last 48 h 2; oldest conv 176 (2026-03-21) |
| Pending with waiting_since > 0 | **37** (waiting 38-177 days) |
| Pending top labels | ai-resolved 62, order-status 47, sub-cancel 39, (none) 36, escalated 22 |
| Snoozed | 0 |

---

## 8. Open questions for the owner

1. Headline SLA: first response including bot replies, or first **human** reply? Should holding acks ever count? (The script reports all three.)
2. Business hours or 24/7 wall clock?
3. Ticket unit for the headline: per cycle (1566 cycles started in 7 complete days) or per conversation-day (1463)?
4. Should outreach threads be excluded from `created` and volume?
5. Overdue thresholds (24 h / 48 h?), and separate targets for Hey and Facebook?
6. What should happen to the 130 pending conversations, especially the 37 with a waiting customer?
7. Can the AgentBot write an append-only decision log (one doc per decision), and can the Chatwoot-UI human replies be tagged? That would replace the label and timing heuristics.

# Chatwoot built-in reporting APIs

Implementation guide for the support analytics dashboard. It covers every Chatwoot
reporting endpoint that answers on this instance (Chatwoot Cloud, account `155355`):
what each metric means, the exact calls, response shapes, how to build correct
Europe/Helsinki day windows, and what the reports cannot tell you.

Everything here was verified with live GET requests on 2026-09-14 unless it is marked
**UNVERIFIED** or **INFERENCE**.

Example script: `src/scripts/analytics/chatwootReports.ts` (read-only).

```bash
npx tsx src/scripts/analytics/chatwootReports.ts --days=7                  # 7 local days, today included (to now)
npx tsx src/scripts/analytics/chatwootReports.ts --days=1 --complete-days  # yesterday, full local day
# --tz=Europe/Helsinki  --out=/home/dolan/support-analytics  --no-events (skip raw event log)
```

It writes `<out>/chatwoot-reports_<N>d[_complete]_<date>.json` and `.md` and prints
cross-checks that tie the report endpoints to the raw event log.

---

## 1. TL;DR for the dashboard builder

| Dashboard need | Use | Do not use |
|---|---|---|
| New tickets per day (total, per inbox) | `GET /v2/.../reports?metric=conversations_count&group_by=day` | `conversation_traffic` (ignores the window, UTC) |
| Tickets per intent label per day | `GET /v2/.../reports?metric=conversations_count&type=label&id=<numeric>` | label titles as `id` (404) |
| All labels for a period, one call | `GET /v2/.../summary_reports/label` (counts only) | its time metrics for comparisons with the account |
| KPI tiles with previous-period delta | `GET /v2/.../reports/summary` | |
| Response time median / p90 | page `GET /v1/.../reporting_events` and compute | the report means (bimodal data, see 2.4) |
| Resolved conversations | `reporting_events` `conversation_resolved`, dedup by `conversation_id` | `resolutions_count` as "conversations" (it counts events) |
| Reopens | `reporting_events` `conversation_opened` with `value > 0` | |
| Replies sent | message API or Firestore `sentReplies` | `outgoing_messages_count` (includes private notes) |
| Backlog now (human queue / bot queue) | `GET /v2/.../live_reports/conversation_metrics` | `reports/conversations` (its `pending` is always 0) |
| Bot vs human | Firestore `agentBotDecisions` / `sentReplies`, `ai-*` labels | `bot_summary`, `bot_metrics` (always 0) |
| CSAT, business hours, teams | Nothing (not configured on this instance) | |

The five facts that matter most:

1. **The AI bot is invisible to Chatwoot reports.** The bot and the human agent act through the
   same user token (user `165591`, "Scandi Gum"). Every metric mixes them, and the native bot
   metrics are always 0.
2. **Two kinds of cohort.** Counts of conversations (`conversations_count`, label counts) cover
   conversations *created* in the window. Time metrics and `resolutions_count` cover *events that
   happened* in the window (a reply or resolve today on a ticket from last week counts today).
3. **Label reports use the label a conversation has now**, not when it was added. History changes
   after the fact when labels are added or removed later. Snapshot daily if you need stable history.
4. **`outgoing_messages_count` includes private notes** (197 of 505 on 2026-09-13).
5. **Timezone:** pass `timezone_offset` = the Helsinki offset *today* (3 in summer, 2 in winter)
   and compute `since`/`until` as Helsinki midnights yourself. `/reports/summary` and all
   `summary_reports/*` ignore `timezone_offset`.

---

## 2. Metric definitions (precise)

All time values are **seconds**. All `since`/`until` are **epoch seconds**, window `[since, until)`.

### 2.1 Count metrics

| Metric | Precise definition on this instance | Verified by |
|---|---|---|
| `conversations_count` | Conversations whose `created_at` is in the window. Includes all inboxes and all current statuses. Includes outbound-first conversations (agent started them) and conversations the bot fully handled. | 2026-09-13: 163 = number of v1 conversations with `created_at` in the window (Support 153, Hey 7, Facebook 3; 4 outbound-first). |
| `incoming_messages_count` | Messages with `message_type` 0 (customer) created in the window, on any conversation. | 257 = message walk over all 717 active conversations. |
| `outgoing_messages_count` | Messages with `message_type` 1 created in the window, **including private notes** and bot, acknowledgement and holding replies. Activity messages (type 2) are excluded. | 505 = 308 public outgoing + 197 private notes. |
| `resolutions_count` | `conversation_resolved` **events** in the window. A conversation resolved twice counts twice. It can exceed `conversations_count`. | 378 events on 356 unique conversations. |
| `bot_resolutions_count`, `bot_handoffs_count` | Would count AgentBot-token actions. **Always 0 here.** | Every day 0. |

### 2.2 Time metrics

Each is a simple mean of the matching raw `reporting_events` rows whose `created_at` falls in the window.
`/reports` buckets carry a `count` = number of events averaged.

| Metric | Event name | Event `value` means | Notes |
|---|---|---|---|
| `avg_first_response_time` | `first_response` | Seconds from the conversation start (or the moment it started waiting) to the first agent reply | At most **one per conversation** (957 events on 957 conversations, 7d). A human reply that follows a bot acknowledgement is never a first response. |
| `reply_time` (summary key; `avg_reply_time` in summary_reports) | `reply_time` | Seconds from a customer message to the next agent reply | Several per conversation (442 events on 326 conversations, 7d). |
| `avg_resolution_time` | `conversation_resolved` | Seconds from conversation creation (or reopen) to the resolve | Long tail of old tickets being closed. |

Keying on event time means a backlog clean-up day shows a *worse* average even when service
improved: Sep 13 closed many old tickets, giving avg FRT 48.8 h and avg resolution 122.8 h.

### 2.3 Raw event log semantics (`/v1/.../reporting_events`)

| `name` | When it fires | `value` |
|---|---|---|
| `conversation_opened` | Conversation status becomes `open` | `0` = new or pending conversation moved to open (for example a bot hand-off, about 10 s after creation). `> 0` = **reopen** of a resolved conversation (seconds since the event start). |
| `conversation_resolved` | Status becomes `resolved` | Seconds open |
| `first_response` | First outgoing reply | Seconds waited |
| `reply_time` | Each later agent reply to a waiting customer | Seconds waited |

No other event names were seen. `user_id` is `165591` for all events except a handful of `null`
(3 in the 7-day window, 0 on single days); what produces the null rows is **UNVERIFIED**.
`value_in_business_hours` is always 0 (working hours are disabled).

### 2.4 Why the means mislead

First response times are bimodal. Instant bot replies make up roughly a third of events, and the
rest are human replies after one to three days. The mean lands between the two groups and
describes neither: on Sep 13 the mean was 48.8 h but the median was 59.6 h, and 51 of 213 events
were under 60 s. Show the median and p90 from the raw log, and split bot and human with
Firestore data, not with a time threshold (a threshold is only a heuristic).

### 2.5 Live counts

| Field | Definition |
|---|---|
| `open` | Conversations with status `open` now (the human queue) |
| `pending` | Status `pending` now (the AgentBot queue). Only correct from `live_reports/conversation_metrics`. |
| `unattended` | Open conversations with no `first_reply_created_at` **or** with `waiting_since > 0`. Verified: 95 without a first reply ∪ 176 waiting = 177, equal to the API value at the time. |
| `unassigned` | Open conversations with no assignee (0 now) |

---

## 3. API reference

### 3.1 Common setup

```ts
import 'dotenv/config';
import axios from 'axios';
import { env } from '../../config/env.js';          // chatwootBaseUrl, chatwootAccountId, chatwootApiToken
import { chatwootClient } from '../../services/chatwoot.js'; // v1 client (retries 429 briefly)

const v2 = axios.create({
  baseURL: `${env.chatwootBaseUrl}/api/v2/accounts/${env.chatwootAccountId}`,
  headers: { api_access_token: env.chatwootApiToken },
  timeout: 90_000,
});
```

Header: `api_access_token: <user token>`. The token belongs to the administrator user. Whether a
lower role can read reports is **UNVERIFIED**.

Reference ids (from `GET /api/v1/accounts/155355/inboxes` and `/labels`):

| Inbox | id | Channel |
|---|---|---|
| Support | 99613 | `Channel::Email` (AgentBot attached) |
| Hey | 107519 | `Channel::Email` |
| Scandi | 128017 | `Channel::FacebookPage` |

Label reports need the numeric label id. Fetch it once:

```ts
const { data } = await chatwootClient.get<{ payload: { id: number; title: string }[] }>('/labels');
const labelId = new Map(data.payload.map((l) => [l.title, l.id]));   // e.g. refund -> 29686, sub-cancel -> 29684
```

Known ids: `refund` 29686, `sub-cancel` 29684, `ai-response` 36466, `sub-cancelled-ai` 36421, `refund-full` 31953.

### 3.2 Helsinki windows (no library needed)

```ts
function tzOffsetMinutes(ms: number, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000) / 60000);
}
function localMidnightMs(ymd: string, tz: string): number {       // DST-correct local 00:00
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) t = Date.UTC(y, m - 1, d) - tzOffsetMinutes(t, tz) * 60000;
  return t;
}
const since = localMidnightMs('2026-09-13', 'Europe/Helsinki') / 1000;   // 1789246800
const until = localMidnightMs('2026-09-14', 'Europe/Helsinki') / 1000;   // 1789333200 (exclusive)
const timezone_offset = tzOffsetMinutes(Date.now(), 'Europe/Helsinki') / 60; // offset NOW, not per date
```

### 3.3 Time series: `GET /api/v2/accounts/155355/reports`

| Param | Values | Notes |
|---|---|---|
| `metric` | `conversations_count`, `incoming_messages_count`, `outgoing_messages_count`, `avg_first_response_time`, `avg_resolution_time`, `reply_time`, `resolutions_count`, `bot_resolutions_count`, `bot_handoffs_count` | An unknown metric returns **HTTP 200 `{}`**, not an error. Check `Array.isArray`. |
| `type` | `account` (default), `inbox`, `agent`, `label` | `team` returns 404 (no teams exist). |
| `id` | Numeric inbox, user or label id | A label title gives 404. |
| `since`, `until` | Epoch seconds | |
| `group_by` | `hour`, `day`, `week`, `month` | Always pass it. Without it you get UTC days and an extra partial leading bucket. `year` returns odd timestamps. |
| `timezone_offset` | Hours, for example `3` | Buckets start at local midnight. |
| `business_hours` | `true` | Every time metric becomes 0 here. Do not use it. |

Response:

```json
// count metric
[{ "value": 155, "timestamp": 1788728400 }, { "value": 199, "timestamp": 1788814800 }]
// time metric: count = number of events averaged
[{ "value": 175530.39906103286, "timestamp": 1789246800, "count": 213 }]
```

```ts
const { data } = await v2.get('/reports', { params: {
  metric: 'conversations_count', type: 'label', id: 29686,
  since, until, group_by: 'day', timezone_offset,
}});
// data: [{ value: 83, timestamp: 1789246800 }]  (refund, 2026-09-13)
```

Bucketing rules (verified):

- `timestamp` = bucket start as UTC epoch; with `timezone_offset=3` that is Helsinki 00:00 (for example 1788728400 = 2026-09-06T21:00Z = Sep 7 00:00 EEST).
- Buckets are clipped to `[since, until)`. A UTC-aligned window with offset 3 gives partial first and last days.
- `group_by=week` starts on **Sunday**. The first bucket's `timestamp` can be before `since`, but its value is clipped to `since` (since = Sep 7 gives 977 for the week whose full value is 1087).
- **DST:** the offset resolves to a DST-aware zone based on the offset that is current at request time. With offset 3 requested in summer, a window across 2026-03-29 buckets at 22:00Z before the change and 21:00Z after it, which is Helsinki midnight on both sides. Offset 2 requested in summer buckets at CET/CEST midnight, one hour off. So pass today's offset. **UNVERIFIED:** which offset gives Helsinki bucketing after 2026-10-25 (probably 2). Always assert that returned timestamps equal `localMidnightMs(...)`. The script does this in its cross-checks.
- `type=agent` with `incoming_messages_count` returns 0; agent incoming counts are not meaningful.

### 3.4 KPI summary: `GET /api/v2/accounts/155355/reports/summary`

Params: `type=account|inbox|agent|label`, `id` (for non-account types), `since`, `until`.
`timezone_offset` is **ignored**.

```json
{
  "conversations_count": 163, "incoming_messages_count": 257, "outgoing_messages_count": 505,
  "avg_first_response_time": 175530.39906103286, "avg_resolution_time": 441907.38,
  "resolutions_count": 378, "reply_time": 202837.57,
  "previous": { "conversations_count": 100, "...": "same keys for the preceding window of equal length" }
}
```

`previous` is the window of the same length ending at `since`. For a partial "today so far"
window (00:00 to 10:56), `previous` is 13:04 yesterday to 00:00 today, **not** yesterday. For
"today vs yesterday", make a second call with yesterday's full window.

A time field is `null` when there are no events. Latency is usually 130 to 600 ms. A 1-year
window has taken between 0.3 s and 15 s (probably server-side caching).

### 3.5 Per-entity summaries: `GET /api/v2/accounts/155355/summary_reports/{label|inbox|agent|team}`

Params: `since`, `until`. One call returns all entities.

```json
// label
[{ "id": 29686, "name": "refund", "conversations_count": 519, "resolved_conversations_count": 711,
   "avg_first_response_time": 170687.597, "avg_resolution_time": 197439.121, "avg_reply_time": 154213.588 }]
// inbox / agent / team (no name) -- 2026-09-07..13, Support inbox
[{ "id": 99613, "conversations_count": 1006, "resolved_conversations_count": 1363,
   "avg_resolution_time": 370099.661, "avg_first_response_time": 115234.018, "avg_reply_time": 154239.206 }]
```

- `conversations_count`: conversations created in the window that currently carry the label (or belong to the inbox).
- `resolved_conversations_count`: resolve **events** in the window on conversations that currently carry the label, **whatever their creation date**. This is a different cohort. `resolved / conversations` is meaningless and often above 100% (reshipped on Sep 13: 0 created, 9 resolved).
- **Label time metrics do not match other endpoints.** For refund over 7 days, `summary_reports/label` gave FRT 170688 s and resolution 197439 s, while `reports/summary?type=label&id=29686` gave 202014 s and 423003 s. The counts agree. For a partial today window, refund label FRT was 2.2 h against the account's 24.9 h. That suggests the label figures only include conversations created in the window (**INFERENCE**). Labels with no qualifying events return `0`, not `null`. Compare labels only against each other, from one endpoint, and label the chart with the endpoint's name.
- At account and agent level, the two endpoints agree (7d FRT 125451.9 in both).
- `agent` has one row (user 165591). Its count is lower than the account total by the number of unassigned conversations. `team` returns `[]`.
- Inbox and agent rows have no `name`; join with `/v1/.../inboxes`.

### 3.6 Channel by status: `GET /api/v2/accounts/155355/summary_reports/channel`

```json
{ "Channel::Email": { "open": 89, "resolved": 1034, "pending": 6, "snoozed": 0, "total": 1129 },
  "Channel::FacebookPage": { "open": 2, "resolved": 9, "pending": 0, "snoozed": 0, "total": 11 } }
```

Conversations created in the window, grouped by channel type and **current** status (the split
changes over time: Sep 13 Email was open 38 on one run and open 36 later). Both email inboxes are
merged into `Channel::Email`.

### 3.7 First response histogram: `GET /api/v2/accounts/155355/reports/first_response_time_distribution`

```json
{ "Channel::Email": { "0-1h": 52, "1-4h": 2, "4-8h": 0, "8-24h": 1, "24h+": 157 },
  "Channel::FacebookPage": { "0-1h": 0, "1-4h": 0, "4-8h": 0, "8-24h": 0, "24h+": 1 } }
```

`first_response` events in the window, by channel type. The 0-1h bucket is almost entirely bot replies.

### 3.8 Inbox x label matrix: `GET /api/v2/accounts/155355/reports/inbox_label_matrix`

```json
{ "inboxes": [{ "id": 99613, "name": "Support" }], "labels": [{ "id": 29686, "title": "refund" }],
  "matrix": [[81]] }   // matrix[inboxIndex][labelIndex]
```

Conversations created in the window, by inbox and current label.

### 3.9 Live snapshot endpoints (`since`/`until` ignored)

| Call | Response |
|---|---|
| `GET /api/v2/accounts/155355/live_reports/conversation_metrics` | `{"open":191,"unattended":179,"unassigned":0,"pending":130}` **Use this one.** |
| `GET /api/v2/accounts/155355/live_reports/grouped_conversation_metrics?group_by=assignee_id` (or `team_id`) | `[{"open":187,"unattended":177,"unassigned":0,"assignee_id":165591}]` |
| `GET /api/v2/accounts/155355/reports/conversations?type=account` | Same keys, but `pending` is always **0** (wrong) |
| `GET /api/v2/accounts/155355/reports/conversations?type=agent` | `[{id, name, email, thumbnail, availability, metric:{open, unattended}}]` (contains agent PII; do not store) |
| `GET /api/v1/accounts/155355/conversations/meta?status=all\|open\|pending\|resolved\|snoozed` | `{"meta":{"mine_count":11614,"assigned_count":11641,"unassigned_count":275,"all_count":11916}}` |

There is no history API for these counts. The dashboard must store snapshots (for example
every 15 minutes) to show a backlog trend. Assignment in `conversations/meta`: nearly
everything is assigned to 165591, but 27 conversations are assigned to another (former) user
and 275 historic ones are unassigned.

### 3.10 Raw event log: `GET /api/v1/accounts/155355/reporting_events`

| Param | Works? |
|---|---|
| `since`, `until` (on event `created_at`) | Yes |
| `name` | Yes (`first_response`, `reply_time`, `conversation_resolved`, `conversation_opened`) |
| `inbox_id` | Yes |
| `page` | Yes. **Fixed 25 rows per page**; `per_page` is ignored. |
| `conversation_id` | **Ignored** (returns everything) |

```json
{ "payload": [{ "id": 1, "name": "first_response", "value": 167169, "value_in_business_hours": 0,
    "event_start_time": "2026-09-11T22:26:24Z", "event_end_time": "2026-09-13T20:52:33Z",
    "account_id": 155355, "inbox_id": 99613, "user_id": 165591, "conversation_id": 58233882,
    "created_at": "...", "updated_at": "..." }],
  "meta": { "count": 848, "current_page": 1, "total_pages": 34 } }
```

`conversation_id` is Chatwoot's **internal DB id** (for example 58233882), not the display id
the v1 conversation API uses as `id` (for example 11904). The v1 conversation JSON does not
expose the internal id. **Events cannot be joined to conversations or labels.** A heuristic
(matching `conversation_opened.event_start_time` to `created_at`) matched only 85 of 173
uniquely. For per-conversation work, use activity messages (`message_type` 2) from
`/conversations/{id}/messages`, which use the display id.

Paging (about 850 events and 34 pages per day; about 170 requests for 7 days):

```ts
interface Ev { id: number; name: string; value: number; conversation_id: number; user_id: number | null }
async function fetchEvents(since: number, until: number, name?: string): Promise<Ev[]> {
  const first = (await chatwootClient.get('/reporting_events', { params: { since, until, name, page: 1 } })).data;
  const all: Ev[] = [...first.payload];
  for (let page = 2; page <= first.meta.total_pages; page++) {    // or 4-6 in parallel
    all.push(...(await chatwootClient.get('/reporting_events', { params: { since, until, name, page } })).data.payload);
  }
  return [...new Map(all.map((e) => [e.id, e])).values()];         // dedup by event id (pages can shift)
}
```

Then compute:

```ts
const fr = events.filter((e) => e.name === 'first_response').map((e) => e.value).sort((a, b) => a - b);
const median = fr[Math.floor(fr.length / 2)];
const resolvedUnique = new Set(events.filter((e) => e.name === 'conversation_resolved').map((e) => e.conversation_id)).size;
const reopens = events.filter((e) => e.name === 'conversation_opened' && e.value > 0).length;
```

Check `payload.length` against `meta.count`. The script cross-checks that the event totals and
means reproduce `/reports/summary` exactly, and they do.

### 3.11 Endpoints that exist but should not be used

| Endpoint | Result | Why not |
|---|---|---|
| `GET /v2/.../reports/bot_summary?type=account` | `{"bot_resolutions_count":0,"bot_handoffs_count":0,"previous":{...}}` | Always 0. **HTTP 500 without `type=account`.** |
| `GET /v2/.../reports/bot_metrics` | `{"conversation_count":1006,"message_count":1740,"resolution_rate":0,"handoff_rate":0}` | `conversation_count` = conversations created in the bot inbox (Support); the rates are 0; what `message_count` counts is **UNVERIFIED**. |
| `GET /v2/.../reports/conversation_traffic?timezone_offset=3` | CSV: `Timezone,(GMT+03:00) Baghdad`, then `Start of the hour,<6 dates>` and 24 rows | Ignores `since`/`until` (always the last 6 UTC days). Values are UTC hours; the offset only changes the header. Use `/reports?group_by=hour`. |
| `GET /v2/.../reports/agents\|inboxes\|labels\|teams\|conversations_summary` | CSV with humanized durations ("1 day 10 hours") | UTC dates in the header; the inboxes CSV has 5 header columns but 7 values per row. |
| `GET /v1/.../csat_survey_responses`, `/csat_survey_responses/metrics` | `[]`, `{"total_count":0,"ratings_count":{},"total_sent_messages_count":0}` | CSAT is disabled (`csat_survey_enabled: false`); 0 responses ever. |
| `business_hours=true` on any report | Time metrics become 0 | Working hours are disabled (inbox timezone UTC). |
| `type=team`, `/v2/.../reports/events`, `/summary_reports/bot`, `/reports/heatmap`, `/reports/agent_status` | 404 | Do not exist or no teams. |
| `/v2/.../reports/outgoing_messages_count` | 422 | Not a route; use `metric=`. |
| `/v1/.../conversations/{id}/reporting_events` | 404 | |

---

## 4. Computation recipe

1. **Window.** Helsinki calendar days: `since = localMidnight(firstDay)`, `until = localMidnight(lastDay + 1)`, or `now` for today. `timezone_offset = current Helsinki offset in hours`.
2. **Volume per day.** `/reports?metric=conversations_count&type=account&group_by=day&timezone_offset`. Per inbox: add `type=inbox&id=`. Assert `sum(buckets) == summary.conversations_count` and that bucket timestamps are local midnights.
3. **Intent mix.** `/summary_reports/label` for totals. For daily series, one `/reports?type=label&id=` call per label (about 25 calls). Store the daily numbers at end of day, because later label changes rewrite history. A conversation can carry several labels (sub-cancel 561 + refund 517 over 7 days, against 1092 conversations), so label counts do not add up to the total.
4. **Labels applied on a given day** (for example `refund-50` added today on an old ticket) are **not available from reports**. Read activity messages (`message_type` 2, content such as "added refund-50") from the conversation messages API.
5. **Messages.** Use `incoming_messages_count` as customer message volume. For public replies, count `message_type` 1 with `private=false` from messages, or use Firestore `sentReplies`; do not use `outgoing_messages_count`.
6. **Response times.** Page `reporting_events` (`name=first_response`, `reply_time`). Report the median and p90 as well as the mean. Bucket by event `created_at` in Helsinki time. For bot vs human, join Firestore data by conversation display id through the messages API; the events themselves cannot be joined.
7. **Resolutions.** `resolutions_count` = resolve actions. Unique resolved conversations = distinct `conversation_id` of `conversation_resolved` events. Reopens = `conversation_opened` with `value > 0`.
8. **Backlog.** Poll `live_reports/conversation_metrics` and store snapshots.
9. **Period comparison.** `/reports/summary` `previous`, or an explicit second call for calendar comparisons (see 3.4).
10. **Caching.** Past full days do not change for event-based metrics, except for late-arriving events, which were not observed. Label and status splits do change (see caveats). Cache past days and refresh today.

### Rate limits

- **HTTP 429 happens.** After about 300 GET requests within roughly a minute (several script runs back to back), Chatwoot Cloud answered `429` with body `Retry later`, `content-type: text/plain`, and **no `Retry-After` header**. It cleared within about 60 s. The exact limit is **UNVERIFIED**.
- The shared `chatwootClient` retries 429 only 4 times (2, 4, 8, 16 s), which may not be enough. The script wraps every call in a linear 15 s backoff (up to 8 attempts).
- Keep concurrency at 4 to 6. One 7-day script run is about 217 requests and takes 12 to 20 s.

---

## 5. Caveats and what is impossible

| Topic | Status |
|---|---|
| Separating bot and human in any Chatwoot report | **Impossible.** Single user token; `user_id` is always 165591 (a few `null`). Fix: give the bot its own AgentBot token, or use Firestore. |
| Labels added per day | **Impossible via reports.** Reports use current labels on the created cohort. Use activity messages or daily snapshots. |
| Joining `reporting_events` to conversations or labels | **Impossible directly** (internal ids). |
| Human first response after a bot acknowledgement | **Not measured.** `first_response` fires once per conversation, on the first reply, which is often the bot. Needs message-level or Firestore data (INFERENCE from Chatwoot behaviour; not separately tested). |
| Business-hours metrics, CSAT, teams | **Not configured** on this instance. |
| Status splits (`summary_reports/channel`, v1 `status`) | Current status, not status at the end of the window. |
| Label time metrics | Differ between `summary_reports/label` and `reports/summary?type=label`; do not mix them. |
| `outgoing_messages_count` | Includes private notes, which were 39% on Sep 13. |
| `reports/conversations` `pending` | Always 0; use `live_reports`. |
| Unknown metric names | Return 200 `{}` silently. |
| DST after 2026-10-25 | **UNVERIFIED** which offset to pass; assert bucket timestamps. |
| Nightly spike | Many conversations are created at 01:00 Helsinki (22:00 UTC): 141 of 1092 in the 7-day window. The cause is unknown; ask the owner. |

---

## 6. Real example (script output, 2026-09-14)

Produced by `chatwootReports.ts` at about 13:56 Helsinki on 2026-09-14. All cross-checks passed
(events fetched = `meta.count`, event totals and means = summary, daily sums = summary, inbox and
channel sums = summary, buckets on Helsinki midnight).

### 6.1 Last 1 local day

**Complete day 2026-09-13** (`--days=1 --complete-days`, since 1789246800, until 1789333200):

| Metric | 2026-09-13 | Previous (2026-09-12) |
|---|---:|---:|
| Conversations created | 163 | 100 |
| Incoming messages | 257 | 159 |
| Outgoing messages (incl. private notes) | 505 | 281 |
| Resolve events | 378 (356 unique conversations) | 192 |
| Avg first response time | 48.8 h (175530 s, 213 events) | 52.4 h |
| Avg resolution time | 122.8 h | 95.3 h |
| Avg reply time | 56.3 h | 56.8 h |

Raw event log (848 events: opened 173, resolved 378, first_response 213, reply_time 84):

| Event | Events | Unique conv. | Mean | Median | P90 | < 60 s |
|---|---:|---:|---:|---:|---:|---:|
| first_response | 213 | 213 | 48.8 h | 59.6 h | 73.9 h | 51 |
| reply_time | 84 | 79 | 56.3 h | 60.1 h | 74.0 h | 15 |
| conversation_resolved | 378 | 356 | 122.8 h | 68.2 h | 180.3 h | 45 |

Reopens 67; opened with value 0: 106.
Inboxes: Support 153 created / 344 resolve events; Hey 7 / 33; Scandi (Facebook) 3 / 1.
Channel (current status): Email 160 (open 36, pending 2, resolved 122); Facebook 3.
FRT distribution: Email 0-1h 52, 1-4h 2, 4-8h 0, 8-24h 1, 24h+ 157; Facebook 24h+ 1.
Labels (created / resolve events): sub-cancel 94/187, refund 83/213, ai-response 45/85,
sub-cancelled 26/86, order-status 14/39, other 9/24, not-delivered 7/18, change-address 5/14,
sub-cancelled-ai 5/12, business 3/12, product-defect 3/11, missing-packs 2/12, refund-full 2/7,
change-contact 1/4, discount-issue 1/1, reshipped 0/9, no-country 0/3, refund-30 0/1, refund-50 0/1.
Hourly created (Helsinki): 00h 5, **01h 38**, then 1 to 10 per hour.
bot_metrics: conversation_count 153, message_count 179, rates 0.

**Today so far, 2026-09-14 00:00 to 13:56** (`--days=1`): created 107, incoming 186, outgoing 397,
resolve events 270 (255 unique), avg FRT 24.9 h over 162 events (median 28.1 h, p90 44.8 h, 34 under 60 s),
reopens 51. Labels: refund 64, sub-cancel 61, ai-response 24, other 8, order-status 7.
(`previous` here is the 13 h 56 min before midnight: 74 created.)

### 6.2 Last 7 local days

**Complete days 2026-09-07 to 2026-09-13** (`--days=7 --complete-days`, since 1788728400, until 1789333200):

| Metric | Window | Previous 7 days |
|---|---:|---:|
| Conversations created | 1140 | 931 |
| Incoming messages | 1716 | 1501 |
| Outgoing messages (incl. private notes) | 2591 | 2328 |
| Resolve events | 1511 (1229 unique conversations) | 1415 |
| Avg first response time | 34.8 h (125452 s, 870 events) | 23.7 h |
| Avg resolution time | 99.5 h | 78.9 h |
| Avg reply time | 43.9 h | 27.8 h |

| Local day | Created | Incoming | Outgoing | Resolve events | Avg FRT |
|---|---:|---:|---:|---:|---:|
| 2026-09-07 | 155 | 229 | 284 | 118 | 9.2 h |
| 2026-09-08 | 199 | 309 | 437 | 233 | 33.0 h |
| 2026-09-09 | 157 | 253 | 379 | 232 | 32.4 h |
| 2026-09-10 | 205 | 270 | 347 | 170 | 14.6 h |
| 2026-09-11 | 161 | 239 | 358 | 188 | 32.7 h |
| 2026-09-12 | 100 | 159 | 281 | 192 | 52.4 h |
| 2026-09-13 | 163 | 257 | 505 | 378 | 48.8 h |

Raw event log (3798 events: opened 1019, resolved 1511, first_response 870, reply_time 398; 4 with `user_id` null):

| Event | Events | Unique conv. | Mean | Median | P90 | < 60 s |
|---|---:|---:|---:|---:|---:|---:|
| first_response | 870 | 870 | 34.8 h | 45.6 h | 71.4 h | 348 |
| reply_time | 398 | 296 | 43.9 h | 51.9 h | 72.3 h | 108 |
| conversation_resolved | 1511 | 1229 | 99.5 h | 54.7 h | 169.4 h | 329 |

Reopens 348. Inboxes (created / resolve events / avg FRT): Support 1006 / 1363 / 32.0 h;
Hey 123 / 141 / 55.8 h; Scandi 11 / 7 / 65.1 h. Channel: Email 1129 (open 89, pending 6, resolved 1034),
Facebook 11 (open 2, resolved 9). FRT distribution: Email 0-1h 357, 1-4h 7, 4-8h 14, 8-24h 3, 24h+ 482; Facebook 24h+ 7.

Labels, 7 complete days (`summary_reports/label`, created / resolve events; daily created from `/reports?type=label`):

| Label | Created | Resolve events | Daily created Sep 7..13 |
|---|---:|---:|---|
| sub-cancel | 579 | 799 | 79, 80, 62, 120, 85, 59, 94 |
| refund | 519 | 711 | 66, 80, 71, 99, 79, 41, 83 |
| ai-response | 337 | 509 | 50, 56, 38, 65, 54, 29, 45 |
| sub-cancelled | 191 | 278 | 29, 26, 23, 38, 27, 22, 26 |
| order-status | 129 | 211 | 13, 39, 24, 17, 13, 9, 14 |
| other | 95 | 117 | 14, 23, 16, 10, 14, 9, 9 |
| not-delivered | 54 | 103 | 14, 6, 12, 6, 7, 2, 7 |
| business | 40 | 45 | 8, 9, 6, 8, 3, 3, 3 |
| sub-cancelled-ai | 37 | 82 | 6, 5, 4, 9, 4, 4, 5 |
| change-address | 32 | 59 | 9, 2, 6, 5, 2, 3, 5 |
| missing-packs | 23 | 52 | 2, 3, 5, 4, 1, 6, 2 |
| product-defect | 13 | 34 | 1, 0, 1, 4, 4, 0, 3 |
| refund-full | 11 | 34 | 3, 0, 3, 0, 1, 2, 2 |
| change-contact | 8 | 14 | 1, 2, 1, 1, 1, 1, 1 |
| no-country | 6 | 11 | 2, 1, 0, 0, 3, 0, 0 |
| reshipped | 5 | 45 | 1, 1, 1, 1, 0, 1, 0 |
| discount-issue | 4 | 4 | 0, 1, 1, 0, 0, 1, 1 |
| refund-30 | 3 | 27 | 2, 1, 0, 0, 0, 0, 0 |
| refund-50 | 1 | 18 | 0, 0, 1, 0, 0, 0, 0 |

Label FRT (from `summary_reports/label` only): ai-response 1.0 h, sub-cancelled-ai 16 s, sub-cancel 22.2 h, refund 47.4 h.
Hourly created, 7 days (Helsinki): 00h 20, **01h 124**, 02h 43, and 23 to 68 per hour otherwise.
bot_metrics: conversation_count 1006, message_count 1740, rates 0.

**7 days including today, 2026-09-08 00:00 to 2026-09-14 13:56** (`--days=7`): created 1092
(previous 870), incoming 1673, outgoing 2704, resolve events 1663 (1345 unique), avg FRT 35.2 h over
957 events (median 43.0 h, p90 71.2 h, 326 under 60 s), reopens 368. Labels: sub-cancel 561,
refund 517, ai-response 311, sub-cancelled 166, order-status 123.

### 6.3 Live snapshot, 2026-09-14 10:56Z (13:56 Helsinki)

`live_reports/conversation_metrics`: open 191, pending 130, unattended 179, unassigned 0.
`conversations/meta` all_count: all 11916, open 190, pending 130, resolved 11596, snoozed 0.
`reports/conversations` returned the same values except `pending: 0`.

---

## 7. Open questions for the owner

1. Should the dashboard show Chatwoot's mean FRT (35 to 49 h, mixing instant bot replies with backlog human replies), or medians and a bot/human split computed from `reporting_events` plus Firestore?
2. Could the AgentBot use its own Chatwoot AgentBot access token? Native `bot_resolutions_count` and `bot_handoffs_count` would then work.
3. What causes the nightly spike of new conversations at 01:00 Helsinki (22:00 UTC)?
4. Should the dashboard store daily label snapshots so historic label counts stop changing?
5. Enable CSAT on the email inboxes? Configure working hours (currently disabled, timezone UTC)?

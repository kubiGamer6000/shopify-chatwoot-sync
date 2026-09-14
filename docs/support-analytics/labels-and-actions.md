# Label analytics: ticket intents and actions taken

This guide explains how to answer two questions from Chatwoot labels:

1. **What are tickets about?** (intent labels such as `refund` or `sub-cancel`)
2. **What was done?** (action labels such as `refund-30`, `reshipped`, `sub-cancelled` and `sub-cancelled-ai`, plus the bot label `ai-response`)

It is written for an engineer or coding agent building the support analytics dashboard. Everything here was checked against the live APIs on 2026-09-14. Anything that could not be checked is marked **UNVERIFIED** or **IMPOSSIBLE**.

Reference implementation: `src/scripts/analytics/labelsAndActions.ts` (read-only).

```bash
npx tsx src/scripts/analytics/labelsAndActions.ts --days=7            # last 7 full local days
npx tsx src/scripts/analytics/labelsAndActions.ts --days=1            # yesterday only
# flags: --tz=Europe/Helsinki  --out=/home/dolan/support-analytics  --no-firestore  --no-v2  --concurrency=6
```

The script prints tables to stdout. It also writes `labels-and-actions_<N>d_<lastDay>.json` and `.md` to the `--out` directory. The output holds aggregates and conversation ids only, no customer PII.

---

## 1. Background: why this is harder than it looks

- Chatwoot has **one agent user**, "Scandi Gum" (id 165591). Ruth (the human agent), the dashboard app and the AI bot all act through it. **Chatwoot cannot tell you who did something.** The label name and its timing are the only attribution signal.
- Labels on a conversation object have **no timestamp**. To place a label on a day you must read the conversation's **activity messages**.
- The app adds labels with `addConversationLabels()` (`src/services/chatwootConversation.ts`). That function merges with the existing set and **skips the write if the label is already present**. As a result:
  - Chatwoot only records an event the **first time** a label lands on a conversation.
  - A second refund, a second cancelled subscription, or bot replies on later days in the same conversation produce **no new event**.
  - Labels are effectively never removed. There were 0 removals in the window and only 2 in all fetched history, both on 2026-06-02.
- Filtering conversations by label on the server **times out**: `GET /conversations?labels[]=` with `status=all` and `POST /conversations/filter` both return 422 "request took too long". You must pull conversations and filter them on the client.

---

## 2. Label catalogue and groups

Source: `GET /api/v1/accounts/{account}/labels`. On 2026-09-14 it returned 23 labels. The `id` is what the v2 label reports need.

| Group | Label | id | Description in Chatwoot | Who adds it |
|---|---|---:|---|---|
| intent | sub-cancel | 29684 | Customer wants to cancel sub | AI classifier |
| intent | refund | 29686 | | AI classifier |
| intent | order-status | 29685 | Customer asks about delivery | AI classifier |
| intent | other | 30403 | | AI classifier |
| intent | not-delivered | 31954 | | AI classifier |
| intent | business | 30410 | | AI classifier |
| intent | change-address | 29693 | | AI classifier |
| intent | missing-packs | 32876 | | AI classifier |
| intent | product-defect | 30228 | | AI classifier |
| intent | change-contact | 32454 | change contact info such as email, phone number | AI classifier |
| intent | no-country | 31949 | | AI classifier |
| intent | discount-issue | 33689 | asking about discount code | AI classifier |
| action | refund-30 | 31950 | | human (Ruth) |
| action | refund-50 | 31951 | | human |
| action | refund-70 | 31952 | | human (unused, 0 in 9 days) |
| action | refund-full | 31953 | | human |
| action | reshipped | 32257 | | human |
| action | sub-cancelled | 31955 | | human: dashboard cancel (`routes/dashboardApp.ts:257`) or manual |
| action | sub-cancelled-ai | 36421 | | AI, after a successful Skio cancel (`aiResponder.ts:503`, only when `result.cancelled > 0`) |
| action | changed-contact | 32455 | changed contact info like phone number or email | human (unused, 0 in 9 days) |
| action | tp-free-pack | 38289 | trust pilot | human (unused, 0 in 9 days) |
| bot | ai-response | 36466 | | AgentBot, when it sends a reply (`aiResponder.ts:594`) |
| bot | ai-reply | 40984 | | unused |

- The intent list is the same as `CLASSIFICATION_LABELS` in `src/services/classifier.ts`. The classifier cannot assign action labels.
- `escalated`, `ai-resolved`, `product-not-received` and `cancel-order` are **not** in the label list, and none of them appears on any conversation active in the last 9 days. Treat them as legacy. If they ever show up, the script counts `product-not-received` and `cancel-order` as intents and `ai-resolved` as a bot label.
- **A single label event never mixes groups.** Over the 7-day window the event composition was intent-only 1377, bot-only 369 and action-only 355, with 0 mixed events.

---

## 3. Metric definitions

All days are **Europe/Helsinki calendar days**. Compute each day's offset from the date itself: UTC+3 until 2026-10-25, then UTC+2. "Last N days" means the N **complete** local days ending yesterday. Report today separately and mark it partial.

### Metric A: tickets per intent, by conversation-created day

> For local day D: the number of conversations with `created_at` in D that **currently** carry intent label L.

- It also gives total conversations created, conversations with no intent label, and the current status mix.
- It is a **snapshot**. Numbers for past days change whenever labels are added later.
- Chatwoot's v2 report `type=label&id=<id>&metric=conversations_count` returns **exactly** this number (verified for every day). Section 4.4 shows the call.
- Use it for "what were the tickets created on day D about?"

### Metric B: labels added per day

> For local day D: the number of **distinct conversations** that got label L **for the first time** in D. This comes from activity messages reading "Scandi Gum added ...".

- For **intents**, B is close to A. The classifier labels within 60 s of the customer's message. B is a little higher because follow-up messages in older conversations add new intents.
- For **actions**, B is the correct basis. Human action labels are added a median of 57 to 227 hours after the conversation is created, so A would put the work on the wrong day. Over 7 days, `refund-full` is 22 by B but only 11 by A.
- **Name it honestly in the UI.** Call it "conversations newly tagged `refund-full`", not "refunds issued". One label says nothing about how many refunds, how large they were, or how many subscriptions were involved, and repeat actions in the same conversation are invisible.

### Metric C: intent combinations

> For conversations created in the window: sort each conversation's current intent labels, join them with `+`, and count the resulting keys (for example `refund+sub-cancel`).

Use `(no intent)` for conversations with no intent label.

### Metric D: action by intent (context)

> For each action label: take the conversations newly tagged with it in the window, and group them by their current intent combination.

### Human vs AI cancellations

- `sub-cancelled-ai` (Metric B) is the **only** per-event record of AI subscription cancellations in Chatwoot or Firestore.
- `sub-cancelled` (Metric B) is human: the dashboard cancel button or a manual label.
- Also report the overlap: conversations that got both labels in the window. It was 0 in the verified window.

### Bot replies

- `ai-response` (Metric B) is "conversations where the bot replied **for the first time** that day". It is **not** a count of bot messages.
- For message counts, use `sentReplies` with `source in ('agent-bot', 'agent-bot-holding')`, but **only from 2026-09-14T08:00Z**. That is when the deploy started logging bot replies; the first row is at 08:00:56Z. The bot was replying before then, but those replies were not logged.

---

## 4. API reference

Environment accessors live in `src/config/env.ts`: `env.chatwootBaseUrl`, `env.chatwootAccountId` and `env.chatwootApiToken`. Every Chatwoot call is a **GET** with header `api_access_token: <token>`.

```ts
import 'dotenv/config';
import axios from 'axios';
import { env } from '../../config/env.js';
import { chatwootClient } from '../../services/chatwoot.js'; // v1 client, base /api/v1/accounts/{id}, has 429 backoff

const v2 = axios.create({
  baseURL: `${env.chatwootBaseUrl}/api/v2/accounts/${env.chatwootAccountId}`,
  headers: { api_access_token: env.chatwootApiToken },
  timeout: 60_000,
});
```

### 4.1 List labels

`GET /api/v1/accounts/{account}/labels`

Response: `{ payload: [{ id, title, description, color, show_on_sidebar }] }`

```ts
const { data } = await chatwootClient.get<{ payload: { id: number; title: string; description: string }[] }>('/labels');
const labelId = new Map(data.payload.map((l) => [l.title, l.id]));
```

### 4.2 List conversations (current labels, created_at)

`GET /api/v1/accounts/{account}/conversations?status=all&assignee_type=all&sort_by=last_activity_at_desc&page=N`

- Response: `data.meta { mine_count, assigned_count, unassigned_count, all_count }` and `data.payload[]`, 25 per page.
- Fields used: `id`, `status`, `labels[]`, `inbox_id`, `created_at` (unix s) and `last_activity_at` (unix s). `first_reply_created_at`, `waiting_since` and `updated_at` are also present.
- **Stop rule:** stop when a page has fewer than 25 rows, or its last row has `last_activity_at < windowStart`.
- **Completeness (verified):** label activity messages bump `last_activity_at`. For all 1625 conversations checked, `last_activity_at` equals the newest message's `created_at`, activity messages included. So every conversation that was created or labelled in the window has `last_activity_at >= windowStart`.
- **The list shifts while you page.** A conversation with new activity jumps to page 1, pushing rows down. That causes duplicates, and rows can also be missed. Always **dedupe by id**, then **re-page from page 1** until you reach rows older than the time the pull started, and merge. This was observed: one run double-counted a single conversation, giving created 101 instead of 100 on 2026-09-12. The dedupe and re-scan fixed it.

```ts
async function conversationsActiveSince(sinceSec: number) {
  const byId = new Map<number, Conv>();
  const pass = async (stopBelow: number) => {
    for (let page = 1; ; page++) {
      const { data } = await chatwootClient.get('/conversations', {
        params: { status: 'all', assignee_type: 'all', sort_by: 'last_activity_at_desc', page },
      });
      const rows: Conv[] = data.data.payload;
      for (const c of rows) {
        const prev = byId.get(c.id);
        if (c.last_activity_at >= sinceSec && (!prev || c.last_activity_at >= prev.last_activity_at)) byId.set(c.id, c);
      }
      const last = rows.at(-1);
      if (rows.length < 25 || !last || last.last_activity_at < stopBelow) return;
    }
  };
  const pullStart = Math.floor(Date.now() / 1000) - 60;
  await pass(sinceSec);   // main pass
  await pass(pullStart);  // re-scan the top to catch rows that jumped up
  return [...byId.values()];
}
```

### 4.3 Conversation messages (label events)

`GET /api/v1/accounts/{account}/conversations/{id}/messages[?before=<smallest message id of previous page>]`

- Response: `{ meta, payload: [{ id, message_type, private, created_at, content, content_attributes, source_id, ... }] }`, with **at most 20 messages per page**.
- `message_type`: 0 incoming, 1 outgoing, 2 activity. `private: true` marks internal notes.
- **Pagination (verified):** a page with fewer than 20 messages is the last page. Across ~1500 short pages, requesting one more page returned nothing every time. Also stop once the oldest message on a page is older than `windowStart`.
- Cost is about 1.05 calls per conversation (7 days: 1564 conversations, 1652 API calls in total).

**Label event format (verified on 2,500+ events):**

| Field | Value |
|---|---|
| `message_type` | `2` |
| `content` | `Scandi Gum added refund, change-address` or `Scandi Gum removed order-status` |
| `content_attributes` | `{}` (no label list, no actor id) |
| `sender` | absent or null |
| `source_id` | `null` |

Several labels can appear in one event, separated by comma and space. The actor is **always** "Scandi Gum", so the text cannot tell bot from human.

Other activity texts you will see and should ignore here (7-day counts): `Conversation was marked resolved by <who>` 1783, `Assigned to Scandi Gum by <who>` 1228, `Conversation was reopened by <who>` 1109, `Scandi Gum self-assigned this conversation` 17, `Conversation was marked open by <who>` 1. `<who>` is "Scandi Gum", "Automation System", "Default Policy" or "system due to an error with the agent bot."; label events never carry a "by".

```ts
const LABEL_EVENT_RE = /^(.+?) (added|removed) ([a-z0-9_-]+(?:, [a-z0-9_-]+)*)$/;

async function messagesSince(convId: number, sinceSec: number) {
  const all: Msg[] = [];
  let before: number | undefined;
  for (;;) {
    const { data } = await chatwootClient.get(`/conversations/${convId}/messages`, { params: before ? { before } : {} });
    const page: Msg[] = data.payload;
    all.push(...page);
    if (page.length < 20 || Math.min(...page.map((m) => m.created_at)) < sinceSec) break;
    before = Math.min(...page.map((m) => m.id));
  }
  return all;
}

// events
for (const m of msgs) {
  if (m.message_type !== 2) continue;
  const hit = LABEL_EVENT_RE.exec((m.content ?? '').trim());
  if (!hit) continue;
  const op = hit[2] as 'added' | 'removed';
  for (const label of hit[3]!.split(', ')) {
    // key for dedupe: `${convId}|${label}|${localDay(m.created_at)}|${op}`
  }
}
```

### 4.4 v2 per-label time series (creation-day semantics)

`GET /api/v2/accounts/{account}/reports?metric=conversations_count&type=label&id=<numeric label id>&since=<unix>&until=<unix>&group_by=day&timezone_offset=3`

- Response: `[{ value, timestamp }]`, where `timestamp` is the start of the local-day bucket.
- `id` **must be numeric**. `id=refund` returns 404 `{"error":"Resource could not be found"}`.
- `conversations_count` is the number of conversations **created** in the bucket that carry the label **now**, i.e. Metric A. The script cross-checks refund, sub-cancel, sub-cancelled, sub-cancelled-ai and refund-full each run; all matched.
- `resolutions_count` with `type=label` counts resolution **events** on any conversation that has the label, whatever its creation date. It does not count label additions.
- Align `since` to local midnight, e.g. `1788728400` = 2026-09-07 00:00 Helsinki. Otherwise the first bucket is partial.
- `timezone_offset` is a single number, so a window that crosses a DST change is off by one hour on one side. Split the call at the DST boundary.

```ts
const { data } = await v2.get<{ value: number; timestamp: number }[]>('/reports', {
  params: { metric: 'conversations_count', type: 'label', id: labelId.get('refund'), since, until, group_by: 'day', timezone_offset: 3 },
});
```

### 4.5 v2 label summary (all labels, one call)

`GET /api/v2/accounts/{account}/summary_reports/label?since=<unix>&until=<unix>&timezone_offset=3`

- Response: `[{ id, name, conversations_count, resolved_conversations_count, avg_first_response_time, avg_resolution_time, avg_reply_time }]`. Times are in seconds.
- `conversations_count` has creation-day semantics (Metric A totals). `resolved_conversations_count` counts resolution events and can be far higher: `refund-30` shows 3 created vs 27 resolved.
- **Neither field counts label additions.** Do not use this for actions per day.
- On 1-day windows the `avg_*` values looked unreliable (many zeros). Prefer windows of 7 days or more for averages.
- `GET /api/v2/accounts/{account}/reports/label` does not exist (404).

### 4.6 Firestore (read-only, optional cross-checks)

`getDb()` from `src/services/firestore.ts`. The `ts` field is epoch milliseconds.

| Collection | Shape | Use | Caveat |
|---|---|---|---|
| `agentBotDecisions/{convId}` | `conversationId, action (responded, escalated, handed-off, closed, skipped, failed, swept-open), classified[], routingLabels[], ts, at`; `route`, `reason` and `intents` are optional | Bot outcome snapshot | Holds **only the latest** decision per conversation, so past-day buckets drift. Always store the pull time. |
| `classifications/{convId}` | `labels[], reasoning, model, ts` | Confirms the classifier applied an intent | Latest only |
| `sentReplies` (auto id) | `conversationId, message, source (dashboard, agent-bot, agent-bot-holding), ts` | Reply message counts | Bot rows exist only from 2026-09-14T08:00Z. There are no dashboard rows on some Sundays (2026-08-30, 2026-09-06). |

```ts
const db = getDb();
const snap = await db!.collection('agentBotDecisions').where('ts', '>=', windowStartSec * 1000).get();
```

A decision with `action: 'responded'` and `sub-cancel` does **not** mean a subscription was cancelled. Many such replies say "no active subscription found". In the 7-day window, only 38 of about 275 such decisions belong to conversations with a `sub-cancelled-ai` event. No collection records Skio cancellations.

---

## 5. Computation recipe

1. **Window.** `today = localDay(now)`. `firstDay = today - N`, `lastDay = today - 1`. `windowStart = localMidnight(firstDay)`, `windowEnd = localMidnight(today)` (exclusive). Build local midnights with `Intl.DateTimeFormat` and `timeZone: 'Europe/Helsinki'` (see `localMidnight()` in the script) so DST is handled.
2. **Labels.** Fetch `GET /labels` to build the title→id map, and assign groups from the table in section 2.
3. **Conversations.** Pull everything with `last_activity_at >= windowStart` (section 4.2), with dedupe and re-scan.
4. **Metric A.** Bucket each conversation by `localDay(created_at)`. Count current intent labels, total conversations, conversations with no intent, and status.
5. **Messages.** For each conversation, fetch messages back to `windowStart` (section 4.3) with concurrency 4 to 6. Keep:
   - label events (type 2 and the regex match),
   - incoming timestamps (type 0),
   - public outgoing timestamps (type 1 and `!private`), used by the attribution checks.
6. **Dedupe events** on `(conversationId, label, localDay, op)`. Duplicate adds of the same label on one conversation are rare but do happen: 1 case since 2026-09-07 (conversation 11162 has two identical `added refund` activity events at 2026-09-09T00:52:18Z, the same second; cross-check pull 2026-09-14T11:42Z). Always dedupe. Count `removed` separately; it was 0 in the window.
7. **Metric B.** Count distinct conversations per `(day, label)` for `added`.
8. **Metric C.** Build combinations from the current intent labels of conversations created in the window, and separately for the last day.
9. **Metric D.** Cross-tab action-label conversations by their current intent combination. Compute the `sub-cancelled` / `sub-cancelled-ai` overlap.
10. **Cross-checks (optional).** Compare the v2 `type=label` series with Metric A; they should match exactly. Take a Firestore decision snapshot and record the pull time.
11. **Persist.** Store Metric B per day **once the day is complete**. Label-added counts for a past day do not drift, because labels are not removed and events are immutable. Metric A for past days does drift, so recompute it or store it with an "as of" time.

### Attribution rules (heuristic, see section 7)

| Label(s) | Attributed to | Evidence (events since 2026-09-07, including 2026-09-14 partial) |
|---|---|---|
| intent labels | AI classifier | 1375 of 1377 intent-only events came 0 to 60 s after an incoming message. The earlier verified research found 1076 of 1373 also match `classifications/{convId}` (subset, ts ±120 s). Only the latest classification is stored, so older events cannot match. |
| `ai-response` | AgentBot | 369 of 369 within ±30 s of a public outgoing message |
| `sub-cancelled-ai` | AgentBot (Skio cancel) | 40 of 40 followed by a public outgoing message within 120 s. Median conversation age at add time is about 0.1 h. |
| `sub-cancelled` | human | 194 of 240 within ±120 s of a public outgoing message (cancel plus reply from the dashboard) |
| `refund-30`, `refund-50`, `refund-full`, `reshipped` | human | 14/16, 7/8, 21/29 and 22/22 within ±120 s of a public outgoing message. No code path adds them. |

---

## 6. Performance and rate limits

- A 7-day run took about 2.5 minutes: 64 list pages, 1564 conversations and 1652 GET calls, with concurrency 6. A 1-day run still needs about 720 conversations, because resolves and reopens bump `last_activity_at` on old conversations. It took about 1.5 minutes and 756 calls.
- Retry on 429, 5xx and network errors with exponential backoff (the script uses 1.5 s × 2^n, up to 5 retries). `chatwootClient` already handles 429 with a `Retry-After` header.
- **Caching for a dashboard.**
  - Label events for completed days never change, so cache events per conversation and fetch only messages newer than your last sync, keyed on `last_activity_at` greater than the last run.
  - Metric A for recent days changes; the v2 `type=label` endpoint is the cheapest way to refresh it (one call per label per metric).
- **Firestore quota.** Cross-check queries read about 1 document per decision or reply in the window (roughly 1-2k reads for 7 days). During this work Firestore returned `8 RESOURCE_EXHAUSTED: Quota exceeded`. The script treats this as non-fatal. Do not poll Firestore from a dashboard, because the production app shares the quota.

---

## 7. Caveats: what is impossible or unverified

- **IMPOSSIBLE from Chatwoot:** knowing who added a label. Every event reads "Scandi Gum added ...". Attribution comes from the label name plus the timing heuristics above.
- **Heuristic:** "intent labels are AI". A human adding an intent in the Chatwoot UI right after a customer message would look identical. The classifier can also run later, from the pending sweeper (`pendingSweeper.ts:118`) or the AgentBot queue (`agentBotQueue.ts:90`), not only from the incoming-message webhook. 2 of 1377 intent events did not follow an incoming message within 60 s. **UNVERIFIED** whether Ruth ever adds intents by hand.
- **Only first-time tagging is visible.** Repeat refunds, cancellations or bot replies in the same conversation produce no event. Refund size is not in the label either: "30%" is a bucket, and real refunds vary (29%, 31%, ...). Use Shopify refunds for amounts (see `shopify-refunds.md`).
- **UNVERIFIED** whether every refund or reship gets a label. Only 41 conversations got any refund-% label in 7 days, against 519 new tickets with the `refund` intent. Refunds made in Shopify admin, by call support or by Chargeflow are probably not labelled.
- **IMPOSSIBLE:** an independent count of AI subscription cancellations from Firestore. `agentBotDecisions` holds the latest decision only, `sentReplies` bot rows start on 2026-09-14, and no collection stores the Skio cancel. A Skio-side cross-check was not done.
- **Firestore snapshot numbers drift.** For example, "responded with sub-cancel" read 276, then 274 minutes later, as documents were overwritten. **UNVERIFIED in this run** because Firestore quota was exhausted. The Firestore figures in section 8 come from the verified research pull at about 10:30Z.
- **Not observed, so the event format is untested for them:** `refund-70`, `changed-contact`, `tp-free-pack`, `ai-reply`, `escalated`, `ai-resolved`, `product-not-received` and `cancel-order`, all with 0 uses in 9 days. The format is presumably the same.
- **The list shifts while paging.** Always dedupe and re-scan (section 4.2).
- **DST.** A v2 `timezone_offset` is a single value, so split calls at 2026-10-25.

---

## 8. Real example

Numbers are from `labels-and-actions.ts`, pulled **2026-09-14 10:58Z** (7-day run) and **11:01Z** (1-day run). Days are Europe/Helsinki.

- Last 1 day = **2026-09-13**.
- Last 7 days = **2026-09-07..2026-09-13**.
- 2026-09-14 is partial, up to about 14:00 local.

Both runs agree on every overlapping number. All v2 `type=label` cross-checks matched.

### 8.1 Conversations created (Metric A base)

| | 09-07 | 09-08 | 09-09 | 09-10 | 09-11 | 09-12 | 09-13 | 7d | 09-14* |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| conversations created | 155 | 199 | 157 | 205 | 161 | 100 | 163 | **1140** | 108 |
| no intent label | 1 | 0 | 0 | 3 | 0 | 0 | 2 | 6 | 0 |

Current status of conversations created 09-13: resolved 123, open 38, pending 2.

### 8.2 Intent labels, by created day (Metric A, current labels) vs by label-added day (Metric B)

| intent | 09-13 created | 09-13 added | 7d created | 7d added |
|---|---:|---:|---:|---:|
| sub-cancel | 94 | 103 | 579 | 592 |
| refund | 83 | 89 | 519 | 529 |
| order-status | 14 | 13 | 129 | 134 |
| other | 9 | 10 | 95 | 96 |
| not-delivered | 7 | 7 | 54 | 60 |
| business | 3 | 4 | 40 | 40 |
| change-address | 5 | 5 | 32 | 35 |
| missing-packs | 2 | 2 | 23 | 28 |
| product-defect | 3 | 4 | 13 | 16 |
| change-contact | 1 | 1 | 8 | 10 |
| no-country | 0 | 0 | 6 | 7 |
| discount-issue | 1 | 1 | 4 | 4 |

Per day (Metric A), 09-07..09-13:

- refund: 66, 80, 71, 99, 79, 41, 83
- sub-cancel: 79, 80, 62, 120, 85, 59, 94
- order-status: 13, 39, 24, 17, 13, 9, 14

### 8.3 Intent combinations (conversations created)

| combination | 7d (n=1140) | 09-13 (n=163) |
|---|---:|---:|
| sub-cancel | 305 | 44 |
| refund | 231 | 32 |
| refund+sub-cancel | 221 | 42 |
| order-status | 90 | 8 |
| other | 76 | 9 |
| business | 37 | 3 |
| change-address | 17 | 3 |
| not-delivered+refund | 17 | 3 |
| not-delivered | 16 | 1 |
| missing-packs | 15 | 1 |
| not-delivered+order-status | 9 | 0 |
| order-status+refund | 9 | 1 |
| order-status+sub-cancel | 8 | 1 |
| order-status+refund+sub-cancel | 6 | 2 |
| (no intent) | 6 | 2 |
| not-delivered+refund+sub-cancel | 5 | 1 |
| not-delivered+sub-cancel | 5 | 2 |
| other+sub-cancel | 5 | 0 |
| product-defect / product-defect+refund / product-defect+sub-cancel | 4 / 4 / 4 | 2 / 1 / 0 |

### 8.4 Actions: conversations newly tagged per day (Metric B)

| label | 09-07 | 09-08 | 09-09 | 09-10 | 09-11 | 09-12 | 09-13 | 7d | 09-14* |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| refund-30 | 3 | 2 | 4 | 1 | 1 | 0 | 1 | 12 | 4 |
| refund-50 | 1 | 0 | 2 | 1 | 0 | 2 | 1 | 7 | 1 |
| refund-70 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| refund-full | 3 | 6 | 4 | 1 | 1 | 4 | 3 | 22 | 7 |
| reshipped | 0 | 5 | 2 | 4 | 2 | 1 | 5 | 19 | 3 |
| sub-cancelled (human) | 12 | 30 | 32 | 14 | 11 | 24 | 71 | 194 | 46 |
| sub-cancelled-ai (AI) | 6 | 5 | 4 | 9 | 4 | 3 | 5 | 36 | 4 |
| changed-contact | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| tp-free-pack | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| ai-response (bot) | 51 | 55 | 39 | 65 | 54 | 31 | 46 | 341 | 28 |

- Distinct conversations with any refund-% label: 7 days **41**; 09-13 **5**.
- Human vs AI cancellations over 7 days: **194 vs 36**, about 84% human, with **0** conversations having both. On 09-13: 71 vs 5.
- The 71 `sub-cancelled` on 09-13 were spread 00:01-23:52 local, with evening clusters around 18:00-19:39 and 21:26-23:52. That looks like catch-up sessions, not one bulk backfill (from the verified research).

The same action labels by **created day** (Metric A snapshot, equal to v2) look very different. Do not use them for actions.

| label | 7d created-snapshot | 7d added (B) | 09-13 created-snapshot | 09-13 added (B) |
|---|---:|---:|---:|---:|
| refund-30 | 3 | 12 | 0 | 1 |
| refund-50 | 1 | 7 | 0 | 1 |
| refund-full | 11 | 22 | 2 | 3 |
| reshipped | 5 | 19 | 0 | 5 |
| sub-cancelled | 191 | 194 | 26 | 71 |
| sub-cancelled-ai | 37 | 36 | 5 | 5 |
| ai-response | 337 | 341 | 45 | 46 |

### 8.5 Action by current intent (7 days)

- **sub-cancelled (194):** refund+sub-cancel 90, refund 49, sub-cancel 26, product-defect+sub-cancel 4, order-status 3, order-status+refund+sub-cancel 3, and a long tail.
- **sub-cancelled-ai (36):** sub-cancel 34, order-status+sub-cancel 1, refund+sub-cancel 1.
- **refund-30 (12):** refund+sub-cancel 9, missing-packs+refund 2, refund 1.
- **refund-50 (7):** refund+sub-cancel 3, plus 4 single combinations.
- **refund-full (22):** refund 8, refund+sub-cancel 4, not-delivered+refund 3, product-defect+refund 2, plus 5 others.
- **reshipped (19):** missing-packs 9, missing-packs+refund 2, not-delivered+refund 2, plus 6 others.
- **ai-response (341):** sub-cancel 255, order-status 55, order-status+sub-cancel 6, other 5, other+sub-cancel 5, refund+sub-cancel 5, and a tail.

The bot mostly answers pure cancellation and order-status tickets. Anything involving a refund goes to a human.

### 8.6 Chatwoot v2 `summary_reports/label`, 7 days (09-07..09-13)

`conversations_count` counts conversations created in the window, `resolved` counts resolution events, and times are in hours (API returns seconds).

| label | conversations_count | resolved | avg first response (h) | avg resolution (h) |
|---|---:|---:|---:|---:|
| sub-cancel | 579 | 799 | 22.2 | 31.0 |
| refund | 519 | 711 | 47.4 | 54.8 |
| ai-response | 337 | 509 | 1.0 | 8.8 |
| sub-cancelled | 191 | 278 | 47.0 | 58.4 |
| order-status | 129 | 211 | 25.3 | 30.7 |
| other | 95 | 117 | 43.8 | 56.4 |
| not-delivered | 54 | 103 | 44.1 | 50.8 |
| business | 40 | 45 | 57.9 | 52.5 |
| sub-cancelled-ai | 37 | 82 | 0.0 (16 s) | 3.3 |
| change-address | 32 | 59 | 28.9 | 52.1 |
| missing-packs | 23 | 52 | 47.8 | 52.1 |
| product-defect | 13 | 34 | 42.2 | 51.1 |
| refund-full | 11 | 34 | 47.6 | 56.9 |
| reshipped | 5 | 45 | 37.6 | 65.8 |
| refund-30 | 3 | 27 | 21.7 | 67.4 |
| refund-50 | 1 | 18 | 73.5 | 98.1 |

### 8.7 Firestore cross-check (snapshot, from the verified research pull at about 10:30Z)

Firestore was quota-exhausted during the script runs, so these numbers were **not** reproduced by the script.

- `agentBotDecisions`, latest decision per conversation, bucketed by the latest `ts`, 09-07..09-13:
  - escalated: 92, 106, 109, 137, 105, 87, 149
  - responded: 46, 53, 35, 59, 49, 26, 45
- Latest decisions for the 40 `sub-cancelled-ai` conversations (since 09-07, including today): responded with sub-cancel 37, escalated with sub-cancel+refund 2, responded with sub-cancel+order-status 1.
- "Responded" decisions with sub-cancel: about 275 (the count drifts). Only 38 of those conversations have `sub-cancelled-ai`.
- `sentReplies` by day, 09-07..09-13: dashboard only (42, 128, 121, 69, 112, 116, 242). On 09-14: dashboard 188, agent-bot 5, agent-bot-holding 15 (bot rows only after 08:00Z).

---

## 9. Open questions for the owner

1. Is the 09-13 spike in `sub-cancelled` (71, against 11-32 on other days) real volume, or catch-up labelling of earlier work?
2. Does Ruth label **every** refund and reship, including ones done in Shopify admin, by call support or by Chargeflow? (41 refund-% conversations against 519 refund-intent tickets.)
3. Should the dashboard date actions by label-added day (recommended) or by conversation created day?
4. Are `refund-70`, `changed-contact` and `tp-free-pack` retired? Can `escalated` and `ai-resolved` be dropped?
5. For bot activity, is "conversations with a first bot reply per day" (the `ai-response` label) enough, or are per-message counts needed (`sentReplies`, from 2026-09-14 only)?
6. Would you add a Firestore record per cancellation (for example a `subscriptionCancellations` collection with convId, subscriptionId, source ai/dashboard, ts)? It would allow exact AI vs human counts, including repeat cancellations in the same conversation.

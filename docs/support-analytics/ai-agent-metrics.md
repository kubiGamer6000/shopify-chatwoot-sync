# AI support agent (AgentBot) metrics

This guide is for the agent building the support analytics dashboard. It covers what the AI support agent (the Chatwoot AgentBot) did, what it cost, and what share of new customer tickets it handled without a human. Specifically:

- conversations processed by the AgentBot per outcome (answered, handed off with an acknowledgement, handed off silently, closed silently, failed, swept open),
- routing intents,
- public messages sent by the bot compared with human sends from the dashboard,
- AI subscription cancellations,
- reply safety guard interventions,
- AI token usage and estimated cost per kind and model,
- the share of new tickets the AI fully handled compared with tickets handed to a human.

Everything was checked on 2026-09-14 with read-only calls (Firestore reads, Chatwoot GETs). The reference implementation is `src/scripts/analytics/aiAgentMetrics.ts`. For the pipeline itself, see [docs/agent-bot.md](../agent-bot.md).

---

## 1. Facts that matter

| Fact | Value | Why it matters |
|---|---|---|
| Launch of intent routing and live acknowledgements | **2026-09-14T07:55:00Z** (`1789372500000` ms). First post-launch decision 08:00:57Z, first bot `sentReplies` row 08:00:56Z | `route`, `intents`, `reason` and bot `sentReplies` rows exist only from launch. Show earlier periods as "not tracked", never as 0. |
| Bot-routed inbox | Only **Support** (email, `99613`). `GET /inboxes/99613/agent_bot` returns bot 8501 "ScandiGPT"; Hey (`107519`) and Facebook (`128017`) return `{}` | 6 to 12% of new conversations never reach the bot (133 of 1,127 over 2026-09-07..13). This caps the AI-handled share. |
| Chatwoot users | One agent user, "Scandi Gum" (id 165591). The human agent and the bot both post as this user | Chatwoot cannot tell bot messages from human messages (same `sender`, no `sender_type`). Attribution comes from Firestore and labels. |
| Ownership by status | `pending` = bot, `open` = human, `resolved` = nobody. A customer reply to a resolved conversation reopens it as `pending` and the bot runs again | A conversation can be decided several times. See the latest-only caveat below. |
| Shadow mode | `acknowledgementShadow` has **0 docs ever**. Production went straight to live | Ignore this collection. |
| Timezone | Business day = **Europe/Helsinki** calendar day (UTC+3 now, UTC+2 after 2026-10-25) | Use a tz-aware conversion, not a fixed +3. |
| Firestore billing | Every returned document is a billed read. The project's daily read quota is shared with production. On 2026-09-14 at about 10:50Z it was exhausted (`8 RESOURCE_EXHAUSTED: Quota exceeded`) after a day of research exports | The dashboard must aggregate incrementally, not re-read 7 days on every page load (section 6). |

---

## 2. Metric definitions

All windows are half-open `[start, end)` in epoch ms. Store the exact boundaries next to every number.

### 2.1 AgentBot outcomes (conversation level, latest decision)

Source: `agentBotDecisions`. There is one doc per conversation, and **only the latest decision survives** (it is written with `set(..., {merge: true})`). A window count therefore means "conversations whose latest decision falls in the window". This number changes after the fact: when a conversation is processed again, its doc moves to the newer timestamp and **past windows lose rows**. Example: the window [07:55Z, 10:32Z) held 26 docs at 10:32Z and 24 at 10:40Z, because conversations 12009 and 12010 got newer decisions.

| Bucket | `route` / `action` | Meaning |
|---|---|---|
| **Answered** | `respond` / `responded` | The responder agent sent an answer (`sentReplies` `agent-bot`), added `ai-response`, resolved |
| **Handoff with acknowledgement** | `acknowledge` / `escalated` | Intents need a human. The bot sent an acknowledgement (usually), opened the conversation and left an `[AI HANDOFF]` note |
| **Responder escalated** | `respond` / `escalated` | The responder tried, then called `escalate_to_human`, or its reply was empty or blocked by the guard. Acknowledgement attempted |
| **Handed off silently** | `handoff` / `handed-off`, or any route with `handed-off` and reason `bot message cap reached (...)` | Opened for a human, no customer message |
| **Closed silently** | `close` / `closed` | Nothing to answer (auto-reply, spam, "thanks"). Private note, resolved |
| **Failed** | `failed` (no route) | Pipeline crashed. Opened for a human with a plain draft |
| **Swept open** | `swept-open` (no route) | The pending sweeper found an unanswered message older than 24h and opened it for a human |
| Skipped | `skipped` | Backfill runs only (not production traffic) |
| Pre-launch | any `action`, no `route` | Old code: `escalated` = opened + private draft (**no** customer message), `responded` = answered |

"Escalated" means handed to a human with an **attempted** acknowledgement. The acknowledgement can be withheld (`shouldSend: false`), in which case nothing is sent. To confirm a message went out, join a `sentReplies` row with `source = 'agent-bot-holding'` for the same conversation with `ts` in `[decision.ts - 15 min, decision.ts + 2 min]`. It is typically 10 to 30 s before the decision. Since launch, 14 of 14 escalations had one.

`failed` and `swept-open` are written without `route`/`intents`, so under `merge: true` a stale `route`/`intents` from an earlier run can remain on the doc. Always bucket by `action` first, and read `route`/`intents` only when `action` is not `failed`/`swept-open`. No such docs existed in the 7 days checked, so their real shape is **UNVERIFIED**.

### 2.2 Runs and messages (append-only, stable)

Append-only sources never lose rows, so they give stable per-day counts. Prefer them for anything shown as a history.

| Metric | Source | Definition |
|---|---|---|
| Bot answers sent | `sentReplies` `source = 'agent-bot'` | One row per public answer. Count messages and distinct conversations |
| Acknowledgements / holding replies sent | `sentReplies` `source = 'agent-bot-holding'` | The live acknowledgement **and** the canned holding fallback share this source |
| Human replies via the dashboard | `sentReplies` `source = 'dashboard'` | Only replies sent from the custom dashboard app. Replies typed in the Chatwoot UI are **not** logged |
| Responder runs | `aiUsage` `kind = 'responder'` | One row per completed tool loop (a run that throws writes no row) |
| Acknowledgements generated | `aiUsage` `kind = 'acknowledge'` | Includes ones the guard then blocked |

A conversation the bot answered and resolved, where the customer then wrote again and got escalated, shows only as "handed to human" under 2.1. Its earlier answer is still counted in `sentReplies`. Example: 12006 has `agent-bot` at 10:09:58Z, `agent-bot-holding` at 10:16:03Z, and a single decision `acknowledge/escalated` at 10:16:33Z.

### 2.3 Intents

For post-launch decisions (with `action` not `failed`/`swept-open`), count each element of `intents` (the routing intents, i.e. what needed handling at that run). Report **mentions** and **conversations with intents** separately, because one conversation can have several. `classified` holds all classifier labels raised anywhere in the conversation and is less useful for routing analysis. Intent values: `business`, `change-address`, `change-contact`, `discount-issue`, `missing-packs`, `no-country`, `not-delivered`, `order-status`, `other`, `product-defect`, `refund`, `sub-cancel`.

### 2.4 AI subscription cancellations

Nothing is written to Firestore when the bot cancels a Skio subscription. The only trace is the Chatwoot label `sub-cancelled-ai`, added by the cancel tool when `cancelled > 0`, and its activity message `Scandi Gum added sub-cancelled-ai` (message_type 2) with a timestamp. Count activity messages in the window. For comparison, human cancellations use the label `sub-cancelled` (exact label, not the `-ai` suffix).

- The label is added **before** the reply is sent. A conversation can carry `sub-cancelled-ai` while its final action is `escalated` (for example 11956), so a cancellation does not imply an AI-resolved ticket.
- Whether Skio actually cancelled is inferred from the label. Skio was not queried (**UNVERIFIED**).
- A label removed later is missed, since the scan only visits conversations that still carry it.

### 2.5 Guard interventions

Source: `responderGuardEvents` (append-only). Group by `outcome`, `source` and `violations[]`.

| `outcome` | Meaning |
|---|---|
| `blocked` | Reply (or acknowledgement, `source = 'holding_reply'`) was not customer-safe and was never sent. Conversation escalated or fallback sent |
| `missing-send-reply-tool` | Agent answered in free text instead of the tool. Salvaged and sent |
| `preamble-stripped` | Leading reasoning removed, then sent |
| `holding-fallback` | A generated holding reply was replaced with the canned one |

`blockedText` can contain customer data. Never copy it into the dashboard store.

### 2.6 Token usage and estimated cost

Source: `aiUsage`, one row per model call: `kind`, `model`, `inputTokens`, `outputTokens`, `conversationId?`, `contactId?`, `at`, `ts`.

- Exclude tooling kinds: anything ending in `-replay` (`classify-replay`, `acknowledge-replay`, `draft-replay`) and `smoke`.
- Take the model from each row. Do not infer it from dates: the resolver ran on both `claude-sonnet-4-6` and `claude-sonnet-5` between 2026-09-13T20:15Z and 2026-09-14T07:42Z.
- Pipeline grouping used by the script:

| Pipeline | Kinds |
|---|---|
| agentbot | `responder`, `acknowledge`, `acknowledge-shadow`, `holding` |
| shared (both pipelines) | `classify` (AgentBot and the human draft webhook), `resolver` (Shopify customer matcher), `structured`, `completion` |
| human-assist | `draft`, `draft-manual`, `summary` |

**ASSUMED price table** (Anthropic first-party list prices as cached in the claude-api skill on 2026-06-24, USD per 1M tokens; **not** this account's invoice):

| Model | Input | Output |
|---|---:|---:|
| claude-sonnet-5 | 2 | 10 |
| claude-sonnet-4-6 | 3 | 15 |
| claude-haiku-4-5 | 1 | 5 |
| claude-opus-5 (not seen in data) | 5 | 25 |

`cost = inputTokens * in / 1e6 + outputTokens * out / 1e6`. Label the result as a **lower-bound estimate**:

- Cache read/write tokens are not recorded (system prompts use `cache_control`). When the cache hits, `input_tokens` excludes those tokens, so billed input is higher than recorded.
- `customerResolver.ts` records usage of the **final turn only**. Resolver rows show `outputTokens` of about 5 before and after launch.
- Pre-launch `claude-sonnet-4-6` responder rows (old code) also recorded only the final turn (about 4 output tokens per call). Post-launch Sonnet 5 responder rows sum all turns (173 to 685 output tokens).

### 2.7 Share of new tickets the AI fully handled

This is conversation level, computed for conversations **created** in the window, and **provisional**: it depends on the current status and latest decision at computation time.

Denominator: Chatwoot conversations with `created_at` in the window (cross-check with v2 `conversations_count`), minus **outbound threads** that contain no incoming (message_type 0) message. For example 11882 and 11890 are business-initiated outreach, so the bot never ran on them. Call the result "customer tickets". Also show the Support-inbox-only share.

Buckets, applied in this order:

| Bucket | Rule |
|---|---|
| `outbound-no-customer-message` | No incoming message. Excluded from the denominator |
| `not-bot-routed-inbox` | `inbox_id != 99613` |
| `bot-did-not-run` | Support inbox, no decision doc (for example still waiting in the debounce) |
| `ai-final-but-human-involved` | Latest action `responded`/`closed`, but there is a dashboard reply for the conversation (any time since window start) or a human action label (`sub-cancelled`, `refund-30/50/70/full`, `reshipped`, `changed-contact`, `tp-free-pack`; the script also lists `changed-address`, which does not exist in the Chatwoot label catalogue and never matches) |
| `ai-answered-not-resolved-yet` | Latest action `responded`/`closed`, status not `resolved` (usually the customer replied and the bot has not run again yet) |
| **`ai-fully-handled:answered`** | Latest action `responded`, status `resolved`, no dashboard reply, no human action label |
| **`ai-fully-handled:closed-silently`** | Same with latest action `closed` |
| `handed-to-human:dashboard-replied` | Latest action `escalated`/`handed-off`/`failed`/`swept-open`, a dashboard reply exists |
| `handed-to-human:no-dashboard-reply` | Same without a dashboard reply (may still have been answered in the Chatwoot UI, which is invisible) |

The label `escalated` does not appear on any recent conversation, and `ai-response` is sticky (it stays on conversations that were later escalated, e.g. 12006, 12009, 12010). Use neither label as an outcome signal.

Silent closes (spam, "thanks") are counted inside "AI fully handled" but shown separately. Whether the headline KPI includes them is an open question for the owner.

---

## 3. API calls

### 3.1 Firestore (read-only)

Credential: `FIREBASE_BASE64_SERVICE_ACCOUNT` (base64 service-account JSON). In this repo use `getDb()` from `src/services/firestore.ts`. Every AI collection doc has `at` (ISO string) and `ts` (epoch ms). A single-field range on `ts` needs no composite index.

```ts
import 'dotenv/config';
import { getDb } from '../../services/firestore.js';

const db = getDb()!;
const since = Date.parse('2026-09-13T21:00:00Z'); // Helsinki 2026-09-14 00:00
const until = Date.now();

// Pick only what the dashboard needs; never store message / blockedText / reason text.
const [decisions, replies, guard, usage] = await Promise.all([
  db.collection('agentBotDecisions').where('ts', '>=', since).where('ts', '<', until).get(),
  db.collection('sentReplies').where('ts', '>=', since).where('ts', '<', until).get(),
  db.collection('responderGuardEvents').where('ts', '>=', since).where('ts', '<', until).get(),
  db.collection('aiUsage').where('ts', '>=', since).where('ts', '<', until).get(),
]);

const decisionRows = decisions.docs.map((d) => {
  const x = d.data();
  return {
    conversationId: Number(x.conversationId ?? d.id), // doc id = conversation id
    action: x.action as string,                        // responded|escalated|handed-off|closed|skipped|failed|swept-open
    route: (x.route ?? null) as string | null,         // respond|acknowledge|handoff|close (post-launch only)
    intents: Array.isArray(x.intents) ? (x.intents as string[]) : null,
    ts: x.ts as number,
  };
});
```

| Collection | Shape | Write pattern |
|---|---|---|
| `agentBotDecisions/<conversationId>` | `conversationId, action, route?, intents?, routingLabels, classified, reason?, at, ts` | **latest only** (merge) |
| `sentReplies/<auto>` | `conversationId, message (PII), source: dashboard / agent-bot / agent-bot-holding, at, ts` | append-only |
| `responderGuardEvents/<auto>` | `conversationId, outcome, source: send_reply / free-text / holding_reply, violations[], blockedText? (PII), at, ts` | append-only |
| `aiUsage/<auto>` | `kind, model, inputTokens, outputTokens, conversationId? (absent on resolver rows), contactId?, at, ts` | append-only |
| `classifications/<conversationId>` | `labels, currentIntents, needsReply, isAutoReply, isSpam, language, reasoning, model, at, ts` | latest only (AgentBot and draft webhook) |
| `acknowledgementShadow` | empty | not used |

Measured volumes (7 days to 2026-09-14T10:32Z): decisions 1,238 docs, sentReplies 1,037, guard events 22, aiUsage 6,512 (about 900 per day). Each query took 200 to 1,500 ms.

### 3.2 Chatwoot: list conversations

```
GET {CHATWOOT_BASE_URL}/api/v1/accounts/{CHATWOOT_ACCOUNT_ID}/conversations
    ?status=all&assignee_type=all&sort_by=last_activity_at_desc&page=N
Header: api_access_token: {CHATWOOT_API_TOKEN}
```

The response has `data.meta` (`all_count`, ...) and `data.payload[]` with 25 rows per page: `id`, `inbox_id`, `status`, `labels[]`, `created_at` (epoch s), `last_activity_at`, `first_reply_created_at`, `waiting_since`, `meta.sender` (PII). Stop when the last row on a page has `last_activity_at < windowStart`. That covers every conversation created or label-changed in the window. Dedupe by `id`.

```ts
import { chatwootClient } from '../../services/chatwoot.js'; // baseURL .../api/v1/accounts/<id>, retries 429

const byId = new Map<number, any>();
for (let page = 1; ; page++) {
  const { data } = await chatwootClient.get('/conversations', {
    params: { status: 'all', assignee_type: 'all', sort_by: 'last_activity_at_desc', page },
  });
  const rows = data.data.payload as { id: number; last_activity_at: number }[];
  rows.forEach((c) => byId.set(c.id, c));
  const last = rows.at(-1);
  if (!last || rows.length < 25 || last.last_activity_at * 1000 < windowStart) break;
}
```

Label filters (`labels[]` on GET, `POST /conversations/filter`) time out with 422. Do not use them. `first_reply_created_at` is also set by bot replies, so it is not a human first-response time after launch.

### 3.3 Chatwoot: conversation messages

```
GET /api/v1/accounts/{id}/conversations/{conversationId}/messages[?before=<smallest message id seen>]
```

Returns `payload[]` with about 20 messages per call: `id`, `message_type` (0 incoming, 1 outgoing, 2 activity, 3 template), `private`, `content` (PII), `created_at` (epoch s), `sender`. Page backwards with `before` until the oldest `created_at` is before the window start. Activity content for labels looks like `Scandi Gum added ai-response, sub-cancelled-ai`. Match with

```ts
const addedLabel = (label: string) =>
  new RegExp(`\\badded\\b.*(?:^|[\\s,])${label.replace(/-/g, '\\-')}(?![\\w-])`, 'i');
addedLabel('sub-cancelled').test('Scandi Gum added sub-cancelled-ai'); // false
```

Use it for: cancellation timestamps (2.4) and the incoming-message check (2.7, only for conversations with no decision or outside the Support inbox, since a decision implies a customer message).

### 3.4 Chatwoot v2 reports (denominator cross-check)

```
GET {CHATWOOT_BASE_URL}/api/v2/accounts/{id}/reports
    ?metric=conversations_count&type=account&since=<epoch s>&until=<epoch s>&group_by=day&timezone_offset=3
Header: api_access_token
-> [{ "value": 163, "timestamp": 1789246800 }, ...]   // timestamp = local midnight, epoch s
```

`type=inbox&id=99613` gives the Support inbox only. The counts matched the list-based counts exactly (2026-09-13: 163 both; 2026-09-14 partial: 105 both). `timezone_offset` is a fixed number, so a range crossing the DST change (2026-10-25) must be split. `resolutions_count` includes bot resolves and cannot separate AI from human.

---

## 4. Computation recipe

1. **Windows.** Convert Helsinki calendar days to UTC with a tz-aware function (the script uses `Intl.DateTimeFormat` with two offset passes). Keep `[start, end)` in ms and store them with the results.
2. **Firestore read.** One `ts >= start` query per collection, projecting to non-PII fields. Bucket each row by its local day of `ts`.
3. **Decisions.** Bucket by 2.1. Rows with `ts < launch` or no `route` go to `pre-launch:<action>`, except `failed`/`swept-open`. For post-launch `escalated`, check the `agent-bot-holding` join.
4. **Intents.** Mentions and conversations with intents (2.3).
5. **Messages.** `sentReplies` grouped by source: message count plus distinct `conversationId`. Before launch, show `agent-bot*` as "not tracked".
6. **Guard.** Group `responderGuardEvents` by outcome/source/violation.
7. **Cost.** Filter out tooling kinds, group by `kind` and `model`, apply the price table, sum per pipeline.
8. **Chatwoot scan.** List conversations active since the window start (3.2). Keep those with `created_at` in the window.
9. **Ticket buckets** (2.7). Build `decisionByConversation` from all decision docs with `ts` since the window start (a decision always follows creation, so this covers every created conversation). Build `dashboardConversations` from `sentReplies` `dashboard` rows since the window start. Fetch messages only where needed.
10. **Cancellations.** For conversations whose current labels include `sub-cancelled-ai` or `sub-cancelled`, page messages back to the window start and count matching activity messages by local day.
11. **Cross-check** the created counts per day against v2 `conversations_count`.
12. **Persist daily aggregates** once a local day has closed (for example at 03:00 Helsinki), and label the current and previous day as provisional.

### Edge cases

- **Mixed-code day.** 2026-09-14 has both pre-launch (no route) and post-launch decisions. Show both bucket families.
- **Reprocessed conversations.** A decision moves to its newest `ts`. Past windows lose rows. Use a stored snapshot for history.
- **Bot message cap.** `handed-off` with reason `bot message cap reached (N in 24h)` belongs with silent handoffs but is worth a separate counter (possible loop).
- **Pagination under live traffic.** A conversation that gets new activity jumps to page 1 during the scan and can be skipped. Re-read page 1 at the end and dedupe by id (the script does this), then cross-check the counts with v2 reports.
- **Tooling rows.** `*-replay` and `smoke` appear on days when the prompt tester or review script ran (for example $1.28 on 2026-09-13).
- **Chatwoot UI replies.** A human reply typed in Chatwoot after an AI resolve is indistinguishable from the bot. Since launch there were 0 dashboard sends, so such replies would be invisible and those conversations would count as AI-handled.

---

## 5. Caveats and what is impossible today

| Item | Status |
|---|---|
| Stable historical counts of AgentBot outcomes | **Impossible** from `agentBotDecisions` alone (latest only). Snapshot daily or add a run log (section 8) |
| Per-day **runs** that ended `closed` / `handed-off` / `failed` / `swept-open` | **Impossible** (no append-only record) |
| Bot messages before 2026-09-14T08:00Z | Not in Firestore. Only reconstructable per conversation from Chatwoot activity (`added ai-response`) and outgoing messages. Not done at scale |
| Human replies typed in the Chatwoot UI | Invisible and indistinguishable from the bot (same user) |
| Acknowledgement vs canned fallback | Both `agent-bot-holding`. A fallback can only be inferred when a `blocked`/`holding_reply` guard event exists near the send |
| Actual Anthropic spend | **UNVERIFIED**. Assumed list prices, no cache tokens, resolver output under-recorded, pre-launch responder rows broken, failed responder runs not recorded |
| Skio cancellation success | **UNVERIFIED** (inferred from the label) |
| `failed` / `swept-open` doc shape | Code verified. No production examples in 7 days (**UNVERIFIED** empirically) |
| Since-launch rates | The since-launch window at the time of writing is 2 h 37 min. Too small for rates. Rerun after 2026-09-15T07:55Z |

---

## 6. Performance and quota

| Call | Cost | Notes |
|---|---|---|
| Firestore, 1 local day, 4 collections | about 1,300 billed reads | aiUsage is about 70% of it |
| Firestore, 7 days | about 9,000 reads | Re-reading this on every dashboard load will exhaust the daily quota, as happened on 2026-09-14 |
| Chatwoot list, 1 day | about 30 pages | about 20 s |
| Chatwoot list, 7 days | about 65 pages | 1 to 2 min |
| Chatwoot messages | 1 call per about 20 messages | 1 day: about 150 conversations (cancellation labels plus no-decision checks). 7 days: several hundred. Concurrency 4. `chatwootClient` retries 429 with backoff |
| v2 reports | 1 call | fast |

Recommendations for the dashboard:

- **Incremental ingestion.** Keep a cursor per collection (`last ts seen`). Read only `ts > cursor` and upsert per-day aggregates into the dashboard's own store. aiUsage at about 900 docs per day is then a trivial cost.
- **Aggregation queries** on a `ts` range bill 1 read per 1,000 index entries. Only `count()` works with today's indexes: `db.collection('aiUsage').where('ts','>=',a).where('ts','<',b).count().get()` (verified 2026-09-14, it reproduced the per-day row counts of sentReplies, aiUsage and responderGuardEvents exactly). `sum('outputTokens')` / `sum('inputTokens')` on the same range query **fails** with `9 FAILED_PRECONDITION: The query requires an index` (it needs a composite index `ts, inputTokens, outputTokens`, which does not exist; verified 2026-09-14). Grouping by kind/model would also need composite indexes (`kind, ts`), which do not exist today. Note that even these small count queries hit `RESOURCE_EXHAUSTED` again on 2026-09-14 at about 11:45Z.
- Snapshot the ticket-share buckets for closed days. Recompute only today and yesterday.
- The script saves the Firestore rows it read (`<out>/raw/ai-agent-firestore_*.json`, no PII) and can rerun on them with `--firestore-snapshot=<file>`.

---

## 7. Running the script

```bash
npx tsx src/scripts/analytics/aiAgentMetrics.ts --days=7 --tz=Europe/Helsinki --out=/home/dolan/support-analytics
# --days=N              N complete local days ending yesterday, plus "today so far" and a rolling N*24h window
# --complete-days       drop today; data ends at local midnight
# --no-chatwoot         Firestore metrics only (no ticket share or cancellations)
# --firestore-snapshot=<file>  reuse saved Firestore rows ("now" = snapshot time; Chatwoot still read live)
```

Output:

- stdout: markdown tables (decisions, intents, messages, guard, cost, cancellations, ticket share) for the named windows (`complete Nd`, `today so far`, `rolling N*24h`, `since launch`) and for each local day.
- `<out>/ai-agent-metrics_<N>d_<asOf>.json` and `.md`: aggregates and conversation ids only. No names, emails, message text, reasons or blocked text.
- `<out>/raw/ai-agent-firestore_<asOf>_<N>d.json`: the projected Firestore rows (ids, actions, routes, intents, sources, token counts, `reason` strings). Keep it outside the repo.

JSON shape (abridged):

```json
{
  "generatedAt": "2026-09-14T10:32:29.000Z", "timezone": "Europe/Helsinki",
  "data": { "startUtc": "...", "endUtc": "...", "localDays": ["2026-09-13", "2026-09-14"], "coverageWarning": null },
  "priceTableAssumption": { "note": "ASSUMED ...", "prices": { "claude-sonnet-5": { "input": 2, "output": 10 } } },
  "windows": {
    "since launch": {
      "startUtc": "2026-09-14T07:55:00.000Z", "endUtc": "2026-09-14T10:32:29.000Z",
      "decisionsLatestOnly": { "conversations": 26, "byOutcome": { "handoff with acknowledgement (acknowledge/escalated)": 11 },
                               "escalatedAckConfirmed": 14, "escalatedNoAckRecord": 0,
                               "intentMentions": { "sub-cancel": 14 }, "conversationsWithIntents": 26 },
      "sentReplies": { "agent-bot-holding": { "messages": 14, "conversations": 14 } }, "botRepliesTracked": true,
      "guard": { "total": 0, "byOutcome": {}, "byOutcomeSource": {}, "byViolation": {}, "conversationIds": [] },
      "aiUsage": { "production": { "calls": 117, "inputTokens": 272449, "outputTokens": 47617, "estCostUsd": 1.02, "unpricedCalls": 0 },
                   "toolingExcluded": { "...": 0 }, "byPipeline": { "agentbot": { "estCostUsd": 0.22 } },
                   "byKindModel": { "draft / claude-sonnet-5": { "calls": 24, "estCostUsd": 0.36 } },
                   "runs": { "responderRuns": 8, "acknowledgementsGenerated": 14 } }
    }
  },
  "perDay": { "2026-09-14": { "...": "same shape" } },
  "tickets": { "windows": { "complete 1d": { "conversationsCreated": 163, "customerTickets": 161, "aiFullyHandled": 44,
               "aiFullyHandledPctOfCustomerTickets": 27.3, "buckets": { "ai-fully-handled:answered": 44 } } },
               "perDay": { "2026-09-13": { "v2ConversationsCount": 163 } } },
  "subscriptionCancellations": { "windows": { "rolling 24h": { "ai": 4, "aiConversations": 4, "human": 94, "humanConversations": 94 } },
                                 "aiConversationIds": [11692, 11930], "aiCancelledButLatestActionNotResponded": [11956] }
}
```

---

## 8. Recommended logging additions (recommendations only, no code changed)

These small changes would make the dashboard exact:

1. **Append-only run log.** Write an `agentBotRuns` collection (or `agentBotDecisions/<id>/runs`) in `finish()` and in the `failed`/`swept-open` paths, with `ts, conversationId, route, action, reason, intents, language, trigger ('webhook' | 'sweeper' | 'backfill'), durationMs, ackSent (bool), sentReplyIds`. This fixes the latest-only problem and gives per-day runs for every outcome.
2. **Explicit nulls.** Write `failed`/`swept-open` decisions with `route: null, intents: []` so `merge` cannot leave stale values.
3. **`sentReplies` detail.** Add `chatwootMessageId`, and split the source into `agent-bot-ack` and `agent-bot-holding-fallback`. Also log `ackWithheld` when `shouldSend` is false.
4. **`aiUsage` accuracy.** Record `cacheReadInputTokens` and `cacheCreationInputTokens`. Sum usage over all turns in `customerResolver.ts` (the responder already does). Record usage for responder runs that throw. Add `pipeline: 'agentbot' | 'human-assist'`, since `classify` serves both.
5. **Subscription actions.** Log to a `subscriptionActions` collection `{conversationId, source: 'ai' | 'dashboard', activeFound, cancelledCount, ok, ts}` from `cancelActiveSubscriptionsByEmail` callers.
6. **Human attribution.** Log dashboard sends and resolves with the staff uid, so human and AI actions are separable even though Chatwoot has one user.
7. **Time to human.** On the first dashboard reply after an escalation, write `humanFirstReplyAt` on the run or decision, to measure the wait after an acknowledgement.

Open questions for the owner:

1. Should "AI fully handled" require that no human replied from the Chatwoot UI? That needs item 6 plus Chatwoot UI replies routed through logging, or a separate Chatwoot user for the bot.
2. Should the Hey and Facebook inboxes be attached to the AgentBot?
3. What are the actual Anthropic prices or discounts, and should cache tokens be costed?
4. Do silent closes count toward the headline "AI handled" KPI?
5. Is pre-launch history (from 2026-07-17) needed for bot answers? That requires a one-time Chatwoot activity backfill.

---

## 9. Real example

### 9.0 How these numbers were produced

- **Firestore:** the live quota was exhausted when the script was run (2026-09-14 about 10:50Z, `RESOURCE_EXHAUSTED`). The script therefore ran with `--firestore-snapshot` on a read-only export of the four collections taken by the research pass at **2026-09-14T10:32:29Z** (all docs with `ts >= 2026-09-07T00:00:00Z`), converted to the script's snapshot format. "Now" = 10:32:29Z in every window below.
- **Chatwoot:** read live between about 11:00Z and 11:10Z. Ticket statuses and labels are about 35 minutes newer than the decisions. Conversations created after 10:32:29Z are excluded.
- **7-day run:** the snapshot starts at 2026-09-07T00:00Z, 3 hours after Helsinki midnight (21:00Z on 09-06). The day 2026-09-07 and the "complete 7d" window miss those 3 hours (for example 142 conversations created in the data vs 155 in the v2 report).
- Commands:

```bash
npx tsx src/scripts/analytics/aiAgentMetrics.ts --days=1 --firestore-snapshot=/home/dolan/support-analytics/raw/ai-agent-firestore_2026-09-14T10-32-29Z_research-dump.json
npx tsx src/scripts/analytics/aiAgentMetrics.ts --days=7 --firestore-snapshot=/home/dolan/support-analytics/raw/ai-agent-firestore_2026-09-14T10-32-29Z_research-dump.json
```

The numbers reproduce the independently verified research figures: rolling 24h decisions 225, dashboard 363 messages / 350 conversations, guard events 5, cost $15.88 + $1.28 tooling = $17.16, AI fully handled 36 of 154 created; Helsinki 2026-09-13 buckets 44 / 2 / 65 / 40 / 10 / 2. The 1-day run takes about 50 s and the 7-day run about 4 min (Chatwoot-dominated).

### 9.1 Last 1 local day

Windows (UTC): complete day **2026-09-13** = [2026-09-12T21:00Z, 2026-09-13T21:00Z), fully pre-launch. **Today so far** 2026-09-14 = [2026-09-13T21:00Z, 10:32:29Z), mixed old and new code. **Rolling 24h** = [2026-09-13T10:32:29Z, 2026-09-14T10:32:29Z). **Since launch** = [07:55Z, 10:32:29Z).

AgentBot latest decisions (conversations, by decision ts):

| | 2026-09-13 | today so far | rolling 24h | since launch |
|---|---:|---:|---:|---:|
| Conversations with a latest decision | 194 | 151 | 225 | 26 |
| Pre-launch code: escalated (no customer message) | 149 | 102 | 162 | 0 |
| Pre-launch code: responded | 45 | 23 | 37 | 0 |
| Answered (respond/responded) | 0 | 4 | 4 | 4 |
| Handoff with acknowledgement (acknowledge/escalated) | 0 | 11 | 11 | 11 |
| Responder escalated (respond/escalated) | 0 | 3 | 3 | 3 |
| Closed silently (close/closed) | 0 | 8 | 8 | 8 |
| Handed off silently / failed / swept-open | 0 | 0 | 0 | 0 |
| Escalations with a confirmed acknowledgement send | n/a | 14 of 14 | 14 of 14 | 14 of 14 |

Since-launch closes: 5 "no reply needed (closing message)", 3 "unsolicited outreach". All 3 responder escalations were order-status questions about orders 14 to 16+ days old.

Routing intents since launch (26 conversations, mentions): sub-cancel 14, refund 12, order-status 5, other 4, not-delivered 1, business 1, missing-packs 1.

Public messages and runs:

| | 2026-09-13 | today so far | rolling 24h | since launch |
|---|---:|---:|---:|---:|
| Bot answers `agent-bot`, msgs (convs) | not tracked | 5 (5) | 5 (5) | 5 (5) |
| Acknowledgements `agent-bot-holding`, msgs (convs) | not tracked | 14 (14) | 14 (14) | 14 (14) |
| Dashboard (human) sends, msgs (convs) | 242 (239) | 188 (186) | 363 (350) | 0 |
| Responder runs (aiUsage) | 73 | 44 | 67 | 8 |
| Acknowledgements generated (aiUsage) | 0 | 14 | 14 | 14 |

Five bot answers but four `respond/responded` decisions: conversation 12006 was answered, then escalated on a later run, which overwrote its decision.

Guard interventions: 2026-09-13: 2 (1 missing-send-reply-tool, 1 blocked/free-text, deliberation). Today so far: 3 (all missing-send-reply-tool). Rolling 24h: 5 (4 missing-send-reply-tool, 1 blocked). Since launch: 0.

AI subscription cancellations (activity "added sub-cancelled-ai"): 2026-09-13: **5**. Today so far: **4** (11930, 11933, 11956, 11692, all before launch). Rolling 24h: 4. Since launch: **0**. For comparison, human `sub-cancelled` label adds: 71 on 2026-09-13, 46 today so far, 0 since launch. Conversation 11956 carries `sub-cancelled-ai` but its latest decision is not `responded`.

Estimated AI cost (ASSUMED list prices, lower bound, tooling excluded):

| | 2026-09-13 | today so far | rolling 24h | since launch |
|---|---:|---:|---:|---:|
| Production calls | 926 | 691 | 1,114 | 117 |
| Input / output tokens | 4.61M / 162k | 3.19M / 141k | 5.45M / 221k | 272k / 48k |
| **Est. USD** | **12.92** | **9.51** | **15.88** | **1.02** |
| AgentBot kinds (responder, acknowledge) | 1.05 | 0.74 | 1.07 | 0.22 |
| Shared (classify, resolver) | 1.03 | 0.80 | 1.25 | 0.25 |
| Human assist (draft, draft-manual, summary) | 10.83 | 7.97 | 13.56 | 0.55 |
| Tooling excluded (`*-replay`) | 1.28 | 0 | 1.28 | 0 |

Since launch by kind (all claude-sonnet-5): draft $0.36 (24 calls), classify $0.22 (37), summary $0.19 (24), acknowledge $0.12 (14), responder $0.10 (8), resolver $0.04 (10, output under-recorded at 5 tokens per call). On 2026-09-13 the responder was claude-sonnet-4-6 with 73 calls averaging **4 output tokens** (the broken pre-launch recording).

Share of new conversations handled by AI (provisional):

| | 2026-09-13 | today so far | rolling 24h | created since launch |
|---|---:|---:|---:|---:|
| Conversations created (v2 report) | 163 (163) | 105 (105) | 154 | 17 |
| Outbound threads, no customer message | 2 | 0 | 2 | 0 |
| **Customer tickets** | **161** | **105** | **152** | **17** |
| AI fully handled: answered | 44 | 20 | 33 | 2 |
| AI fully handled: closed silently | 0 | 3 | 3 | 3 |
| **AI fully handled, % of customer tickets** | **44 (27.3%)** | **23 (21.9%)** | **36 (23.7%)** | **5 (29.4%)** |
| AI final but human involved | 2 | 0 | 0 | 0 |
| AI answered, not resolved yet | 0 | 2 | 2 | 2 |
| Handed to human, dashboard replied | 65 | 7 | 19 | 0 |
| Handed to human, no dashboard reply yet | 40 | 70 | 85 | 10 |
| **Handed to human, %** | **105 (65.2%)** | **77 (73.3%)** | **104 (68.4%)** | **10 (58.8%)** |
| Not bot-routed inbox (Hey, Facebook) | 10 | 3 | 10 | 0 |
| AI fully handled, % of Support-inbox tickets | 29.1% | 22.5% | 25.4% | 29.4% |

### 9.2 Last 7 local days

Windows: complete 7 days **2026-09-07 .. 2026-09-13** = [2026-09-06T21:00Z, 2026-09-13T21:00Z) (Firestore data from 09-07T00:00Z, see 9.0). Rolling 168h = [2026-09-07T10:32:29Z, 2026-09-14T10:32:29Z). Today (09-14) is partial to 10:32:29Z.

Per local day:

| Day | Latest decisions: escalated / responded (old code) | Dashboard msgs (convs) | Responder runs | Guard events | AI cancels | Human cancels | Est. USD | Created (v2) | Customer tickets | AI fully handled | To human |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-09-07* | 83 / 44 | 42 (41) | 88 | 0 | 6 | 12 | 7.78 | 142 (155) | 141 | 43 (30.5%) | 86 |
| 2026-09-08 | 106 / 53 | 128 (128) | 93 | 6 | 5 | 30 | 13.10 | 199 (199) | 199 | 51 (25.6%) | 85 |
| 2026-09-09 | 109 / 35 | 121 (119) | 81 | 5 | 4 | 32 | 11.73 | 157 (157) | 157 | 31 (19.7%) | 100 |
| 2026-09-10 | 137 / 59 | 69 (67) | 98 | 1 | 9 | 14 | 10.21 | 205 (205) | 202 | 56 (27.7%) | 130 |
| 2026-09-11 | 105 / 49 | 112 (110) | 84 | 1 | 4 | 11 | 9.72 | 161 (161) | 161 | 46 (28.6%) | 101 |
| 2026-09-12 | 87 / 26 | 116 (116) | 58 | 4 | 3 | 24 | 8.32 | 100 (100) | 100 | 25 (25.0%) | 70 |
| 2026-09-13 | 149 / 45 | 242 (239) | 73 | 2 | 5 | 71 | 12.92 | 163 (163) | 161 | 44 (27.3%) | 105 |
| 2026-09-14 (to 10:32Z) | 102 / 23 + post-launch 26 | 188 (186) + bot 5 + ack 14 | 44 | 3 | 4 | 46 | 9.51 | 105 (105) | 105 | 23 (21.9%) | 77 |

\* 2026-09-07 misses 21:00Z to 00:00Z of Firestore and Chatwoot-created data in this run.

2026-09-08 had 61 new conversations outside the Support inbox (the usual is 2 to 24), which lowers that day's all-inbox AI share. The Support-inbox-only share that day was 37.0%.

Window totals:

| | Complete 7d (09-07 .. 09-13) | Rolling 168h |
|---|---:|---:|
| Latest decisions | 1,087 (escalated 776, responded 311) | 1,178 (pre-launch escalated 836, responded 316, + 26 post-launch) |
| Dashboard sends, msgs (convs) | 830 (703) | 1,018 (840) |
| Bot answers / acknowledgements | not tracked | 5 / 14 (post-launch only) |
| Responder runs | 575 | 575 |
| Guard events | 19: missing-send-reply-tool 12, blocked/send_reply 6, blocked/free-text 1 | 22: missing-send-reply-tool 15, blocked 7 (6 send_reply, 1 free-text); all blocks = deliberation |
| AI subscription cancellations (conversations) | 36 | 35 |
| Human `sub-cancelled` adds | 194 | 240 |
| Est. USD (production) | **73.79** | **80.48** |
| of which AgentBot / shared / human assist | 8.61 / 6.03 / 59.15 | 8.66 / 6.53 / 65.28 |
| Tooling excluded | 1.54 | 1.54 |
| Conversations created / customer tickets | 1,127 / 1,121 | 1,170 / 1,164 |
| **AI fully handled** | **296 (26.4%)** | **301 (25.9%)** |
| AI final but human involved | 15 | 14 |
| **Handed to human** | **677 (60.4%)**: 456 dashboard replied, 221 not | **713 (61.3%)**: 440 / 273 |
| Not bot-routed inbox | 133 | 134 |
| AI fully handled, % of Support-inbox tickets | 30.0% | 29.2% |

Complete 7d cost by kind and model: draft / claude-sonnet-4-6 $34.80 (1,262 calls), draft-manual / claude-sonnet-4-6 $18.37 (667), responder / claude-sonnet-4-6 $8.61 (575, output under-recorded at 4 tokens per call), summary / claude-haiku-4-5 $5.98 (1,227), classify / claude-haiku-4-5 $4.85 (1,679), resolver / claude-sonnet-4-6 $1.09 (188), resolver / claude-sonnet-5 $0.09 (21).

Label state (conversations active since 2026-09-07T00Z that carry the label now): `sub-cancelled-ai` 41, `sub-cancelled` 278. Two AI-cancellation conversations (11494, 11956) have a latest decision other than `responded`.

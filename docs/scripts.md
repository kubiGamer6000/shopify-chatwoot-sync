# Scripts

One-off CLI tools for operational tasks. All scripts load `.env` automatically and use the same Chatwoot/Shopify/Claude credentials as the main server.

## Bulk Draft Generator

**Location:** `src/scripts/bulkDraft.ts`
**Run:** `npm run bulk-draft -- [options]`

Generates an AI draft reply for every open Chatwoot conversation that's still waiting on a customer message. Each draft is posted as an `AI DRAFT` private note — the agent reads it, copies/edits, and sends.

### When to use

- Catching up on backlog after server downtime
- Onboarding the bot against an existing pile of open tickets
- Running a "refresh all drafts" pass after updating a prompt

### How it decides what to draft

For each conversation, the script:

1. Fetches all messages (including private notes and activity events).
2. Filters out private notes (`private: true`) and activity messages (`message_type: 2`).
3. Looks at the **last public non-activity message**:
   - If it's from the customer (`message_type: 0`) → draft a reply.
   - If it's from an agent (`message_type: 1`) → skip (agent already replied).
4. Skips if the conversation already has an `AI DRAFT` private note (unless you delete it first).

This means previous AI handoff notes or agent-private-notes don't count as "replied".

### Options

| Flag | Default | Purpose |
|------|---------|---------|
| `--prompt "<text>"` | — | Inline system prompt to use for drafts |
| `--prompt-file <path>` | — | Read system prompt from a file |
| `--include-pending` | `false` | Also process `pending` conversations (bot-owned) |
| `--after <YYYY-MM-DD>` | — | Only draft conversations created after this date |
| `--inbox-id <n>` | — | Limit to one inbox |
| `--concurrency <n>` | `2` | Parallel Claude calls |
| `--dry-run` | `false` | Log what would be drafted; don't post notes |

If neither `--prompt` nor `--prompt-file` is given, it uses `src/config/prompts/responder.txt` as the system prompt.

### Examples

Dry run against one inbox, past week only:
```bash
npm run bulk-draft -- --inbox-id 5 --after 2026-04-05 --dry-run
```

Real run with a custom prompt file:
```bash
npm run bulk-draft -- --prompt-file ./prompts/catchup.txt --concurrency 3
```

Include pending conversations (normally excluded — those are bot-controlled):
```bash
npm run bulk-draft -- --include-pending
```

### Output

Per conversation the script logs:

```
[123] Processing conversation ...
[123] Customer: jane@example.com — 2 orders
[123] Last message (customer): "where is my order?"
[123] Draft posted as private note
```

Or when skipping:

```
[124] Skipping — last public message is from agent
[125] Skipping — already has AI DRAFT note
```

### Cautions

- Drafts are private notes, not customer-facing. Nothing is sent to the customer.
- Each draft uses one Claude call; large backlogs cost real money.
- Use `--dry-run` first to see what would be drafted.

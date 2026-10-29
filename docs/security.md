# Security model

This service reads customer data (Shopify, Skio, 17TRACK) and can act on it
(Chatwoot replies, Skio cancellations). This page describes who may do what,
and how. It was introduced by the `fix/security-hardening` change (Oct 2026).

## 1. Linking a Chatwoot contact to a Shopify customer

One function decides it: [`src/services/contactLink.ts`](../src/services/contactLink.ts).

**Contact custom attributes are customer-writable.** Chatwoot's public widget
API (`PATCH /api/v1/widget/contact`) lets a website visitor set their own
contact's `custom_attributes`, even with identity validation enforced. So no
unsigned attribute (`shopify_email_link`, `shopify_customer_id`, anything
"suggested") is trusted, displayed as a reason, or confirmable.

| Status | When | What it allows |
|---|---|---|
| `verified` | (a) an agent confirmed the link in the tab (HMAC with `LINK_CONFIRMATION_SECRET`), or (b) the Shopify customer's email is exactly the contact's email **and** the email is trustworthy for this conversation: an **email inbox**, or a **web widget whose contact is HMAC-verified** (`hmac_verified`) | AI drafts and the AgentBot see orders. Agents can cancel. The bot can cancel **except on email inboxes** |
| `suggested` | Server-derived candidates only: the contact's own email on a channel where it proves nothing (unverified widget, API, social…); a link the old AI matcher made **before** this change (signed by `npm run snapshot:legacy-links`); an email / order number found **live** in the customer's messages in this conversation | Agents see it with **Unverified**, the quoted message, and a warning, plus **Confirm link**. The AI sees no account data. No cancellations |
| `none` | Nothing found. Unsigned link attributes or a mismatching `shopify_customer_id` are ignored (the tab says so) | — |

- Nothing is ever linked automatically from message text, and suggestions are
  no longer stored on the contact. They are computed from the conversation's
  incoming messages on each request. The reason text comes from fixed server
  templates, and the tab quotes the message that contained the email or order
  number.
- Shopify's customer search is fuzzy, so every email match is re-checked for
  exact equality.
- **Agent confirmation** writes `shopify_email_link`,
  `shopify_email_link_confirmed_by` (Chatwoot agent id),
  `shopify_email_link_confirmed_at` and `shopify_email_link_sig`, an HMAC over
  the account, contact id, email, agent and time. Only server-derived
  candidates can be confirmed, only with a personal session, and the write is
  based on a fresh read of the contact.
- **Old AI links:** run `npm run snapshot:legacy-links` (dry run) and then
  `-- --apply` once **before** deploying, with the production environment. It
  signs the links that exist at that moment (`shopify_email_link_legacy_sig`),
  which makes them confirmable suggestions. Links set later are ignored.

## 2. AgentBot and AI drafts

- Order/customer data reaches the AI only for `verified` links; otherwise the
  prompt contains an *IDENTITY NOT VERIFIED* block forbidding any disclosure or
  account action.
- `cancel_subscription` is offered to the bot only for a verified account
  holder and **never in an email conversation**: a From address can be
  forged, so there the bot sends the self-service cancellation link, and the
  reply goes to the address on file. The handler re-checks both conditions. It cancels with Skio's customer notice
  (`shouldSendNotif: true`), records the reason in the audit log and posts a
  private note. (Skio's `CancelSubscriptionInput` has no reason field; checked
  by schema introspection.)
- When the sender is unverified but a possible match exists, the bot hands the
  conversation to a human with an acknowledgement instead of answering.
- Drafts for unverified contacts start with `[ACCOUNT MATCH NOT VERIFIED]`.

## 3. Customer 360 tab authentication

No secret in the URL any more. The Chatwoot Dashboard App URL is just
`https://<domain>/app`.

1. First time in a browser the tab shows **Connect Customer 360**. The agent
   pastes their own Chatwoot access token (avatar → Profile settings → Access
   Token).
2. `POST /app/auth/connect` calls Chatwoot `GET /api/v1/profile` with it and
   accepts the agent only if they are a member of `CHATWOOT_ACCOUNT_ID`. The
   token is used for that one call; it is not stored or logged.
3. The server returns an HMAC-signed access token (12 h) and refresh token
   (signed with `APP_SESSION_SECRET`), kept in the iframe's `localStorage` and
   sent as `Authorization: Bearer`.
   - Every refresh re-checks with the account API that the agent still exists.
   - **Absolute cap:** nothing outlives 30 days from the original connect.
   - **Sign out** bumps the agent's session generation (Firestore
     `agentSessions`), which revokes all of that agent's tokens.
   - Rotating `APP_SESSION_SECRET` signs everyone out.
   - The stored session is dropped only on a 401, not on 429/503.
4. **Per-inbox authorization:** an agent can only open conversations of
   inboxes they are a member of (`GET /inbox_members/:inbox_id`, cached 5 min).
   Chatwoot administrators can open all inboxes. It fails closed if membership
   can't be read, so the `CHATWOOT_API_TOKEN` user must be able to read inbox
   members (an administrator).
5. Chatwoot's `appContext.currentAgent` (unsigned) is compared with the
   session. If they differ, the stored session is dropped and the person has to
   connect as themselves. It is never used for authorization.
6. **Transition:** the old `/app?token=<DASHBOARD_APP_TOKEN>` URL works only
   while `LEGACY_DASHBOARD_TOKEN_ENABLED=true` **and** the current time is
   before `LEGACY_DASHBOARD_TOKEN_UNTIL` (ISO date, required).
   - It is **read-only**: no replies, no cancellations, no link confirmations.
   - The SPA removes the token from the address bar and sends it only in the
     `x-app-token` header; the server compares it in constant time.
   - Requests are audited as `legacy-shared-token`, with a rate-limit bucket
     per IP and claimed agent.

## 4. Server-side scope

Every `/app/api/*` call names one conversation (`X-Chatwoot-Conversation`).
The server loads the conversation and its contact from the Chatwoot API (the
client is bound to `CHATWOOT_ACCOUNT_ID`) and derives the customer from that
contact. Emails, Shopify ids, contact ids or subscription ownership sent by the
browser are ignored. A cancellation must name a subscription that Skio (read
live, not cached) lists for the conversation's **verified** customer, needs a
reason, and defaults to sending Skio's cancellation email.

## 5. Webhooks

`/chatwoot` (account webhook) and `/chatwoot/agent-bot`:

- Preferred: Chatwoot's HMAC signature (`X-Chatwoot-Timestamp`,
  `X-Chatwoot-Signature: sha256=HMAC(secret, "<ts>.<raw body>")`; accepted
  up to 5 min old and at most 60 s in the future). Replayed
  `X-Chatwoot-Delivery` ids are dropped,
  with `CHATWOOT_WEBHOOK_SIGNING_SECRET` / `CHATWOOT_AGENT_BOT_SIGNING_SECRET`.
- Transition: `LEGACY_WEBHOOK_QUERY_SECRET_ENABLED=true` accepts the old
  `?secret=` (constant-time) when no signing secret is set.
- Otherwise rejected with 401: **fails closed**, plus an alert.
- `/sync/*` now fails closed without `SYNC_API_KEY` and compares in constant
  time. Shopify webhooks keep their HMAC check (a malformed header no longer
  throws).

## 6. Fail-safe when Firestore is down

- AgentBot dedupe (`claim()`): if Firestore can't confirm a delivery is new, the
  bot does **not** reply or act; the conversation is opened for a human with a
  private note, and an `ALERT` is raised. Same in the pending sweeper.
- The bot reply cap returns "unknown" instead of 0 when the log can't be read,
  and the bot hands off instead of replying. An in-process counter backs it up.
- AI drafts (private notes only) continue on the in-process dedupe with an alert.
- Log writes that fail raise alerts instead of failing silently.

Alerts are `ALERT [kind]` error log lines, and are also POSTed to
`ALERT_WEBHOOK_URL` (Slack-compatible) when set, at most once per 10 min per kind.

## 7. Audit trail

[`src/services/audit.ts`](../src/services/audit.ts): every tab lookup and
action (customer lookup, summary read/refresh, draft read/generate, reply send,
link confirm, subscription cancel, sign-in) and every AgentBot cancellation is
written as an `AUDIT {json}` log line **and** to the Firestore `auditLog`
collection, with agent id, conversation, contact, Shopify customer and
subscription ids and the outcome. No emails or message text. Cancels and link
confirmations also leave a private note in the conversation.

## 8. Other hardening

- Logs: emails are replaced by a hash reference and secret-looking fields are
  redacted (`src/utils/logger.ts`); webhook handlers no longer log sender emails.
- `/app`: CSP `default-src 'self'; script-src 'self'; ... frame-ancestors
  <CHATWOOT_BASE_URL origin>` (no more `*.chatwoot.com`), `Referrer-Policy:
  no-referrer`, `Cache-Control: no-store` on API responses. Admin SPA:
  `frame-ancestors 'none'` + `X-Frame-Options: DENY`. `x-powered-by` off, HSTS on.
- postMessage: only messages from the parent frame **and** the Chatwoot origin
  are accepted; requests go to that origin, never `'*'`.
- Errors: generic messages; body-parser errors return 400/413 instead of 500.
- Rate limits: connect 20 / 15 min per IP; per agent (own bucket) 1500 reads and 400 writes / hour.
- Admin console: only a **verified** Google email can match `ADMIN_BOOTSTRAP_EMAILS`.
- Dependencies: removed unused `firebase` (client) and `xlsx` from the server;
  `npm audit fix` applied to the server, `web/` and `admin-web/`.

## Environment variables

| Variable | Purpose |
|---|---|
| `APP_SESSION_SECRET` | **Required** (≥ 32 chars). Signs agent sessions |
| `LINK_CONFIRMATION_SECRET` | **Required** (≥ 32 chars, different from the above). Signs agent link confirmations and the legacy-link snapshot |
| `LEGACY_DASHBOARD_TOKEN_ENABLED` | `true` only during the switch to the new tab URL. Default `false` |
| `LEGACY_DASHBOARD_TOKEN_UNTIL` | Hard end date for the legacy token (ISO, e.g. `2026-11-06T00:00:00Z`); required for the legacy token to work |
| `CHATWOOT_WEBHOOK_SIGNING_SECRET` | Secret of the account webhook in Chatwoot |
| `CHATWOOT_AGENT_BOT_SIGNING_SECRET` | Secret of the Agent Bot in Chatwoot |
| `LEGACY_WEBHOOK_QUERY_SECRET_ENABLED` | `true` only until the signing secrets are set. Default `false` |
| `ALERT_WEBHOOK_URL` | Optional Slack-compatible incoming webhook for alerts |

The server refuses to start (unless `NODE_ENV=development`/`test`) when
either secret is missing, shorter than 32 characters, or the two are equal.
There is no fallback derivation. Changing `APP_SESSION_SECRET` signs everyone
out; changing `LINK_CONFIRMATION_SECRET` voids all agent confirmations and the
legacy snapshot (those links go back to unverified).

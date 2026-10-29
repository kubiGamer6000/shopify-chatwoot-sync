# Security model

This service reads customer data (Shopify, Skio, 17TRACK) and can act on it
(Chatwoot replies, Skio cancellations). This page describes who may do what,
and how. It was introduced by the `fix/security-hardening` change (Oct 2026).

## 1. Linking a Chatwoot contact to a Shopify customer

One function decides it: [`src/services/contactLink.ts`](../src/services/contactLink.ts).

| Status | When | What it allows |
|---|---|---|
| `verified` | The Shopify customer's email **is** the contact's own email (exact, case-insensitive), **or** an agent confirmed the link in the Customer 360 tab | Everything: AI drafts and the AgentBot see the orders; agents and the bot can cancel |
| `suggested` | A `shopify_email_link` without a valid agent confirmation (e.g. set by the old AI matcher, by hand, or via the widget SDK); a `shopify_customer_id` whose email differs from the sender; an email / order number found in the customer's message | Agents see the candidate in the tab with **Unverified** + **Confirm link**. The AI sees no account data. No cancellations |
| `none` | Nothing found | — |

- Nothing is ever linked automatically from message text. The old Claude
  matcher (`customerResolver.ts`) is removed; a deterministic extractor
  ([`linkSuggestions.ts`](../src/services/linkSuggestions.ts)) stores a
  **pending suggestion** on the contact (`shopify_email_link_suggested`,
  `shopify_email_link_suggested_basis`).
- Shopify's customer search is fuzzy, so every email match is re-checked for
  exact equality.
- **Agent confirmation** writes `shopify_email_link`,
  `shopify_email_link_confirmed_by` (Chatwoot agent id),
  `shopify_email_link_confirmed_at` and `shopify_email_link_sig`, an HMAC over
  account, contact id, email, agent and time with a server-only key. Editing
  these attributes anywhere else (Chatwoot UI, API, widget) does not produce a
  valid signature, so the link stays unverified.
- Existing AI-made links are therefore unverified automatically (no migration),
  and show as "suggested" until an agent confirms them.
- Only the pending candidates can be confirmed (the endpoint can't attach an
  arbitrary customer to a contact), and only with a personal session.

## 2. AgentBot and AI drafts

- Order/customer data reaches the AI only for `verified` links; otherwise the
  prompt contains an *IDENTITY NOT VERIFIED* block forbidding any disclosure or
  account action.
- `cancel_subscription` is offered to the bot only for a verified account
  holder, and the handler re-checks. It cancels with Skio's customer notice
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
   (30 days), kept in the iframe's `localStorage` and sent as
   `Authorization: Bearer`. Refresh re-checks with the account API token that
   the agent still exists in the account. Rotating `APP_SESSION_SECRET` signs
   everyone out.
4. Chatwoot's `appContext.currentAgent` (unsigned) is only compared with the
   session to warn about a mismatch; it is never used for authorization.
5. **Transition:** with `LEGACY_DASHBOARD_TOKEN_ENABLED=true`, the old
   `/app?token=<DASHBOARD_APP_TOKEN>` URL still works. The SPA removes the token
   from the address bar, sends it only in the `x-app-token` header, and the
   server compares it in constant time. Such requests are audited as
   `legacy-shared-token`; confirming links is not allowed with it. Default off.

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
  `X-Chatwoot-Signature: sha256=HMAC(secret, "<ts>.<raw body>")`, ±5 min),
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
- Rate limits: connect 20 / 15 min per IP; per agent 1500 reads and 400 writes / hour.
- Admin console: only a **verified** Google email can match `ADMIN_BOOTSTRAP_EMAILS`.
- Dependencies: removed unused `firebase` (client) and `xlsx` from the server;
  `npm audit fix` applied to the server, `web/` and `admin-web/`.

## Environment variables

| Variable | Purpose |
|---|---|
| `APP_SESSION_SECRET` | Signs agent sessions and link confirmations. If unset, a key is derived from `CHATWOOT_API_TOKEN` (works, but set a dedicated 32+ byte random value) |
| `LEGACY_DASHBOARD_TOKEN_ENABLED` | `true` only during the switch to the new tab URL. Default `false` |
| `CHATWOOT_WEBHOOK_SIGNING_SECRET` | Secret of the account webhook in Chatwoot |
| `CHATWOOT_AGENT_BOT_SIGNING_SECRET` | Secret of the Agent Bot in Chatwoot |
| `LEGACY_WEBHOOK_QUERY_SECRET_ENABLED` | `true` only until the signing secrets are set. Default `false` |
| `ALERT_WEBHOOK_URL` | Optional Slack-compatible incoming webhook for alerts |

Changing `APP_SESSION_SECRET` (or `CHATWOOT_API_TOKEN` while it is unset)
invalidates all sessions **and** all agent link confirmations (they become
"suggested" again).

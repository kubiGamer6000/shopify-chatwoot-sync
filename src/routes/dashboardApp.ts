import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { buildCustomerProfile } from '../services/customerProfile.js';
import {
  cancelSubscription,
  fetchSubscriptionsLive,
  invalidateSubscriptionsCache,
} from '../services/skio.js';
import { recordSentReply } from '../services/aiAudit.js';
import { getStoredSummary, refreshSummaryForContact } from '../services/customerSummary.js';
import { getLatestDraft } from '../services/draftStore.js';
import { generateResponse } from '../services/aiDraft.js';
import {
  sendReply,
  getLastCustomerMessage,
  getConversationMessages,
  resolveConversation,
  addConversationLabels,
  postPrivateNote,
} from '../services/chatwootConversation.js';
import { mergeContactAttributes, getContact } from '../services/chatwoot.js';
import {
  ScopeError,
  loadConversationScope,
  parseConversationId,
  shopifyLinkDeps,
  type ConversationScope,
} from '../services/conversationScope.js';
import {
  confirmableEmails,
  confirmationAttributes,
  contactEmailTrusted,
  findCustomerByExactEmail,
  resolveContactCustomer,
  type ContactResolution,
  type LinkSuggestion,
} from '../services/contactLink.js';
import { customerTexts, findLinkSuggestion } from '../services/linkSuggestions.js';
import { audit, type AuditEntry } from '../services/audit.js';
import { normalizeEmail } from '../security/crypto.js';
import { RateLimiter } from '../utils/rateLimit.js';
import type { SkioSubscription } from '../types/skio.js';

/**
 * Customer 360 API (mounted at /app/api behind appAuth).
 *
 * Every route is scoped to ONE conversation, named by the
 * `X-Chatwoot-Conversation` header (or `conversationId`). The contact,
 * customer and subscriptions are derived on the server from the Chatwoot API
 * (security fix P3); email / customer id / contact id values sent by the
 * browser are ignored. Every lookup and action is audited with the agent id.
 */

// Label applied to a conversation when an agent cancels a subscription from the
// dashboard (the human counterpart to the AI's `sub-cancelled-ai` label).
const SUB_CANCELLED_LABEL = 'sub-cancelled';

const ACTIVE_STATUSES = new Set(['ACTIVE', 'active']);

// Per-agent limits (single instance): lookups and writes.
// Generous enough for a busy agent (each conversation switch is ~3 reads,
// each reply ~2 writes); they exist to stop scripted bulk extraction.
const readLimiter = new RateLimiter(1500, 60 * 60 * 1000);
const writeLimiter = new RateLimiter(400, 60 * 60 * 1000);

const router = Router();

router.use((req: Request, res: Response, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const limiter = req.method === 'GET' ? readLimiter : writeLimiter;
  // One bucket per agent; legacy-token callers get a bucket per IP + claimed agent.
  const a = req.agent;
  const bucket =
    a?.via === 'session'
      ? `agent:${a.id}`
      : `legacy:${req.header('do-connecting-ip') ?? req.ip}:${a?.id ?? 0}`;
  if (!limiter.take(bucket)) {
    res.status(429).json({ error: 'Too many requests, slow down.' });
    return;
  }
  next();
});

function conversationIdFrom(req: Request): number | null {
  return (
    parseConversationId(req.header('x-chatwoot-conversation')) ??
    parseConversationId(req.query.conversationId) ??
    parseConversationId((req.body as Record<string, unknown> | undefined)?.conversationId)
  );
}

function auditBase(
  req: Request,
  scope: ConversationScope | null,
): Pick<AuditEntry, 'actor' | 'actorName' | 'via' | 'conversationId' | 'contactId'> {
  return {
    actor: req.agent?.actor ?? 'unknown',
    actorName: req.agent?.name ?? null,
    via: req.agent?.via ?? 'session',
    conversationId: scope?.conversationId ?? null,
    contactId: scope?.contact.id ?? null,
  };
}

/** Loads the conversation scope or sends the error response (returns null). */
async function scopeOr(
  req: Request,
  res: Response,
  action: string,
): Promise<ConversationScope | null> {
  const conversationId = conversationIdFrom(req);
  if (!conversationId) {
    res.status(400).json({ error: 'conversationId is required' });
    return null;
  }
  try {
    return await loadConversationScope(conversationId, req.agent);
  } catch (err) {
    const status = err instanceof ScopeError ? err.status : 502;
    const message = err instanceof ScopeError ? err.message : 'Could not load the conversation';
    void audit({
      ...auditBase(req, null),
      conversationId,
      action,
      outcome: 'denied',
      reason: message,
    });
    res.status(status).json({ error: message });
    return null;
  }
}

async function resolveScope(scope: ConversationScope, loadOrders = true): Promise<ContactResolution> {
  return resolveContactCustomer(scope.contact, shopifyLinkDeps, {
    loadOrders,
    trustContactEmail: contactEmailTrusted(scope.conversation),
  });
}

/** Suggestion computed live from this conversation's customer messages. */
async function liveSuggestion(
  scope: ConversationScope,
  contactEmail: string | null,
): Promise<LinkSuggestion | null> {
  const messages = await getConversationMessages(scope.conversationId).catch(() => null);
  return findLinkSuggestion(
    customerTexts(messages?.payload ?? [], scope.conversation.additional_attributes?.['mail_subject']),
    contactEmail,
    shopifyLinkDeps,
  ).catch(() => null);
}

/** Legacy shared-token callers are read-only. */
function denyLegacy(req: Request, res: Response, scope: ConversationScope, action: string): boolean {
  if (req.agent?.via === 'session') return false;
  void audit({ ...auditBase(req, scope), action, outcome: 'denied', reason: 'legacy token is read-only' });
  res.status(403).json({
    error: 'Connect Customer 360 with your own Chatwoot access token to do this.',
    code: 'personal_session_required',
  });
  return true;
}

function agentLabel(req: Request): string {
  const a = req.agent;
  if (!a || a.via === 'legacy-token') return 'an agent (shared legacy token)';
  return `${a.name ?? 'agent'} (agent #${a.id})`;
}

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

// --- Identity ------------------------------------------------------------------

router.get('/me', (req: Request, res: Response) => {
  const a = req.agent!;
  res.json({ id: a.id || null, name: a.name, role: a.role, via: a.via });
});

// --- Customer lookup -------------------------------------------------------------

router.get('/customer', async (req: Request, res: Response) => {
  const scope = await scopeOr(req, res, 'customer.lookup');
  if (!scope) return;
  try {
    const resolution = await resolveScope(scope);

    // No verified orders and no server-derived candidate: look for an email /
    // order number in the customer's messages, live (never from attributes).
    if (!resolution.suggestion && resolution.orders.length === 0) {
      const live = await liveSuggestion(scope, resolution.contactEmail);
      if (live) resolution.suggestion = live;
    }

    const [profile, aiSummary] = await Promise.all([
      buildCustomerProfile(resolution),
      getStoredSummary(scope.contact.id),
    ]);
    void audit({
      ...auditBase(req, scope),
      action: 'customer.lookup',
      shopifyCustomerId: resolution.customer?.id ?? null,
      linkStatus: resolution.status,
      outcome: 'ok',
      detail: { basis: resolution.basis, hasSuggestion: Boolean(resolution.suggestion) },
    });
    res.json({
      ...profile,
      aiSummary,
      contact: {
        id: scope.contact.id,
        name: scope.contact.name ?? null,
        email: scope.contact.email ?? null,
      },
    });
  } catch (err) {
    logger.error('Failed to build customer profile', {
      conversationId: scope.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    void audit({ ...auditBase(req, scope), action: 'customer.lookup', outcome: 'error' });
    fail(res, 500, 'Failed to build customer profile');
  }
});

// --- Link confirmation -------------------------------------------------------------

router.post('/link/confirm', async (req: Request, res: Response) => {
  const scope = await scopeOr(req, res, 'link.confirm');
  if (!scope) return;
  const rawEmail = (req.body as { email?: unknown } | undefined)?.email;
  const email = normalizeEmail(typeof rawEmail === 'string' ? rawEmail : null);
  if (!email) {
    fail(res, 400, 'email is required');
    return;
  }
  if (denyLegacy(req, res, scope, 'link.confirm')) return;
  try {
    const resolution = await resolveScope(scope, false);
    // Only SERVER-DERIVED candidates can be confirmed (the resolution's own
    // suggestion, or one computed live from the messages). Contact attributes
    // are customer-writable, so they never qualify by themselves.
    const live = resolution.suggestion ? null : await liveSuggestion(scope, resolution.contactEmail);
    if (!confirmableEmails(resolution, live).has(email)) {
      void audit({
        ...auditBase(req, scope),
        action: 'link.confirm',
        outcome: 'denied',
        reason: 'not a server-derived suggestion',
      });
      fail(res, 409, 'That email is not a suggestion for this conversation.');
      return;
    }
    const customer = await findCustomerByExactEmail(shopifyLinkDeps, email);
    if (!customer) {
      fail(res, 404, 'No Shopify customer has that email.');
      return;
    }
    // Fresh read right before writing, so no stale attributes are written back.
    const fresh = await getContact(scope.contact.id);
    if (!fresh) {
      fail(res, 404, 'Contact not found');
      return;
    }
    await mergeContactAttributes(
      scope.contact.id,
      (fresh.custom_attributes as Record<string, unknown> | undefined) ?? {},
      confirmationAttributes(scope.contact.id, email, req.agent!.id),
    );
    void audit({
      ...auditBase(req, scope),
      action: 'link.confirm',
      shopifyCustomerId: customer.id,
      linkStatus: 'verified',
      outcome: 'ok',
      detail: { previousStatus: resolution.status, basis: resolution.basis },
    });
    await postPrivateNote(
      scope.conversationId,
      `[Customer 360] Customer link confirmed by ${agentLabel(req)}: this contact is now linked to Shopify customer #${customer.id}.`,
    ).catch(() => undefined);
    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to confirm link', {
      conversationId: scope.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    void audit({ ...auditBase(req, scope), action: 'link.confirm', outcome: 'error' });
    fail(res, 500, 'Failed to confirm the link');
  }
});

// --- AI summary --------------------------------------------------------------------

router.get('/summary', async (req: Request, res: Response) => {
  const scope = await scopeOr(req, res, 'summary.read');
  if (!scope) return;
  try {
    const summary = await getStoredSummary(scope.contact.id);
    void audit({ ...auditBase(req, scope), action: 'summary.read', outcome: 'ok' });
    res.json({ summary });
  } catch (err) {
    logger.error('Failed to read summary', {
      conversationId: scope.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    fail(res, 500, 'Failed to read summary');
  }
});

router.post('/summary/refresh', async (req: Request, res: Response) => {
  const scope = await scopeOr(req, res, 'summary.refresh');
  if (!scope) return;
  try {
    const resolution = await resolveScope(scope, false);
    const verified = resolution.status === 'verified';
    const summary = await refreshSummaryForContact({
      contactId: scope.contact.id,
      conversationId: scope.conversationId,
      // Order data only for a verified link.
      email: verified ? resolution.customerEmail : null,
      shopifyCustomerId: verified && resolution.customer ? String(resolution.customer.id) : null,
      customerName: scope.contact.name ?? null,
    });
    void audit({
      ...auditBase(req, scope),
      action: 'summary.refresh',
      linkStatus: resolution.status,
      outcome: summary ? 'ok' : 'error',
    });
    if (!summary) {
      fail(res, 502, 'Failed to generate summary');
      return;
    }
    res.json({ summary });
  } catch (err) {
    logger.error('Failed to refresh summary', {
      conversationId: scope.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    fail(res, 500, 'Failed to refresh summary');
  }
});

// --- AI reply composer ----------------------------------------------------------------

router.get('/draft', async (req: Request, res: Response) => {
  const scope = await scopeOr(req, res, 'draft.read');
  if (!scope) return;
  try {
    const [draft, lastCustomerMessage] = await Promise.all([
      getLatestDraft(scope.conversationId),
      getLastCustomerMessage(scope.conversationId).catch(() => null),
    ]);
    void audit({ ...auditBase(req, scope), action: 'draft.read', outcome: 'ok' });
    res.json({ draft, lastCustomerMessage });
  } catch (err) {
    logger.error('Failed to read draft', {
      conversationId: scope.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    fail(res, 500, 'Failed to read draft');
  }
});

router.post('/draft/generate', async (req: Request, res: Response) => {
  const scope = await scopeOr(req, res, 'draft.generate');
  if (!scope) return;
  const body = (req.body ?? {}) as {
    instruction?: unknown;
    previousResponse?: unknown;
    correction?: unknown;
  };
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
  try {
    const draft = await generateResponse({
      conversationId: scope.conversationId,
      contactId: scope.contact.id,
      instruction: str(body.instruction, 4000),
      previousResponse: str(body.previousResponse, 20000),
      correction: str(body.correction, 4000),
    });
    void audit({
      ...auditBase(req, scope),
      action: 'draft.generate',
      outcome: draft ? 'ok' : 'error',
    });
    if (!draft) {
      fail(res, 502, 'Failed to generate a response');
      return;
    }
    res.json(draft);
  } catch (err) {
    logger.error('Failed to generate response', {
      conversationId: scope.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    fail(res, 500, 'Failed to generate response');
  }
});

router.post('/draft/send', async (req: Request, res: Response) => {
  const scope = await scopeOr(req, res, 'reply.send');
  if (!scope) return;
  if (denyLegacy(req, res, scope, 'reply.send')) return;
  const body = (req.body ?? {}) as { message?: unknown; resolve?: unknown };
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const shouldResolve = body.resolve !== false;
  if (!message) {
    fail(res, 400, 'message is required');
    return;
  }
  if (message.length > 20000) {
    fail(res, 400, 'message is too long');
    return;
  }

  try {
    // Sending the reply is the critical step. Resolving is best-effort so a
    // resolve failure never loses the agent's message.
    await sendReply(scope.conversationId, message);
    void recordSentReply({
      conversationId: scope.conversationId,
      message,
      source: 'dashboard',
      agentId: req.agent?.actor ?? null,
    });

    let resolved = false;
    if (shouldResolve) {
      try {
        await resolveConversation(scope.conversationId);
        resolved = true;
      } catch (err) {
        logger.warn('Reply sent but failed to resolve conversation', {
          conversationId: scope.conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    void audit({
      ...auditBase(req, scope),
      action: 'reply.send',
      outcome: 'ok',
      detail: { resolved, length: message.length },
    });
    res.json({ ok: true, resolved });
  } catch (err) {
    logger.error('Failed to send reply', {
      conversationId: scope.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    void audit({ ...auditBase(req, scope), action: 'reply.send', outcome: 'error' });
    fail(res, 500, 'Failed to send reply');
  }
});

// --- Subscription cancel ---------------------------------------------------------------

router.post('/subscriptions/:id/cancel', async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const subscriptionId = String(Array.isArray(rawId) ? rawId[0] : (rawId ?? ''));
  if (!/^[0-9a-f-]{8,64}$/i.test(subscriptionId)) {
    fail(res, 400, 'Invalid subscription id');
    return;
  }
  const scope = await scopeOr(req, res, 'subscription.cancel');
  if (!scope) return;
  if (denyLegacy(req, res, scope, 'subscription.cancel')) return;

  const body = (req.body ?? {}) as { reason?: unknown; notifyCustomer?: unknown };
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  const notifyCustomer = body.notifyCustomer !== false;
  const base = { ...auditBase(req, scope), action: 'subscription.cancel', subscriptionId };

  if (reason.length < 3) {
    fail(res, 400, 'A cancellation reason is required');
    return;
  }

  try {
    const resolution = await resolveScope(scope, false);
    if (resolution.status !== 'verified' || !resolution.customerEmail) {
      void audit({
        ...base,
        linkStatus: resolution.status,
        outcome: 'denied',
        reason: 'link not verified',
      });
      fail(
        res,
        409,
        'This contact is not verified as the account holder. Confirm the customer link first.',
      );
      return;
    }

    // The subscription must belong to THIS conversation's verified customer,
    // read live from Skio (not the browser, not a cache).
    let subs: SkioSubscription[];
    try {
      subs = await fetchSubscriptionsLive(resolution.customerEmail);
    } catch {
      fail(res, 502, 'Could not read subscriptions from Skio');
      return;
    }
    const sub = subs.find((s) => s.id === subscriptionId);
    if (!sub) {
      void audit({
        ...base,
        linkStatus: 'verified',
        outcome: 'denied',
        reason: 'subscription not owned by customer',
      });
      fail(res, 403, 'That subscription does not belong to this customer.');
      return;
    }
    if (!ACTIVE_STATUSES.has(sub.status) || sub.cancelledAt) {
      void audit({ ...base, linkStatus: 'verified', outcome: 'noop', reason: 'already inactive' });
      fail(res, 409, 'That subscription is not active.');
      return;
    }

    const ok = await cancelSubscription(subscriptionId, { notifyCustomer });
    if (!ok) {
      void audit({ ...base, linkStatus: 'verified', outcome: 'error', reason });
      fail(res, 502, 'Skio did not confirm the cancellation');
      return;
    }
    void audit({
      ...base,
      shopifyCustomerId: resolution.customer?.id ?? null,
      linkStatus: 'verified',
      outcome: 'ok',
      reason,
      detail: { notifyCustomer },
    });

    await invalidateSubscriptionsCache(resolution.customerEmail);

    // Durable, visible trail in Chatwoot (also survives a Firestore outage).
    await postPrivateNote(
      scope.conversationId,
      `[Customer 360] Skio subscription cancelled by ${agentLabel(req)}.\nReason: ${reason}\nCustomer notified by Skio: ${notifyCustomer ? 'yes' : 'no'}`,
    ).catch(() => undefined);

    // Best-effort: tag the ticket so agents can filter cancellations. The
    // cancellation already happened, so a labelling failure never fails it.
    let labelled = false;
    try {
      const merged = await addConversationLabels(scope.conversationId, [SUB_CANCELLED_LABEL]);
      labelled = merged.includes(SUB_CANCELLED_LABEL);
    } catch {
      labelled = false;
    }
    res.json({ ok: true, labelled });
  } catch (err) {
    logger.error('Failed to cancel subscription', {
      subscriptionId,
      error: err instanceof Error ? err.message : String(err),
    });
    void audit({ ...base, outcome: 'error' });
    fail(res, 500, 'Failed to cancel subscription');
  }
});

export default router;

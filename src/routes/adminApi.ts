import { Router } from 'express';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';
import { logger } from '../utils/logger.js';
import { requireAuth, requireAdmin } from '../middleware/adminAuth.js';
import {
  getDefaultAiConfig,
  getStoredOverrides,
  getAiConfig,
  saveAiConfig,
  getAiConfigHistory,
} from '../services/appConfig.js';
import { listUsers, setUserRole } from '../services/users.js';
import { runReplay, type ReplayKind } from '../services/aiReplay.js';

const router = Router();

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Current user ------------------------------------------------------------

router.get('/me', requireAuth, (req: Request, res: Response) => {
  const u = req.adminUser!;
  res.json({
    uid: u.uid,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
  });
});

// --- AI config ---------------------------------------------------------------

const AiConfigOverridesSchema = z
  .object({
    draftSystemPrompt: z.string(),
    responderSystemPrompt: z.string(),
    classifierSystemPrompt: z.string(),
    summarySystemPrompt: z.string(),
    resolverSystemPromptTemplate: z.string(),
    holdingSystemPrompt: z.string(),
    draftModel: z.string(),
    responderModel: z.string(),
    classifierModel: z.string(),
    summaryModel: z.string(),
    resolverModel: z.string(),
    holdingModel: z.string(),
    autoRespondLabels: z.array(z.string()),
    backfillAutoRespondLabels: z.array(z.string()),
    holdingReplyEnabled: z.boolean(),
    draftMaxTokens: z.number(),
    classifierMaxTokens: z.number(),
    summaryMaxTokens: z.number(),
    holdingMaxTokens: z.number(),
    responderMaxTokens: z.number(),
    responderMaxIterations: z.number(),
    resolverMaxTokens: z.number(),
    resolverMaxIterations: z.number(),
  })
  .partial();

router.get('/config', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const [{ config, meta }, effective] = await Promise.all([
      getStoredOverrides(),
      getAiConfig(),
    ]);
    res.json({
      defaults: getDefaultAiConfig(),
      overrides: config,
      effective,
      meta,
    });
  } catch (err) {
    logger.error('Failed to read AI config', { error: errMessage(err) });
    res.status(500).json({ error: 'Failed to read AI config' });
  }
});

router.put('/config', requireAdmin, async (req: Request, res: Response) => {
  const parsed = AiConfigOverridesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid config', details: parsed.error.issues });
    return;
  }
  const result = await saveAiConfig(parsed.data, req.adminUser?.email ?? null);
  if (!result.ok) {
    res.status(500).json({ error: result.reason ?? 'Failed to save config' });
    return;
  }
  const effective = await getAiConfig();
  res.json({ ok: true, effective });
});

router.get('/config/history', requireAdmin, async (_req: Request, res: Response) => {
  const history = await getAiConfigHistory();
  res.json({ history });
});

// --- Users -------------------------------------------------------------------

router.get('/users', requireAdmin, async (_req: Request, res: Response) => {
  const users = await listUsers();
  res.json({ users });
});

const RoleSchema = z.object({ role: z.enum(['admin', 'pending']) });

router.post('/users/:uid/role', requireAdmin, async (req: Request, res: Response) => {
  const parsed = RoleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'role must be "admin" or "pending"' });
    return;
  }
  const uid = String(req.params.uid ?? '');
  if (!uid) {
    res.status(400).json({ error: 'uid is required' });
    return;
  }
  if (uid === req.adminUser?.uid && parsed.data.role !== 'admin') {
    res.status(400).json({ error: 'You cannot revoke your own admin access' });
    return;
  }
  const result = await setUserRole(uid, parsed.data.role, req.adminUser?.email ?? null);
  if (!result.ok) {
    res.status(400).json({ error: result.reason ?? 'Failed to update role' });
    return;
  }
  res.json({ ok: true });
});

// --- Prompt tester / replay --------------------------------------------------

const ReplaySchema = z.object({
  conversationId: z.number().int().positive(),
  kind: z.enum(['draft', 'classifier', 'responder']),
  overrides: AiConfigOverridesSchema.optional(),
  escalation: z.boolean().optional(),
});

router.post('/replay', requireAdmin, async (req: Request, res: Response) => {
  const parsed = ReplaySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid replay request', details: parsed.error.issues });
    return;
  }
  try {
    const result = await runReplay({
      conversationId: parsed.data.conversationId,
      kind: parsed.data.kind as ReplayKind,
      overrides: parsed.data.overrides,
      escalation: parsed.data.escalation,
    });
    res.json(result);
  } catch (err) {
    logger.error('Replay failed', { error: errMessage(err) });
    res.status(500).json({ error: errMessage(err) });
  }
});

export default router;

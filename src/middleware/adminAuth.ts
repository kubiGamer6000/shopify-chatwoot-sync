import type { Request, Response, NextFunction } from 'express';
import { verifyIdToken } from '../services/firebaseAuth.js';
import { ensureUserRecord, type UserRecord } from '../services/users.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminUser?: UserRecord;
    }
  }
}

function extractBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Verifies the Firebase ID token and attaches the user record (creating a
 * `pending` one on first sight). Returns 401 when the token is missing/invalid.
 * Does NOT require admin — used by `/me` so pending users can see their status.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const verified = await verifyIdToken(extractBearer(req));
  if (!verified) {
    res.status(401).json({ error: 'Invalid or missing authentication token' });
    return;
  }
  req.adminUser = await ensureUserRecord(verified);
  next();
}

/**
 * Requires a valid token AND the `admin` role. Returns 403 for authenticated
 * but unapproved (pending) users.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const verified = await verifyIdToken(extractBearer(req));
  if (!verified) {
    res.status(401).json({ error: 'Invalid or missing authentication token' });
    return;
  }
  const user = await ensureUserRecord(verified);
  req.adminUser = user;
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required', role: user.role });
    return;
  }
  next();
}

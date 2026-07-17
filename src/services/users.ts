/**
 * Admin dashboard user records + role management (manual approval).
 *
 * Anyone can sign in with Google, but they land as `pending` and can see/do
 * nothing until an existing admin grants them the `admin` role. Emails listed
 * in ADMIN_BOOTSTRAP_EMAILS are always admins (bootstraps the first approver).
 */
import { getDb } from './firestore.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { VerifiedUser } from './firebaseAuth.js';

export type UserRole = 'admin' | 'pending';

export interface UserRecord {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const COLLECTION = 'users';

function isBootstrapAdmin(email: string | null): boolean {
  if (!email) return false;
  return env.adminBootstrapEmails.includes(email.trim().toLowerCase());
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ensures a user record exists for a freshly-verified identity and returns the
 * effective record. First sight → `pending` (or `admin` for a bootstrap email).
 * Bootstrap emails always resolve to `admin` even if the stored doc says
 * otherwise, and the stored doc is healed to match.
 */
export async function ensureUserRecord(user: VerifiedUser): Promise<UserRecord> {
  const bootstrap = isBootstrapAdmin(user.email);
  const now = new Date().toISOString();
  const db = getDb();

  if (!db) {
    // No persistence available — still honour bootstrap admins at runtime.
    return {
      uid: user.uid,
      email: user.email,
      displayName: user.name,
      role: bootstrap ? 'admin' : 'pending',
      approvedBy: bootstrap ? 'bootstrap' : null,
      createdAt: now,
      updatedAt: now,
    };
  }

  const ref = db.collection(COLLECTION).doc(user.uid);
  try {
    const snap = await ref.get();
    if (!snap.exists) {
      const record: UserRecord = {
        uid: user.uid,
        email: user.email,
        displayName: user.name,
        role: bootstrap ? 'admin' : 'pending',
        approvedBy: bootstrap ? 'bootstrap' : null,
        createdAt: now,
        updatedAt: now,
      };
      await ref.set(record);
      return record;
    }

    const existing = snap.data() as UserRecord;
    // Keep identity fields fresh, and force bootstrap emails to admin.
    const patch: Partial<UserRecord> = {
      email: user.email,
      displayName: user.name,
      updatedAt: now,
    };
    if (bootstrap && existing.role !== 'admin') {
      patch.role = 'admin';
      patch.approvedBy = 'bootstrap';
    }
    if (Object.keys(patch).length > 0) await ref.set(patch, { merge: true });
    return { ...existing, ...patch } as UserRecord;
  } catch (err) {
    logger.warn('Failed to ensure user record', { uid: user.uid, error: errMessage(err) });
    return {
      uid: user.uid,
      email: user.email,
      displayName: user.name,
      role: bootstrap ? 'admin' : 'pending',
      approvedBy: bootstrap ? 'bootstrap' : null,
      createdAt: now,
      updatedAt: now,
    };
  }
}

export async function listUsers(): Promise<UserRecord[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const snap = await db.collection(COLLECTION).orderBy('createdAt', 'desc').get();
    return snap.docs.map((d) => d.data() as UserRecord);
  } catch (err) {
    logger.warn('Failed to list users', { error: errMessage(err) });
    return [];
  }
}

/**
 * Sets a user's role. Bootstrap admins cannot be demoted (they always resolve
 * to admin), so this is a no-op refusal for those emails.
 */
export async function setUserRole(
  uid: string,
  role: UserRole,
  approvedBy: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  const db = getDb();
  if (!db) return { ok: false, reason: 'Firestore is not enabled' };
  try {
    const ref = db.collection(COLLECTION).doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, reason: 'User not found' };
    const existing = snap.data() as UserRecord;
    if (isBootstrapAdmin(existing.email) && role !== 'admin') {
      return { ok: false, reason: 'Cannot demote a bootstrap admin' };
    }
    await ref.set(
      { role, approvedBy, updatedAt: new Date().toISOString() },
      { merge: true },
    );
    logger.info('Updated user role', { uid, role, approvedBy });
    return { ok: true };
  } catch (err) {
    logger.error('Failed to set user role', { uid, error: errMessage(err) });
    return { ok: false, reason: errMessage(err) };
  }
}

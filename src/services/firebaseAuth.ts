/**
 * Firebase Auth (admin SDK) helpers for the Admin Control Dashboard. Verifies
 * the Google-sign-in ID tokens sent by the admin SPA, reusing the same
 * firebase-admin App used for Firestore.
 */
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getFirebaseApp } from './firestore.js';
import { logger } from '../utils/logger.js';

export interface VerifiedUser {
  uid: string;
  email: string | null;
  name: string | null;
}

/**
 * Verifies a Firebase ID token and returns the identity, or null if the token
 * is missing/invalid or Firebase isn't configured.
 */
export async function verifyIdToken(
  idToken: string | undefined | null,
): Promise<VerifiedUser | null> {
  if (!idToken) return null;
  const app = getFirebaseApp();
  if (!app) return null;

  try {
    const decoded: DecodedIdToken = await getAuth(app).verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      name: (decoded.name as string | undefined) ?? null,
    };
  } catch (err) {
    logger.warn('Firebase ID token verification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

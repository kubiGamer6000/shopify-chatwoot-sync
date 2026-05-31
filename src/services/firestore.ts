import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

let db: Firestore | null = null;
let initAttempted = false;

/**
 * Lazily initializes Firestore from the base64-encoded service account.
 * Returns null (and logs once) if the credential is missing or invalid, so
 * callers can degrade gracefully instead of crashing the server.
 */
export function getDb(): Firestore | null {
  if (db) return db;
  if (initAttempted) return db;
  initAttempted = true;

  if (!env.firebaseServiceAccountBase64) {
    logger.warn('FIREBASE_BASE64_SERVICE_ACCOUNT not set — Firestore disabled');
    return null;
  }

  try {
    const json = Buffer.from(
      env.firebaseServiceAccountBase64,
      'base64',
    ).toString('utf-8');
    const serviceAccount = JSON.parse(json) as {
      project_id: string;
      client_email: string;
      private_key: string;
    };

    const app: App =
      getApps()[0] ??
      initializeApp({
        credential: cert({
          projectId: serviceAccount.project_id,
          clientEmail: serviceAccount.client_email,
          privateKey: serviceAccount.private_key,
        }),
      });

    db = getFirestore(app);
    logger.info('Firestore initialized', { projectId: serviceAccount.project_id });
    return db;
  } catch (err) {
    logger.error('Failed to initialize Firestore', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function isFirestoreEnabled(): boolean {
  return getDb() !== null;
}

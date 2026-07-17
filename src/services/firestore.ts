import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

let app: App | null = null;
let db: Firestore | null = null;
let initAttempted = false;

/**
 * Lazily initializes the firebase-admin App from the base64-encoded service
 * account. Returns null (and logs once) if the credential is missing/invalid,
 * so callers can degrade gracefully instead of crashing the server. Shared by
 * Firestore and Firebase Auth (admin token verification).
 */
export function getFirebaseApp(): App | null {
  if (app) return app;
  if (initAttempted) return app;
  initAttempted = true;

  if (!env.firebaseServiceAccountBase64) {
    logger.warn('FIREBASE_BASE64_SERVICE_ACCOUNT not set — Firestore/Auth disabled');
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

    app =
      getApps()[0] ??
      initializeApp({
        credential: cert({
          projectId: serviceAccount.project_id,
          clientEmail: serviceAccount.client_email,
          privateKey: serviceAccount.private_key,
        }),
      });

    logger.info('Firebase initialized', { projectId: serviceAccount.project_id });
    return app;
  } catch (err) {
    logger.error('Failed to initialize Firebase', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Lazily initializes Firestore from the shared firebase-admin App. Returns null
 * (degrades gracefully) when the credential is missing or invalid.
 */
export function getDb(): Firestore | null {
  if (db) return db;
  const firebaseApp = getFirebaseApp();
  if (!firebaseApp) return null;

  try {
    db = getFirestore(firebaseApp);
    // Cached API payloads (e.g. tracking summaries) contain optional fields that
    // may be `undefined`; ignore them instead of throwing on write.
    try {
      db.settings({ ignoreUndefinedProperties: true });
    } catch {
      // settings() throws if called more than once — safe to ignore.
    }
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

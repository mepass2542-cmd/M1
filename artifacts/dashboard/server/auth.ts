import type { Request, Response, NextFunction } from 'express';
import * as admin from 'firebase-admin';

let _initialised = false;

export function ensureAdmin(): void {
  if (_initialised) return;
  _initialised = true;

  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saJson) {
    try {
      const serviceAccount = JSON.parse(saJson);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log('[auth] Firebase Admin initialised with service account');
      return;
    } catch (e) {
      console.error('[auth] Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:', e);
    }
  }

  // Fallback: projectId-only (works for token verification but NOT Firestore)
  console.warn('[auth] No FIREBASE_SERVICE_ACCOUNT found — falling back to projectId-only init (Firestore unavailable)');
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID ?? 'meta-earth-dashboard',
  });
}

/** Returns the Firestore instance (initialises Firebase Admin first). */
export function getFirestoreDb(): admin.firestore.Firestore {
  ensureAdmin();
  return admin.firestore();
}

/**
 * Express middleware — verifies the Firebase ID token from the
 * `Authorization: Bearer <token>` header.
 * Returns 401 if missing or invalid, otherwise sets req.uid / req.email and calls next().
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  ensureAdmin();
  const header = req.headers.authorization ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorised — no token' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    (req as any).uid   = decoded.uid;
    (req as any).email = decoded.email ?? null;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorised — invalid or expired token' });
  }
}

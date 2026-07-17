import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';

// The Firebase web config is public by design (it identifies, not authorizes).
// Values come from build-time VITE_FIREBASE_* env vars with a fallback to the
// kybalion-pb project so a plain `vite build` still works out of the box.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'AIzaSyDYewHtIpPWtU_hB4n4GJAeWccVJTZDoH8',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'kybalion-pb.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'kybalion-pb',
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? 'kybalion-pb.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '710083096792',
  appId:
    import.meta.env.VITE_FIREBASE_APP_ID ??
    '1:710083096792:web:01e9717d5672ef54e567ad',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

/** Opens the Google sign-in popup, falling back to a redirect if it's blocked. */
export async function signInWithGoogle(): Promise<void> {
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    const code = (err as { code?: string })?.code ?? '';
    if (code === 'auth/popup-blocked' || code === 'auth/cancelled-popup-request') {
      await signInWithRedirect(auth, provider);
      return;
    }
    throw err;
  }
}

export function signOutUser(): Promise<void> {
  return signOut(auth);
}

export type { User };

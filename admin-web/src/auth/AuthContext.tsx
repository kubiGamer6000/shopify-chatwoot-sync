import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, signInWithGoogle, signOutUser, type User } from '@/lib/firebase';
import { fetchMe } from '@/lib/api';
import type { MeResponse, UserRole } from '@/lib/types';

interface AuthState {
  // Firebase user (null when signed out).
  user: User | null;
  // Server-verified identity + role (null until /me resolves).
  me: MeResponse | null;
  role: UserRole | null;
  // True during the initial auth + /me resolution (prevents UI flicker).
  loading: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    try {
      const result = await fetchMe();
      setMe(result);
      setError(null);
    } catch (err) {
      setMe(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (current) => {
      setUser(current);
      if (current) {
        await loadMe();
      } else {
        setMe(null);
      }
      setLoading(false);
    });
    return unsub;
  }, [loadMe]);

  const signIn = useCallback(async () => {
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const signOut = useCallback(async () => {
    await signOutUser();
    setMe(null);
  }, []);

  const value: AuthState = {
    user,
    me,
    role: me?.role ?? null,
    loading,
    error,
    signIn,
    signOut,
    refreshMe: loadMe,
  };

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

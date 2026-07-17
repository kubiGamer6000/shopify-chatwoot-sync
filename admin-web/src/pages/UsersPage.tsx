import { useEffect, useState } from 'react';
import { Check, Loader2, ShieldOff } from 'lucide-react';
import { fetchUsers, setUserRole } from '@/lib/api';
import type { UserRecord } from '@/lib/types';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function UsersPage() {
  const { me } = useAuth();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetchUsers();
      setUsers(res.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function changeRole(uid: string, role: 'admin' | 'pending') {
    setBusy(uid);
    setError(null);
    try {
      await setUserRole(uid, role);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Users</h1>
        <p className="text-muted-foreground text-sm">
          Anyone can sign in, but access requires the admin role. Approve or
          revoke access below.
        </p>
      </div>

      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {users.length} account{users.length === 1 ? '' : 's'}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
            </div>
          ) : users.length === 0 ? (
            <p className="text-muted-foreground text-sm">No users yet.</p>
          ) : (
            users.map((u) => {
              const isSelf = u.uid === me?.uid;
              return (
                <div
                  key={u.uid}
                  className="flex items-center justify-between gap-4 rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">
                        {u.displayName || u.email || u.uid}
                      </span>
                      {u.role === 'admin' ? (
                        <Badge variant="success">admin</Badge>
                      ) : (
                        <Badge variant="warning">pending</Badge>
                      )}
                      {isSelf ? <Badge variant="outline">you</Badge> : null}
                    </div>
                    <span className="text-muted-foreground truncate text-sm">
                      {u.email}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {u.role === 'pending' ? (
                      <Button
                        size="sm"
                        disabled={busy === u.uid}
                        onClick={() => void changeRole(u.uid, 'admin')}
                      >
                        {busy === u.uid ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Check className="size-4" />
                        )}
                        Approve
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === u.uid || isSelf}
                        onClick={() => void changeRole(u.uid, 'pending')}
                        title={isSelf ? 'You cannot revoke your own access' : undefined}
                      >
                        <ShieldOff className="size-4" />
                        Revoke
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}

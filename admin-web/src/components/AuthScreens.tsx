import { Clock, LogOut, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function LoginScreen() {
  const { signIn, error } = useAuth();
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="items-center text-center">
        <div className="bg-primary/10 mb-2 flex size-12 items-center justify-center rounded-full">
          <ShieldCheck className="text-primary size-6" />
        </div>
        <CardTitle className="text-xl">Scandi Admin Control</CardTitle>
        <CardDescription>
          Manage AI prompts, models, routing, and test prompt changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button onClick={() => void signIn()} className="w-full">
          Sign in with Google
        </Button>
        {error ? (
          <p className="text-destructive text-center text-sm">{error}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function PendingScreen() {
  const { me, user, signOut } = useAuth();
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="items-center text-center">
        <div className="bg-warning/15 mb-2 flex size-12 items-center justify-center rounded-full">
          <Clock className="text-warning size-6" />
        </div>
        <CardTitle className="text-xl">Awaiting approval</CardTitle>
        <CardDescription>
          You're signed in as{' '}
          <span className="font-medium">
            {me?.email ?? user?.email ?? 'unknown'}
          </span>
          , but your account needs to be approved by an administrator before you
          can access the dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          onClick={() => void signOut()}
          className="w-full"
        >
          <LogOut className="size-4" />
          Sign out
        </Button>
      </CardContent>
    </Card>
  );
}

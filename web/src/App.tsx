import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { useChatwootContext } from '@/lib/chatwoot';
import { fetchCustomerProfile } from '@/lib/api';
import type { CustomerProfile } from '@/lib/types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ProfileHeader } from '@/components/ProfileHeader';
import { SummaryRow } from '@/components/SummaryRow';
import { OrdersList } from '@/components/OrdersList';
import { SubscriptionsPanel } from '@/components/SubscriptionsPanel';
import { ToastProvider } from '@/components/Toast';

export function App() {
  return (
    <ToastProvider>
      <Dashboard />
    </ToastProvider>
  );
}

function Dashboard() {
  const { context } = useChatwootContext();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const shopifyCustomerId = context?.shopifyCustomerId ?? null;
  const email = context?.email ?? null;

  useEffect(() => {
    if (!context) return;
    if (!shopifyCustomerId && !email) {
      setProfile(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    // Clear stale data so we never show one customer's info under another.
    setProfile(null);

    fetchCustomerProfile({ shopifyCustomerId, email, signal: controller.signal })
      .then((data) => setProfile(data))
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load profile');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [context, shopifyCustomerId, email, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col gap-4 p-3 sm:p-4">
      {context === null ? (
        <WaitingState />
      ) : !shopifyCustomerId && !email ? (
        <EmptyState
          title="No customer linked"
          message="This conversation has no contact email or Shopify customer ID yet."
        />
      ) : loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : profile && profile.found ? (
        <Loaded profile={profile} onChanged={reload} />
      ) : (
        <EmptyState
          title="No Shopify match"
          message="We couldn't find this customer's orders or subscriptions in Shopify or Skio."
        />
      )}
    </div>
  );
}

function Loaded({
  profile,
  onChanged,
}: {
  profile: CustomerProfile;
  onChanged: () => void;
}) {
  const activeSubs = profile.summary.activeSubscriptionCount;

  return (
    <>
      <ProfileHeader profile={profile} />
      <SummaryRow profile={profile} />

      <Tabs defaultValue="orders" className="gap-3">
        <TabsList className="w-full">
          <TabsTrigger value="orders">
            Orders ({profile.orders.length})
          </TabsTrigger>
          <TabsTrigger value="subscriptions">
            Subscriptions{activeSubs > 0 ? ` (${activeSubs})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="orders">
          <OrdersList orders={profile.orders} />
        </TabsContent>

        <TabsContent value="subscriptions">
          <SubscriptionsPanel
            subscriptions={profile.subscriptions}
            currency={profile.summary.currency}
            onChanged={onChanged}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}

function WaitingState() {
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-16 text-sm">
      <Loader2 className="size-5 animate-spin" />
      Waiting for Chatwoot context…
    </div>
  );
}

function LoadingState() {
  return (
    <>
      <div className="flex items-center gap-3">
        <Skeleton className="size-11 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-52" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <AlertTriangle className="text-destructive size-6" />
        <div>
          <p className="font-medium">Something went wrong</p>
          <p className="text-muted-foreground mt-1 text-sm">{message}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-4" />
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
        <Inbox className="text-muted-foreground size-6" />
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground max-w-xs text-sm">{message}</p>
      </CardContent>
    </Card>
  );
}

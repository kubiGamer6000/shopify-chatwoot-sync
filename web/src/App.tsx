import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Inbox, KeyRound, Link2, Loader2, RefreshCw, SearchX } from 'lucide-react';
import { useChatwootContext } from '@/lib/chatwoot';
import { clearSession, connect, getLegacyToken, getSession } from '@/lib/auth';
import {
  AuthRequiredError,
  confirmLink,
  fetchCustomerProfile,
  setClaimedAgentId,
} from '@/lib/api';
import { useToast } from '@/components/Toast';
import type { CustomerProfile } from '@/lib/types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ProfileHeader } from '@/components/ProfileHeader';
import { SummaryRow } from '@/components/SummaryRow';
import { OrdersList } from '@/components/OrdersList';
import { SubscriptionsPanel } from '@/components/SubscriptionsPanel';
import { CustomerSummary, type SummaryContext } from '@/components/CustomerSummary';
import { ResponseComposer } from '@/components/ResponseComposer';
import { ToastProvider } from '@/components/Toast';
import type { CustomerSummary as CustomerSummaryType, ResolvedContext } from '@/lib/types';

export function App() {
  return (
    <ToastProvider>
      <Dashboard />
    </ToastProvider>
  );
}

function Dashboard() {
  const [signedIn, setSignedIn] = useState<boolean>(
    () => getSession() !== null || getLegacyToken() !== null,
  );
  const { context } = useChatwootContext();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const conversationId = context?.conversationId ?? null;

  useEffect(() => {
    setClaimedAgentId(context?.currentAgentId ?? null);
  }, [context?.currentAgentId]);

  useEffect(() => {
    if (!signedIn || !context) return;
    if (!conversationId) {
      setProfile(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setProfile(null);

    fetchCustomerProfile({ conversationId, signal: controller.signal })
      .then((data) => setProfile(data))
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        if (err instanceof AuthRequiredError) {
          clearSession();
          setSignedIn(false);
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load profile');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [signedIn, context, conversationId, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const handleSummaryRefreshed = useCallback((summary: CustomerSummaryType) => {
    setProfile((p) => (p ? { ...p, aiSummary: summary } : p));
  }, []);

  if (!signedIn) {
    return (
      <div className="mx-auto flex min-h-full max-w-2xl flex-col gap-4 p-3 sm:p-4">
        <ConnectState onConnected={() => setSignedIn(true)} />
      </div>
    );
  }

  const session = getSession();
  const agentMismatch =
    session && context?.currentAgentId && session.agent.id !== context.currentAgentId;

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col gap-4 p-3 sm:p-4">
      {agentMismatch && (
        <div className="border-warning/40 bg-warning/10 flex items-start justify-between gap-2 rounded-lg border px-3 py-2.5 text-sm">
          <span>
            Connected as {session.agent.name ?? `agent #${session.agent.id}`}, but Chatwoot
            shows {context?.currentAgentName ?? 'another agent'}.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              clearSession();
              setSignedIn(false);
            }}
          >
            Reconnect
          </Button>
        </div>
      )}
      {!session && getLegacyToken() && (
        <div className="border-warning/40 bg-warning/10 flex items-start justify-between gap-2 rounded-lg border px-3 py-2.5 text-sm">
          <span>Using the old shared link. Connect with your own Chatwoot token.</span>
          <Button variant="outline" size="sm" onClick={() => setSignedIn(false)}>
            Connect
          </Button>
        </div>
      )}
      {context === null ? (
        <WaitingState />
      ) : loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : profile && profile.found ? (
        <Loaded
          profile={profile}
          context={context}
          onChanged={reload}
          onSummaryRefreshed={handleSummaryRefreshed}
        />
      ) : context.conversationId != null || context.contactId != null ? (
        // No Shopify/Skio match (or nothing linked yet), but there's still a
        // conversation/contact — show a simplified panel so agents keep the AI
        // summary of past conversations and the reply composer.
        <SimplifiedView
          profile={profile}
          context={context}
          onChanged={reload}
          onSummaryRefreshed={handleSummaryRefreshed}
        />
      ) : (
        <EmptyState
          title="No customer linked"
          message="This conversation has no contact email or Shopify customer ID yet."
        />
      )}
      {session && (
        <p className="text-muted-foreground text-center text-xs">
          Signed in as {session.agent.name ?? `agent #${session.agent.id}`} ·{' '}
          <button
            type="button"
            className="underline"
            onClick={() => {
              clearSession();
              setSignedIn(false);
            }}
          >
            Sign out
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * Shown when the customer link is only a suggestion: the agent checks the
 * sender's identity and confirms with one click. Until then nothing can be
 * cancelled and the AI never uses this account's details.
 */
function LinkSuggestionBanner({
  profile,
  conversationId,
  onConfirmed,
}: {
  profile: CustomerProfile | null;
  conversationId: number | null;
  onConfirmed: () => void;
}) {
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  const link = profile?.link;
  const suggestion = link?.suggestion;
  if (!link || !suggestion || !conversationId) return null;
  const isCurrent = link.status === 'suggested';

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await confirmLink(conversationId, suggestion.email);
      notify('success', 'Customer link confirmed.');
      onConfirmed();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to confirm the link.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-warning/40 bg-warning/10 flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm">
      <div className="flex items-start gap-2">
        <Link2 className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">
            {isCurrent ? 'Suggested link — not verified' : 'Possible other account'}
          </p>
          <p className="text-muted-foreground">
            {suggestion.basis}: <span className="break-all">{suggestion.email}</span>
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            Check the sender is this customer (name + address or order) before confirming.
            Until confirmed, the AI won’t share account details and cancellations are blocked.
          </p>
        </div>
      </div>
      <div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleConfirm()}>
          {busy && <RefreshCw className="size-4 animate-spin" />}
          Confirm link
        </Button>
      </div>
    </div>
  );
}

function Loaded({
  profile,
  context,
  onChanged,
  onSummaryRefreshed,
}: {
  profile: CustomerProfile;
  context: ResolvedContext;
  onChanged: () => void;
  onSummaryRefreshed: (summary: CustomerSummaryType) => void;
}) {
  const activeSubs = profile.summary.activeSubscriptionCount;

  const summaryContext: SummaryContext = {
    contactId: context.contactId,
    conversationId: context.conversationId,
    email: context.email,
    shopifyCustomerId: context.shopifyCustomerId,
    customerName: context.contactName,
  };

  return (
    <>
      <ProfileHeader customer={profile.customer} linkStatus={profile.link?.status} />
      <LinkSuggestionBanner
        profile={profile}
        conversationId={context.conversationId}
        onConfirmed={onChanged}
      />
      <SummaryRow profile={profile} />

      <CustomerSummary
        summary={profile.aiSummary ?? null}
        context={summaryContext}
        onRefreshed={onSummaryRefreshed}
      />

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
            conversationId={context.conversationId}
            canCancel={profile.link?.status === 'verified'}
            onChanged={onChanged}
          />
        </TabsContent>
      </Tabs>

      {context.conversationId && (
        <div className="mt-2 border-t pt-5">
          <ResponseComposer context={context} />
        </div>
      )}
    </>
  );
}

function SimplifiedView({
  profile,
  context,
  onChanged,
  onSummaryRefreshed,
}: {
  profile: CustomerProfile | null;
  context: ResolvedContext;
  onChanged: () => void;
  onSummaryRefreshed: (summary: CustomerSummaryType) => void;
}) {
  const summaryContext: SummaryContext = {
    contactId: context.contactId,
    conversationId: context.conversationId,
    email: context.email,
    shopifyCustomerId: context.shopifyCustomerId,
    customerName: context.contactName,
  };

  // Merge whatever we know: prefer the (partial) Shopify profile, fall back to
  // the Chatwoot contact identity from the conversation context.
  const customer = {
    shopifyCustomerId: profile?.customer.shopifyCustomerId ?? null,
    name: profile?.customer.name ?? context.contactName ?? null,
    email: profile?.customer.email ?? context.email ?? null,
    phone: profile?.customer.phone ?? null,
    address: profile?.customer.address ?? null,
    shopifyUrl: profile?.customer.shopifyUrl ?? null,
  };

  return (
    <>
      <ProfileHeader customer={customer} />

      <LinkSuggestionBanner
        profile={profile}
        conversationId={context.conversationId}
        onConfirmed={onChanged}
      />

      <div className="border-warning/40 bg-warning/10 text-warning-foreground/90 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm">
        <SearchX className="mt-0.5 size-4 shrink-0" />
        <span>
          No Shopify or Skio match for this contact. Showing the AI summary of
          past conversations and the reply composer only.
        </span>
      </div>

      <CustomerSummary
        summary={profile?.aiSummary ?? null}
        context={summaryContext}
        onRefreshed={onSummaryRefreshed}
      />

      {context.conversationId && (
        <div className="mt-2 border-t pt-5">
          <ResponseComposer context={context} />
        </div>
      )}
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

function ConnectState({ onConnected }: { onConnected: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await connect(token);
      setToken('');
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <KeyRound className="text-muted-foreground size-6" />
        <div>
          <p className="font-medium">Connect Customer 360</p>
          <p className="text-muted-foreground mt-1 max-w-sm text-sm">
            One-time step per browser. In Chatwoot open your avatar → Profile settings, copy your
            Access Token and paste it here. It is checked with Chatwoot and not stored.
          </p>
        </div>
        <form className="flex w-full max-w-sm flex-col gap-2" onSubmit={(e) => void handleConnect(e)}>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="border-input rounded-md border bg-transparent px-3 py-2 text-sm"
            placeholder="Chatwoot access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-label="Chatwoot access token"
          />
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button type="submit" disabled={busy || !token.trim()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Connect
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

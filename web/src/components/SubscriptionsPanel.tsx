import * as React from 'react';
import { CalendarClock, Package, RefreshCw, Repeat, Sprout } from 'lucide-react';
import type { SubscriptionDTO } from '@/lib/types';
import {
  formatDate,
  formatMoney,
  subscriptionStatusVariant,
  titleCase,
} from '@/lib/format';
import { cancelSubscription } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/components/Toast';

export function SubscriptionsPanel({
  subscriptions,
  currency,
  onChanged,
}: {
  subscriptions: SubscriptionDTO[];
  currency: string;
  onChanged: () => void;
}) {
  if (subscriptions.length === 0) {
    return (
      <div className="border-border/60 flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-center">
        <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-full">
          <Sprout className="size-5" />
        </div>
        <p className="text-sm font-medium">No subscriptions yet</p>
        <p className="text-muted-foreground text-xs">
          This customer has had 0 subscriptions.
        </p>
      </div>
    );
  }

  // Active subscriptions first, then cancelled/inactive — no section headers
  // since customers typically have only one or two subscriptions.
  const ordered = [...subscriptions].sort(
    (a, b) => Number(b.isActive) - Number(a.isActive),
  );

  return (
    <div className="flex flex-col gap-3">
      {ordered.map((sub) => (
        <SubscriptionCard
          key={sub.id}
          sub={sub}
          currency={currency}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function SubscriptionCard({
  sub,
  currency,
  onChanged,
}: {
  sub: SubscriptionDTO;
  currency: string;
  onChanged: () => void;
}) {
  const { notify } = useToast();
  const [isCancelling, setIsCancelling] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  const handleCancel = async () => {
    setIsCancelling(true);
    try {
      await cancelSubscription(sub.id);
      notify('success', 'Subscription cancelled.');
      setOpen(false);
      onChanged();
    } catch (err) {
      notify(
        'error',
        err instanceof Error ? err.message : 'Failed to cancel subscription.',
      );
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <Card className={cn('gap-0 py-0', !sub.isActive && 'bg-muted/20')}>
      <CardContent className="flex flex-col gap-3 px-3.5 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={subscriptionStatusVariant(sub.status)}>
              {titleCase(sub.status)}
            </Badge>
            {sub.intervalLabel && (
              <Badge variant="outline" className="gap-1">
                <Repeat className="size-3" />
                {sub.intervalLabel}
              </Badge>
            )}
          </div>
          {sub.isActive && (
            <AlertDialog open={open} onOpenChange={setOpen}>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" className="h-7 px-2.5">
                  Cancel
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Cancel this subscription?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently cancels the customer's subscription in Skio
                    and the underlying Shopify contract. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isCancelling}>
                    Keep subscription
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(e) => {
                      e.preventDefault();
                      void handleCancel();
                    }}
                    disabled={isCancelling}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {isCancelling && (
                      <RefreshCw className="size-4 animate-spin" />
                    )}
                    {isCancelling ? 'Cancelling…' : 'Yes, cancel'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          {sub.lines.map((line, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <Package className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              <span className="flex-1">
                {line.productTitle}
                {line.variantTitle ? (
                  <span className="text-muted-foreground">
                    {' '}
                    · {line.variantTitle}
                  </span>
                ) : null}
                {line.quantity && line.quantity > 1 ? (
                  <span className="text-muted-foreground"> ×{line.quantity}</span>
                ) : null}
              </span>
              {line.price != null && (
                <span className="text-muted-foreground shrink-0">
                  {formatMoney(line.price, currency)}
                </span>
              )}
            </div>
          ))}
        </div>

        <Separator />

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {sub.isActive && sub.nextBillingDate && (
            <span className="flex items-center gap-1">
              <CalendarClock className="size-3.5" />
              Next billing {formatDate(sub.nextBillingDate)}
            </span>
          )}
          {!sub.isActive && sub.cancelledAt && (
            <span>Cancelled {formatDate(sub.cancelledAt)}</span>
          )}
          <span>Started {formatDate(sub.createdAt)}</span>
          {sub.cyclesCompleted != null && (
            <span>{sub.cyclesCompleted} orders billed</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

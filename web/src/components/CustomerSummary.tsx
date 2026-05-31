import * as React from 'react';
import { ChevronDown, RefreshCw, Sparkles } from 'lucide-react';
import type { CustomerSummary as CustomerSummaryType } from '@/lib/types';
import { refreshSummary } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/components/Toast';

export interface SummaryContext {
  contactId: number | null;
  conversationId: number | null;
  email: string | null;
  shopifyCustomerId: string | null;
  customerName: string | null;
}

export function CustomerSummary({
  summary,
  context,
  onRefreshed,
}: {
  summary: CustomerSummaryType | null;
  context: SummaryContext;
  onRefreshed: (summary: CustomerSummaryType) => void;
}) {
  const { notify } = useToast();
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const canGenerate = context.contactId != null;

  const handleRefresh = async () => {
    if (!context.contactId) return;
    setBusy(true);
    try {
      const res = await refreshSummary({
        contactId: context.contactId,
        conversationId: context.conversationId,
        email: context.email,
        shopifyCustomerId: context.shopifyCustomerId,
        customerName: context.customerName,
      });
      if (res.summary) {
        onRefreshed(res.summary);
        setExpanded(true);
        notify('success', 'Summary updated.');
      } else {
        notify('error', 'Could not generate a summary.');
      }
    } catch (err) {
      notify(
        'error',
        err instanceof Error ? err.message : 'Failed to refresh summary.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="bg-muted/30">
      <CardContent className="flex flex-col gap-2 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="text-info size-4" />
            AI Summary
          </div>
          <div className="flex items-center gap-2">
            {summary && (
              <span className="text-muted-foreground hidden text-xs sm:inline">
                {formatDateTime(summary.generatedAt)}
              </span>
            )}
            {canGenerate && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={handleRefresh}
                disabled={busy}
                title="Regenerate summary"
              >
                <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
              </Button>
            )}
          </div>
        </div>

        {summary ? (
          <>
            <p className="text-sm leading-relaxed">{summary.overview}</p>

            {expanded && (
              <>
                <Separator className="my-1" />
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                    Conversation history
                  </span>
                  <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap">
                    {summary.history}
                  </p>
                </div>
              </>
            )}

            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-info mt-0.5 flex items-center gap-1 self-start text-xs font-medium hover:underline"
            >
              {expanded ? 'Show less' : 'Show full history'}
              <ChevronDown
                className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
              />
            </button>
          </>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground text-sm">
              {busy
                ? 'Generating summary…'
                : 'No AI summary yet for this customer.'}
            </p>
            {canGenerate && !busy && (
              <Button variant="outline" size="sm" onClick={handleRefresh}>
                <Sparkles className="size-3.5" />
                Generate
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

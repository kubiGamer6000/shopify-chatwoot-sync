import * as React from 'react';
import { ChevronDown, RefreshCw, Sparkles } from 'lucide-react';
import type {
  ConversationHistoryItem,
  CustomerSummary as CustomerSummaryType,
} from '@/lib/types';
import { refreshSummary } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/components/Toast';

function statusVariant(status: string | null): 'success' | 'warning' | 'secondary' {
  const s = (status ?? '').toLowerCase();
  if (s === 'resolved') return 'success';
  if (s === 'open' || s === 'pending' || s === 'snoozed') return 'warning';
  return 'secondary';
}

function HistoryView({
  history,
}: {
  history: ConversationHistoryItem[] | string;
}) {
  // Backward compatibility: older summaries stored history as a single string.
  if (typeof history === 'string') {
    return (
      <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap">
        {history}
      </p>
    );
  }

  if (history.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No prior support history.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {history.map((item, i) => (
        <div
          key={i}
          className="border-border/60 bg-card/70 flex flex-col gap-1 rounded-lg border p-2.5"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold">
              {item.conversationId
                ? `Conversation #${item.conversationId}`
                : 'Conversation'}
            </span>
            {item.date && (
              <span className="text-muted-foreground text-xs">
                {formatDate(item.date)}
              </span>
            )}
            {item.status && (
              <Badge variant={statusVariant(item.status)} className="ml-auto">
                {item.status}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap">
            {item.summary}
          </p>
        </div>
      ))}
    </div>
  );
}

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
    <Card className="border-info/20 bg-info/5">
      <CardContent className="flex flex-col gap-2 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="bg-info/10 text-info flex size-6 items-center justify-center rounded-md">
              <Sparkles className="size-3.5" />
            </span>
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
                <div className="flex flex-col gap-2">
                  <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                    Conversation history
                  </span>
                  <HistoryView history={summary.history} />
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

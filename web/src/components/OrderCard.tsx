import * as React from 'react';
import {
  ChevronDown,
  ExternalLink,
  MapPin,
  Sparkles,
  Truck,
} from 'lucide-react';
import type { OrderDTO, OrderTrackingDTO } from '@/lib/types';
import {
  deliveryLabel,
  deliveryVariant,
  financialLabel,
  financialVariant,
  formatDate,
  formatDateTime,
  formatMoney,
} from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export function OrderCard({ order }: { order: OrderDTO }) {
  const hasTracking = order.tracking.length > 0;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <a
              href={order.adminUrl}
              target="_blank"
              rel="noreferrer"
              className="group inline-flex items-center gap-1 font-semibold hover:underline"
            >
              {order.name}
              <ExternalLink className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
            </a>
            <div className="text-muted-foreground text-xs">
              {formatDate(order.createdAt)}
            </div>
          </div>
          <div className="text-right">
            <div className="font-semibold">
              {formatMoney(order.totalPrice, order.currency)}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={deliveryVariant(order.deliveryStatus)}>
            {deliveryLabel(order.deliveryStatus)}
          </Badge>
          <Badge variant={financialVariant(order.financialStatus)}>
            {financialLabel(order.financialStatus)}
          </Badge>
          {order.subscriptionType && (
            <Badge variant="outline" className="gap-1">
              <Sparkles className="size-3" />
              {order.subscriptionType === 'first'
                ? 'Subscription · First'
                : 'Subscription · Recurring'}
            </Badge>
          )}
        </div>

        <ul className="text-muted-foreground flex flex-col gap-0.5 text-sm">
          {order.lineItems.map((item, i) => (
            <li key={i} className="flex justify-between gap-2">
              <span className="truncate">
                {item.title}
                {item.variantTitle && item.variantTitle !== 'Default Title' ? (
                  <span className="opacity-70"> · {item.variantTitle}</span>
                ) : null}
                <span className="opacity-70"> ×{item.quantity}</span>
              </span>
            </li>
          ))}
        </ul>

        {hasTracking && <TrackingSection tracking={order.tracking} />}
      </CardContent>
    </Card>
  );
}

function TrackingSection({ tracking }: { tracking: OrderTrackingDTO[] }) {
  const [open, setOpen] = React.useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 text-xs font-medium transition-colors">
        <Truck className="size-3.5" />
        Tracking ({tracking.length})
        <ChevronDown
          className={cn(
            'size-3.5 transition-transform',
            open && 'rotate-180',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 overflow-hidden">
        <div className="mt-2 flex flex-col gap-2">
          {tracking.map((t, i) => (
            <TrackingRow key={`${t.number}-${i}`} tracking={t} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const DEFAULT_EVENT_COUNT = 5;

function TrackingRow({ tracking }: { tracking: OrderTrackingDTO }) {
  const live = tracking.live;
  const [showAll, setShowAll] = React.useState(false);

  const events = live?.events ?? [];
  const visibleEvents = showAll
    ? events
    : events.slice(0, DEFAULT_EVENT_COUNT);

  return (
    <div className="bg-muted/40 rounded-md border px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {tracking.company || live?.carrier || 'Carrier'}
        </span>
        {tracking.url ? (
          <a
            href={tracking.url}
            target="_blank"
            rel="noreferrer"
            className="text-info inline-flex items-center gap-1 hover:underline"
          >
            {tracking.number}
            <ExternalLink className="size-3" />
          </a>
        ) : (
          <span className="text-muted-foreground">{tracking.number}</span>
        )}
      </div>

      {live ? (
        <div className="mt-1.5 flex flex-col gap-1">
          {live.status && (
            <div>
              <span className="text-muted-foreground">Status: </span>
              <span className="font-medium">
                {live.status}
                {live.subStatus ? ` (${live.subStatus})` : ''}
              </span>
            </div>
          )}

          <TransitMetrics live={live} />

          {events.length > 0 && (
            <>
              <ol className="border-border mt-1.5 flex flex-col gap-2 border-l pl-3">
                {visibleEvents.map((e, i) => (
                  <li key={i} className="relative">
                    <span className="bg-border absolute top-1 -left-[15px] size-1.5 rounded-full" />
                    <div className="text-foreground/80 font-medium">
                      {e.time_iso || e.time_utc
                        ? formatDateTime(e.time_utc || e.time_iso)
                        : ''}
                    </div>
                    <div className="text-muted-foreground">{e.description}</div>
                    {(e.location || e.provider) && (
                      <div className="text-muted-foreground/80 flex items-center gap-1">
                        <MapPin className="size-3 shrink-0" />
                        {[e.location, e.provider].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
              {events.length > DEFAULT_EVENT_COUNT && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="text-info mt-1 self-start hover:underline"
                >
                  {showAll
                    ? 'Show less'
                    : `Show all ${events.length} updates`}
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="text-muted-foreground mt-1">
          {tracking.shipmentStatus
            ? `Carrier status: ${tracking.shipmentStatus.replace(/_/g, ' ')}`
            : 'No live tracking events yet.'}
        </div>
      )}
    </div>
  );
}

function TransitMetrics({
  live,
}: {
  live: NonNullable<OrderTrackingDTO['live']>;
}) {
  const bits: string[] = [];
  if (live.daysInTransit != null) {
    bits.push(`${live.daysInTransit}d in transit`);
  }
  if (live.originCountry && live.destinationCountry) {
    bits.push(`${live.originCountry} → ${live.destinationCountry}`);
  }

  return (
    <>
      {live.estimatedDelivery?.from && (
        <div className="text-muted-foreground">
          Est. delivery: {formatDate(live.estimatedDelivery.from)}
          {live.estimatedDelivery.to
            ? ` – ${formatDate(live.estimatedDelivery.to)}`
            : ''}
        </div>
      )}
      {bits.length > 0 && (
        <div className="text-muted-foreground/80">{bits.join(' · ')}</div>
      )}
    </>
  );
}

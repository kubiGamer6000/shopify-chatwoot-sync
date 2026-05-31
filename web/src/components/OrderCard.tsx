import * as React from 'react';
import {
  ChevronDown,
  ExternalLink,
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

function TrackingRow({ tracking }: { tracking: OrderTrackingDTO }) {
  const live = tracking.live;
  return (
    <div className="bg-muted/40 rounded-md border px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {tracking.company || 'Carrier'}
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
          {live.lastEvent && (
            <div className="text-muted-foreground">
              {live.lastEvent}
              {live.lastLocation ? ` — ${live.lastLocation}` : ''}
            </div>
          )}
          {live.estimatedDelivery?.from && (
            <div className="text-muted-foreground">
              Est. delivery: {formatDate(live.estimatedDelivery.from)}
              {live.estimatedDelivery.to
                ? ` – ${formatDate(live.estimatedDelivery.to)}`
                : ''}
            </div>
          )}
          {live.events.length > 0 && (
            <ol className="border-border mt-1 flex flex-col gap-1 border-l pl-3">
              {live.events.slice(0, 6).map((e, i) => (
                <li key={i} className="text-muted-foreground">
                  <span className="text-foreground/70">
                    {e.time_iso ? formatDate(e.time_iso) : ''}
                  </span>{' '}
                  {e.description}
                  {e.location ? ` (${e.location})` : ''}
                </li>
              ))}
            </ol>
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

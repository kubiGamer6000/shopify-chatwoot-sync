import type { LucideIcon } from 'lucide-react';
import { BadgeCheck, Repeat, ShoppingBag, Wallet } from 'lucide-react';
import type { CustomerProfile } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Stat {
  label: string;
  value: string;
  icon: LucideIcon;
  iconClass: string;
}

export function SummaryRow({ profile }: { profile: CustomerProfile }) {
  const { summary } = profile;

  const stats: Stat[] = [
    {
      label: 'Orders',
      value: String(summary.totalOrders),
      icon: ShoppingBag,
      iconClass: 'bg-info/10 text-info',
    },
    {
      label: 'Lifetime value',
      value: formatMoney(summary.totalSpent, summary.currency),
      icon: Wallet,
      iconClass: 'bg-success/10 text-success',
    },
    {
      label: 'Sub. orders',
      value: String(summary.subscriptionOrderCount),
      icon: Repeat,
      iconClass: 'bg-warning/15 text-warning',
    },
    {
      label: 'Active subs',
      value: String(summary.activeSubscriptionCount),
      icon: BadgeCheck,
      iconClass:
        summary.activeSubscriptionCount > 0
          ? 'bg-success/10 text-success'
          : 'bg-muted text-muted-foreground',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {stats.map((s) => {
        const Icon = s.icon;
        return (
          <div
            key={s.label}
            className="bg-card flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 shadow-xs"
          >
            <div
              className={cn(
                'flex size-6 items-center justify-center rounded-md',
                s.iconClass,
              )}
            >
              <Icon className="size-3.5" />
            </div>
            <div>
              <div className="truncate text-base font-semibold leading-tight">
                {s.value}
              </div>
              <div className="text-muted-foreground text-xs">{s.label}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

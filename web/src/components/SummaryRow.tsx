import type { CustomerProfile } from '@/lib/types';
import { formatMoney } from '@/lib/format';

export function SummaryRow({ profile }: { profile: CustomerProfile }) {
  const { summary } = profile;

  const stats: { label: string; value: string }[] = [
    { label: 'Orders', value: String(summary.totalOrders) },
    {
      label: 'Lifetime value',
      value: formatMoney(summary.totalSpent, summary.currency),
    },
    { label: 'Sub. orders', value: String(summary.subscriptionOrderCount) },
    {
      label: 'Active subs',
      value: String(summary.activeSubscriptionCount),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {stats.map((s) => (
        <div
          key={s.label}
          className="bg-muted/40 rounded-lg border px-3 py-2"
        >
          <div className="text-muted-foreground text-xs">{s.label}</div>
          <div className="mt-0.5 truncate text-base font-semibold">
            {s.value}
          </div>
        </div>
      ))}
    </div>
  );
}

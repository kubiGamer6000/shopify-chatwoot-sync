import type { DeliveryStatus } from './types';

export function formatMoney(amount: string | number, currency: string): string {
  const value = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (Number.isNaN(value)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'info';

const DELIVERY_LABELS: Record<DeliveryStatus, string> = {
  unfulfilled: 'Unfulfilled',
  partially_fulfilled: 'Partially fulfilled',
  fulfilled: 'Fulfilled',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  ready_for_pickup: 'Ready for pickup',
  delivered: 'Delivered',
  failure: 'Delivery failed',
  cancelled: 'Cancelled',
};

const DELIVERY_VARIANTS: Record<DeliveryStatus, BadgeVariant> = {
  unfulfilled: 'secondary',
  partially_fulfilled: 'warning',
  fulfilled: 'info',
  in_transit: 'info',
  out_for_delivery: 'info',
  ready_for_pickup: 'warning',
  delivered: 'success',
  failure: 'destructive',
  cancelled: 'destructive',
};

export function deliveryLabel(status: DeliveryStatus): string {
  return DELIVERY_LABELS[status] ?? status;
}

export function deliveryVariant(status: DeliveryStatus): BadgeVariant {
  return DELIVERY_VARIANTS[status] ?? 'secondary';
}

export function financialVariant(status: string): BadgeVariant {
  const s = status.toLowerCase();
  if (s === 'paid') return 'success';
  if (s === 'pending' || s === 'authorized') return 'warning';
  if (s === 'refunded' || s === 'voided' || s === 'partially_refunded') {
    return 'destructive';
  }
  return 'secondary';
}

export function financialLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

export function subscriptionStatusVariant(status: string): BadgeVariant {
  const s = status.toLowerCase();
  if (s === 'active') return 'success';
  if (s === 'paused' || s === 'under review') return 'warning';
  if (s === 'cancelled' || s === 'failed') return 'destructive';
  return 'secondary';
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[\s_]+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

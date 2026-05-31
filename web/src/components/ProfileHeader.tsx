import { ExternalLink, Mail, Phone, MapPin, User } from 'lucide-react';
import type { CustomerProfile } from '@/lib/types';
import { Button } from '@/components/ui/button';

export function ProfileHeader({ profile }: { profile: CustomerProfile }) {
  const { customer } = profile;
  const name = customer.name || 'Unknown customer';

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <div className="from-info to-primary text-primary-foreground flex size-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-base font-semibold shadow-sm">
          {initials(customer.name)}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold leading-tight">
            {name}
          </h1>
          <div className="text-muted-foreground mt-1 flex flex-col gap-0.5 text-sm">
            {customer.email && (
              <span className="flex items-center gap-1.5">
                <Mail className="size-3.5 shrink-0" />
                <span className="truncate">{customer.email}</span>
              </span>
            )}
            {customer.phone && (
              <span className="flex items-center gap-1.5">
                <Phone className="size-3.5 shrink-0" />
                {customer.phone}
              </span>
            )}
            {customer.address && (
              <span className="flex items-center gap-1.5">
                <MapPin className="size-3.5 shrink-0" />
                <span className="truncate">{customer.address}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {customer.shopifyUrl && (
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <a href={customer.shopifyUrl} target="_blank" rel="noreferrer">
            <User className="size-3.5" />
            Shopify
            <ExternalLink className="size-3.5" />
          </a>
        </Button>
      )}
    </div>
  );
}

function initials(name: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]![0] : '';
  return (first + last).toUpperCase() || '?';
}

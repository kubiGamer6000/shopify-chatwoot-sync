import type { OrderDTO } from '@/lib/types';
import { OrderCard } from './OrderCard';

export function OrdersList({ orders }: { orders: OrderDTO[] }) {
  if (orders.length === 0) {
    return (
      <p className="text-muted-foreground py-6 text-center text-sm">
        No orders found for this customer.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {orders.map((order) => (
        <OrderCard key={order.id} order={order} />
      ))}
    </div>
  );
}

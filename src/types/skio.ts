// --- Skio (subscriptions) Types ---

export interface SkioProductVariant {
  title: string | null;
  Product: { title: string | null } | null;
}

export interface SkioSubscriptionLine {
  id: string;
  quantity: number | null;
  priceWithoutDiscount: number | null;
  ProductVariant: SkioProductVariant | null;
}

export interface SkioPolicy {
  interval: string | null;
  intervalCount: number | null;
}

export interface SkioSubscription {
  id: string;
  platformId: string | null;
  status: string;
  statusContext: string | null;
  createdAt: string;
  cancelledAt: string | null;
  nextBillingDate: string | null;
  cyclesCompleted: number | null;
  DeliveryPolicy: SkioPolicy | null;
  SubscriptionLines: SkioSubscriptionLine[];
}

export interface SkioGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

// Mirrors the API DTOs returned by the Express backend (src/services/customerProfile.ts).

export type DeliveryStatus =
  | 'unfulfilled'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'in_transit'
  | 'out_for_delivery'
  | 'ready_for_pickup'
  | 'delivered'
  | 'failure'
  | 'cancelled';

export type SubscriptionOrderType = 'first' | 'recurring' | null;

export interface TrackingEvent {
  time_iso?: string;
  time_utc?: string;
  description?: string;
  location?: string;
  stage?: string;
  sub_status?: string;
  provider?: string;
}

export interface TrackingSummary {
  status?: string;
  subStatus?: string;
  lastEvent?: string;
  lastLocation?: string;
  lastUpdate?: string;
  estimatedDelivery?: { from?: string; to?: string };
  carrier?: string;
  daysInTransit?: number;
  daysAfterOrder?: number;
  originCountry?: string;
  destinationCountry?: string;
  events: TrackingEvent[];
}

export interface OrderLineItemDTO {
  title: string;
  quantity: number;
  price: string;
  variantTitle?: string;
}

export interface OrderTrackingDTO {
  number: string;
  company?: string;
  url?: string;
  shipmentStatus?: string | null;
  live?: TrackingSummary;
}

export interface OrderDTO {
  id: number;
  name: string;
  createdAt: string;
  date: string;
  totalPrice: string;
  currency: string;
  financialStatus: string;
  fulfillmentStatus: string;
  deliveryStatus: DeliveryStatus;
  subscriptionType: SubscriptionOrderType;
  cancelledAt: string | null;
  lineItems: OrderLineItemDTO[];
  tracking: OrderTrackingDTO[];
  adminUrl: string;
}

export interface SubscriptionLineDTO {
  productTitle: string;
  variantTitle: string | null;
  quantity: number | null;
  price: number | null;
}

export interface SubscriptionDTO {
  id: string;
  platformId: string | null;
  status: string;
  statusContext: string | null;
  isActive: boolean;
  createdAt: string;
  cancelledAt: string | null;
  nextBillingDate: string | null;
  cyclesCompleted: number | null;
  intervalLabel: string | null;
  lines: SubscriptionLineDTO[];
}

export interface CustomerProfile {
  found: boolean;
  customer: {
    shopifyCustomerId: number | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    shopifyUrl: string | null;
  };
  summary: {
    totalOrders: number;
    totalSpent: string;
    currency: string;
    subscriptionOrderCount: number;
    activeSubscriptionCount: number;
  };
  orders: OrderDTO[];
  subscriptions: SubscriptionDTO[];
  aiSummary?: CustomerSummary | null;
}

// --- Chatwoot appContext payload ---

export interface ChatwootSender {
  id: number;
  name?: string;
  email?: string;
  phone_number?: string;
  identifier?: string | null;
  custom_attributes?: Record<string, unknown>;
}

export interface ChatwootAppContext {
  conversation?: {
    id: number;
    inbox_id?: number;
    status?: string;
    custom_attributes?: Record<string, unknown>;
    meta?: {
      sender?: ChatwootSender;
      assignee?: { id: number; name?: string };
    };
  };
  contact?: ChatwootSender;
  currentAgent?: {
    id: number;
    name?: string;
    email?: string;
    role?: string;
  };
}

export interface ResolvedContext {
  conversationId: number | null;
  contactId: number | null;
  shopifyCustomerId: string | null;
  email: string | null;
  contactName: string | null;
}

export interface CustomerSummary {
  contactId: number;
  email: string | null;
  shopifyCustomerId: string | null;
  conversationId: number | null;
  overview: string;
  history: string;
  model: string;
  generatedAt: string;
}

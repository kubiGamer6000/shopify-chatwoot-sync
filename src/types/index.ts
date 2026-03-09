// --- Shopify Types ---

export interface ShopifyAddress {
  id?: number;
  first_name?: string;
  last_name?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  province_code?: string;
  country?: string;
  country_code?: string;
  zip?: string;
  phone?: string;
}

export interface ShopifyCustomer {
  id: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  orders_count?: number;
  total_spent?: string;
  currency?: string;
  default_address?: ShopifyAddress;
  addresses?: ShopifyAddress[];
  tags?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ShopifyFulfillment {
  id: number;
  order_id: number;
  status: string;
  tracking_company?: string;
  tracking_number?: string;
  tracking_numbers?: string[];
  tracking_url?: string;
  tracking_urls?: string[];
  created_at: string;
  updated_at: string;
}

export interface ShopifyLineItem {
  id: number;
  title: string;
  quantity: number;
  price: string;
  sku?: string;
  variant_title?: string;
  product_id?: number;
  variant_id?: number;
}

export interface ShopifyOrder {
  id: number;
  name: string;
  email?: string;
  created_at: string;
  updated_at: string;
  financial_status?: string;
  fulfillment_status?: string | null;
  total_price: string;
  subtotal_price?: string;
  currency: string;
  customer?: ShopifyCustomer;
  line_items?: ShopifyLineItem[];
  fulfillments?: ShopifyFulfillment[];
  shipping_address?: ShopifyAddress;
  tags?: string;
  order_status_url?: string;
  cancel_reason?: string | null;
  cancelled_at?: string | null;
}

// --- Chatwoot Types ---

export interface ChatwootCustomAttributes {
  shopify_customer_id: string;
  shopify_url: string;
  total_orders: number;
  total_spent: string;
  last_order_name: string;
  last_order_status: string;
  last_order_tracking_url: string;
  last_order_date: string;
  default_address: string;
  recent_orders: string;
  subscription_orders: number;
}

export interface ChatwootContactPayload {
  name?: string;
  email?: string;
  phone_number?: string;
  identifier?: string;
  custom_attributes?: Partial<ChatwootCustomAttributes>;
}

export interface ChatwootContact {
  id: number;
  name?: string;
  email?: string;
  phone_number?: string;
  identifier?: string;
  custom_attributes?: Record<string, unknown>;
  additional_attributes?: Record<string, unknown>;
  thumbnail?: string;
  availability_status?: string;
}

export interface ChatwootSearchResponse {
  payload: ChatwootContact[];
  meta?: { count: number; current_page: string };
}

export interface ChatwootCreateResponse {
  payload: { contact: ChatwootContact };
}

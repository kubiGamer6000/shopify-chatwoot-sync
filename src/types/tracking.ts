export type TrackStatus =
  | 'NotFound'
  | 'InfoReceived'
  | 'InTransit'
  | 'OutForDelivery'
  | 'FailedAttempt'
  | 'Delivered'
  | 'AvailableForPickup'
  | 'Exception'
  | 'Expired';

export interface TrackEvent {
  time_iso: string;
  time_utc?: string;
  description: string;
  location?: string;
  stage?: string;
}

export interface TrackMilestone {
  key_stage: string;
  time_iso: string;
  description: string;
}

export interface TrackProvider {
  provider: { key: number; name: string; alias?: string };
  service_type?: string;
  latest_sync_status?: string;
  latest_sync_time?: string;
  events: TrackEvent[];
}

export interface TrackInfo {
  latest_status: {
    status: TrackStatus;
    sub_status?: string;
  };
  latest_event?: TrackEvent;
  time_metrics?: {
    days_after_order?: number;
    days_of_transit?: number;
    estimated_delivery_date?: { from: string; to: string };
  };
  milestone?: TrackMilestone[];
  tracking?: {
    providers_hash: string;
    providers: TrackProvider[];
  };
  misc_info?: {
    weight_kg?: number;
    service_type?: string;
    origin_country?: string;
    destination_country?: string;
  };
}

export interface AcceptedTrackItem {
  number: string;
  carrier?: number;
  tag?: string;
  track_info: TrackInfo;
}

export interface RejectedTrackItem {
  number: string;
  error: { code: number; message: string };
}

export interface TrackInfoResponse {
  code: number;
  data: {
    accepted: AcceptedTrackItem[];
    rejected: RejectedTrackItem[];
  };
}

export interface RegisterTrackingItem {
  number: string;
  carrier?: number | null;
  tag?: string;
  order_id?: string;
}

export interface TrackingSummary {
  status: TrackStatus;
  subStatus?: string;
  lastEvent?: string;
  lastLocation?: string;
  lastUpdate?: string;
  estimatedDelivery?: { from: string; to: string };
  events: TrackEvent[];
}

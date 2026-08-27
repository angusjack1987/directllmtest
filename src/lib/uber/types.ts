/**
 * Types for the Uber Direct API surface this app uses.
 *
 * Monetary fields are in CENTS everywhere except `RefundRequest.total_refund_amount`,
 * which is e5. See money.ts.
 */

/**
 * Structured address. Recommended over the flat string form for accuracy and
 * validation. Apartment/unit numbers are a SEPARATE element of `street_address`,
 * never appended to the street line.
 */
export interface StructuredAddress {
  street_address: string[];
  city: string;
  state: string;
  zip_code: string;
  country: string;
}

export type MerchantType =
  | "MERCHANT_TYPE_RESTAURANT"
  | "MERCHANT_TYPE_GROCERY"
  | "MERCHANT_TYPE_LIQUOR"
  | "MERCHANT_TYPE_RETAIL"
  | "MERCHANT_TYPE_ESSENTIALS"
  | "MERCHANT_TYPE_PHARMACY"
  | "MERCHANT_TYPE_SPECIALTY_FOOD"
  | "MERCHANT_TYPE_FLOWER"
  | "MERCHANT_TYPE_PET_SUPPLY";

export type ItemSize = "small" | "medium" | "large" | "xlarge" | "big";

export interface ManifestItem {
  name: string;
  quantity: number;
  size?: ItemSize;
  /** cm */
  dimensions?: { length: number; height: number; depth: number };
  /** cents */
  price?: number;
  /** grams. Mandatory when `dimensions` is set, and vice versa. Per item, NOT multiplied by quantity. */
  weight?: number;
  /** e.g. 12.5% -> 1250000 */
  vat_percentage?: number;
}

export type DeliverableAction =
  | "deliverable_action_meet_at_door"
  | "deliverable_action_leave_at_door";

export type UndeliverableAction = "leave_at_door" | "return" | "discard";

/** Proof-of-delivery requirements. Same shape for pickup / dropoff / return. */
export interface VerificationRequirement {
  signature_requirement?: {
    enabled: boolean;
    collect_signer_name?: boolean;
    collect_signer_relationship?: boolean;
  };
  barcodes?: Array<{
    value: string;
    type: "CODE39" | "CODE39_FULL_ASCII" | "CODE128" | "QR" | "EAN13";
  }>;
  picture?: boolean;
  /** Dropoff only. min_age is 18-25. */
  identification?: { min_age: number; no_sobriety_check?: boolean };
  /** Dropoff only. Incompatible with leave_at_door. Cannot be removed once set. */
  pincode?: { enabled: true; type: "default" | "random" | "merchant_provided"; value?: string };
}

/** The four delivery-window timestamps, RFC 3339. Built by windows.ts, never by hand. */
export interface DeliveryWindow {
  pickup_ready_dt?: string;
  pickup_deadline_dt?: string;
  dropoff_ready_dt?: string;
  dropoff_deadline_dt?: string;
}

export interface CreateQuoteRequest extends DeliveryWindow {
  /** JSON-stringified StructuredAddress. */
  pickup_address: string;
  dropoff_address: string;
  pickup_latitude?: number;
  pickup_longitude?: number;
  dropoff_latitude?: number;
  dropoff_longitude?: number;
  pickup_phone_number?: string;
  dropoff_phone_number?: string;
  /** cents */
  manifest_total_value?: number;
  external_store_id?: string;
}

export interface Quote {
  kind: "delivery_quote";
  /** dqt_... — pass to Create Delivery to lock in this price/ETA. */
  id: string;
  created: string;
  /** Quotes are valid 15 minutes. */
  expires: string;
  /** cents */
  fee: number;
  currency: string;
  currency_type: string;
  dropoff_eta: string;
  dropoff_deadline: string;
  /** Total minutes to dropoff. */
  duration: number;
  /** Minutes until the courier reaches pickup. `duration - pickup_duration` is the transit leg. */
  pickup_duration: number;
}

export interface RoboCourierSpecification {
  mode: "auto" | "custom";
  cancel_reason?:
    | "cannot_access_customer_location"
    | "cannot_find_customer_address"
    | "customer_rejected_order"
    | "customer_unavailable";
  enroute_for_pickup_at?: string;
  pickup_imminent_at?: string;
  pickup_at?: string;
  dropoff_imminent_at?: string;
  dropoff_at?: string;
}

export interface CreateDeliveryRequest extends DeliveryWindow {
  pickup_name: string;
  pickup_address: string;
  pickup_phone_number: string;
  dropoff_name: string;
  dropoff_address: string;
  dropoff_phone_number: string;
  manifest_items: ManifestItem[];

  quote_id?: string;
  pickup_business_name?: string;
  dropoff_business_name?: string;
  pickup_latitude?: number;
  pickup_longitude?: number;
  dropoff_latitude?: number;
  dropoff_longitude?: number;
  /** 280 char max */
  pickup_notes?: string;
  dropoff_notes?: string;
  dropoff_seller_notes?: string;
  pickup_verification?: VerificationRequirement;
  dropoff_verification?: VerificationRequirement;
  return_verification?: VerificationRequirement;
  deliverable_action?: DeliverableAction;
  undeliverable_action?: UndeliverableAction;
  /** Your order number. The courier only sees first name + last initial, so this is how the store identifies the order. */
  manifest_reference?: string;
  /** cents */
  manifest_total_value?: number;
  /** cents */
  tip?: number;
  /** Retained 60 minutes; a repeat inside that window returns the original delivery. */
  idempotency_key?: string;
  external_store_id?: string;
  /** Shows up on the billing details report. */
  external_id?: string;
  return_notes?: string;
  /** Sandbox only. */
  test_specifications?: { robo_courier_specification: RoboCourierSpecification };
}

export type DeliveryStatus =
  | "pending"
  | "pickup"
  | "pickup_complete"
  | "dropoff"
  | "delivered"
  | "canceled"
  | "returned"
  | "shopping_completed";

export interface Waypoint {
  name: string;
  phone_number: string;
  address: string;
  detailed_address?: StructuredAddress;
  notes?: string;
  seller_notes?: string;
  courier_notes?: string;
  location?: { lat: number; lng: number };
  status?: string;
  status_timestamp?: string;
  external_store_id?: string;
  /** What was actually captured, distinct from the requirements you requested. */
  verification?: CapturedVerification;
}

export interface CapturedVerification {
  signature?: { image_url?: string; name?: string; signer_relationship?: string };
  barcodes?: Array<{
    type: string;
    value: string;
    scan_result?: { outcome: string; timestamp: string };
  }>;
  picture?: { image_url?: string };
  identification?: { min_age_verified?: boolean };
  pin_code?: { entered?: boolean };
  completion_location?: { lat: number; lng: number };
}

export interface Courier {
  name: string;
  phone_number?: string;
  vehicle_type?: string;
  location?: { lat: number; lng: number };
  img_href?: string;
  public_phone_info?: { phone_number?: string; pin?: string };
}

export interface RefundOrderItem {
  party_at_fault?: string;
  /** cents */
  partner_refund_amount?: number;
  /** cents */
  uber_refund_amount?: number;
  reason?: string;
  refund_items?: Array<{ name: string; quantity: number }>;
}

export interface EmbeddedRefund {
  id: string;
  created_at: string;
  currency_code: string;
  /** cents */
  total_partner_refund?: number;
  /** cents */
  total_uber_refund?: number;
  refund_fees?: Array<{ category: string; fee_code: string; value: number }>;
  refund_order_items?: RefundOrderItem[];
}

export interface Delivery {
  kind: "delivery";
  /** del_... (or ret_... for a return leg). Use `id`, not `uuid`, for identification. */
  id: string;
  uuid?: string;
  quote_id?: string;
  external_id?: string;
  status: DeliveryStatus;
  /** true once the delivery has ended, whatever the end status. */
  complete: boolean;
  created: string;
  updated: string;
  pickup: Waypoint;
  dropoff: Waypoint;
  return?: Waypoint;
  manifest?: { reference?: string; description?: string; total_value?: number };
  manifest_items: ManifestItem[];
  /** cents */
  fee: number;
  currency: string;
  /** Current tip, cents. */
  tip?: number;
  tracking_url?: string;
  pickup_ready?: string;
  pickup_eta?: string;
  pickup_deadline?: string;
  dropoff_ready?: string;
  dropoff_eta?: string;
  dropoff_deadline?: string;
  dropoff_identifier?: string;
  deliverable_action?: DeliverableAction;
  /** NOT an echo of the request. This is the action the courier ACTUALLY took, empty otherwise. */
  undeliverable_action?: string;
  undeliverable_reason?: string;
  /** null until a courier is assigned. */
  courier?: Courier | null;
  /** true means the courier is ~80m / ~1 minute away. */
  courier_imminent: boolean;
  live_mode: boolean;
  batch_id?: string;
  related_deliveries?: Array<{ id: string; relationship: "original" | "return" }>;
  /** Get Delivery only. */
  refund?: EmbeddedRefund;
  short_batch_id?: string;
  /** Last 4 characters, masked. */
  vehicle_license_plate?: string;
  dropoff_sequence_number?: number;
}

export type CancellationReason =
  | "out_of_items"
  | "store_closed"
  | "customer_called_to_cancel"
  | "store_too_busy"
  | "courier_delayed_en_route_to_pickup"
  | "too_expensive"
  | "delivery_vehicle_too_small"
  | "no_courier_assigned"
  | "other";

export type RefundReason =
  | "uber_never_received_order"
  | "uber_entire_order_wrong"
  | "uber_missing_items"
  | "uber_damaged_item"
  | "uber_order_delivered_late"
  | "uber_delayed_pick_up"
  | "uber_had_to_prepare_order_again"
  | "uber_never_pick_up"
  | "uber_courier_cancelled"
  | "uber_safety_issue"
  | "uber_return_trip_issue";

export interface RefundRequest {
  delivery_id: string;
  /** A real monitored inbox — refund status updates are sent here. */
  requester_email_id: string;
  cc_email_ids?: string[];
  refund_reason: RefundReason;
  notes?: string;
  /** Only used with uber_missing_items. */
  items_missing?: string[];
  /** amount is e5, NOT cents. Build it with centsToE5(). */
  total_refund_amount: { amount: number; currency_code: string };
}

export interface RefundResponse {
  code: "OK" | "PERMISSION_DENIED" | "ALREADY_EXISTS" | "INVALID_ARGUMENT" | "INTERNAL";
  message?: string;
}

export type DeliveryFilter =
  | "pending"
  | "pickup"
  | "pickup_complete"
  | "dropoff"
  | "delivered"
  | "canceled"
  | "returned"
  | "ongoing";

/** The interface both the real client and the mock implement. */
export interface UberDirectClient {
  createQuote(req: CreateQuoteRequest): Promise<Quote>;
  createDelivery(req: CreateDeliveryRequest): Promise<Delivery>;
  getDelivery(deliveryId: string): Promise<Delivery>;
  listDeliveries(params?: { filter?: DeliveryFilter; limit?: number }): Promise<Delivery[]>;
  cancelDelivery(deliveryId: string, reason?: CancellationReason): Promise<Delivery>;
  submitRefund(req: RefundRequest): Promise<RefundResponse>;
  readonly isMock: boolean;
}

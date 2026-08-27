/**
 * Local order records.
 *
 * This is our side of the integration: the order number the customer and store
 * see, the payment state, and the link to Uber's quote_id / delivery_id. Uber's
 * delivery object is never mirrored here as a source of truth — Get Delivery is
 * authoritative, so the tracking page always re-fetches. The snapshot kept here
 * is only for rendering the order list without N API calls.
 */

import { readJson, updateJson } from "./jsonFile";
import type { Delivery, DeliveryStatus, ManifestItem, StructuredAddress } from "./uber/types";
import type { WindowMode } from "./uber/windows";

const ORDERS_FILE = "orders";

export type PaymentStatus = "unpaid" | "captured" | "refunded";

export interface OrderRecord {
  /** Our own order number. Sent as manifest_reference so the store can identify the bag. */
  orderNumber: string;
  createdAt: string;

  externalStoreId: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;

  /**
   * The EXACT string sent as dropoff_address on Create Quote. Create Delivery
   * reuses this verbatim rather than re-serialising the form, so the quote and
   * the delivery can't disagree on address format or key order.
   */
  dropoffAddressJson: string;
  dropoffAddress: StructuredAddress;
  dropoffNotes?: string;

  items: ManifestItem[];
  /** cents */
  manifestTotalValue: number;

  windowMode: WindowMode;
  promisedDropoffAt?: string;
  leaveAtDoor: boolean;
  ageRestricted: boolean;
  highRisk: boolean;
  roboCourier: boolean;

  quote?: {
    id: string;
    fee: number;
    currency: string;
    expires: string;
    dropoffEta: string;
    duration: number;
    pickupDuration: number;
  };

  /** Stable for the life of the order, so a retried submit can't double-create. */
  idempotencyKey: string;

  paymentStatus: PaymentStatus;
  paymentCapturedAt?: string;

  deliveryId?: string;
  /** Display-only snapshot; refreshed on every Get Delivery and webhook. */
  lastStatus?: DeliveryStatus;
  lastFee?: number;
  lastDropoffEta?: string;
  lastSyncedAt?: string;
  trackingUrl?: string;
  refundSubmittedAt?: string;
}

type OrdersFile = Record<string, OrderRecord>;

/** Short, unambiguous order number — no vowels or lookalike characters. */
function generateOrderNumber(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTVWXYZ";
  let out = "";
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

export async function createOrder(
  input: Omit<
    OrderRecord,
    "orderNumber" | "createdAt" | "idempotencyKey" | "paymentStatus"
  >,
): Promise<OrderRecord> {
  const record: OrderRecord = {
    ...input,
    orderNumber: generateOrderNumber(),
    createdAt: new Date().toISOString(),
    idempotencyKey: globalThis.crypto.randomUUID(),
    paymentStatus: "unpaid",
  };

  await updateJson<OrdersFile>(ORDERS_FILE, {}, (current) => ({
    ...current,
    [record.orderNumber]: record,
  }));

  return record;
}

export async function getOrder(orderNumber: string): Promise<OrderRecord | undefined> {
  const orders = await readJson<OrdersFile>(ORDERS_FILE, {});
  return orders[orderNumber];
}

export async function getOrderByDeliveryId(deliveryId: string): Promise<OrderRecord | undefined> {
  const orders = await readJson<OrdersFile>(ORDERS_FILE, {});
  return Object.values(orders).find((order) => order.deliveryId === deliveryId);
}

export async function listOrders(limit = 50): Promise<OrderRecord[]> {
  const orders = await readJson<OrdersFile>(ORDERS_FILE, {});
  return Object.values(orders)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export async function patchOrder(
  orderNumber: string,
  patch: Partial<OrderRecord>,
): Promise<OrderRecord | undefined> {
  let updated: OrderRecord | undefined;

  await updateJson<OrdersFile>(ORDERS_FILE, {}, (current) => {
    const existing = current[orderNumber];
    if (!existing) return current;
    updated = { ...existing, ...patch };
    return { ...current, [orderNumber]: updated };
  });

  return updated;
}

/** Refresh the display snapshot from an authoritative Get Delivery response. */
export async function syncOrderFromDelivery(
  orderNumber: string,
  delivery: Delivery,
): Promise<OrderRecord | undefined> {
  return patchOrder(orderNumber, {
    deliveryId: delivery.id,
    lastStatus: delivery.status,
    lastFee: delivery.fee,
    lastDropoffEta: delivery.dropoff_eta,
    trackingUrl: delivery.tracking_url,
    lastSyncedAt: new Date().toISOString(),
  });
}

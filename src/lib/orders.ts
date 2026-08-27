/**
 * Order service: the business logic between the HTTP routes and the Uber client.
 *
 * The flow it enforces, in order:
 *   1. Quote AFTER the dropoff address is captured but BEFORE checkout, so the
 *      customer sees a real fee and ETA before committing.
 *   2. Capture payment.
 *   3. Create the delivery, reusing the quote_id and the exact same address.
 *
 * Creating the delivery before payment produces live deliveries for orders that
 * then fail payment, which is a real cost, so step 2 gates step 3.
 */

import { formatAddress, normalizeAddress, serializeAddress } from "./address";
import { createOrder, getOrder, patchOrder, type OrderRecord } from "./store";
import { defaultUndeliverableAction, getStore, isPerishable, type Store } from "./stores";
import { getUberClient, isMockMode } from "./uber";
import { UberApiError } from "./uber/client";
import { buildDeliveryWindow, DeliveryWindowError, type WindowMode } from "./uber/windows";
import { pickupBarcode, selectDropoffVerification } from "./uber/verification";
import type {
  CreateDeliveryRequest,
  CreateQuoteRequest,
  DeliverableAction,
  Delivery,
  ManifestItem,
  Quote,
} from "./uber/types";
import type { QuoteRequestInput } from "./validation";

export class OrderError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request",
  ) {
    super(message);
    this.name = "OrderError";
  }
}

function requireStore(externalStoreId: string): Store {
  const store = getStore(externalStoreId);
  if (!store) throw new OrderError(`Unknown store ${externalStoreId}`, 404, "store_not_found");
  return store;
}

function toManifestItems(items: QuoteRequestInput["items"]): ManifestItem[] {
  // Real dimensions and weight rather than T-shirt sizing: item size feeds
  // vehicle-class routing, and defaulting to "Small" can route the job to a
  // courier who can't carry it. Weight is per item, not multiplied by quantity.
  return items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    price: item.price,
    weight: item.weight,
    dimensions: item.dimensions,
  }));
}

function manifestTotalValue(items: QuoteRequestInput["items"]): number {
  return items.reduce((total, item) => total + item.price * item.quantity, 0);
}

/**
 * Step 1: quote.
 *
 * Creates the local order record and attaches a fresh quote to it. The exact
 * address string sent here is stored and reused at Create Delivery time.
 */
export async function quoteOrder(input: QuoteRequestInput): Promise<{
  order: OrderRecord;
  quote: Quote;
  windowNote?: string;
}> {
  const store = requireStore(input.externalStoreId);

  if (input.windowMode !== "asap" && !input.promisedDropoffAt) {
    throw new OrderError("A scheduled order needs a promised dropoff time.");
  }

  const dropoffAddress = normalizeAddress(input.dropoff);
  const dropoffAddressJson = serializeAddress(dropoffAddress);
  const pickupAddressJson = serializeAddress(store.address);

  const items = toManifestItems(input.items);
  const totalValue = manifestTotalValue(input.items);

  // The quote itself is always requested without scheduled timestamps: the
  // transit leg it returns is what the scheduled window is then derived FROM,
  // so asking for a window here would be circular.
  const quoteRequest: CreateQuoteRequest = {
    pickup_address: pickupAddressJson,
    dropoff_address: dropoffAddressJson,
    pickup_latitude: store.latitude,
    pickup_longitude: store.longitude,
    pickup_phone_number: store.phoneNumber,
    dropoff_phone_number: input.customerPhone,
    manifest_total_value: totalValue,
    external_store_id: store.externalStoreId,
  };

  const quote = await getUberClient().createQuote(quoteRequest);

  // Validate the window now, against this fresh quote, so a bad promised time
  // surfaces at quote time rather than after the customer has paid.
  let windowNote: string | undefined;
  if (input.windowMode !== "asap") {
    const built = buildDeliveryWindow({
      mode: input.windowMode,
      promisedDropoffAt: new Date(input.promisedDropoffAt!),
      quote,
      prepMinutes: store.prepMinutes,
    });
    windowNote = built.note;
  }

  const order = await createOrder({
    externalStoreId: store.externalStoreId,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    customerEmail: input.customerEmail || undefined,
    dropoffAddressJson,
    dropoffAddress,
    dropoffNotes: input.dropoffNotes,
    items,
    manifestTotalValue: totalValue,
    windowMode: input.windowMode,
    promisedDropoffAt: input.promisedDropoffAt,
    leaveAtDoor: input.leaveAtDoor,
    ageRestricted: input.ageRestricted,
    highRisk: input.highRisk,
    roboCourier: input.roboCourier,
    quote: {
      id: quote.id,
      fee: quote.fee,
      currency: quote.currency,
      expires: quote.expires,
      dropoffEta: quote.dropoff_eta,
      duration: quote.duration,
      pickupDuration: quote.pickup_duration,
    },
  });

  return { order, quote, windowNote };
}

/**
 * Simulated payment capture.
 *
 * Stands in for a real PSP. It exists as its own step because the ordering
 * matters: money first, delivery second.
 */
async function capturePayment(order: OrderRecord): Promise<OrderRecord> {
  if (order.paymentStatus === "captured") return order;
  const updated = await patchOrder(order.orderNumber, {
    paymentStatus: "captured",
    paymentCapturedAt: new Date().toISOString(),
  });
  if (!updated) throw new OrderError("Order disappeared during payment capture", 500);
  return updated;
}

/** Step 2 + 3: capture payment, then create the delivery. */
export async function placeOrder(orderNumber: string): Promise<{
  order: OrderRecord;
  delivery: Delivery;
  podRationale: string;
}> {
  let order = await getOrder(orderNumber);
  if (!order) throw new OrderError(`Unknown order ${orderNumber}`, 404, "order_not_found");
  if (order.deliveryId) {
    throw new OrderError("This order already has a delivery.", 409, "duplicate_delivery");
  }
  const quote = order.quote;
  if (!quote) throw new OrderError("Quote this order before placing it.");

  // Quotes are valid 15 minutes. Re-quote rather than sending a stale one and
  // taking an expired_quote back.
  if (new Date(quote.expires).getTime() <= Date.now()) {
    throw new OrderError(
      "The quote has expired. Re-quote to get a current fee and ETA.",
      409,
      "expired_quote",
    );
  }

  const store = requireStore(order.externalStoreId);

  order = await capturePayment(order);

  const deliverableAction: DeliverableAction = order.leaveAtDoor
    ? "deliverable_action_leave_at_door"
    : "deliverable_action_meet_at_door";

  const pod = selectDropoffVerification({
    merchantType: store.merchantType,
    deliverableAction,
    ageRestricted: order.ageRestricted,
    highRisk: order.highRisk,
  });

  const window = buildDeliveryWindow({
    mode: order.windowMode as WindowMode,
    promisedDropoffAt: order.promisedDropoffAt ? new Date(order.promisedDropoffAt) : undefined,
    // Re-derived from the quote attached to THIS order, not a stored offset.
    quote: { duration: quote.duration, pickup_duration: quote.pickupDuration },
    prepMinutes: store.prepMinutes,
  });

  const request: CreateDeliveryRequest = {
    pickup_name: store.name,
    pickup_business_name: store.name,
    // Byte-identical to the addresses sent at quote time.
    pickup_address: serializeAddress(store.address),
    pickup_phone_number: store.phoneNumber,
    pickup_latitude: store.latitude,
    pickup_longitude: store.longitude,
    pickup_notes: store.pickupNotes,

    dropoff_name: order.customerName,
    dropoff_address: order.dropoffAddressJson,
    dropoff_phone_number: order.customerPhone,
    dropoff_notes: order.dropoffNotes,

    manifest_items: order.items,
    manifest_total_value: order.manifestTotalValue,
    // The courier only sees the customer's first name + last initial, so the
    // order number is how the store and courier identify the right bag.
    manifest_reference: order.orderNumber,
    // Appears on the billing details report — worth setting even when it isn't
    // needed for reconciliation.
    external_id: order.orderNumber,

    quote_id: quote.id,
    external_store_id: store.externalStoreId,
    // Retained 60 minutes: a retried submit returns the original delivery
    // instead of creating a duplicate.
    idempotency_key: order.idempotencyKey,

    deliverable_action: deliverableAction,
    // Explicit per vertical rather than inheriting the `return` default, which
    // is wrong for perishables.
    undeliverable_action: defaultUndeliverableAction(store),

    pickup_verification: pickupBarcode(order.orderNumber),
    dropoff_verification: pod.requirement,

    ...window.window,
  };

  if (order.roboCourier) {
    if (!isMockMode() && process.env.UBER_ALLOW_ROBOCOURIER !== "true") {
      throw new OrderError(
        "Robocourier is sandbox-only. Set UBER_ALLOW_ROBOCOURIER=true to send it with live-looking credentials.",
        400,
      );
    }
    request.test_specifications = { robo_courier_specification: { mode: "auto" } };
  }

  let delivery: Delivery;
  try {
    delivery = await getUberClient().createDelivery(request);
  } catch (error) {
    // Payment is already captured, so make the failure loud rather than
    // silently leaving a paid order with no delivery.
    await patchOrder(order.orderNumber, { lastSyncedAt: new Date().toISOString() });
    throw error;
  }

  const updated = await patchOrder(order.orderNumber, {
    deliveryId: delivery.id,
    lastStatus: delivery.status,
    lastFee: delivery.fee,
    lastDropoffEta: delivery.dropoff_eta,
    trackingUrl: delivery.tracking_url,
    lastSyncedAt: new Date().toISOString(),
  });

  return { order: updated ?? order, delivery, podRationale: pod.rationale };
}

/** Summary shown alongside the quote so the operator can see what will be sent. */
export function describeOrderPolicy(order: OrderRecord): {
  undeliverableAction: string;
  podRationale: string;
  perishable: boolean;
} {
  const store = requireStore(order.externalStoreId);
  const deliverableAction: DeliverableAction = order.leaveAtDoor
    ? "deliverable_action_leave_at_door"
    : "deliverable_action_meet_at_door";

  let podRationale: string;
  try {
    podRationale = selectDropoffVerification({
      merchantType: store.merchantType,
      deliverableAction,
      ageRestricted: order.ageRestricted,
      highRisk: order.highRisk,
    }).rationale;
  } catch (error) {
    podRationale = error instanceof Error ? error.message : "Unavailable";
  }

  return {
    undeliverableAction: defaultUndeliverableAction(store),
    podRationale,
    perishable: isPerishable(store),
  };
}

/** Map any thrown error onto an HTTP status + JSON body for the API routes. */
export function toErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof UberApiError) {
    return {
      status: error.httpStatus,
      body: {
        error: error.message,
        code: error.code,
        paramDetails: error.paramDetails,
        // 4xx means fix the request; the UI uses this to decide whether a retry
        // button makes any sense.
        retryable: !error.isClientError,
      },
    };
  }
  if (error instanceof DeliveryWindowError) {
    return { status: 400, body: { error: error.message, code: error.code, retryable: false } };
  }
  if (error instanceof OrderError) {
    return { status: error.status, body: { error: error.message, code: error.code, retryable: false } };
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return { status: 500, body: { error: message, code: "internal_error", retryable: true } };
}

export { formatAddress };

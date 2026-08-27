/**
 * A mock Uber Direct client.
 *
 * It implements the same interface as the live client and returns objects with
 * the same shape, so the whole app — quote, create, track, cancel, refund — can
 * be driven without credentials. Set UBER_MOCK=false with real keys in
 * .env.local to switch to the real API; no other code changes.
 *
 * Status is COMPUTED from elapsed wall-clock time on every read rather than
 * advanced by a background timer, so it stays correct across hot reloads,
 * restarts, and multiple server workers.
 */

import { readJson, updateJson } from "../jsonFile";
import type {
  CancellationReason,
  CreateDeliveryRequest,
  CreateQuoteRequest,
  Delivery,
  DeliveryFilter,
  DeliveryStatus,
  Quote,
  RefundRequest,
  RefundResponse,
  StructuredAddress,
  UberDirectClient,
} from "./types";
import { UberApiError } from "./client";

const QUOTES_FILE = "mock-quotes";
const DELIVERIES_FILE = "mock-deliveries";

const QUOTE_TTL_MINUTES = 15;

/** Lifecycle offsets from creation, in seconds. */
interface Timeline {
  enroute: number;
  pickupImminent: number;
  pickup: number;
  dropoffStart: number;
  dropoffImminent: number;
  dropoff: number;
}

/** Robocourier auto mode runs the whole lifecycle in ~2.5 minutes. */
const ROBO_TIMELINE: Timeline = {
  enroute: 30,
  pickupImminent: 60,
  pickup: 90,
  dropoffStart: 105,
  dropoffImminent: 120,
  dropoff: 150,
};

/** Without Robocourier, a plausible ~35 minute trip. */
const REALISTIC_TIMELINE: Timeline = {
  enroute: 120,
  pickupImminent: 480,
  pickup: 660,
  dropoffStart: 720,
  dropoffImminent: 1860,
  dropoff: 2040,
};

interface StoredQuote {
  quote: Quote;
  consumedByDeliveryId?: string;
  pickupAddress: string;
  dropoffAddress: string;
}

interface StoredDelivery {
  id: string;
  createdMs: number;
  timeline: Timeline;
  request: CreateDeliveryRequest;
  fee: number;
  currency: string;
  pickupLocation: { lat: number; lng: number };
  dropoffLocation: { lat: number; lng: number };
  canceledAtMs?: number;
  cancellationReason?: CancellationReason;
  /** Simulated failure at the door, when a robocourier cancel_reason was set. */
  undeliverableReason?: string;
  relatedDeliveries?: Delivery["related_deliveries"];
  refund?: Delivery["refund"];
  isReturnLeg?: boolean;
}

function randomId(prefix: string): string {
  const raw = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  return `${prefix}_${raw}`;
}

function parseAddress(value: string): StructuredAddress | undefined {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? (parsed as StructuredAddress) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Deterministic pseudo-geocode: the same address always resolves to the same
 * point, so a quote and its delivery agree, and the fee is stable across reads.
 */
function pseudoGeocode(address: string): { lat: number; lng: number } {
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = (hash * 31 + address.charCodeAt(i)) | 0;
  }
  const jitter = (seed: number, spread: number) =>
    ((Math.abs(Math.sin(seed)) * 2 - 1) * spread) / 1;
  return {
    lat: 37.7749 + jitter(hash, 0.06),
    lng: -122.4194 + jitter(hash >> 3, 0.06),
  };
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Fee in cents: a base plus a per-km distance component, mirroring DELIVERY_FEE + DISTANCE_FEE. */
function priceQuote(distanceKm: number): { fee: number; pickupDuration: number; duration: number } {
  const fee = Math.round(599 + distanceKm * 145);
  const pickupDuration = 8 + Math.round(distanceKm * 0.8);
  const transit = 6 + Math.round(distanceKm * 3.2);
  return { fee, pickupDuration, duration: pickupDuration + transit };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

/** Derive the delivery's current state from elapsed time. */
function project(stored: StoredDelivery, nowMs: number): Delivery {
  const elapsed = (nowMs - stored.createdMs) / 1000;
  const t = stored.timeline;
  const req = stored.request;

  let status: DeliveryStatus;
  let courierImminent = false;

  if (stored.canceledAtMs !== undefined) {
    status = "canceled";
  } else if (elapsed < t.enroute) {
    status = "pending";
  } else if (elapsed < t.pickup) {
    status = "pickup";
    courierImminent = elapsed >= t.pickupImminent;
  } else if (elapsed < t.dropoffStart) {
    status = "pickup_complete";
  } else if (elapsed < t.dropoff) {
    status = "dropoff";
    courierImminent = elapsed >= t.dropoffImminent;
  } else if (stored.undeliverableReason) {
    // A robocourier cancel_reason fails the delivery at the door and triggers
    // whatever undeliverable_action was set.
    status = req.undeliverable_action === "return" ? "returned" : "canceled";
  } else {
    status = "delivered";
  }

  const complete =
    status === "delivered" || status === "canceled" || status === "returned";

  const at = (seconds: number) => new Date(stored.createdMs + seconds * 1000).toISOString();

  // Courier position: to the store first, then on to the dropoff.
  let courierLocation = stored.pickupLocation;
  if (elapsed >= t.enroute && elapsed < t.pickup) {
    const progress = (elapsed - t.enroute) / (t.pickup - t.enroute);
    courierLocation = {
      lat: lerp(stored.dropoffLocation.lat, stored.pickupLocation.lat, progress),
      lng: lerp(stored.dropoffLocation.lng, stored.pickupLocation.lng, progress),
    };
  } else if (elapsed >= t.dropoffStart) {
    const progress = (elapsed - t.dropoffStart) / (t.dropoff - t.dropoffStart);
    courierLocation = {
      lat: lerp(stored.pickupLocation.lat, stored.dropoffLocation.lat, progress),
      lng: lerp(stored.pickupLocation.lng, stored.dropoffLocation.lng, progress),
    };
  }

  const courierAssigned = elapsed >= t.enroute && stored.canceledAtMs === undefined;

  const pickupCaptured =
    elapsed >= t.pickup && req.pickup_verification?.barcodes?.length
      ? {
          barcodes: req.pickup_verification.barcodes.map((barcode) => ({
            type: barcode.type,
            value: barcode.value,
            scan_result: { outcome: "SUCCESS", timestamp: at(t.pickup) },
          })),
        }
      : undefined;

  const dropoffCaptured =
    status === "delivered"
      ? {
          ...(req.dropoff_verification?.picture ? { picture: {} } : {}),
          ...(req.dropoff_verification?.signature_requirement?.enabled
            ? { signature: { name: req.dropoff_name } }
            : {}),
          ...(req.dropoff_verification?.identification
            ? { identification: { min_age_verified: true } }
            : {}),
          ...(req.dropoff_verification?.pincode ? { pin_code: { entered: true } } : {}),
          completion_location: stored.dropoffLocation,
        }
      : undefined;

  return {
    kind: "delivery",
    id: stored.id,
    uuid: stored.id.slice(4),
    quote_id: req.quote_id,
    external_id: req.external_id,
    status,
    complete,
    created: new Date(stored.createdMs).toISOString(),
    updated: new Date(nowMs).toISOString(),
    pickup: {
      name: req.pickup_name,
      phone_number: req.pickup_phone_number,
      address: req.pickup_address,
      detailed_address: parseAddress(req.pickup_address),
      notes: req.pickup_notes,
      location: stored.pickupLocation,
      external_store_id: req.external_store_id,
      status: elapsed >= t.pickup ? "completed" : "pending",
      status_timestamp: elapsed >= t.pickup ? at(t.pickup) : undefined,
      verification: pickupCaptured,
    },
    dropoff: {
      name: req.dropoff_name,
      phone_number: req.dropoff_phone_number,
      address: req.dropoff_address,
      detailed_address: parseAddress(req.dropoff_address),
      notes: req.dropoff_notes,
      seller_notes: req.dropoff_seller_notes,
      location: stored.dropoffLocation,
      status: status === "delivered" ? "completed" : "pending",
      status_timestamp: status === "delivered" ? at(t.dropoff) : undefined,
      verification: dropoffCaptured,
    },
    manifest: {
      reference: req.manifest_reference,
      total_value: req.manifest_total_value,
    },
    manifest_items: req.manifest_items,
    fee: stored.fee,
    currency: stored.currency,
    tip: req.tip ?? 0,
    tracking_url: `https://example.com/mock-tracking/${stored.id}`,
    pickup_ready: req.pickup_ready_dt,
    pickup_eta: at(t.pickup),
    pickup_deadline: req.pickup_deadline_dt,
    dropoff_ready: req.dropoff_ready_dt,
    dropoff_eta: at(t.dropoff),
    dropoff_deadline: req.dropoff_deadline_dt,
    dropoff_identifier: stored.id.slice(-4).toUpperCase(),
    deliverable_action: req.deliverable_action,
    // The ACTUAL action taken, empty unless the delivery was undeliverable.
    undeliverable_action: stored.undeliverableReason ? req.undeliverable_action : undefined,
    undeliverable_reason: stored.undeliverableReason,
    courier: courierAssigned
      ? {
          name: stored.isReturnLeg ? "Sam R." : "Alex M.",
          phone_number: "+14155550100",
          vehicle_type: "car",
          location: courierLocation,
          public_phone_info: { phone_number: "+14155550100", pin: "4821" },
        }
      : null,
    courier_imminent: courierImminent,
    live_mode: false,
    related_deliveries: stored.relatedDeliveries,
    refund: stored.refund,
    vehicle_license_plate: courierAssigned ? "••••7Q42" : undefined,
  };
}

export class MockUberDirectClient implements UberDirectClient {
  readonly isMock = true;

  async createQuote(req: CreateQuoteRequest): Promise<Quote> {
    const pickup = pseudoGeocode(req.pickup_address);
    const dropoff = pseudoGeocode(req.dropoff_address);
    const distanceKm = haversineKm(pickup, dropoff);

    // Mirror the real API's behaviour of rejecting far-flung dropoffs.
    if (distanceKm > 40) {
      throw new UberApiError(
        "address_undeliverable",
        "That dropoff address is outside the deliverable area for this store.",
        400,
      );
    }

    const { fee, duration, pickupDuration } = priceQuote(distanceKm);
    const now = new Date();
    const dropoffEta = new Date(now.getTime() + duration * 60_000);

    const quote: Quote = {
      kind: "delivery_quote",
      id: randomId("dqt"),
      created: now.toISOString(),
      expires: new Date(now.getTime() + QUOTE_TTL_MINUTES * 60_000).toISOString(),
      fee,
      currency: "usd",
      currency_type: "USD",
      dropoff_eta: dropoffEta.toISOString(),
      dropoff_deadline: new Date(dropoffEta.getTime() + 15 * 60_000).toISOString(),
      duration,
      pickup_duration: pickupDuration,
    };

    await updateJson<Record<string, StoredQuote>>(QUOTES_FILE, {}, (current) => ({
      ...current,
      [quote.id]: {
        quote,
        pickupAddress: req.pickup_address,
        dropoffAddress: req.dropoff_address,
      },
    }));

    return quote;
  }

  async createDelivery(req: CreateDeliveryRequest): Promise<Delivery> {
    const quotes = await readJson<Record<string, StoredQuote>>(QUOTES_FILE, {});

    let fee: number | undefined;
    let currency = "usd";

    if (req.quote_id) {
      const stored = quotes[req.quote_id];
      if (!stored) {
        throw new UberApiError("invalid_params", `Unknown quote_id ${req.quote_id}.`, 400);
      }
      if (stored.consumedByDeliveryId) {
        throw new UberApiError("used_quote", "That quote has already been used.", 400);
      }
      if (new Date(stored.quote.expires).getTime() < Date.now()) {
        throw new UberApiError(
          "expired_quote",
          "That quote is more than 15 minutes old. Re-quote before creating the delivery.",
          400,
        );
      }
      // Mixing address formats between quote and delivery is a documented cause
      // of delivery_location_changed, so the mock enforces it too.
      if (stored.dropoffAddress !== req.dropoff_address) {
        throw new UberApiError(
          "invalid_params",
          "delivery_location_changed: the dropoff address differs from the quoted one.",
          400,
          { param_details: "delivery_location_changed" },
        );
      }
      fee = stored.quote.fee;
      currency = stored.quote.currency;
    }

    if (fee === undefined) {
      const distanceKm = haversineKm(
        pseudoGeocode(req.pickup_address),
        pseudoGeocode(req.dropoff_address),
      );
      fee = priceQuote(distanceKm).fee;
    }

    const robo = req.test_specifications?.robo_courier_specification;

    const stored: StoredDelivery = {
      id: randomId("del"),
      createdMs: Date.now(),
      timeline: robo?.mode === "auto" ? ROBO_TIMELINE : REALISTIC_TIMELINE,
      request: req,
      fee,
      currency,
      pickupLocation: pseudoGeocode(req.pickup_address),
      dropoffLocation: pseudoGeocode(req.dropoff_address),
      undeliverableReason: robo?.cancel_reason,
    };

    await updateJson<Record<string, StoredDelivery>>(DELIVERIES_FILE, {}, (current) => ({
      ...current,
      [stored.id]: stored,
    }));

    if (req.quote_id) {
      await updateJson<Record<string, StoredQuote>>(QUOTES_FILE, {}, (current) => {
        const entry = current[req.quote_id!];
        if (!entry) return current;
        return { ...current, [req.quote_id!]: { ...entry, consumedByDeliveryId: stored.id } };
      });
    }

    return project(stored, Date.now());
  }

  async getDelivery(deliveryId: string): Promise<Delivery> {
    const deliveries = await readJson<Record<string, StoredDelivery>>(DELIVERIES_FILE, {});
    const stored = deliveries[deliveryId];
    if (!stored) {
      throw new UberApiError("delivery_not_found", `No delivery with id ${deliveryId}.`, 404);
    }
    return project(stored, Date.now());
  }

  async listDeliveries(params: { filter?: DeliveryFilter; limit?: number } = {}): Promise<
    Delivery[]
  > {
    const deliveries = await readJson<Record<string, StoredDelivery>>(DELIVERIES_FILE, {});
    const now = Date.now();
    let all = Object.values(deliveries)
      .sort((a, b) => b.createdMs - a.createdMs)
      .map((stored) => project(stored, now));

    if (params.filter === "ongoing") {
      all = all.filter((delivery) => !delivery.complete);
    } else if (params.filter) {
      all = all.filter((delivery) => delivery.status === params.filter);
    }

    return params.limit ? all.slice(0, params.limit) : all;
  }

  async cancelDelivery(deliveryId: string, reason?: CancellationReason): Promise<Delivery> {
    const deliveries = await readJson<Record<string, StoredDelivery>>(DELIVERIES_FILE, {});
    const stored = deliveries[deliveryId];
    if (!stored) {
      throw new UberApiError("delivery_not_found", `No delivery with id ${deliveryId}.`, 404);
    }

    const current = project(stored, Date.now());
    if (current.complete) {
      throw new UberApiError(
        "noncancelable_delivery",
        `This delivery is already ${current.status}.`,
        400,
      );
    }
    if (current.status === "pickup_complete" || current.status === "dropoff") {
      throw new UberApiError(
        "noncancelable_delivery",
        "The order has already been picked up and can no longer be cancelled.",
        400,
      );
    }

    const nowMs = Date.now();
    const updates: Record<string, StoredDelivery> = {
      [deliveryId]: { ...stored, canceledAtMs: nowMs, cancellationReason: reason },
    };

    // Cancelling a delivery whose undeliverable_action is `return` auto-creates
    // a return leg with a ret_ prefix, linked via related_deliveries.
    if (stored.request.undeliverable_action === "return" && current.status !== "pending") {
      const returnLeg: StoredDelivery = {
        ...stored,
        id: randomId("ret"),
        createdMs: nowMs,
        canceledAtMs: undefined,
        isReturnLeg: true,
        request: {
          ...stored.request,
          // The return leg runs the trip in reverse.
          pickup_name: stored.request.dropoff_name,
          pickup_address: stored.request.dropoff_address,
          pickup_phone_number: stored.request.dropoff_phone_number,
          dropoff_name: stored.request.pickup_name,
          dropoff_address: stored.request.pickup_address,
          dropoff_phone_number: stored.request.pickup_phone_number,
        },
        pickupLocation: stored.dropoffLocation,
        dropoffLocation: stored.pickupLocation,
        relatedDeliveries: [{ id: deliveryId, relationship: "original" }],
      };
      updates[returnLeg.id] = returnLeg;
      updates[deliveryId].relatedDeliveries = [{ id: returnLeg.id, relationship: "return" }];
    }

    await updateJson<Record<string, StoredDelivery>>(DELIVERIES_FILE, {}, (currentAll) => ({
      ...currentAll,
      ...updates,
    }));

    return project(updates[deliveryId], Date.now());
  }

  async submitRefund(req: RefundRequest): Promise<RefundResponse> {
    const deliveries = await readJson<Record<string, StoredDelivery>>(DELIVERIES_FILE, {});
    const stored = deliveries[req.delivery_id];
    if (!stored) {
      return { code: "INVALID_ARGUMENT", message: `No delivery with id ${req.delivery_id}.` };
    }
    if (stored.refund) {
      // ALREADY_EXISTS is a signal to stop, not to retry.
      return { code: "ALREADY_EXISTS", message: "A refund was already submitted for this delivery." };
    }

    // The request carries e5; the embedded refund object on Get Delivery is cents.
    const cents = Math.round(req.total_refund_amount.amount / 1000);

    await updateJson<Record<string, StoredDelivery>>(DELIVERIES_FILE, {}, (current) => ({
      ...current,
      [req.delivery_id]: {
        ...stored,
        refund: {
          id: randomId("rfd"),
          created_at: new Date().toISOString(),
          currency_code: req.total_refund_amount.currency_code,
          total_uber_refund: cents,
          total_partner_refund: 0,
          refund_order_items: [
            {
              reason: req.refund_reason,
              uber_refund_amount: cents,
              partner_refund_amount: 0,
              refund_items: (req.items_missing ?? []).map((name) => ({ name, quantity: 1 })),
            },
          ],
        },
      },
    }));

    return { code: "OK", message: "Refund request submitted." };
  }
}

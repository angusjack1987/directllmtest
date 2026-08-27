/**
 * Delivery-window timestamp derivation.
 *
 * This is the single most commonly botched part of a Direct integration, so it
 * lives in one place with tests rather than being inlined at the call site.
 *
 * The rule that matters: the timestamps you send must describe the REAL
 * customer promise. Sending a scheduled-looking set of four timestamps for what
 * is functionally an ASAP order raises cost (courier-rejection pricing escalates
 * on tight windows) and degrades on-time performance, because the timestamps no
 * longer describe reality.
 */

import type { DeliveryWindow, Quote } from "./types";

export const MINUTE_MS = 60_000;

/** Below this lead time Uber treats the order as ASAP no matter what you send. */
export const ASAP_LEAD_TIME_MINUTES = 90;

const MIN_PICKUP_WINDOW_MINUTES = 10;
const MIN_DROPOFF_WINDOW_MINUTES = 20;
const MAX_PICKUP_READY_DAYS = 30;

export type WindowMode = "asap" | "scheduled_food" | "scheduled_retail";

export class DeliveryWindowError extends Error {
  constructor(
    /** Mirrors the API error code this would have produced. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeliveryWindowError";
  }
}

/**
 * The pickup-to-dropoff transit leg, in minutes.
 *
 * `duration` is the total time to dropoff, which INCLUDES the courier's trip to
 * the store. Working backwards from a promised dropoff time means subtracting
 * only the transit leg — `duration - pickup_duration` — not the whole duration.
 * Subtracting the full `duration` sends the courier to the store far too early.
 */
export function transitMinutes(quote: Pick<Quote, "duration" | "pickup_duration">): number {
  return Math.max(0, quote.duration - quote.pickup_duration);
}

function toRfc3339(date: Date): string {
  return date.toISOString();
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

export interface BuildWindowInput {
  mode: WindowMode;
  /** Now. Injectable so the tests aren't wall-clock dependent. */
  now?: Date;
  /** Minutes the store needs before a courier should arrive. ASAP only. */
  prepMinutes?: number;
  /** Start of the promised dropoff window. Required for both scheduled modes. */
  promisedDropoffAt?: Date;
  /** End of the promised dropoff window. scheduled_retail only; defaults to +1h. */
  promisedDropoffEndAt?: Date;
  /**
   * A FRESH quote. Required for both scheduled modes — the transit leg is
   * re-derived per order, never stored as a fixed offset, because a stale
   * duration produces a wrong pickup_ready_dt.
   */
  quote?: Pick<Quote, "duration" | "pickup_duration">;
}

export interface BuiltWindow {
  window: DeliveryWindow;
  /** The mode actually applied, which may differ from what was asked for. */
  effectiveMode: WindowMode;
  /** Set when the requested mode was downgraded, for surfacing in the UI. */
  note?: string;
}

/**
 * Build the delivery-window timestamps for an order.
 *
 * ASAP             -> pickup_ready_dt only (or nothing at all).
 * scheduled_food   -> pickup_ready_dt only, derived from a fresh quote.
 * scheduled_retail -> all four, reflecting the real promise.
 *
 * Sending fewer than four for a scheduled retail order makes the backend fill
 * in the gaps, which produces artificially tight windows and inconsistent
 * on-time measurement.
 */
export function buildDeliveryWindow(input: BuildWindowInput): BuiltWindow {
  const now = input.now ?? new Date();

  if (input.mode === "asap") {
    return { window: asapWindow(now, input.prepMinutes), effectiveMode: "asap" };
  }

  if (!input.promisedDropoffAt) {
    throw new DeliveryWindowError(
      "invalid_params",
      `mode "${input.mode}" requires promisedDropoffAt.`,
    );
  }
  if (!input.quote) {
    throw new DeliveryWindowError(
      "invalid_params",
      `mode "${input.mode}" requires a fresh quote to derive the transit leg from. ` +
        "Re-quote rather than reusing a stored offset.",
    );
  }

  const leadMinutes = (input.promisedDropoffAt.getTime() - now.getTime()) / MINUTE_MS;

  // Under 90 minutes of lead time is treated as ASAP/ASAP+ by the backend
  // regardless of what we send, so don't pretend otherwise.
  if (leadMinutes < ASAP_LEAD_TIME_MINUTES) {
    return {
      window: asapWindow(now, input.prepMinutes),
      effectiveMode: "asap",
      note:
        `Lead time is ${Math.round(leadMinutes)} min, under the ${ASAP_LEAD_TIME_MINUTES} min ` +
        "threshold — sent as ASAP, since scheduled behaviour can't be forced onto a short-lead order.",
    };
  }

  const transit = transitMinutes(input.quote);

  if (input.mode === "scheduled_food") {
    // Same shape as ASAP, with the timestamp pushed to the right moment:
    // promised dropoff minus the transit leg only.
    const pickupReady = addMinutes(input.promisedDropoffAt, -transit);
    const window = { pickup_ready_dt: toRfc3339(pickupReady) };
    validateDeliveryWindow(window, now);
    return { window, effectiveMode: "scheduled_food" };
  }

  // scheduled_retail: all four timestamps.
  const dropoffReady = input.promisedDropoffAt;
  const dropoffEnd = input.promisedDropoffEndAt ?? addMinutes(dropoffReady, 60);

  // Work backwards from the promised window start, leaving the store a pickup
  // window rather than a single instant.
  const pickupReady = addMinutes(dropoffReady, -(transit + MIN_PICKUP_WINDOW_MINUTES));

  // dropoff_ready_dt must be at or before pickup_deadline_dt, so the pickup
  // deadline lands on the dropoff window start rather than before it.
  const pickupDeadline = dropoffReady;

  const dropoffDeadline = new Date(
    Math.max(
      dropoffEnd.getTime(),
      addMinutes(dropoffReady, MIN_DROPOFF_WINDOW_MINUTES).getTime(),
      pickupDeadline.getTime(),
    ),
  );

  const window: DeliveryWindow = {
    pickup_ready_dt: toRfc3339(pickupReady),
    pickup_deadline_dt: toRfc3339(pickupDeadline),
    dropoff_ready_dt: toRfc3339(dropoffReady),
    dropoff_deadline_dt: toRfc3339(dropoffDeadline),
  };

  validateDeliveryWindow(window, now);
  return { window, effectiveMode: "scheduled_retail" };
}

function asapWindow(now: Date, prepMinutes?: number): DeliveryWindow {
  // Leave all four blank for a pure ASAP order. Send pickup_ready_dt alone when
  // the store needs prep time — dispatch starts ~25 min before pickup_ready_dt,
  // so a longer lead time costs nothing.
  if (!prepMinutes || prepMinutes <= 0) return {};
  return { pickup_ready_dt: toRfc3339(addMinutes(now, prepMinutes)) };
}

/**
 * Check a window against the documented constraints before spending an API call
 * on it. Each thrown code matches the error the API would have returned.
 */
export function validateDeliveryWindow(window: DeliveryWindow, now: Date = new Date()): void {
  const parse = (value: string | undefined, field: string): Date | undefined => {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new DeliveryWindowError("invalid_params", `${field} is not a valid RFC 3339 timestamp.`);
    }
    return date;
  };

  const pickupReady = parse(window.pickup_ready_dt, "pickup_ready_dt");
  const pickupDeadline = parse(window.pickup_deadline_dt, "pickup_deadline_dt");
  const dropoffReady = parse(window.dropoff_ready_dt, "dropoff_ready_dt");
  const dropoffDeadline = parse(window.dropoff_deadline_dt, "dropoff_deadline_dt");

  if (pickupReady) {
    if (pickupReady.getTime() < now.getTime()) {
      throw new DeliveryWindowError("pickup_ready_too_early", "pickup_ready_dt is in the past.");
    }
    const maxReady = addMinutes(now, MAX_PICKUP_READY_DAYS * 24 * 60);
    if (pickupReady.getTime() > maxReady.getTime()) {
      throw new DeliveryWindowError(
        "pickup_ready_too_late",
        `pickup_ready_dt is more than ${MAX_PICKUP_READY_DAYS} days out.`,
      );
    }
  }

  if (pickupDeadline) {
    if (!pickupReady) {
      throw new DeliveryWindowError(
        "invalid_params",
        "pickup_deadline_dt was sent without pickup_ready_dt.",
      );
    }
    const windowMinutes = (pickupDeadline.getTime() - pickupReady.getTime()) / MINUTE_MS;
    if (windowMinutes < MIN_PICKUP_WINDOW_MINUTES) {
      throw new DeliveryWindowError(
        "pickup_window_too_small",
        `The pickup window is ${windowMinutes.toFixed(1)} min; it must be at least ${MIN_PICKUP_WINDOW_MINUTES} min.`,
      );
    }
    if ((pickupDeadline.getTime() - now.getTime()) / MINUTE_MS < 20) {
      throw new DeliveryWindowError(
        "pickup_deadline_too_early",
        "pickup_deadline_dt is under 20 minutes from now.",
      );
    }
  }

  if (dropoffReady && pickupDeadline && dropoffReady.getTime() > pickupDeadline.getTime()) {
    throw new DeliveryWindowError(
      "dropoff_ready_after_pickup_deadline",
      "dropoff_ready_dt must be at or before pickup_deadline_dt.",
    );
  }

  if (dropoffDeadline) {
    if (!dropoffReady) {
      throw new DeliveryWindowError(
        "invalid_params",
        "dropoff_deadline_dt was sent without dropoff_ready_dt.",
      );
    }
    const windowMinutes = (dropoffDeadline.getTime() - dropoffReady.getTime()) / MINUTE_MS;
    if (windowMinutes < MIN_DROPOFF_WINDOW_MINUTES) {
      throw new DeliveryWindowError(
        "dropoff_deadline_too_early",
        `The dropoff window is ${windowMinutes.toFixed(1)} min; it must be at least ${MIN_DROPOFF_WINDOW_MINUTES} min.`,
      );
    }
    if (pickupDeadline && dropoffDeadline.getTime() < pickupDeadline.getTime()) {
      throw new DeliveryWindowError(
        "dropoff_deadline_before_pickup_deadline",
        "dropoff_deadline_dt must be at or after pickup_deadline_dt.",
      );
    }
  }
}

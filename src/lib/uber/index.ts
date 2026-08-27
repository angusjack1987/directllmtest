import { LiveUberDirectClient } from "./live";
import { MockUberDirectClient } from "./mock";
import type { UberDirectClient } from "./types";

let cached: UberDirectClient | undefined;

/** True unless real credentials are configured and UBER_MOCK isn't explicitly on. */
export function isMockMode(): boolean {
  if (process.env.UBER_MOCK === "false") return false;
  if (process.env.UBER_MOCK === "true") return true;
  // No explicit setting: fall back to mock when credentials are missing, so the
  // app runs out of the box rather than 401-ing on the first quote.
  return !(process.env.UBER_CLIENT_ID && process.env.UBER_CLIENT_SECRET && process.env.UBER_CUSTOMER_ID);
}

export function getUberClient(): UberDirectClient {
  if (!cached) {
    cached = isMockMode() ? new MockUberDirectClient() : new LiveUberDirectClient();
  }
  return cached;
}

export * from "./types";
export { UberApiError } from "./client";
export { DeliveryWindowError, buildDeliveryWindow, transitMinutes } from "./windows";
export { centsToE5, dollarsToCents, formatCents } from "./money";

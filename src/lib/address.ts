/**
 * Address normalisation.
 *
 * Bad address data is one of the most common causes of failed deliveries and
 * refund disputes, so the fixes the API docs call for are applied once, here,
 * and the result is serialised exactly once (see serializeAddress) so the quote
 * and the delivery can never disagree.
 */

import type { StructuredAddress } from "./uber/types";

export interface AddressInput {
  street: string;
  /** Apartment / unit / suite. Kept as its own element, never appended to the street line. */
  unit?: string;
  city: string;
  /** May be empty in regions with no state or province. */
  state?: string;
  zipCode: string;
  country?: string;
}

/**
 * Hyphenated house numbers ("10-12 Roker St") must be sent as a single number
 * with the hyphen removed, or the courier gets an address that doesn't resolve.
 */
function normalizeHouseNumber(street: string): string {
  return street.replace(/^(\d+)-(\d+)\b/, "$1");
}

/**
 * A bare unit number gets dropped when it's surfaced to the courier, so give it
 * an explicit prefix unless the customer already typed one.
 */
function normalizeUnit(unit: string): string {
  const trimmed = unit.trim();
  if (!trimmed) return "";
  if (/^(unit|u|#|apt|apartment|suite|ste|fl|floor|room|rm)\b/i.test(trimmed)) return trimmed;
  return `Unit ${trimmed}`;
}

export function normalizeAddress(input: AddressInput): StructuredAddress {
  const streetLines = [normalizeHouseNumber(input.street.trim())];

  const unit = normalizeUnit(input.unit ?? "");
  if (unit) streetLines.push(unit);

  const city = input.city.trim();
  // Where a region has no state/province, set city and state to the same value
  // rather than leaving state blank.
  const state = (input.state ?? "").trim() || city;

  return {
    street_address: streetLines,
    city,
    state,
    zip_code: input.zipCode.trim(),
    country: (input.country ?? "US").trim().toUpperCase(),
  };
}

/**
 * Serialise a structured address for the API.
 *
 * Call this ONCE per order and store the string. Reusing the stored string for
 * both Create Quote and Create Delivery guarantees byte-identical addresses;
 * re-serialising from the form for the second call risks a different key order
 * or a re-typed value, which geocodes differently and produces
 * `delivery_location_changed`.
 */
export function serializeAddress(address: StructuredAddress): string {
  return JSON.stringify(address);
}

/** Single-line rendering for the UI. */
export function formatAddress(address: StructuredAddress): string {
  return `${address.street_address.join(", ")}, ${address.city}, ${address.state} ${address.zip_code}`;
}

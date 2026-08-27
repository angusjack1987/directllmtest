/**
 * The pickup stores this app can dispatch from.
 *
 * `externalStoreId` is the single value that must stay identical across Create
 * Quote, Create Delivery, Find Stores, and `external_business_location_id` on
 * the Business Location API. Inconsistency here is the most common cause of
 * incorrect store-to-location mapping, so it is defined once, here.
 *
 * Lat/lng is pre-collected per store rather than geocoded on every request.
 */

import type { MerchantType, StructuredAddress, UndeliverableAction } from "./uber/types";

export interface Store {
  externalStoreId: string;
  name: string;
  phoneNumber: string;
  merchantType: MerchantType;
  address: StructuredAddress;
  latitude: number;
  longitude: number;
  /** Minutes of prep before a courier should arrive, for ASAP orders. */
  prepMinutes: number;
  pickupNotes?: string;
}

export const STORES: Store[] = [
  {
    externalStoreId: "store-sf-mission-01",
    name: "Golden Gate Kitchen",
    phoneNumber: "+14155550142",
    merchantType: "MERCHANT_TYPE_RESTAURANT",
    address: {
      street_address: ["2800 Mission St"],
      city: "San Francisco",
      state: "CA",
      zip_code: "94110",
      country: "US",
    },
    latitude: 37.7519,
    longitude: -122.4183,
    prepMinutes: 15,
    pickupNotes: "Collect from the counter marked DELIVERY. Ask for the order number.",
  },
  {
    externalStoreId: "store-sf-soma-02",
    name: "Embarcadero Market",
    phoneNumber: "+14155550178",
    merchantType: "MERCHANT_TYPE_GROCERY",
    address: {
      street_address: ["631 Folsom St", "Suite 100"],
      city: "San Francisco",
      state: "CA",
      zip_code: "94107",
      country: "US",
    },
    latitude: 37.7852,
    longitude: -122.3969,
    prepMinutes: 25,
    pickupNotes: "Loading bay on Hawthorne St. Staff will bring bags out.",
  },
  {
    externalStoreId: "store-sf-marina-03",
    name: "Chestnut Street Pharmacy",
    phoneNumber: "+14155550196",
    merchantType: "MERCHANT_TYPE_PHARMACY",
    address: {
      street_address: ["2100 Chestnut St"],
      city: "San Francisco",
      state: "CA",
      zip_code: "94123",
      country: "US",
    },
    latitude: 37.8005,
    longitude: -122.4368,
    prepMinutes: 20,
  },
];

export function getStore(externalStoreId: string): Store | undefined {
  return STORES.find((store) => store.externalStoreId === externalStoreId);
}

/** Verticals whose goods can't be resold after a failed dropoff. */
const PERISHABLE_MERCHANT_TYPES: MerchantType[] = [
  "MERCHANT_TYPE_RESTAURANT",
  "MERCHANT_TYPE_GROCERY",
  "MERCHANT_TYPE_SPECIALTY_FOOD",
  "MERCHANT_TYPE_FLOWER",
];

/**
 * `undeliverable_action` defaults to `return` when unset, which is wrong for
 * perishables — returned food can't be resold, so the trip back is pure cost.
 * Set it explicitly per vertical instead of inheriting the default.
 */
export function defaultUndeliverableAction(store: Store): UndeliverableAction {
  return PERISHABLE_MERCHANT_TYPES.includes(store.merchantType) ? "discard" : "return";
}

export function isPerishable(store: Store): boolean {
  return PERISHABLE_MERCHANT_TYPES.includes(store.merchantType);
}

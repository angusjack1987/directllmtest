/**
 * Proof-of-delivery selection.
 *
 * The rule this encodes: pick ONE verification type per delivery. Stacking them
 * compounds each type's failure rate and adds dropoff time for no extra
 * protection — pincode in particular is the strongest anti-fraud check but has
 * a real fail rate, so it shouldn't ride along with anything else.
 *
 * Compatibility also matters: signature, pincode, and ID are all incompatible
 * with leave_at_door. Photo is the one type that pairs safely with it, and is
 * auto-enabled there anyway.
 */

import type { MerchantType } from "./types";
import type { DeliverableAction, VerificationRequirement } from "./types";

export interface PodInput {
  merchantType: MerchantType;
  deliverableAction: DeliverableAction;
  /** Basket contains alcohol/tobacco/anything age-gated. */
  ageRestricted?: boolean;
  /** Non-alcohol age-restricted goods (e.g. tobacco) don't need a sobriety check. */
  ageRestrictedNonAlcohol?: boolean;
  /** Caller-flagged high-value or high-risk order. */
  highRisk?: boolean;
}

export interface PodChoice {
  requirement?: VerificationRequirement;
  /** Human-readable reason, surfaced in the UI so the choice isn't a black box. */
  rationale: string;
}

const SIGNATURE_VERTICALS: MerchantType[] = [
  "MERCHANT_TYPE_RETAIL",
  "MERCHANT_TYPE_PHARMACY",
  "MERCHANT_TYPE_LIQUOR",
  "MERCHANT_TYPE_ESSENTIALS",
];

export function selectDropoffVerification(input: PodInput): PodChoice {
  const leaveAtDoor = input.deliverableAction === "deliverable_action_leave_at_door";

  // ID check wins outright: it's a legal requirement, not a preference, and
  // alcohol auto-triggers it regardless of what we ask for.
  if (input.ageRestricted) {
    if (leaveAtDoor) {
      throw new Error(
        "An age-restricted order can't be left at the door — ID verification requires meet at door.",
      );
    }
    return {
      requirement: {
        identification: {
          min_age: 21,
          ...(input.ageRestrictedNonAlcohol ? { no_sobriety_check: true } : {}),
        },
      },
      rationale: input.ageRestrictedNonAlcohol
        ? "Age-restricted, non-alcohol: ID scan, sobriety check skipped."
        : "Age-restricted: ID scan and sobriety check (auto-applied for alcohol anyway).",
    };
  }

  if (leaveAtDoor) {
    // Photo is auto-enabled for leave at door; being explicit documents intent.
    // Never used for meet at door — couriers can read it as a cue to leave the
    // order unattended, and in some cases photograph the customer.
    return {
      requirement: { picture: true },
      rationale: "Leave at door: drop-off photo (the only POD type that's safe here).",
    };
  }

  if (input.highRisk) {
    return {
      requirement: { pincode: { enabled: true, type: "default" } },
      rationale: "Flagged high-risk: pincode, the strongest anti-fraud check. Used on its own.",
    };
  }

  if (SIGNATURE_VERTICALS.includes(input.merchantType)) {
    return {
      requirement: {
        signature_requirement: { enabled: true, collect_signer_name: true },
      },
      rationale: "Retail/pharmacy/liquor: signature on handover.",
    };
  }

  // Food. Signature is fraud-prone in this context, and meet-at-door handover
  // is the check, so nothing extra is requested.
  return {
    rationale: "Food, meet at door: no extra POD — signature is fraud-prone for restaurant delivery.",
  };
}

/** A per-bag barcode for the pickup handshake, useful for high-volume stores. */
export function pickupBarcode(orderNumber: string): VerificationRequirement {
  return { barcodes: [{ value: orderNumber, type: "CODE128" }] };
}

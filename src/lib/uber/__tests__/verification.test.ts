import { describe, expect, it } from "vitest";
import { selectDropoffVerification } from "../verification";

const MEET = "deliverable_action_meet_at_door" as const;
const LEAVE = "deliverable_action_leave_at_door" as const;

function countTypes(requirement: ReturnType<typeof selectDropoffVerification>["requirement"]): number {
  if (!requirement) return 0;
  return [
    requirement.signature_requirement?.enabled,
    requirement.picture,
    requirement.identification,
    requirement.pincode,
  ].filter(Boolean).length;
}

describe("selectDropoffVerification", () => {
  it("never returns more than one POD type", () => {
    const cases = [
      { merchantType: "MERCHANT_TYPE_RESTAURANT", deliverableAction: MEET },
      { merchantType: "MERCHANT_TYPE_RESTAURANT", deliverableAction: LEAVE },
      { merchantType: "MERCHANT_TYPE_RETAIL", deliverableAction: MEET, highRisk: true },
      { merchantType: "MERCHANT_TYPE_PHARMACY", deliverableAction: MEET },
      { merchantType: "MERCHANT_TYPE_LIQUOR", deliverableAction: MEET, ageRestricted: true },
    ] as const;

    for (const input of cases) {
      expect(countTypes(selectDropoffVerification(input).requirement)).toBeLessThanOrEqual(1);
    }
  });

  it("uses a photo for leave at door and nothing else", () => {
    const { requirement } = selectDropoffVerification({
      merchantType: "MERCHANT_TYPE_RESTAURANT",
      deliverableAction: LEAVE,
    });
    expect(requirement).toEqual({ picture: true });
  });

  it("never asks for a photo on meet at door", () => {
    const { requirement } = selectDropoffVerification({
      merchantType: "MERCHANT_TYPE_RESTAURANT",
      deliverableAction: MEET,
    });
    expect(requirement?.picture).toBeUndefined();
  });

  it("never asks for a signature on food", () => {
    const { requirement } = selectDropoffVerification({
      merchantType: "MERCHANT_TYPE_RESTAURANT",
      deliverableAction: MEET,
    });
    expect(requirement?.signature_requirement).toBeUndefined();
  });

  it("uses a signature for pharmacy and retail", () => {
    for (const merchantType of ["MERCHANT_TYPE_PHARMACY", "MERCHANT_TYPE_RETAIL"] as const) {
      const { requirement } = selectDropoffVerification({ merchantType, deliverableAction: MEET });
      expect(requirement?.signature_requirement?.enabled).toBe(true);
    }
  });

  it("puts ID verification ahead of everything else, with min_age in the 18-25 range", () => {
    const { requirement } = selectDropoffVerification({
      merchantType: "MERCHANT_TYPE_LIQUOR",
      deliverableAction: MEET,
      ageRestricted: true,
      highRisk: true,
    });
    expect(requirement?.identification?.min_age).toBe(21);
    expect(requirement?.pincode).toBeUndefined();
    expect(countTypes(requirement)).toBe(1);
  });

  it("skips the sobriety check for non-alcohol age-restricted goods", () => {
    const { requirement } = selectDropoffVerification({
      merchantType: "MERCHANT_TYPE_ESSENTIALS",
      deliverableAction: MEET,
      ageRestricted: true,
      ageRestrictedNonAlcohol: true,
    });
    expect(requirement?.identification?.no_sobriety_check).toBe(true);
  });

  it("refuses to leave an age-restricted order at the door", () => {
    expect(() =>
      selectDropoffVerification({
        merchantType: "MERCHANT_TYPE_LIQUOR",
        deliverableAction: LEAVE,
        ageRestricted: true,
      }),
    ).toThrow(/can't be left at the door/);
  });

  it("uses a pincode alone for a high-risk meet-at-door order", () => {
    const { requirement } = selectDropoffVerification({
      merchantType: "MERCHANT_TYPE_RETAIL",
      deliverableAction: MEET,
      highRisk: true,
    });
    expect(requirement?.pincode?.enabled).toBe(true);
    expect(requirement?.signature_requirement).toBeUndefined();
  });
});

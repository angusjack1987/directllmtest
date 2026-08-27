import { describe, expect, it } from "vitest";
import { normalizeAddress, serializeAddress } from "../../address";

describe("normalizeAddress", () => {
  it("keeps the unit as its own street_address element", () => {
    const address = normalizeAddress({
      street: "1515 3rd St",
      unit: "Apt. 5",
      city: "San Francisco",
      state: "CA",
      zipCode: "94158",
    });
    expect(address.street_address).toEqual(["1515 3rd St", "Apt. 5"]);
  });

  it("prefixes a bare unit number so it isn't dropped for the courier", () => {
    const address = normalizeAddress({
      street: "1515 3rd St",
      unit: "5",
      city: "San Francisco",
      state: "CA",
      zipCode: "94158",
    });
    expect(address.street_address[1]).toBe("Unit 5");
  });

  it("collapses a hyphenated house number to one number", () => {
    const address = normalizeAddress({
      street: "10-12 Roker St",
      city: "Leeds",
      state: "",
      zipCode: "LS1 4AB",
      country: "GB",
    });
    expect(address.street_address[0]).toBe("10 Roker St");
  });

  it("mirrors city into state where a region has no state value", () => {
    const address = normalizeAddress({
      street: "1 Marina Blvd",
      city: "Singapore",
      zipCode: "018956",
      country: "SG",
    });
    expect(address.state).toBe("Singapore");
  });

  it("does not treat a house number as a hyphenated pair mid-string", () => {
    const address = normalizeAddress({
      street: "42 Smith-Jones Ave",
      city: "Austin",
      state: "TX",
      zipCode: "78701",
    });
    expect(address.street_address[0]).toBe("42 Smith-Jones Ave");
  });
});

describe("serializeAddress", () => {
  it("is stable, so the quote and the delivery send identical bytes", () => {
    const input = {
      street: "1515 3rd St",
      unit: "5",
      city: "San Francisco",
      state: "CA",
      zipCode: "94158",
    };
    expect(serializeAddress(normalizeAddress(input))).toBe(
      serializeAddress(normalizeAddress(input)),
    );
  });
});

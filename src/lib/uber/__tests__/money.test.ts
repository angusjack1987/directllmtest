import { describe, expect, it } from "vitest";
import { centsToE5, dollarsToCents, formatCents } from "../money";

describe("centsToE5", () => {
  it("converts $10.99 to 1099000, not 1099", () => {
    // e5 is 1/100,000 of a currency unit. Sending 1099 here would refund a
    // thousandth of the intended amount.
    expect(centsToE5(1099)).toBe(1099000);
    expect(centsToE5(1099)).not.toBe(1099);
  });

  it("scales every amount by exactly 1000", () => {
    expect(centsToE5(0)).toBe(0);
    expect(centsToE5(1)).toBe(1000);
    expect(centsToE5(2500)).toBe(2_500_000);
    expect(centsToE5(123_456)).toBe(123_456_000);
  });
});

describe("dollarsToCents", () => {
  it("parses strings and numbers", () => {
    expect(dollarsToCents("10.99")).toBe(1099);
    expect(dollarsToCents(10.99)).toBe(1099);
  });

  it("rounds rather than truncating float noise", () => {
    expect(dollarsToCents(0.1 + 0.2)).toBe(30);
  });

  it("rejects nonsense", () => {
    expect(() => dollarsToCents("abc")).toThrow();
  });
});

describe("formatCents", () => {
  it("renders cents as currency", () => {
    expect(formatCents(1099, "USD")).toBe("$10.99");
    expect(formatCents(599)).toBe("$5.99");
  });
});

describe("the full refund path", () => {
  it("takes an operator-entered dollar amount through to e5", () => {
    expect(centsToE5(dollarsToCents("24.50"))).toBe(2_450_000);
  });
});

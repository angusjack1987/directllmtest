import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { centsToE5, dollarsToCents, formatCents } from "../money.ts";

describe("centsToE5", () => {
  it("converts $10.99 to 1099000, not 1099", () => {
    // e5 is 1/100,000 of a currency unit. Sending 1099 here would refund a
    // thousandth of the intended amount.
    assert.strictEqual(centsToE5(1099), 1099000);
    assert.notStrictEqual(centsToE5(1099), 1099);
  });

  it("scales every amount by exactly 1000", () => {
    assert.strictEqual(centsToE5(0), 0);
    assert.strictEqual(centsToE5(1), 1000);
    assert.strictEqual(centsToE5(2500), 2_500_000);
    assert.strictEqual(centsToE5(123_456), 123_456_000);
  });
});

describe("dollarsToCents", () => {
  it("parses strings and numbers", () => {
    assert.strictEqual(dollarsToCents("10.99"), 1099);
    assert.strictEqual(dollarsToCents(10.99), 1099);
  });

  it("rounds rather than truncating float noise", () => {
    assert.strictEqual(dollarsToCents(0.1 + 0.2), 30);
  });

  it("rejects nonsense", () => {
    assert.throws(() => dollarsToCents("abc"));
  });
});

describe("formatCents", () => {
  it("renders cents as currency", () => {
    assert.strictEqual(formatCents(1099, "USD"), "$10.99");
    assert.strictEqual(formatCents(599), "$5.99");
  });
});

describe("the full refund path", () => {
  it("takes an operator-entered dollar amount through to e5", () => {
    assert.strictEqual(centsToE5(dollarsToCents("24.50")), 2_450_000);
  });
});

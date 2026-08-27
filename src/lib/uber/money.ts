/**
 * Money helpers.
 *
 * Every monetary field in the Uber Direct API is in CENTS (e2) — fees, tips,
 * item prices, manifest_total_value, refund webhook amounts — with exactly one
 * exception, handled by centsToE5 below.
 */

/** Format a cents amount for display, e.g. formatCents(1099, "USD") -> "$10.99". */
export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/**
 * Convert cents to the e5 format used by ONE field in the entire platform:
 * `total_refund_amount.amount` on POST /v1/direct/{customer_id}/submit_refund.
 *
 * e5 is 1/100,000 of a currency unit, so $10.99 is 1099000 — not 1099.
 * Getting this wrong under- or over-refunds by three orders of magnitude.
 *
 * This is deliberately NOT the same helper as the cents formatting above, and
 * it is deliberately named for the format rather than for "refund", so it is
 * obvious at the call site that a different unit is in play.
 */
export function centsToE5(cents: number): number {
  return Math.round(cents * 1000);
}

/** Parse a user-entered dollar string ("10.99") into cents. */
export function dollarsToCents(dollars: string | number): number {
  const value = typeof dollars === "number" ? dollars : Number.parseFloat(dollars);
  if (!Number.isFinite(value)) throw new Error(`Not a valid amount: ${dollars}`);
  return Math.round(value * 100);
}

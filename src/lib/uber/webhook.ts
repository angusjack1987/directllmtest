/**
 * Webhook signature verification.
 *
 * The signature is an HMAC-SHA256 of the RAW request body. It must be verified
 * against the bytes as received — re-serialising a parsed JSON object mangles
 * `\uXXXX` unicode escapes and silently breaks verification for any payload
 * containing them.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type UberWebhookKind =
  | "event.delivery_status"
  | "event.courier_update"
  | "event.shopping_progress"
  | "event.refund_request"
  | "dapi.refund_requested";

export interface WebhookEnvelope {
  kind?: UberWebhookKind | string;
  delivery_id?: string;
  /** Delivery-status/courier-update payloads carry the delivery under `data`. */
  data?: Record<string, unknown>;
  status?: string;
  [key: string]: unknown;
}

export function computeSignature(rawBody: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(rawBody, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface VerifyInput {
  rawBody: string;
  /** Header values as received; either may be absent. */
  uberSignature?: string | null;
  postmatesSignature?: string | null;
  kind?: string;
  signingKey: string;
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

/**
 * `x-postmates-signature` is accepted as a legacy alias for the delivery-status
 * and courier-update webhooks only. The refund webhook requires
 * `x-uber-signature` specifically, so it does not fall back.
 */
export function verifyWebhookSignature(input: VerifyInput): VerifyResult {
  if (!input.signingKey) {
    return { valid: false, reason: "No signing key configured." };
  }

  const isRefund = input.kind === "event.refund_request" || input.kind === "dapi.refund_requested";

  const provided = isRefund
    ? input.uberSignature
    : (input.uberSignature ?? input.postmatesSignature);

  if (!provided) {
    return {
      valid: false,
      reason: isRefund
        ? "Missing x-uber-signature (the refund webhook does not accept x-postmates-signature)."
        : "Missing x-uber-signature / x-postmates-signature.",
    };
  }

  const expected = computeSignature(input.rawBody, input.signingKey);
  return safeEqual(provided.trim().toLowerCase(), expected)
    ? { valid: true }
    : { valid: false, reason: "Signature mismatch." };
}

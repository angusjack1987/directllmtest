import { describe, expect, it } from "vitest";
import { computeSignature, verifyWebhookSignature } from "../webhook";

const KEY = "whsec_test_key";

/**
 * A raw body exactly as it arrives on the wire, with the non-ASCII characters
 * sent as \uXXXX escapes. This is the case that breaks naive verification:
 * JSON.parse decodes the escapes, and re-stringifying emits the literal
 * characters instead, producing a different byte sequence and a different HMAC.
 */
const RAW_BODY =
  '{"kind":"event.delivery_status","delivery_id":"del_abc","status":"pickup",' +
  '"customer":"Caf\\u00e9 R\\u00fcgen"}';

describe("verifyWebhookSignature", () => {
  it("accepts a correct x-uber-signature", () => {
    const result = verifyWebhookSignature({
      rawBody: RAW_BODY,
      uberSignature: computeSignature(RAW_BODY, KEY),
      kind: "event.delivery_status",
      signingKey: KEY,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signature = computeSignature(RAW_BODY, KEY);
    const tampered = RAW_BODY.replace("pickup", "delivered");

    const result = verifyWebhookSignature({
      rawBody: tampered,
      uberSignature: signature,
      kind: "event.delivery_status",
      signingKey: KEY,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("Signature mismatch.");
  });

  it("rejects a signature made with a different key", () => {
    const result = verifyWebhookSignature({
      rawBody: RAW_BODY,
      uberSignature: computeSignature(RAW_BODY, "wrong-key"),
      kind: "event.delivery_status",
      signingKey: KEY,
    });
    expect(result.valid).toBe(false);
  });

  it("verifies against the raw bytes, so unicode escapes survive", () => {
    // Re-serialising the parsed object emits the literal characters rather than
    // the \uXXXX escapes, producing a different digest. This asserts that the
    // difference is real, which is why the route never re-serialises.
    const reserialized = JSON.stringify(JSON.parse(RAW_BODY));
    expect(reserialized).not.toBe(RAW_BODY);
    expect(computeSignature(reserialized, KEY)).not.toBe(computeSignature(RAW_BODY, KEY));
  });

  it("accepts x-postmates-signature for delivery status", () => {
    const result = verifyWebhookSignature({
      rawBody: RAW_BODY,
      postmatesSignature: computeSignature(RAW_BODY, KEY),
      kind: "event.delivery_status",
      signingKey: KEY,
    });
    expect(result.valid).toBe(true);
  });

  it("does NOT accept x-postmates-signature for the refund webhook", () => {
    const result = verifyWebhookSignature({
      rawBody: RAW_BODY,
      postmatesSignature: computeSignature(RAW_BODY, KEY),
      kind: "event.refund_request",
      signingKey: KEY,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("x-uber-signature");
  });

  it("fails closed when no signing key is configured", () => {
    const result = verifyWebhookSignature({
      rawBody: RAW_BODY,
      uberSignature: computeSignature(RAW_BODY, KEY),
      kind: "event.delivery_status",
      signingKey: "",
    });
    expect(result.valid).toBe(false);
  });
});

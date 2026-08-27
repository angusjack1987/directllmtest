import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { UberApiError, uberFetch } from "../client.ts";
import { __clearTokenCache } from "../auth.ts";

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tokenResponse(): Response {
  return jsonResponse(200, { access_token: "test-token", expires_in: 2_592_000 });
}

interface FetchStub {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Every URL the stub was called with, in order. */
  calls: string[];
  tokenCallCount(): number;
}

/**
 * A minimal stand-in for fetch.
 *
 * `queue` supplies responses in order; once exhausted, `fallback` answers every
 * further call. Token requests are answered automatically so each test only has
 * to describe the API responses it cares about.
 */
function stubFetch(options: {
  queue?: Response[];
  fallback?: () => Response;
}): FetchStub {
  const queue = [...(options.queue ?? [])];

  const stub = (async (input: RequestInfo | URL) => {
    const url = String(input);
    stub.calls.push(url);

    if (url.includes("auth.uber.com")) return tokenResponse();
    if (queue.length > 0) return queue.shift()!;
    if (options.fallback) return options.fallback();

    throw new Error(`stubFetch: no response queued for ${url}`);
  }) as FetchStub;

  stub.calls = [];
  stub.tokenCallCount = () => stub.calls.filter((url) => url.includes("auth.uber.com")).length;

  globalThis.fetch = stub as unknown as typeof fetch;
  return stub;
}

/** API calls only — the token request is bookkeeping, not behaviour under test. */
function apiCallCount(stub: FetchStub): number {
  return stub.calls.filter((url) => !url.includes("auth.uber.com")).length;
}

beforeEach(() => {
  __clearTokenCache();
  process.env.UBER_CLIENT_ID = "test-id";
  process.env.UBER_CLIENT_SECRET = "test-secret";
  process.env.UBER_CUSTOMER_ID = "cus_test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("retry policy", () => {
  // These two tests spend the real backoff (500ms, then 1000ms). That is a
  // couple of seconds total, which is cheaper than adding a retry-timing knob
  // to uberFetch that only tests would ever use.

  it("retries a 503 and succeeds on a later attempt", async () => {
    const stub = stubFetch({
      queue: [
        jsonResponse(503, { code: "service_unavailable", message: "down" }),
        jsonResponse(200, { kind: "delivery", id: "del_1" }),
      ],
    });

    const result = await uberFetch<{ id: string }>({ path: "/customers/x/deliveries/del_1" });

    assert.strictEqual(result.id, "del_1");
    assert.strictEqual(apiCallCount(stub), 2);
  });

  it("does NOT retry a 400 — a bad request will fail identically", async () => {
    const stub = stubFetch({
      queue: [
        jsonResponse(400, {
          kind: "error",
          code: "invalid_params",
          message: "Address could not be determined",
          metadata: { param_details: "dropoff_address" },
        }),
      ],
    });

    await assert.rejects(
      uberFetch({ method: "POST", path: "/customers/x/deliveries", body: {} }),
      (error: unknown) => {
        assert.ok(error instanceof UberApiError);
        assert.strictEqual(error.code, "invalid_params");
        assert.strictEqual(error.httpStatus, 400);
        return true;
      },
    );

    assert.strictEqual(apiCallCount(stub), 1);
  });

  it("does not retry a 429, so a rate limit isn't hammered", async () => {
    const stub = stubFetch({
      queue: [jsonResponse(429, { code: "customer_limited", message: "slow down" })],
    });

    await assert.rejects(uberFetch({ path: "/customers/x/deliveries" }), (error: unknown) => {
      assert.ok(error instanceof UberApiError);
      assert.strictEqual(error.code, "customer_limited");
      return true;
    });

    assert.strictEqual(apiCallCount(stub), 1);
  });

  it("gives up after the attempt cap on persistent 5xx", async () => {
    const stub = stubFetch({
      fallback: () => jsonResponse(500, { code: "internal_server_error", message: "boom" }),
    });

    await assert.rejects(
      uberFetch({ path: "/customers/x/deliveries" }),
      (error: unknown) => error instanceof UberApiError,
    );

    // MAX_ATTEMPTS is 3; it must stop there rather than looping forever.
    assert.strictEqual(apiCallCount(stub), 3);
  });
});

describe("error mapping", () => {
  it("surfaces code, message and param_details", async () => {
    stubFetch({
      queue: [
        jsonResponse(400, {
          kind: "error",
          code: "expired_quote",
          message: "Quote is older than 15 minutes",
          metadata: { param_details: "quote_id" },
        }),
      ],
    });

    await assert.rejects(
      uberFetch({ method: "POST", path: "/customers/x/deliveries", body: {} }),
      (error: unknown) => {
        assert.ok(error instanceof UberApiError);
        assert.strictEqual(error.code, "expired_quote");
        assert.strictEqual(error.message, "Quote is older than 15 minutes");
        assert.strictEqual(error.paramDetails, "quote_id");
        assert.strictEqual(error.isClientError, true);
        return true;
      },
    );
  });
});

describe("token caching", () => {
  it("fetches one token and reuses it across calls", async () => {
    const stub = stubFetch({ fallback: () => jsonResponse(200, { ok: true }) });

    await uberFetch({ path: "/customers/x/deliveries" });
    await uberFetch({ path: "/customers/x/deliveries" });
    await uberFetch({ path: "/customers/x/deliveries" });

    // The token lives 30 days and the token endpoint allows 100 requests/hour,
    // so three API calls must cost exactly one token request.
    assert.strictEqual(stub.tokenCallCount(), 1);
    assert.strictEqual(apiCallCount(stub), 3);
  });
});

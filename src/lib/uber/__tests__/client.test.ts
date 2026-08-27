import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UberApiError, uberFetch } from "../client";
import { __clearTokenCache } from "../auth";

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

beforeEach(() => {
  __clearTokenCache();
  process.env.UBER_CLIENT_ID = "test-id";
  process.env.UBER_CLIENT_SECRET = "test-secret";
  process.env.UBER_CUSTOMER_ID = "cus_test";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Runs a promise while auto-advancing timers, so backoff sleeps don't hang. */
async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const result = await settled;
  if (result.ok) return result.value;
  throw result.error;
}

describe("retry policy", () => {
  it("retries a 503 and succeeds on a later attempt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(503, { code: "service_unavailable", message: "down" }))
      .mockResolvedValueOnce(jsonResponse(200, { kind: "delivery", id: "del_1" }));
    globalThis.fetch = fetchMock;

    const result = await runWithTimers(uberFetch<{ id: string }>({ path: "/customers/x/deliveries/del_1" }));

    expect(result.id).toBe("del_1");
    // token + failed attempt + successful retry
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a 400 — a bad request will fail identically", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse(400, {
          kind: "error",
          code: "invalid_params",
          message: "Address could not be determined",
          metadata: { param_details: "dropoff_address" },
        }),
      );
    globalThis.fetch = fetchMock;

    await expect(
      runWithTimers(uberFetch({ method: "POST", path: "/customers/x/deliveries", body: {} })),
    ).rejects.toMatchObject({ code: "invalid_params", httpStatus: 400 });

    // token + one attempt, no retry
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 429, so a rate limit isn't hammered", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(429, { code: "customer_limited", message: "slow down" }));
    globalThis.fetch = fetchMock;

    await expect(runWithTimers(uberFetch({ path: "/customers/x/deliveries" }))).rejects.toMatchObject({
      code: "customer_limited",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt cap on persistent 5xx", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).includes("auth.uber.com")) return tokenResponse();
      return jsonResponse(500, { code: "internal_server_error", message: "boom" });
    });
    globalThis.fetch = fetchMock;

    await expect(runWithTimers(uberFetch({ path: "/customers/x/deliveries" }))).rejects.toBeInstanceOf(
      UberApiError,
    );
  });
});

describe("error mapping", () => {
  it("surfaces code, message and param_details", async () => {
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse(400, {
          kind: "error",
          code: "expired_quote",
          message: "Quote is older than 15 minutes",
          metadata: { param_details: "quote_id" },
        }),
      );

    try {
      await runWithTimers(uberFetch({ method: "POST", path: "/customers/x/deliveries", body: {} }));
      throw new Error("expected a throw");
    } catch (error) {
      const apiError = error as UberApiError;
      expect(apiError).toBeInstanceOf(UberApiError);
      expect(apiError.code).toBe("expired_quote");
      expect(apiError.paramDetails).toBe("quote_id");
      expect(apiError.isClientError).toBe(true);
    }
  });
});

describe("token caching", () => {
  it("fetches one token and reuses it across calls", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).includes("auth.uber.com")) return tokenResponse();
      return jsonResponse(200, { ok: true });
    });
    globalThis.fetch = fetchMock;

    await runWithTimers(uberFetch({ path: "/customers/x/deliveries" }));
    await runWithTimers(uberFetch({ path: "/customers/x/deliveries" }));
    await runWithTimers(uberFetch({ path: "/customers/x/deliveries" }));

    const tokenCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("auth.uber.com"),
    );
    expect(tokenCalls).toHaveLength(1);
  });
});

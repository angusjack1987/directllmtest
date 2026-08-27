/**
 * HTTP layer for the Uber Direct API.
 *
 * Everything goes to https://api.uber.com/v1. There is no separate sandbox
 * hostname — sandbox vs production is decided by which credentials are in use.
 */

import { getAccessToken, type UberScope } from "./auth.ts";

export const UBER_API_BASE = "https://api.uber.com/v1";

/** Retry only these. See shouldRetry() for why 4xx is excluded. */
const RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

export interface UberErrorBody {
  kind?: "error";
  code?: string;
  message?: string;
  metadata?: { param_details?: unknown };
}

export class UberApiError extends Error {
  /** e.g. invalid_params, address_undeliverable, expired_quote, customer_limited. */
  readonly code: string;
  readonly httpStatus: number;
  /** Present on invalid_params: the specific sub-case. */
  readonly paramDetails?: unknown;

  constructor(code: string, message: string, httpStatus: number, paramDetails?: unknown) {
    super(message);
    this.name = "UberApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.paramDetails = paramDetails;
  }

  /** True when the caller should fix the request rather than resend it as-is. */
  get isClientError(): boolean {
    return this.httpStatus >= 400 && this.httpStatus < 500;
  }
}

/**
 * A 4xx means the request itself is wrong — a bad address, an expired quote, a
 * stage-invalid field. Resending the identical payload will fail identically
 * while still consuming rate-limit budget, so 4xx is never retried. That
 * includes 429: it is surfaced to the caller rather than hammered in a loop.
 */
function shouldRetry(status: number | undefined): boolean {
  return status === undefined || RETRYABLE_STATUSES.has(status);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface UberFetchOptions {
  method?: "GET" | "POST" | "PATCH";
  /** Path relative to UBER_API_BASE, e.g. "/customers/abc/deliveries". */
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  scope?: UberScope;
  /** Extra headers, e.g. Idempotency-Key. */
  headers?: Record<string, string>;
}

export async function uberFetch<T>(options: UberFetchOptions): Promise<T> {
  const { method = "GET", path, body, query, scope = "eats.deliveries", headers = {} } = options;

  const url = new URL(`${UBER_API_BASE}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const token = await getAccessToken(scope);

      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });

      const text = await res.text();
      const json: unknown = text ? safeParse(text) : undefined;

      if (res.ok) return json as T;

      const err = json as UberErrorBody | undefined;
      const apiError = new UberApiError(
        err?.code ?? `http_${res.status}`,
        err?.message ?? `Request failed with ${res.status}`,
        res.status,
        err?.metadata?.param_details,
      );

      if (!shouldRetry(res.status) || attempt === MAX_ATTEMPTS) throw apiError;
      lastError = apiError;
    } catch (error) {
      // A thrown UberApiError we already decided not to retry propagates as-is.
      if (error instanceof UberApiError && !shouldRetry(error.httpStatus)) throw error;
      if (attempt === MAX_ATTEMPTS) throw error;
      lastError = error;
    }

    // Exponential backoff, retryable failures only.
    await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
  }

  throw lastError;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/** The {customer_id} path param on every /v1/customers/... call. */
export function requireCustomerId(): string {
  const customerId = process.env.UBER_CUSTOMER_ID;
  if (!customerId) {
    throw new Error(
      "UBER_CUSTOMER_ID is not set. Set it in .env.local, or run with UBER_MOCK=true.",
    );
  }
  return customerId;
}

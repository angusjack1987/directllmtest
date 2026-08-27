/**
 * OAuth 2.0 client_credentials for Uber Direct.
 *
 * Tokens live for 30 days and cannot be refreshed. Fetching one per request
 * would burn through the token endpoint's 100 requests/hour limit almost
 * immediately, so the token is cached at module scope and reused until it
 * actually expires.
 */

const TOKEN_URL = "https://auth.uber.com/oauth/v2/token";

/** Refresh this far before the real expiry so an in-flight request can't race it. */
const EXPIRY_SKEW_MS = 60_000;

export type UberScope = "eats.deliveries" | "direct.organizations";

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

const cache = new Map<UberScope, CachedToken>();

/** In-flight fetches, so N concurrent callers share one token request. */
const inFlight = new Map<UberScope, Promise<string>>();

export class UberAuthError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = "UberAuthError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

async function fetchToken(scope: UberScope): Promise<string> {
  const clientId = process.env.UBER_CLIENT_ID;
  const clientSecret = process.env.UBER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new UberAuthError(
      "invalid_client",
      "UBER_CLIENT_ID / UBER_CLIENT_SECRET are not set. Set them in .env.local, or run with UBER_MOCK=true.",
      401,
    );
  }

  // The token endpoint takes form-encoded params, not JSON.
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !json.access_token) {
    throw new UberAuthError(
      json.error ?? "unauthorized",
      json.error_description ?? `Token request failed with ${res.status}`,
      res.status,
    );
  }

  // Documented lifetime is 2,592,000s (30 days); trust the response if it says otherwise.
  const expiresInMs = (json.expires_in ?? 2_592_000) * 1000;
  cache.set(scope, {
    accessToken: json.access_token,
    expiresAtMs: Date.now() + expiresInMs,
  });

  return json.access_token;
}

export async function getAccessToken(scope: UberScope = "eats.deliveries"): Promise<string> {
  const cached = cache.get(scope);
  if (cached && cached.expiresAtMs - EXPIRY_SKEW_MS > Date.now()) {
    return cached.accessToken;
  }

  const existing = inFlight.get(scope);
  if (existing) return existing;

  const pending = fetchToken(scope).finally(() => inFlight.delete(scope));
  inFlight.set(scope, pending);
  return pending;
}

/** Test helper. */
export function __clearTokenCache(): void {
  cache.clear();
  inFlight.clear();
}

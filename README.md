# Direct Dispatch

A small delivery-ordering app built on the [Uber Direct API](https://developer.uber.com/docs/deliveries/introduction).
It covers the merchant flow end to end — quote, pay, dispatch, track, cancel, refund — plus a
signed webhook receiver and a Robocourier sandbox simulation.

It runs with **no Uber credentials**: a mock client returns realistic objects and advances a
simulated courier through the real status sequence. Drop real keys into `.env.local` and it
talks to the live API instead, with no code changes.

Requires **Node 22.18 or newer** — the tests are TypeScript run directly by Node's built-in
test runner, which needs type stripping on by default.

```bash
npm install
npm run dev          # http://localhost:3000 — mock mode by default
npm test             # 51 tests, no test framework installed
npm run build
```

### Dependencies are deliberately minimal

Runtime: `next`, `react`, `react-dom`, `zod`. Dev: TypeScript and its `@types`. That's it —
32 packages installed.

Tests run on `node --test` with `node:assert`, so there is no vitest/vite/rollup/esbuild
tree. React is pinned to 18.x rather than 19.x. Both choices are so the project installs
behind a curated corporate registry, where a large transitive tree is a large surface for
policy blocks and mirror lag.

`package-lock.json` is intentionally **not** committed, so npm resolves against whichever
versions your registry mirror actually carries instead of demanding exact versions from
someone else's. The trade is reproducibility: add a lockfile if you control your registry
and want installs pinned.

## What it does

| Screen | |
|---|---|
| `/` | Order form. Picks a store, captures a structured dropoff address and a basket, quotes before checkout, then takes payment and dispatches. |
| `/orders` | The order book. |
| `/orders/[orderNumber]` | Live tracking: a five-stop transit board, courier card, cancel, and refund submission. |

| Endpoint | |
|---|---|
| `POST /api/quote` | Create Quote. Persists the order draft with the exact address string that was quoted. |
| `POST /api/deliveries` | Captures payment, then Create Delivery with the stored `quote_id`. |
| `GET /api/deliveries/[orderNumber]` | Get Delivery — the tracking poll. |
| `POST /api/deliveries/[orderNumber]/cancel` | Cancel Delivery with a reason, stage-gated. |
| `POST /api/refunds` | Refund Submission, amount converted to e5. |
| `POST /api/webhooks/uber` | Signed webhook receiver. |

## Layout

```
src/lib/uber/
  types.ts         The API surface, typed
  auth.ts          OAuth token + 30-day cache
  client.ts        fetch wrapper: bearer auth, error mapping, retry policy
  live.ts          The real client
  mock.ts          The simulated client, same interface
  windows.ts       Delivery-window timestamp derivation
  verification.ts  Proof-of-delivery selection
  money.ts         Cents formatting, and the one e5 conversion
  webhook.ts       HMAC-SHA256 signature verification
src/lib/
  address.ts       Address normalisation, serialised exactly once per order
  orders.ts        Quote -> pay -> dispatch, and the rules that gate it
  store.ts         Local order records (file-backed JSON, no database)
  stores.ts        The pickup store catalogue
```

## Configuration

Copy `.env.example` to `.env.local`.

| Variable | |
|---|---|
| `UBER_CLIENT_ID` / `UBER_CLIENT_SECRET` | OAuth credentials. Constant across your whole account. |
| `UBER_CUSTOMER_ID` | Your org UUID — the `{customer_id}` path param. A sub-org's `organization_id` goes here too. |
| `UBER_WEBHOOK_SIGNING_KEY` | From the Dashboard. Each webhook has its own key. |
| `UBER_REFUND_WEBHOOK_SIGNING_KEY` | Optional; falls back to the above. |
| `UBER_MOCK` | `true` to simulate. Unset falls back to mock when credentials are missing. |

There is no separate sandbox hostname — everything goes to `https://api.uber.com/v1`, and
sandbox vs production is decided by which credentials you use.

## Pre-launch checklist

The checklist from the API reference, and where each item is handled.

- [x] **Structured addresses used consistently in Create Quote and Create Delivery, unit numbers
      in the address rather than notes** — `address.ts` normalises once and `serializeAddress`
      runs once per order; the resulting string is stored on the order record and reused
      verbatim at Create Delivery time (`store.ts`, `dropoffAddressJson`). Re-serialising from
      the form for the second call is what produces `delivery_location_changed`.
- [x] **`external_store_id` identical across Create Quote, Create Delivery, and Find Stores** —
      defined once per store in `stores.ts` and read from there by both calls.
- [x] **Correct `quote_id` attached; re-quoted rather than reused when ASAP/Scheduled or the
      pickup address changes** — `orders.ts` attaches the stored quote and rejects an expired
      one; the form tracks the quote inputs and drops the quote when any of them change.
- [x] **Payment processed before Create Delivery** — `capturePayment` runs first in `placeOrder`,
      and a failure there means no delivery is created.
- [x] **Delivery-window timestamps match the real customer promise** — `windows.ts`. ASAP sends
      `pickup_ready_dt` alone; scheduled food sends `pickup_ready_dt` alone, derived as promised
      dropoff minus `(duration - pickup_duration)` from a fresh quote; scheduled retail sends
      all four. Under 90 minutes of lead time is sent as ASAP with a note.
- [x] **POD matched to the vertical, never stacked** — `verification.ts` returns exactly one
      type: photo for leave-at-door, ID for age-restricted, pincode for high-risk, signature for
      retail/pharmacy/liquor, nothing extra for food.
- [x] **`undeliverable_action` not left at the `return` default for perishables** —
      `defaultUndeliverableAction` in `stores.ts` returns `discard` for restaurant, grocery,
      specialty food, and flowers.
- [x] **Real dimensions and weight rather than defaulted sizing** — the basket rows require
      length, height, depth, and per-item weight; `size` is never sent.
- [x] **`merchant_type` set accurately per store** — `stores.ts`.
- [x] **Webhook consumer treats Get Delivery as source of truth and refunds as non-incremental** —
      the webhook route re-fetches rather than trusting the payload, and refund values replace
      rather than accumulate. The tracking page polls Get Delivery too.
- [x] **No retry logic on 4xx** — `client.ts` retries 408 and 5xx only. 429 is surfaced, not
      hammered.
- [ ] **Sandbox testing done against a centralized-billing org** — your account setup, not the
      app's. A decentralized sandbox org has no default billing policy.
- [ ] **Sub-orgs: parent confirmed as root, decentralized billing set up with Uber first** — not
      used here; this app targets a single `customer_id`.
- [ ] **Courier Pick & Pack: SKUs registered, `replacement_type` set per item** — not
      implemented. See below.

## Notes on specific decisions

**Token caching.** The token lives 30 days and the token endpoint allows 100 requests/hour, so
`auth.ts` caches at module scope and shares one in-flight fetch between concurrent callers.
Fetching per request would exhaust the limit almost immediately.

**Retries.** Only 408 and 5xx are retried, with exponential backoff. A 4xx means the request
itself is wrong and will fail identically on a resend, while still consuming rate-limit budget.

**Webhook signatures.** The route reads `await req.text()` and verifies the raw bytes. Parsing
and re-serialising would emit literal characters where the wire body had `\uXXXX` escapes,
producing a different digest — there is a test covering exactly that. `x-postmates-signature` is
accepted for delivery-status and courier-update, but the refund webhook requires
`x-uber-signature`.

**The e5 refund amount.** `total_refund_amount.amount` is the only field in the platform that
isn't cents. `centsToE5` is named for the format rather than for "refund" so the unit change is
visible at the call site, and it is deliberately not the same helper used for display.

**Robocourier.** Sandbox only. In mock mode it compresses the lifecycle to ~2.5 minutes, matching
the documented auto-mode timings. Against real credentials the app refuses to send
`test_specifications` unless `UBER_ALLOW_ROBOCOURIER=true` is set.

## Not implemented

- **Courier Pick & Pack** — needs a business agreement and Catalog/INCA SKU registration, so it
  isn't self-serve. The types leave room for `pickup_action`, `replacement_type`, `sku`, and
  `weight_v2`.
- **Organizations API and Business Location Management** — a different scope
  (`direct.organizations`) and a different base path. This app targets one `customer_id`.
- **Tips** — `tip` is typed and sent when present, but there is no UI for adding or increasing one.
- **Real payments** — `capturePayment` is a stub standing in for a PSP. The ordering it enforces
  is the part that matters.
- **Address autocomplete** — the reference recommends an autocomplete provider with a full
  dropdown, device geolocation, and an editable map pin. This uses plain structured fields, with
  the normalisation rules applied on submit.

Webhook endpoint URLs and signing keys are configured in the Direct Dashboard, not through the
API, so there is nothing to automate there.

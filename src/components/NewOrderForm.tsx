"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/uber/money";
import type { Quote } from "@/lib/uber/types";
import type { Store } from "@/lib/stores";

interface ItemDraft {
  key: string;
  name: string;
  quantity: string;
  priceDollars: string;
  weightGrams: string;
  length: string;
  height: string;
  depth: string;
}

interface Policy {
  undeliverableAction: string;
  podRationale: string;
  perishable: boolean;
}

interface QuoteResult {
  orderNumber: string;
  quote: Quote;
  windowNote?: string;
  policy: Policy;
}

const FOOD_MERCHANT_TYPES = ["MERCHANT_TYPE_RESTAURANT", "MERCHANT_TYPE_SPECIALTY_FOOD"];

function newItem(): ItemDraft {
  return {
    key: Math.random().toString(36).slice(2),
    name: "",
    quantity: "1",
    priceDollars: "",
    weightGrams: "",
    length: "",
    height: "",
    depth: "",
  };
}

/** datetime-local value for "n minutes from now", in the browser's timezone. */
function localDateTimeValue(minutesFromNow: number): string {
  const date = new Date(Date.now() + minutesFromNow * 60_000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function NewOrderForm({ stores, mock }: { stores: Store[]; mock: boolean }) {
  const router = useRouter();

  const [storeId, setStoreId] = useState(stores[0]?.externalStoreId ?? "");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");

  const [street, setStreet] = useState("");
  const [unit, setUnit] = useState("");
  const [city, setCity] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [dropoffNotes, setDropoffNotes] = useState("");

  const [items, setItems] = useState<ItemDraft[]>([newItem()]);

  const [scheduled, setScheduled] = useState(false);
  const [promisedAt, setPromisedAt] = useState(() => localDateTimeValue(150));

  const [leaveAtDoor, setLeaveAtDoor] = useState(false);
  const [ageRestricted, setAgeRestricted] = useState(false);
  const [highRisk, setHighRisk] = useState(false);
  const [roboCourier, setRoboCourier] = useState(mock);

  const [result, setResult] = useState<QuoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"quote" | "place" | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const store = useMemo(
    () => stores.find((candidate) => candidate.externalStoreId === storeId),
    [stores, storeId],
  );

  // Restaurants get the food-scheduling shape (pickup_ready_dt alone, worked
  // back from the quote); everything else gets the full four timestamps.
  const windowMode = !scheduled
    ? "asap"
    : store && FOOD_MERCHANT_TYPES.includes(store.merchantType)
      ? "scheduled_food"
      : "scheduled_retail";

  /**
   * Anything that changes what was quoted invalidates the quote. A quote is
   * tied to a specific pickup/dropoff pair and basket, and switching between
   * ASAP and Scheduled changes the shape of the request entirely — so both
   * force a re-quote rather than silently reusing the old quote_id.
   */
  const quoteInputs = JSON.stringify({
    storeId,
    street,
    unit,
    city,
    stateCode,
    zipCode,
    customerPhone,
    windowMode,
    promisedAt: scheduled ? promisedAt : null,
    items: items.map((item) => [item.name, item.quantity, item.priceDollars, item.weightGrams]),
  });
  const quotedInputs = useRef<string | null>(null);

  useEffect(() => {
    if (quotedInputs.current !== null && quotedInputs.current !== quoteInputs) {
      setResult(null);
      quotedInputs.current = null;
    }
  }, [quoteInputs]);

  // Drives the quote-expiry countdown.
  useEffect(() => {
    if (!result) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [result]);

  const expiresInMs = result ? new Date(result.quote.expires).getTime() - now : 0;
  const quoteExpired = Boolean(result) && expiresInMs <= 0;

  function updateItem(key: string, patch: Partial<ItemDraft>) {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }

  function buildPayload() {
    return {
      externalStoreId: storeId,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerEmail: customerEmail.trim() || undefined,
      dropoff: {
        street: street.trim(),
        unit: unit.trim() || undefined,
        city: city.trim(),
        state: stateCode.trim() || undefined,
        zipCode: zipCode.trim(),
        country: "US",
      },
      dropoffNotes: dropoffNotes.trim() || undefined,
      items: items.map((item) => ({
        name: item.name.trim(),
        quantity: Number(item.quantity || 0),
        price: Math.round(Number(item.priceDollars || 0) * 100),
        weight: Number(item.weightGrams || 0),
        dimensions: {
          length: Number(item.length || 0),
          height: Number(item.height || 0),
          depth: Number(item.depth || 0),
        },
      })),
      windowMode,
      promisedDropoffAt: scheduled ? new Date(promisedAt).toISOString() : undefined,
      leaveAtDoor,
      ageRestricted,
      highRisk,
      roboCourier,
    };
  }

  async function getQuote() {
    setBusy("quote");
    setError(null);
    try {
      const res = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();

      if (!res.ok) {
        const issue = data.issues?.[0];
        setError(issue ? `${issue.path?.join(".") ?? ""}: ${issue.message}` : data.error);
        setResult(null);
        return;
      }

      setResult(data);
      setNow(Date.now());
      quotedInputs.current = quoteInputs;
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function placeOrder() {
    if (!result) return;
    setBusy("place");
    setError(null);
    try {
      const res = await fetch("/api/deliveries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber: result.orderNumber }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Couldn't create the delivery.");
        return;
      }

      router.push(`/orders/${result.orderNumber}`);
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(null);
    }
  }

  const canQuote =
    Boolean(storeId && customerName && customerPhone && street && city && zipCode) &&
    items.every((item) => item.name && item.priceDollars && item.weightGrams && item.length && item.height && item.depth);

  return (
    <div className="layout">
      <div className="panel">
        <div className="panel-head">
          <span className="stencil">Dispatch slip</span>
          <span className="label">Quote first · pay · then dispatch</span>
        </div>

        <div className="panel-body">
          <div className="section-rule">
            <span className="label">01 — Pickup store</span>
          </div>

          <div className="store-grid">
            {stores.map((candidate) => (
              <button
                key={candidate.externalStoreId}
                type="button"
                className="store-card"
                data-selected={candidate.externalStoreId === storeId}
                onClick={() => setStoreId(candidate.externalStoreId)}
              >
                <strong>{candidate.name}</strong>
                <div className="tiny muted" style={{ marginTop: 3 }}>
                  {candidate.address.street_address[0]}, {candidate.address.city}
                </div>
                <div className="mono faint" style={{ fontSize: 10, marginTop: 7 }}>
                  {candidate.externalStoreId}
                </div>
              </button>
            ))}
          </div>

          <div className="section-rule">
            <span className="label">02 — Customer</span>
          </div>

          <div className="grid grid-3">
            <div className="field">
              <label className="label" htmlFor="name">Full name</label>
              <input
                id="name"
                type="text"
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                placeholder="Dana Okafor"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="phone">Phone (E.164)</label>
              <input
                id="phone"
                type="tel"
                value={customerPhone}
                onChange={(event) => setCustomerPhone(event.target.value)}
                placeholder="+14155550123"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="email">Email (optional)</label>
              <input
                id="email"
                type="email"
                value={customerEmail}
                onChange={(event) => setCustomerEmail(event.target.value)}
                placeholder="dana@example.com"
              />
            </div>
          </div>

          <p className="tiny faint" style={{ margin: "9px 0 0" }}>
            The courier only sees a first name and last initial, so the order number travels
            along as <code className="mono">manifest_reference</code> for the store handover.
          </p>

          <div className="section-rule">
            <span className="label">03 — Dropoff address</span>
          </div>

          <div className="grid" style={{ gridTemplateColumns: "minmax(0, 2.4fr) minmax(0, 1fr)" }}>
            <div className="field">
              <label className="label" htmlFor="street">Street address</label>
              <input
                id="street"
                type="text"
                value={street}
                onChange={(event) => setStreet(event.target.value)}
                placeholder="1515 3rd St"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="unit">Apt / unit</label>
              <input
                id="unit"
                type="text"
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                placeholder="5"
              />
            </div>
          </div>

          <div className="grid grid-3" style={{ marginTop: 12 }}>
            <div className="field">
              <label className="label" htmlFor="city">City</label>
              <input
                id="city"
                type="text"
                value={city}
                onChange={(event) => setCity(event.target.value)}
                placeholder="San Francisco"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="state">State / province</label>
              <input
                id="state"
                type="text"
                value={stateCode}
                onChange={(event) => setStateCode(event.target.value)}
                placeholder="CA"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="zip">Postcode</label>
              <input
                id="zip"
                type="text"
                value={zipCode}
                onChange={(event) => setZipCode(event.target.value)}
                placeholder="94158"
              />
            </div>
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label className="label" htmlFor="notes">Dropoff notes (280 max)</label>
            <textarea
              id="notes"
              maxLength={280}
              value={dropoffNotes}
              onChange={(event) => setDropoffNotes(event.target.value)}
              placeholder="Gate code 4471. Buzzer is on the left."
            />
          </div>

          <p className="tiny faint" style={{ margin: "9px 0 0" }}>
            The unit stays a separate line inside the structured address rather than being
            appended to the street or hidden in notes, where couriers miss it. A bare number
            gets a <code className="mono">Unit</code> prefix; a hyphenated house number is
            collapsed to one number; a blank state mirrors the city.
          </p>

          <div className="section-rule">
            <span className="label">04 — Basket</span>
          </div>

          <div className="stack" style={{ gap: 10 }}>
            <div className="item-row">
              <span className="label">Item</span>
              <span className="label">Qty</span>
              <span className="label">Price $</span>
              <span className="label">Weight g</span>
              <span className="label">L × H × D cm</span>
              <span />
            </div>

            {items.map((item) => (
              <div className="item-row" key={item.key}>
                <input
                  type="text"
                  value={item.name}
                  onChange={(event) => updateItem(item.key, { name: event.target.value })}
                  placeholder="Chicken katsu curry"
                />
                <input
                  type="number"
                  min="1"
                  value={item.quantity}
                  onChange={(event) => updateItem(item.key, { quantity: event.target.value })}
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={item.priceDollars}
                  onChange={(event) => updateItem(item.key, { priceDollars: event.target.value })}
                  placeholder="14.50"
                />
                <input
                  type="number"
                  min="1"
                  value={item.weightGrams}
                  onChange={(event) => updateItem(item.key, { weightGrams: event.target.value })}
                  placeholder="650"
                />
                <div className="dims">
                  <input
                    type="number"
                    min="1"
                    value={item.length}
                    onChange={(event) => updateItem(item.key, { length: event.target.value })}
                    placeholder="L"
                  />
                  <input
                    type="number"
                    min="1"
                    value={item.height}
                    onChange={(event) => updateItem(item.key, { height: event.target.value })}
                    placeholder="H"
                  />
                  <input
                    type="number"
                    min="1"
                    value={item.depth}
                    onChange={(event) => updateItem(item.key, { depth: event.target.value })}
                    placeholder="D"
                  />
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${item.name || "item"}`}
                  disabled={items.length === 1}
                  onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginTop: 12 }}
            onClick={() => setItems((current) => [...current, newItem()])}
          >
            + Add item
          </button>

          <p className="tiny faint" style={{ margin: "10px 0 0" }}>
            Real dimensions and weight, not T-shirt sizing: item size decides which vehicle
            classes are eligible for the job, and an unspecified size defaults to Small. Weight
            is per item, not multiplied by quantity.
          </p>

          <div className="section-rule">
            <span className="label">05 — Timing</span>
          </div>

          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className={`btn btn-sm ${!scheduled ? "btn-primary" : ""}`}
              onClick={() => setScheduled(false)}
            >
              ASAP
            </button>
            <button
              type="button"
              className={`btn btn-sm ${scheduled ? "btn-primary" : ""}`}
              onClick={() => setScheduled(true)}
            >
              Scheduled
            </button>
            {scheduled && (
              <input
                type="datetime-local"
                value={promisedAt}
                min={localDateTimeValue(0)}
                onChange={(event) => setPromisedAt(event.target.value)}
                style={{ width: "auto", flex: "0 1 240px" }}
              />
            )}
          </div>

          <div className="notice" data-tone="info" style={{ marginTop: 12 }}>
            <span aria-hidden="true">→</span>
            <div>
              {windowMode === "asap" && (
                <>
                  Sends <code className="mono">pickup_ready_dt</code> alone
                  {store ? ` (+${store.prepMinutes} min prep)` : ""} and leaves the other three
                  blank. Dispatch starts about 25 minutes before that time, so extra lead time
                  costs nothing — but a scheduled-looking set of four timestamps on an ASAP
                  order raises cost and hurts on-time performance.
                </>
              )}
              {windowMode === "scheduled_food" && (
                <>
                  Restaurant order: sends <code className="mono">pickup_ready_dt</code> alone,
                  set to the promised dropoff minus the transit leg only
                  (<code className="mono">duration − pickup_duration</code>), re-derived from
                  this order&rsquo;s own quote.
                </>
              )}
              {windowMode === "scheduled_retail" && (
                <>
                  Retail/grocery order: sends all four timestamps. Sending fewer makes the
                  backend fill the gaps, which produces artificially tight windows.
                </>
              )}
            </div>
          </div>

          <div className="section-rule">
            <span className="label">06 — Handling</span>
          </div>

          <div className="grid grid-2">
            <label className="check">
              <input
                type="checkbox"
                checked={leaveAtDoor}
                onChange={(event) => setLeaveAtDoor(event.target.checked)}
              />
              <div>
                <strong>Leave at door</strong>
                <span>Switches proof of delivery to a photo — the only type that pairs safely with it.</span>
              </div>
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={ageRestricted}
                onChange={(event) => setAgeRestricted(event.target.checked)}
              />
              <div>
                <strong>Age-restricted</strong>
                <span>Requires an ID scan at the door, so it can&rsquo;t be left unattended.</span>
              </div>
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={highRisk}
                onChange={(event) => setHighRisk(event.target.checked)}
              />
              <div>
                <strong>High-risk order</strong>
                <span>Adds a pincode — strongest anti-fraud check, used on its own, never stacked.</span>
              </div>
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={roboCourier}
                onChange={(event) => setRoboCourier(event.target.checked)}
              />
              <div>
                <strong>Robocourier</strong>
                <span>Sandbox only. Runs the whole lifecycle in about 2.5 minutes.</span>
              </div>
            </label>
          </div>
        </div>
      </div>

      <div className="sticky stack" style={{ gap: 14 }}>
        {error && (
          <div className="notice" data-tone="error">
            <span aria-hidden="true">!</span>
            <div>{error}</div>
          </div>
        )}

        {!result && (
          <div className="panel">
            <div className="panel-head">
              <span className="stencil">Fare</span>
            </div>
            <div className="panel-body">
              <p className="tiny muted" style={{ margin: "0 0 16px" }}>
                Quote once the dropoff address is complete and before checkout, so the customer
                sees a real fee and ETA before committing. The quote holds for 15 minutes.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: "100%" }}
                disabled={!canQuote || busy !== null}
                onClick={getQuote}
              >
                {busy === "quote" ? <><span className="spin" /> Quoting</> : "Get quote"}
              </button>
              {!canQuote && (
                <p className="tiny faint" style={{ margin: "10px 0 0" }}>
                  Fill in the store, customer, address, and every item field first.
                </p>
              )}
            </div>
          </div>
        )}

        {result && (
          <div className="docket fade-in">
            <div className="panel-body">
              <div className="spread" style={{ marginBottom: 14 }}>
                <span className="stencil">Quoted</span>
                <span className="mono faint" style={{ fontSize: 10 }}>
                  {result.orderNumber}
                </span>
              </div>

              <div className="fare">
                <span className="amount">
                  {formatCents(result.quote.fee, result.quote.currency)}
                </span>
                <span className="label">delivery fee</span>
              </div>

              <dl style={{ margin: "16px 0 0" }}>
                <div className="readout">
                  <dt>Dropoff ETA</dt>
                  <dd>
                    {new Date(result.quote.dropoff_eta).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </dd>
                </div>
                <div className="readout">
                  <dt>Total duration</dt>
                  <dd>{result.quote.duration} min</dd>
                </div>
                <div className="readout">
                  <dt>To store</dt>
                  <dd>{result.quote.pickup_duration} min</dd>
                </div>
                <div className="readout">
                  <dt>Transit leg</dt>
                  <dd>{result.quote.duration - result.quote.pickup_duration} min</dd>
                </div>
                <div className="readout">
                  <dt>Quote holds</dt>
                  <dd style={{ color: quoteExpired ? "var(--signal-stop)" : undefined }}>
                    {quoteExpired
                      ? "Expired"
                      : `${Math.floor(expiresInMs / 60000)}:${String(
                          Math.floor((expiresInMs % 60000) / 1000),
                        ).padStart(2, "0")}`}
                  </dd>
                </div>
              </dl>

              <div className="perf" />

              <div className="stack" style={{ gap: 8 }}>
                <div>
                  <span className="label">Proof of delivery</span>
                  <p className="tiny muted" style={{ margin: "3px 0 0" }}>
                    {result.policy.podRationale}
                  </p>
                </div>
                <div>
                  <span className="label">If undeliverable</span>
                  <p className="tiny muted" style={{ margin: "3px 0 0" }}>
                    <code className="mono">{result.policy.undeliverableAction}</code>
                    {result.policy.perishable
                      ? " — set explicitly, since returned perishables can't be resold."
                      : " — resellable goods come back to the store."}
                  </p>
                </div>
              </div>

              {result.windowNote && (
                <div className="notice" data-tone="warn" style={{ marginTop: 14 }}>
                  <span aria-hidden="true">!</span>
                  <div>{result.windowNote}</div>
                </div>
              )}

              <div className="stack" style={{ gap: 8, marginTop: 18 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy !== null || quoteExpired}
                  onClick={placeOrder}
                >
                  {busy === "place" ? (
                    <><span className="spin" /> Dispatching</>
                  ) : (
                    "Take payment & dispatch"
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy !== null}
                  onClick={getQuote}
                >
                  Re-quote
                </button>
              </div>

              <p className="tiny faint" style={{ margin: "12px 0 0" }}>
                Payment is captured before the delivery is created, so a failed payment can
                never leave a live courier job behind it.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

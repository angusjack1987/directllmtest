"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { StatusChip } from "@/components/StatusChip";
import { formatCents } from "@/lib/uber/money";
import type { CancellationReason, Delivery, DeliveryStatus } from "@/lib/uber/types";
import type { OrderRecord } from "@/lib/store";
import type { Store } from "@/lib/stores";

/**
 * The customer-facing touchpoints, mirroring Uber's own default set: order
 * created, courier enroute, courier arriving, delivered/failed — sourced from
 * `status`, `courier_imminent`, and `dropoff_eta` respectively.
 */
const STOPS: Array<{ name: string; statuses: DeliveryStatus[] }> = [
  { name: "Received", statuses: ["pending"] },
  { name: "To store", statuses: ["pickup"] },
  { name: "Picked up", statuses: ["pickup_complete"] },
  { name: "On the way", statuses: ["dropoff"] },
  { name: "Delivered", statuses: ["delivered"] },
];

const CANCEL_REASONS: Array<{ value: CancellationReason; label: string }> = [
  { value: "customer_called_to_cancel", label: "Customer called to cancel" },
  { value: "out_of_items", label: "Out of items" },
  { value: "store_closed", label: "Store closed" },
  { value: "store_too_busy", label: "Store too busy" },
  { value: "courier_delayed_en_route_to_pickup", label: "Courier delayed to pickup" },
  { value: "too_expensive", label: "Too expensive" },
  { value: "delivery_vehicle_too_small", label: "Vehicle too small" },
  { value: "no_courier_assigned", label: "No courier assigned" },
  { value: "other", label: "Other" },
];

const REFUND_REASONS = [
  { value: "uber_never_received_order", label: "Never received the order" },
  { value: "uber_missing_items", label: "Missing items" },
  { value: "uber_damaged_item", label: "Damaged item" },
  { value: "uber_entire_order_wrong", label: "Entire order wrong" },
  { value: "uber_order_delivered_late", label: "Delivered late" },
  { value: "uber_delayed_pick_up", label: "Delayed pickup" },
  { value: "uber_never_pick_up", label: "Never picked up" },
  { value: "uber_courier_cancelled", label: "Courier cancelled" },
  { value: "uber_safety_issue", label: "Safety issue" },
  { value: "uber_return_trip_issue", label: "Return trip issue" },
] as const;

function stopState(index: number, delivery: Delivery | null): "todo" | "active" | "done" | "failed" {
  if (!delivery) return index === 0 ? "active" : "todo";

  if (delivery.status === "canceled" || delivery.status === "returned") {
    return index === 0 ? "done" : index === 1 ? "failed" : "todo";
  }

  const currentIndex = STOPS.findIndex((stop) => stop.statuses.includes(delivery.status));
  if (currentIndex === -1) return "todo";
  if (index < currentIndex) return "done";
  if (index === currentIndex) return delivery.status === "delivered" ? "done" : "active";
  return "todo";
}

function timeOf(value?: string): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function TrackingView({
  initialOrder,
  initialDelivery,
  store,
}: {
  initialOrder: OrderRecord;
  initialDelivery: Delivery | null;
  store?: Store;
}) {
  const [order, setOrder] = useState(initialOrder);
  const [delivery, setDelivery] = useState(initialDelivery);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [cancelReason, setCancelReason] = useState<CancellationReason>("customer_called_to_cancel");
  const [showRefund, setShowRefund] = useState(false);
  const [refundReason, setRefundReason] = useState<string>("uber_missing_items");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundEmail, setRefundEmail] = useState("");
  const [refundNotes, setRefundNotes] = useState("");
  const [refundResult, setRefundResult] = useState<string | null>(null);

  /**
   * Poll Get Delivery rather than relying on webhooks alone. Get Delivery is
   * the authoritative source of truth — a support-side change to a delivery may
   * never appear in a webhook — so the page reconciles against it every tick.
   */
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/deliveries/${order.orderNumber}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setOrder(data.order);
      setDelivery(data.delivery);
    } catch {
      // A dropped poll is not worth surfacing; the next tick will catch up.
    }
  }, [order.orderNumber]);

  useEffect(() => {
    if (delivery?.complete) return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh, delivery?.complete]);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/deliveries/${order.orderNumber}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: cancelReason }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't cancel.");
        return;
      }
      setOrder(data.order);
      setDelivery(data.delivery);
    } finally {
      setBusy(false);
    }
  }

  async function submitRefund() {
    setBusy(true);
    setError(null);
    setRefundResult(null);
    try {
      const res = await fetch("/api/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderNumber: order.orderNumber,
          reason: refundReason,
          amountDollars: Number(refundAmount),
          requesterEmail: refundEmail,
          notes: refundNotes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't submit the refund.");
        return;
      }
      setRefundResult(
        `Submitted ${formatCents(data.submittedAmountCents)} — sent as ${
          data.submittedAmountCents * 1000
        } in e5 format.`,
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  // Cancelling after pickup doesn't stop the delivery — it auto-fails it and
  // triggers the undeliverable action — so the control disappears at that point.
  const cancellable =
    delivery !== null && ["pending", "pickup"].includes(delivery.status) && !delivery.complete;

  const refundable = delivery !== null && delivery.complete && !order.refundSubmittedAt;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="spread" style={{ flexWrap: "wrap" }}>
        <div className="row" style={{ gap: 14 }}>
          <h2 className="mono" style={{ fontSize: 22, color: "var(--amber)" }}>
            {order.orderNumber}
          </h2>
          <StatusChip status={delivery?.status} imminent={delivery?.courier_imminent} />
          {delivery && !delivery.complete && (
            <span className="label row" style={{ gap: 6 }}>
              <span className="pulse" style={{ background: "var(--signal-go)" }} /> live
            </span>
          )}
        </div>
        <Link className="btn btn-ghost btn-sm" href="/orders">
          ← All orders
        </Link>
      </div>

      <div className="board">
        {STOPS.map((stop, index) => {
          const state = stopState(index, delivery);
          const imminent = delivery?.courier_imminent && state === "active";
          return (
            <div className="stop" key={stop.name} data-state={state}>
              <span className="idx">{String(index + 1).padStart(2, "0")}</span>
              <span className="name">{state === "failed" ? "Stopped" : stop.name}</span>
              <span className="when">
                {state === "active" && imminent
                  ? "~1 min away"
                  : state === "active"
                    ? "In progress"
                    : state === "done"
                      ? "Done"
                      : "—"}
              </span>
            </div>
          );
        })}
      </div>

      {!delivery && (
        <div className="notice" data-tone="info">
          <span aria-hidden="true">→</span>
          <div>
            This order has been quoted but not dispatched — no delivery exists yet, so there is
            nothing to track. Its quote holds for 15 minutes from creation.
          </div>
        </div>
      )}

      {error && (
        <div className="notice" data-tone="error">
          <span aria-hidden="true">!</span>
          <div>{error}</div>
        </div>
      )}

      {refundResult && (
        <div className="notice" data-tone="warn">
          <span aria-hidden="true">✓</span>
          <div>{refundResult}</div>
        </div>
      )}

      <div className="layout">
        <div className="stack" style={{ gap: 20 }}>
          <div className="panel">
            <div className="panel-head">
              <span className="stencil">Trip</span>
              {delivery?.tracking_url && (
                <a
                  className="label"
                  href={delivery.tracking_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--amber)" }}
                >
                  Uber tracking ↗
                </a>
              )}
            </div>
            <div className="panel-body">
              <div className="grid grid-2">
                <div>
                  <span className="label">Pickup</span>
                  <p style={{ margin: "5px 0 0", fontSize: 14 }}>
                    {delivery?.pickup.name ?? store?.name ?? "—"}
                  </p>
                  <p className="tiny muted" style={{ margin: "2px 0 0" }}>
                    {(
                      delivery?.pickup.detailed_address ?? store?.address
                    )?.street_address.join(", ") ?? ""}
                  </p>
                </div>
                <div>
                  <span className="label">Dropoff</span>
                  <p style={{ margin: "5px 0 0", fontSize: 14 }}>{order.customerName}</p>
                  <p className="tiny muted" style={{ margin: "2px 0 0" }}>
                    {order.dropoffAddress.street_address.join(", ")}, {order.dropoffAddress.city}
                  </p>
                </div>
              </div>

              <div className="perf" />

              <dl style={{ margin: 0 }}>
                <div className="readout">
                  <dt>Dropoff ETA</dt>
                  <dd>{timeOf(delivery?.dropoff_eta)}</dd>
                </div>
                <div className="readout">
                  <dt>Delivery fee</dt>
                  <dd>{delivery ? formatCents(delivery.fee, delivery.currency) : "—"}</dd>
                </div>
                <div className="readout">
                  <dt>Basket</dt>
                  <dd>{formatCents(order.manifestTotalValue)}</dd>
                </div>
                <div className="readout">
                  <dt>Payment</dt>
                  <dd>{order.paymentStatus}</dd>
                </div>
                <div className="readout">
                  <dt>Delivery ID</dt>
                  <dd style={{ fontSize: 10.5 }}>{delivery?.id ?? "—"}</dd>
                </div>
                {delivery?.dropoff_identifier && (
                  <div className="readout">
                    <dt>Dropoff code</dt>
                    <dd>{delivery.dropoff_identifier}</dd>
                  </div>
                )}
              </dl>

              {delivery?.related_deliveries?.length ? (
                <div className="notice" data-tone="warn" style={{ marginTop: 14 }}>
                  <span aria-hidden="true">↩</span>
                  <div>
                    A return leg was created for this order:{" "}
                    {delivery.related_deliveries.map((related) => (
                      <code className="mono" key={related.id}>
                        {related.id}
                      </code>
                    ))}
                    . Cancelling a delivery whose undeliverable action is{" "}
                    <code className="mono">return</code> auto-creates one.
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="stencil">Manifest</span>
              <span className="label">ref {order.orderNumber}</span>
            </div>
            <div className="panel-body">
              <dl style={{ margin: 0 }}>
                {order.items.map((item) => (
                  <div className="readout" key={item.name}>
                    <dt style={{ letterSpacing: "0.04em", textTransform: "none", fontSize: 12 }}>
                      {item.quantity} × {item.name}
                    </dt>
                    <dd>{formatCents((item.price ?? 0) * item.quantity)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>

        <div className="stack" style={{ gap: 20 }}>
          <div className="panel">
            <div className="panel-head">
              <span className="stencil">Courier</span>
            </div>
            <div className="panel-body">
              {delivery?.courier ? (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="spread">
                    <strong style={{ fontSize: 16 }}>{delivery.courier.name}</strong>
                    <span className="chip" data-tone="idle">
                      {delivery.courier.vehicle_type}
                    </span>
                  </div>
                  <dl style={{ margin: 0 }}>
                    {delivery.courier.public_phone_info?.phone_number && (
                      <div className="readout">
                        <dt>Contact</dt>
                        <dd>
                          {delivery.courier.public_phone_info.phone_number}
                          {delivery.courier.public_phone_info.pin
                            ? ` · ${delivery.courier.public_phone_info.pin}`
                            : ""}
                        </dd>
                      </div>
                    )}
                    {delivery.vehicle_license_plate && (
                      <div className="readout">
                        <dt>Plate</dt>
                        <dd>{delivery.vehicle_license_plate}</dd>
                      </div>
                    )}
                    {delivery.courier.location && (
                      <div className="readout">
                        <dt>Position</dt>
                        <dd>
                          {delivery.courier.location.lat.toFixed(4)},{" "}
                          {delivery.courier.location.lng.toFixed(4)}
                        </dd>
                      </div>
                    )}
                  </dl>
                  <p className="tiny faint" style={{ margin: 0 }}>
                    The masked contact number is reissued on each courier assignment, so it is
                    re-read on every new <code className="mono">pickup</code> event.
                  </p>
                </div>
              ) : (
                <p className="tiny muted" style={{ margin: 0 }}>
                  No courier assigned yet.
                </p>
              )}
            </div>
          </div>

          {cancellable && (
            <div className="panel">
              <div className="panel-head">
                <span className="stencil">Cancel</span>
              </div>
              <div className="panel-body stack" style={{ gap: 10 }}>
                <p className="tiny muted" style={{ margin: 0 }}>
                  Cancellations are cost-bearing and get more expensive once a courier is
                  allocated. After pickup this control disappears — cancelling then auto-fails
                  the delivery instead of stopping it.
                </p>
                <select
                  value={cancelReason}
                  onChange={(event) => setCancelReason(event.target.value as CancellationReason)}
                >
                  {CANCEL_REASONS.map((reason) => (
                    <option key={reason.value} value={reason.value}>
                      {reason.label}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={cancel}>
                  Cancel delivery
                </button>
              </div>
            </div>
          )}

          {refundable && (
            <div className="panel">
              <div className="panel-head">
                <span className="stencil">Refund</span>
                {!showRefund && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setShowRefund(true)}
                  >
                    Open
                  </button>
                )}
              </div>
              {showRefund && (
                <div className="panel-body stack" style={{ gap: 10 }}>
                  <select
                    value={refundReason}
                    onChange={(event) => setRefundReason(event.target.value)}
                  >
                    {REFUND_REASONS.map((reason) => (
                      <option key={reason.value} value={reason.value}>
                        {reason.label}
                      </option>
                    ))}
                  </select>
                  <div className="field">
                    <label className="label" htmlFor="refund-amount">Amount ($)</label>
                    <input
                      id="refund-amount"
                      type="number"
                      min="0"
                      step="0.01"
                      value={refundAmount}
                      onChange={(event) => setRefundAmount(event.target.value)}
                      placeholder="10.99"
                    />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="refund-email">Monitored inbox</label>
                    <input
                      id="refund-email"
                      type="email"
                      value={refundEmail}
                      onChange={(event) => setRefundEmail(event.target.value)}
                      placeholder="support@example.com"
                    />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="refund-notes">Notes</label>
                    <textarea
                      id="refund-notes"
                      value={refundNotes}
                      onChange={(event) => setRefundNotes(event.target.value)}
                      placeholder="Two items missing from the bag."
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || !refundAmount || !refundEmail}
                    onClick={submitRefund}
                  >
                    Submit refund
                  </button>
                  <p className="tiny faint" style={{ margin: 0 }}>
                    The amount is converted to e5 (1/100,000 of a dollar) for this endpoint —
                    the one field in the platform that isn&rsquo;t cents. Refund updates go to
                    the inbox above, so it needs to be a real one.
                  </p>
                </div>
              )}
            </div>
          )}

          {order.refundSubmittedAt && (
            <div className="notice" data-tone="info">
              <span aria-hidden="true">✓</span>
              <div>
                Refund submitted {new Date(order.refundSubmittedAt).toLocaleString()}. A second
                submission would come back <code>ALREADY_EXISTS</code>, which is a signal to
                stop rather than retry.
              </div>
            </div>
          )}

          {delivery?.refund && (
            <div className="panel">
              <div className="panel-head">
                <span className="stencil">Refund on file</span>
              </div>
              <div className="panel-body">
                <dl style={{ margin: 0 }}>
                  <div className="readout">
                    <dt>Uber refund</dt>
                    <dd>{formatCents(delivery.refund.total_uber_refund ?? 0)}</dd>
                  </div>
                  <div className="readout">
                    <dt>Partner refund</dt>
                    <dd>{formatCents(delivery.refund.total_partner_refund ?? 0)}</dd>
                  </div>
                </dl>
                <p className="tiny faint" style={{ margin: "10px 0 0" }}>
                  Read from the embedded <code className="mono">refund</code> on Get Delivery.
                  Corrections arrive as a new full value, never a delta, so this replaces rather
                  than accumulates.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

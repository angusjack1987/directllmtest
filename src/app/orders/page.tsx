import Link from "next/link";
import { StatusChip } from "@/components/StatusChip";
import { listOrders } from "@/lib/store";
import { getStore } from "@/lib/stores";
import { formatCents } from "@/lib/uber/money";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const orders = await listOrders();

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="stencil">Order book</span>
        <span className="label">{orders.length} order{orders.length === 1 ? "" : "s"}</span>
      </div>

      {orders.length === 0 ? (
        <div className="panel-body">
          <p className="muted" style={{ margin: 0 }}>
            Nothing dispatched yet. <Link href="/">Place an order</Link> to get started.
          </p>
        </div>
      ) : (
        <div>
          {orders.map((order) => {
            const store = getStore(order.externalStoreId);
            return (
              <Link className="order-row" key={order.orderNumber} href={`/orders/${order.orderNumber}`}>
                <span className="mono" style={{ fontSize: 12, color: "var(--amber)" }}>
                  {order.orderNumber}
                </span>

                <span className="stack" style={{ gap: 2 }}>
                  <strong style={{ fontSize: 14 }}>{order.customerName}</strong>
                  <span className="tiny faint">
                    {store?.name ?? order.externalStoreId} → {order.dropoffAddress.street_address[0]},{" "}
                    {order.dropoffAddress.city}
                  </span>
                </span>

                <StatusChip status={order.lastStatus} />

                <span className="mono tiny" style={{ textAlign: "right" }}>
                  {order.lastFee !== undefined
                    ? formatCents(order.lastFee, order.quote?.currency)
                    : order.quote
                      ? formatCents(order.quote.fee, order.quote.currency)
                      : "—"}
                </span>

                <span className="mono tiny faint" style={{ textAlign: "right" }}>
                  {new Date(order.createdAt).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

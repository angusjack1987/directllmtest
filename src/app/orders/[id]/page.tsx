import Link from "next/link";
import { notFound } from "next/navigation";
import { TrackingView } from "@/components/TrackingView";
import { getOrder, syncOrderFromDelivery } from "@/lib/store";
import { getStore } from "@/lib/stores";
import { getUberClient } from "@/lib/uber";
import type { Delivery } from "@/lib/uber/types";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const order = await getOrder(id);
  if (!order) notFound();

  let delivery: Delivery | null = null;
  let loadError: string | null = null;

  if (order.deliveryId) {
    try {
      // Get Delivery is the source of truth, so the first paint comes from it
      // rather than from the local snapshot.
      delivery = await getUberClient().getDelivery(order.deliveryId);
      await syncOrderFromDelivery(order.orderNumber, delivery);
    } catch (error) {
      loadError = error instanceof Error ? error.message : "Couldn't load the delivery.";
    }
  }

  if (loadError) {
    return (
      <div className="stack" style={{ gap: 16 }}>
        <div className="notice" data-tone="error">
          <span aria-hidden="true">!</span>
          <div>{loadError}</div>
        </div>
        <Link className="btn btn-ghost btn-sm" href="/orders" style={{ alignSelf: "flex-start" }}>
          ← All orders
        </Link>
      </div>
    );
  }

  return (
    <TrackingView
      initialOrder={order}
      initialDelivery={delivery}
      store={getStore(order.externalStoreId)}
    />
  );
}

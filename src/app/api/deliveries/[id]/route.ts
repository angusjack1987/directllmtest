import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/orders";
import { getOrder, syncOrderFromDelivery } from "@/lib/store";
import { getUberClient } from "@/lib/uber";

export const dynamic = "force-dynamic";

/**
 * Tracking poll.
 *
 * Reads through to Get Delivery every time rather than serving the local
 * snapshot: Get Delivery is the authoritative source of truth, including after
 * Uber support has intervened on a delivery, which webhooks may not reflect.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: orderNumber } = await context.params;

    const order = await getOrder(orderNumber);
    if (!order) {
      return NextResponse.json({ error: "Unknown order.", code: "order_not_found" }, { status: 404 });
    }
    if (!order.deliveryId) {
      return NextResponse.json({ order, delivery: null });
    }

    const delivery = await getUberClient().getDelivery(order.deliveryId);
    const synced = await syncOrderFromDelivery(orderNumber, delivery);

    return NextResponse.json({ order: synced ?? order, delivery });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/orders";
import { getOrder, syncOrderFromDelivery } from "@/lib/store";
import { getUberClient } from "@/lib/uber";
import { cancelSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: orderNumber } = await context.params;

    const parsed = cancelSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "A cancellation reason is required.", code: "invalid_params" },
        { status: 400 },
      );
    }

    const order = await getOrder(orderNumber);
    if (!order?.deliveryId) {
      return NextResponse.json({ error: "Unknown order.", code: "order_not_found" }, { status: 404 });
    }

    const client = getUberClient();

    // Re-check the live stage first. Cancellations are cost-bearing and
    // stage-dependent, and cancelling after pickup auto-fails the delivery and
    // triggers the undeliverable_action instead of stopping it.
    const current = await client.getDelivery(order.deliveryId);
    if (["pickup_complete", "dropoff", "delivered", "returned", "canceled"].includes(current.status)) {
      return NextResponse.json(
        {
          error: `This order is already at "${current.status}" and can't be cancelled. Submit a refund instead.`,
          code: "noncancelable_delivery",
          retryable: false,
        },
        { status: 409 },
      );
    }

    const delivery = await client.cancelDelivery(order.deliveryId, parsed.data.reason);
    const synced = await syncOrderFromDelivery(orderNumber, delivery);

    return NextResponse.json({ order: synced ?? order, delivery });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

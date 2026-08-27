import { NextResponse } from "next/server";
import { placeOrder, toErrorResponse } from "@/lib/orders";
import { listOrders } from "@/lib/store";
import { placeOrderSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** The order list. Rendered from local snapshots, not N Get Delivery calls. */
export async function GET() {
  return NextResponse.json({ orders: await listOrders() });
}

/** Capture payment, then create the delivery. */
export async function POST(request: Request) {
  try {
    const parsed = placeOrderSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "An order number is required.", code: "invalid_params" },
        { status: 400 },
      );
    }

    const { order, delivery, podRationale } = await placeOrder(parsed.data.orderNumber);
    return NextResponse.json({ orderNumber: order.orderNumber, delivery, podRationale });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

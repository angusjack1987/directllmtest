import { NextResponse } from "next/server";
import { quoteOrder, toErrorResponse } from "@/lib/orders";
import { describeOrderPolicy } from "@/lib/orders";
import { quoteRequestSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const parsed = quoteRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Check the order details.", code: "invalid_params", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const { order, quote, windowNote } = await quoteOrder(parsed.data);

    return NextResponse.json({
      orderNumber: order.orderNumber,
      quote,
      windowNote,
      policy: describeOrderPolicy(order),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

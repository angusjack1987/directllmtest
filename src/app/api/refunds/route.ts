import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/orders";
import { getOrder, patchOrder } from "@/lib/store";
import { getUberClient } from "@/lib/uber";
import { centsToE5, dollarsToCents } from "@/lib/uber/money";
import { refundSchema } from "@/lib/validation";
import type { RefundRequest } from "@/lib/uber/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const parsed = refundSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Check the refund details.", code: "invalid_params", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const input = parsed.data;

    const order = await getOrder(input.orderNumber);
    if (!order?.deliveryId) {
      return NextResponse.json({ error: "Unknown order.", code: "order_not_found" }, { status: 404 });
    }
    if (order.refundSubmittedAt) {
      return NextResponse.json(
        {
          error: "A refund has already been submitted for this order.",
          code: "ALREADY_EXISTS",
          retryable: false,
        },
        { status: 409 },
      );
    }

    const cents = dollarsToCents(input.amountDollars);
    if (order.lastFee !== undefined && cents > order.manifestTotalValue + order.lastFee) {
      return NextResponse.json(
        { error: "Refund exceeds the order total plus delivery fee.", code: "invalid_params" },
        { status: 400 },
      );
    }

    const refundRequest: RefundRequest = {
      delivery_id: order.deliveryId,
      requester_email_id: input.requesterEmail,
      refund_reason: input.reason,
      notes: input.notes,
      ...(input.reason === "uber_missing_items" && input.itemsMissing?.length
        ? { items_missing: input.itemsMissing }
        : {}),
      total_refund_amount: {
        // e5, NOT cents. $10.99 is 1099000 here. This is the one field in the
        // whole platform that doesn't use the cents format, so it gets its own
        // converter rather than reusing the cents helper.
        amount: centsToE5(cents),
        currency_code: (order.quote?.currency ?? "usd").toUpperCase(),
      },
    };

    const result = await getUberClient().submitRefund(refundRequest);

    if (result.code === "OK") {
      await patchOrder(order.orderNumber, {
        refundSubmittedAt: new Date().toISOString(),
        paymentStatus: "refunded",
      });
      return NextResponse.json({ result, submittedAmountCents: cents });
    }

    // ALREADY_EXISTS means stop, not retry.
    return NextResponse.json(
      { error: result.message ?? result.code, code: result.code, retryable: false },
      { status: result.code === "ALREADY_EXISTS" ? 409 : 400 },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

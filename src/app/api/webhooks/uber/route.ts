import { NextResponse } from "next/server";
import { getOrderByDeliveryId, patchOrder, syncOrderFromDelivery } from "@/lib/store";
import { getUberClient } from "@/lib/uber";
import { verifyWebhookSignature, type WebhookEnvelope } from "@/lib/uber/webhook";

export const dynamic = "force-dynamic";

function signingKeyFor(kind: string | undefined): string {
  const isRefund = kind === "event.refund_request" || kind === "dapi.refund_requested";
  if (isRefund && process.env.UBER_REFUND_WEBHOOK_SIGNING_KEY) {
    return process.env.UBER_REFUND_WEBHOOK_SIGNING_KEY;
  }
  return process.env.UBER_WEBHOOK_SIGNING_KEY ?? "";
}

export async function POST(request: Request) {
  // The RAW body, byte for byte. Never request.json() here: re-serialising a
  // parsed object mangles \uXXXX escapes and breaks signature verification.
  const rawBody = await request.text();

  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody) as WebhookEnvelope;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const verification = verifyWebhookSignature({
    rawBody,
    uberSignature: request.headers.get("x-uber-signature"),
    postmatesSignature: request.headers.get("x-postmates-signature"),
    kind: envelope.kind,
    signingKey: signingKeyFor(envelope.kind),
  });

  if (!verification.valid) {
    return NextResponse.json({ error: verification.reason }, { status: 401 });
  }

  try {
    await handleEvent(envelope);
  } catch (error) {
    // Reconciliation failed on our side. Returning 5xx asks Uber to retry
    // (+10s, then 30s/60s/120s backoff, 3 attempts total).
    console.error("[uber-webhook] handler failed", error);
    return new NextResponse(null, { status: 500 });
  }

  // 200 with an empty body stops the retry chain.
  return new NextResponse(null, { status: 200 });
}

async function handleEvent(envelope: WebhookEnvelope): Promise<void> {
  const deliveryId =
    envelope.delivery_id ??
    (typeof envelope.data?.id === "string" ? envelope.data.id : undefined);

  if (!deliveryId) return;

  const order = await getOrderByDeliveryId(deliveryId);
  if (!order) return;

  switch (envelope.kind) {
    case "event.delivery_status":
    case "event.courier_update": {
      // Don't trust the webhook payload as state. Re-fetch: Get Delivery is
      // authoritative, and a post-hoc support change may not appear in the
      // webhook at all.
      const delivery = await getUberClient().getDelivery(deliveryId);
      await syncOrderFromDelivery(order.orderNumber, delivery);
      return;
    }

    case "event.refund_request":
    case "dapi.refund_requested": {
      // Refund values are NOT incremental. A corrected amount arrives as a new
      // webhook carrying the full corrected value, so the latest one replaces
      // what we hold — never sum successive refund webhooks for one delivery.
      const delivery = await getUberClient().getDelivery(deliveryId);
      await syncOrderFromDelivery(order.orderNumber, delivery);
      if (delivery.refund) {
        await patchOrder(order.orderNumber, { paymentStatus: "refunded" });
      }
      return;
    }

    default:
      return;
  }
}

/**
 * The real Uber Direct client. Every method is a thin, typed wrapper over one
 * endpoint — no business logic here; that lives in windows.ts and the API routes.
 */

import { requireCustomerId, uberFetch } from "./client";
import type {
  CancellationReason,
  CreateDeliveryRequest,
  CreateQuoteRequest,
  Delivery,
  DeliveryFilter,
  Quote,
  RefundRequest,
  RefundResponse,
  UberDirectClient,
} from "./types";

export class LiveUberDirectClient implements UberDirectClient {
  readonly isMock = false;

  async createQuote(req: CreateQuoteRequest): Promise<Quote> {
    return uberFetch<Quote>({
      method: "POST",
      path: `/customers/${requireCustomerId()}/delivery_quotes`,
      body: req,
    });
  }

  async createDelivery(req: CreateDeliveryRequest): Promise<Delivery> {
    return uberFetch<Delivery>({
      method: "POST",
      path: `/customers/${requireCustomerId()}/deliveries`,
      body: req,
    });
  }

  /**
   * Get Delivery is the authoritative source of truth, including after Uber
   * support has intervened on a delivery. Reconcile against this rather than
   * trusting the last webhook received.
   */
  async getDelivery(deliveryId: string): Promise<Delivery> {
    return uberFetch<Delivery>({
      path: `/customers/${requireCustomerId()}/deliveries/${deliveryId}`,
    });
  }

  async listDeliveries(params: { filter?: DeliveryFilter; limit?: number } = {}): Promise<
    Delivery[]
  > {
    const res = await uberFetch<{ data?: Delivery[] } | Delivery[]>({
      path: `/customers/${requireCustomerId()}/deliveries`,
      query: { filter: params.filter, limit: params.limit },
    });
    return Array.isArray(res) ? res : (res.data ?? []);
  }

  /**
   * Cancellations are cost-bearing and stage-dependent. The caller is expected
   * to have checked the stage first — never cancel after pickup, since that
   * auto-fails the delivery and triggers the undeliverable_action.
   */
  async cancelDelivery(deliveryId: string, reason?: CancellationReason): Promise<Delivery> {
    return uberFetch<Delivery>({
      method: "POST",
      path: `/customers/${requireCustomerId()}/deliveries/${deliveryId}/cancel`,
      body: reason ? { cancellation_reason: reason } : {},
    });
  }

  /**
   * Note the path shape: /direct/{customer_id}/..., not /customers/{customer_id}/...
   * `total_refund_amount.amount` must already be in e5 — build it with centsToE5().
   */
  async submitRefund(req: RefundRequest): Promise<RefundResponse> {
    return uberFetch<RefundResponse>({
      method: "POST",
      path: `/direct/${requireCustomerId()}/submit_refund`,
      body: req,
    });
  }
}

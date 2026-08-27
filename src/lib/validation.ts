import { z } from "zod";

/** E.164. The API rejects anything else, so catch it before spending a call. */
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, "Use an E.164 phone number, e.g. +14155550123");

export const addressSchema = z.object({
  street: z.string().trim().min(1, "Street address is required"),
  unit: z.string().trim().optional(),
  city: z.string().trim().min(1, "City is required"),
  state: z.string().trim().optional(),
  zipCode: z.string().trim().min(1, "Postcode is required"),
  country: z.string().trim().length(2).optional(),
});

export const itemSchema = z.object({
  name: z.string().trim().min(1, "Item name is required"),
  quantity: z.number().int().positive(),
  /** cents */
  price: z.number().int().nonnegative(),
  /** grams, per item */
  weight: z.number().int().positive(),
  dimensions: z.object({
    length: z.number().positive(),
    height: z.number().positive(),
    depth: z.number().positive(),
  }),
});

export const quoteRequestSchema = z.object({
  externalStoreId: z.string().trim().min(1),
  customerName: z.string().trim().min(1, "Customer name is required"),
  customerPhone: phoneSchema,
  customerEmail: z.string().trim().email().optional().or(z.literal("")),
  dropoff: addressSchema,
  dropoffNotes: z.string().trim().max(280).optional(),
  items: z.array(itemSchema).min(1, "Add at least one item"),
  windowMode: z.enum(["asap", "scheduled_food", "scheduled_retail"]),
  /** ISO timestamp; required for both scheduled modes. */
  promisedDropoffAt: z.string().datetime({ offset: true }).optional(),
  leaveAtDoor: z.boolean().default(false),
  ageRestricted: z.boolean().default(false),
  highRisk: z.boolean().default(false),
  roboCourier: z.boolean().default(false),
});

export type QuoteRequestInput = z.infer<typeof quoteRequestSchema>;

export const placeOrderSchema = z.object({
  orderNumber: z.string().trim().min(1),
});

export const cancelSchema = z.object({
  reason: z.enum([
    "out_of_items",
    "store_closed",
    "customer_called_to_cancel",
    "store_too_busy",
    "courier_delayed_en_route_to_pickup",
    "too_expensive",
    "delivery_vehicle_too_small",
    "no_courier_assigned",
    "other",
  ]),
});

export const refundSchema = z.object({
  orderNumber: z.string().trim().min(1),
  reason: z.enum([
    "uber_never_received_order",
    "uber_entire_order_wrong",
    "uber_missing_items",
    "uber_damaged_item",
    "uber_order_delivered_late",
    "uber_delayed_pick_up",
    "uber_had_to_prepare_order_again",
    "uber_never_pick_up",
    "uber_courier_cancelled",
    "uber_safety_issue",
    "uber_return_trip_issue",
  ]),
  /** Entered by the operator in dollars; converted to cents, then to e5. */
  amountDollars: z.number().positive(),
  requesterEmail: z.string().trim().email("Refund updates need a real, monitored inbox"),
  notes: z.string().trim().max(2000).optional(),
  itemsMissing: z.array(z.string().trim().min(1)).optional(),
});

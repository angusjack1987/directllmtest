import type { DeliveryStatus } from "@/lib/uber/types";

const TONES: Record<DeliveryStatus, { tone: string; label: string }> = {
  pending: { tone: "hold", label: "Finding courier" },
  pickup: { tone: "move", label: "To the store" },
  pickup_complete: { tone: "move", label: "Picked up" },
  dropoff: { tone: "move", label: "On the way" },
  delivered: { tone: "go", label: "Delivered" },
  canceled: { tone: "stop", label: "Cancelled" },
  returned: { tone: "stop", label: "Returned" },
  shopping_completed: { tone: "hold", label: "Shopping done" },
};

export function StatusChip({
  status,
  imminent,
}: {
  status?: DeliveryStatus;
  imminent?: boolean;
}) {
  if (!status) {
    return (
      <span className="chip" data-tone="idle">
        Not dispatched
      </span>
    );
  }

  const { tone, label } = TONES[status] ?? { tone: "idle", label: status };

  // courier_imminent means ~80m out, about a minute. Worth its own wording:
  // it's the moment the customer should be told to look out for the courier.
  const display = imminent && (status === "pickup" || status === "dropoff") ? "Arriving now" : label;

  return (
    <span className="chip" data-tone={imminent ? "move" : tone}>
      {display}
    </span>
  );
}

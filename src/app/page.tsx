import { NewOrderForm } from "@/components/NewOrderForm";
import { STORES } from "@/lib/stores";
import { isMockMode } from "@/lib/uber";

export const dynamic = "force-dynamic";

export default function NewOrderPage() {
  return <NewOrderForm stores={STORES} mock={isMockMode()} />;
}

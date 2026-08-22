import type { ModelOption } from "@/state/store";

export function modelSelectable(option: ModelOption): boolean {
  return option.selectable !== false;
}

export function modelReadinessLabel(option: ModelOption): string | undefined {
  if (!option.status) return option.loaded ? "Loaded" : undefined;
  if (option.status.busy) return "Busy";
  if (option.status.admitted) return "Ready";
  if (option.status.verified) return "Not admitted";
  if (option.status.reachable) return "Not verified";
  if (option.status.configured) return "Unreachable";
  return "Not configured";
}

export function modelCostLabel(option: ModelOption): string | undefined {
  switch (option.costClass) {
    case "free": return "Free";
    case "paid": return "Paid";
    case "paid_subscription": return "Subscription";
    case "paid_metered": return "Metered";
    case "local": return "Local";
    case "unknown": return "Cost unknown";
    default: return undefined;
  }
}

export function modelMetadata(option: ModelOption): string[] {
  return [
    option.canonicalId,
    modelCostLabel(option),
    option.host,
    modelReadinessLabel(option),
    option.manualOnly ? "Manual" : undefined,
  ].filter((part): part is string => Boolean(part));
}

export function modelSearchText(option: ModelOption): string {
  return [
    option.id,
    option.canonicalId,
    option.label,
    option.provider,
    option.host,
    option.costClass,
    option.reason,
    option.manualOnly ? "manual" : undefined,
    ...(option.capabilities ?? []),
  ].filter(Boolean).join(" ").toLowerCase();
}

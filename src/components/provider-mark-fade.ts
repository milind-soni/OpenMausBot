import type { InstanceInfo } from "@/state/store";

export type ProviderMarkTone = "brand" | "mono";

const BRAND_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "mistral", "meta", "museCode", "kimiAgent", "qwenAgent", "deepseekAgent"]);
const MONO_PRESETS: ReadonlySet<string> = new Set(["openai", "xai"]);

export function providerMarkTone(instance: Pick<InstanceInfo, "driverKind" | "icon">): ProviderMarkTone {
  if (instance.icon?.kind === "custom") return "brand";
  if (instance.icon?.kind === "preset") return MONO_PRESETS.has(instance.icon.preset) ? "mono" : "brand";
  return BRAND_DRIVERS.has(instance.driverKind) ? "brand" : "mono";
}

// A focused row lifts the mark like a hovered one. A touch screen has no hover, so it keeps the mark at rest.
export const FADED_PROVIDER_MARK: Record<ProviderMarkTone, string> = {
  brand: "opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-60",
  mono: "[--color-ink:var(--color-ink-tertiary)] [--color-ink-secondary:var(--color-ink-tertiary)] group-hover:[--color-ink:inherit] group-hover:[--color-ink-secondary:inherit] group-focus-within:[--color-ink:inherit] group-focus-within:[--color-ink-secondary:inherit]",
};

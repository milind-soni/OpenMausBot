import { z } from "zod";
import { persistableInstanceConfigs, type AppConfig } from "./config.ts";
import { PROVIDER_ICON_PRESETS, type ProviderIcon } from "../shared/provider-icon.ts";

const iconSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), preset: z.enum(PROVIDER_ICON_PRESETS) }).strict(),
  z.object({ kind: z.literal("custom"), dataUrl: z.string() }).strict(),
]);

export const providerIconPatchSchema = z.object({ icon: iconSchema.nullable() }).strict();

export function withInstanceIcon(cfg: AppConfig, instanceId: string, icon: ProviderIcon | null) {
  const next: AppConfig = structuredClone(cfg);
  const instances = persistableInstanceConfigs(next);
  if (!Object.hasOwn(instances, instanceId)) return { ok: false as const, config: cfg, instances };
  if (icon) instances[instanceId].icon = icon;
  else delete instances[instanceId].icon;
  next.instances = instances;
  return { ok: true as const, config: next, instances };
}

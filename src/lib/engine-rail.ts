// Split engines into Cloud (first-party catalog + Custom) and Local
// (no catalog — inject a model). A missing `access` is Cloud so older
// payloads stay in the top group. VibeCoder would join Local later.
import type { InstanceInfo } from "@/state/store";

/** The picker is for usable connections; the full catalog stays in Settings.
 * A signed-out CLI can still run its configured custom/local models. */
export function configuredModelInstances(instances: readonly InstanceInfo[]): InstanceInfo[] {
  return instances.flatMap((instance) => {
    if (instance.snapshot.state !== "available") return [];
    const options = instance.access !== "custom" && instance.snapshot.authenticated === false
      ? instance.models.options.filter((option) => option.custom)
      : instance.models.options;
    return options.length ? [{ ...instance, models: { ...instance.models, options } }] : [];
  });
}

export function isCustomOnly(instance: { access?: InstanceInfo["access"] } | undefined): boolean {
  return instance?.access === "custom";
}

export function splitEngineRail<T>(instances: readonly T[]): {
  subscription: T[];
  custom: T[];
} {
  const subscription: T[] = [];
  const custom: T[] = [];
  for (const instance of instances) {
    if (isCustomOnly(instance as { access?: InstanceInfo["access"] })) custom.push(instance);
    else subscription.push(instance);
  }
  return { subscription, custom };
}

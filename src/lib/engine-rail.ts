// Split engines into Cloud (first-party catalog + Custom) and Local
// (no catalog — inject a model). A missing `access` is Cloud so older
// payloads stay in the top group. VibeCoder would join Local later.
import type { InstanceInfo } from "@/state/store";

/** The picker lists engines someone can use or finish setting up; the full
 * catalog stays in Settings. Each instance (so each Claude account) is judged
 * on its own:
 * - an installed engine stays with its whole catalog, signed in or not. A
 *   signed-out one shows its sign-in card instead of cloud models, and its
 *   local models stay pickable;
 * - the engine the bot runs on now always stays, even when its CLI is
 *   missing, so its setup card explains why instead of the model vanishing;
 * - an engine that is not installed and not in use stays in Settings, as does
 *   an installed engine with nothing to list. */
export function configuredModelInstances(instances: readonly InstanceInfo[], selectedInstanceId?: string): InstanceInfo[] {
  return instances.filter((instance) =>
    instance.instanceId === selectedInstanceId
      || (instance.snapshot.state === "available" && instance.models.options.length > 0));
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

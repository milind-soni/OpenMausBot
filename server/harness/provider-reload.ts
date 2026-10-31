import type { InstanceConfigMap, ProviderInstance } from "../contracts.ts";
import type { EventBus } from "./bus.ts";
import type { ProviderRegistry } from "./registry.ts";

export async function reloadProviderInstances(
  registry: Pick<ProviderRegistry, "load" | "dispose" | "get">,
  bus: Pick<EventBus, "detach" | "attach">,
  configs: InstanceConfigMap,
  changed: ReadonlySet<string>,
  decorate?: (instance: ProviderInstance) => ProviderInstance,
) {
  const reloaded = new Set<string>();
  const results = await Promise.allSettled([...changed].map(async (id) => {
    if (Object.hasOwn(configs, id)) await registry.load({ [id]: configs[id] }, decorate);
    else await registry.dispose(id);
    bus.detach(id);
    const live = registry.get(id);
    if (live) bus.attach([live]);
    reloaded.add(id);
  }));
  return { reloaded, failed: results.find(result => result.status === "rejected") };
}

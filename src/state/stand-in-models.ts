import type { InstanceInfo } from "./store";

/** Engine lists arrive from overlapping requests: one answered before a model read finished must not bring that
 * engine's stand-in list (`placeholder`) back over the catalog the read found. */
export function keepReadCatalogs(current: readonly InstanceInfo[], next: InstanceInfo[]): InstanceInfo[] {
  return next.map((instance) => {
    if (!instance.models.placeholder) return instance;
    const read = current.find((candidate) => candidate.instanceId === instance.instanceId && !candidate.models.placeholder);
    return read ? { ...instance, models: read.models } : instance;
  });
}

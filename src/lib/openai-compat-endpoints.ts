import type { InstanceInfo } from "@/state/store";

/** Servers added from Settings → API keys → Other; matches the server's ADDED_ENDPOINT_PREFIX. */
export function addedServers(instances: readonly InstanceInfo[]): Array<InstanceInfo & { url?: string; managedModels?: string[] }> {
  return instances.filter((instance) => instance.driverKind === "openai-compat" && instance.instanceId.startsWith("openai-compat-"));
}

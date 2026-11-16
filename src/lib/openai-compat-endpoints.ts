import type { InstanceInfo } from "@/state/store";

/** A server added from Settings → API keys → Other; matches the server's ADDED_ENDPOINT_PREFIX. */
export function isAddedServer(instance: InstanceInfo): boolean {
  return instance.driverKind === "openai-compat" && instance.instanceId.startsWith("openai-compat-");
}

export function addedServers(instances: readonly InstanceInfo[]): Array<InstanceInfo & {
  url?: string; managedModels?: string[];
  /** Its saved key is Ollama's placeholder, which the server keeps on any address. */
  placeholderKey?: boolean;
}> {
  return instances.filter(isAddedServer);
}

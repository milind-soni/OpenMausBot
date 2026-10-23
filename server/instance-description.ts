import type { ModelSelection } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import { endpointDisplayUrl } from "./openai-compat-endpoints.ts";
import { isDirectModelDriver } from "../shared/model-arrangement.ts";

export function createModelName(registry: Pick<ProviderRegistry, "get">): (selection: ModelSelection) => string {
  return (selection) => {
    const instance = registry.get(selection.instanceId);
    const label = instance?.models.options.find((option) => option.id === selection.model)?.label ?? selection.model;
    return instance ? `${instance.displayName || instance.driverKind} · ${label}` : label;
  };
}

export function directModelUrl(driverKind: string, config: unknown): string | undefined {
  return isDirectModelDriver(driverKind) ? endpointDisplayUrl(config) : undefined;
}

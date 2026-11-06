import type { FleetRegistry } from "./fleet.ts";

export function assertWorkspaceHost(input: { registry: FleetRegistry; slug: string; host?: string; portalUrl?: string }): void {
  if (input.host !== undefined) throw new Error("fleet create --host is not implemented yet");
}

export function workspaceHostFor(registry: FleetRegistry, slug: string, host?: string): string {
  return host ?? `${slug}.${registry.domain}`;
}

import type { SendTurnInput } from "./contracts.ts";
import { computerProxyEnv } from "./container-computer.ts";
import type { HostMcpServer } from "./host-mcp.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

type TurnIntegrations = NonNullable<SendTurnInput["integrations"]>;

const NODE_MODE = { ELECTRON_RUN_AS_NODE: "1" };

/** Convert OpenMausBot's per-turn integrations into the same app-owned
 * gateway catalog used for installed host MCPs. Full-task-scoped providers
 * mount only the one capability proxy; credentials and backend topology stay
 * in the harness. */
export function appCapabilityServers(
  integrations: TurnIntegrations,
  executable = process.execPath,
): Record<string, HostMcpServer> {
  const servers: Record<string, HostMcpServer> = {};
  if (integrations.composio) {
    servers["openmaus-connectors"] = { type: "stdio", ...integrations.composio };
  }
  if (integrations.computer) {
    servers["openmaus-computer"] = {
      type: "stdio",
      command: executable,
      args: [SPAWNED_PROXIES.computer],
      env: { ...NODE_MODE, ...computerProxyEnv(integrations.computer) },
    };
  } else if (integrations.localComputer) {
    servers["openmaus-computer"] = {
      type: "stdio",
      command: integrations.localComputer.command,
      args: integrations.localComputer.args,
      env: integrations.localComputer.env,
    };
  }
  if (integrations.agents) {
    servers["openmaus-agents"] = { type: "stdio", ...integrations.agents };
  }
  if (integrations.phone) {
    servers["openmaus-phone"] = { type: "stdio", ...integrations.phone };
  }
  if (integrations.dweb) {
    servers["openmaus-dweb"] = {
      type: "stdio",
      command: executable,
      args: [SPAWNED_PROXIES.dweb],
      env: { ...NODE_MODE, DWEB_URL: integrations.dweb.url },
    };
  }
  return servers;
}

export function retainOnlyCapabilityGateway(integrations: TurnIntegrations): void {
  for (const key of Object.keys(integrations) as Array<keyof TurnIntegrations>) {
    if (key !== "capabilityGateway") delete integrations[key];
  }
}

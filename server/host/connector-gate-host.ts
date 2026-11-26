// Where a call made outside a turn reaches the connected apps: this computer's or the team's installation, or, on a Team
// Cloud where each person connects an app for themselves, the calling person's own. Security: the person comes from the
// request's own session, never from the caller, and no key or token leaves the server.
import type * as Composio from "../composio.ts";
import type { AppConfig } from "../config.ts";
import type { AppInstallation, GateApps } from "../connector-gate.ts";
import { asPerson, type PersonAppsAccess } from "../team-connections.ts";

export interface ConnectorGateAppsDeps {
  cfg(): AppConfig;
  composio: Pick<typeof Composio, "configured" | "connectedServices" | "sharedConnectedInventory" | "connectedServiceSlugs" | "listConnectorTools" | "relayMcp">;
  /** The apps each person connects for themselves (only on a Team Cloud). */
  personApps(): readonly string[];
  appsAccess(person: string): PersonAppsAccess | null;
  policyRefusal(slugs: readonly string[], serviceSlugs: readonly string[]): string | undefined;
}

export function createConnectorGateApps(deps: ConnectorGateAppsDeps): GateApps {
  const { composio } = deps;
  // A tool's own listing is the same whoever connected its app, so the shared installation's listing is read for every call.
  const readOnlyTools = async () => new Set(Object.values(await composio.listConnectorTools(deps.cfg())).flat().filter((tool) => tool.readOnly).map((tool) => tool.name));
  return {
    configured: () => composio.configured(deps.cfg()),
    policyRefusal: deps.policyRefusal,
    installation(person, toolkit): AppInstallation | null {
      if (!deps.personApps().includes(toolkit)) {
        const cfg = deps.cfg();
        return {
          id: "shared",
          connected: async () => (await composio.sharedConnectedInventory(cfg)).services,
          serviceSlugs: () => composio.connectedServiceSlugs(cfg),
          readOnlyTools,
          relay: (frame, session, signal) => composio.relayMcp(cfg, frame as never, session, undefined, signal),
        };
      }
      const own = person ? deps.appsAccess(person) : null;
      if (!person || !own) return null;
      const [cfg, access] = asPerson(deps.cfg(), own);
      return {
        id: `person:${person}`,
        connected: () => composio.connectedServices(cfg, access),
        serviceSlugs: () => composio.connectedServiceSlugs(cfg, access),
        readOnlyTools,
        relay: (frame, session, signal) => composio.relayMcp(cfg, frame as never, session, undefined, signal, access),
      };
    },
  };
}

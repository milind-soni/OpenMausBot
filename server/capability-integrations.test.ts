import { describe, expect, it } from "vitest";

import { appCapabilityServers, retainOnlyCapabilityGateway } from "./capability-integrations.ts";
import type { SendTurnInput } from "./contracts.ts";

describe("full-task-scoped app capability routing", () => {
  it("moves every app integration behind the one shared gateway", () => {
    const integrations: NonNullable<SendTurnInput["integrations"]> = {
      composio: { command: "/connector", args: ["serve"], env: { CONNECTOR_TOKEN: "canary" } },
      localComputer: { command: "/computer", args: ["mcp"], env: {}, scope: "local-computer" },
      agents: { command: "/agents", args: [], env: {} },
      phone: { command: "/phone", args: [], env: {} },
      dweb: { url: "http://127.0.0.1:9999" },
      capabilityGateway: { command: "/gateway", args: [], env: {} },
    };
    const servers = appCapabilityServers(integrations, "/node");
    expect(Object.keys(servers).sort()).toEqual([
      "openmaus-agents",
      "openmaus-computer",
      "openmaus-connectors",
      "openmaus-dweb",
      "openmaus-phone",
    ]);
    expect(JSON.stringify(servers)).toContain("canary");

    retainOnlyCapabilityGateway(integrations);
    expect(Object.keys(integrations)).toEqual(["capabilityGateway"]);
  });
});

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

  it("maps a cloud computer to the app-owned proxy with control metadata", () => {
    const servers = appCapabilityServers({
      computer: {
        kind: "box",
        boxId: "box-123",
        token: "box-token-canary",
        control: { url: "http://127.0.0.1:8799", token: "control-token-canary" },
      },
    }, "/node");

    expect(servers["openmaus-computer"]).toMatchObject({
      type: "stdio",
      command: "/node",
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        OGB_BOX_ID: "box-123",
        OGB_BOX_TOKEN: "box-token-canary",
        OMB_CONTROL_URL: "http://127.0.0.1:8799",
        OMB_CONTROL_TOKEN: "control-token-canary",
      },
    });
  });
});

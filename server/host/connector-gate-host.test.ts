// Which installation a call made outside a turn goes to, with a fake connected-apps module: nothing leaves this process.
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { PersonAppsAccess } from "../team-connections.ts";
import { createConnectorGateApps, type ConnectorGateAppsDeps } from "./connector-gate-host.ts";

function fixture(personApps: string[] = []) {
  const relayed: Array<{ cfg: AppConfig; as: unknown }> = [];
  const composio = {
    configured: () => true,
    connectedServices: vi.fn(async () => ({})),
    sharedConnectedInventory: vi.fn(async () => ({ services: { gmail: { connected: true } }, complete: true })),
    connectedServiceSlugs: vi.fn(async () => ["gmail"]),
    listConnectorTools: vi.fn(async () => ({ gmail: [{ name: "GMAIL_FETCH_EMAILS", readOnly: true as const }, { name: "GMAIL_SEND_EMAIL" }] })),
    relayMcp: vi.fn(async (cfg: AppConfig, _payload: unknown, _session?: string, _before?: unknown, _signal?: AbortSignal, as?: unknown) => {
      relayed.push({ cfg, as });
      return { status: 200, bytes: new Uint8Array(), contentType: "application/json" };
    }),
  } as unknown as ConnectorGateAppsDeps["composio"];
  const ada = { installationId: "inst-ada", token: "t".repeat(64), brokerUrl: "https://broker.example" } as unknown as PersonAppsAccess;
  const apps = createConnectorGateApps({ cfg: () => ({}), composio, personApps: () => personApps, appsAccess: (person) => (person === "ada" ? ada : null), policyRefusal: () => undefined });
  return { apps, composio, relayed };
}

describe("the connector gate's installations", () => {
  it("sends an app every person shares to this computer's installation, and reads which tools only read from its listing", async () => {
    const { apps, relayed } = fixture();
    const shared = apps.installation("ada", "gmail")!;
    expect(shared.id).toBe("shared");
    expect([...await shared.readOnlyTools()]).toEqual(["GMAIL_FETCH_EMAILS"]);
    expect(await shared.connected()).toEqual({ gmail: { connected: true } });
    await shared.relay({ jsonrpc: "2.0" }, undefined, AbortSignal.timeout(1_000));
    expect(relayed).toEqual([{ cfg: {}, as: undefined }]);
  });

  it("sends an app each person connects to the calling person's own, and to nobody's without one", async () => {
    const { apps, relayed } = fixture(["gmail"]);
    expect(apps.installation(null, "gmail")).toBeNull();
    expect(apps.installation("bob", "gmail")).toBeNull();
    const own = apps.installation("ada", "gmail")!;
    expect(own.id).toBe("person:ada");
    await own.relay({ jsonrpc: "2.0" }, undefined, AbortSignal.timeout(1_000));
    expect(relayed[0]!.as).toBeDefined();
    expect(apps.installation("ada", "notion")!.id).toBe("shared");
  });
});

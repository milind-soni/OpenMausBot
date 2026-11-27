import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { createConnectorListingRoutes, type ConnectorListingDeps } from "./connectors-listing.ts";
import { PASS, type RouteContext } from "./table.ts";

function setup(overrides: Partial<ConnectorListingDeps["composio"]> = {}) {
  const composio = {
    listToolkits: vi.fn(async () => ({ cards: [{ slug: "gmail", label: "Gmail", blurb: "", logo: null, domain: null }], source: "api" as const, pagination: { items: 1, stalled: false, complete: true }, fresh: false })),
    configured: () => true,
    connectionMode: () => "managed" as const,
    connectorSetup: vi.fn(() => "ready" as const),
    connectorAvailability: vi.fn(() => "configured" as const),
    sharedConnectedInventory: vi.fn(async () => ({ complete: true, services: { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [] } } })),
    ...overrides,
  };
  const route = createConnectorListingRoutes({ cfg: () => ({}), composio, managedHost: true });
  const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
    const json = vi.fn();
    const out = await route({ req: { headers } as IncomingMessage, res: {} as ServerResponse, path, method, json } as unknown as RouteContext);
    return { out, answer: json.mock.calls[0] as [unknown, number, Record<string, unknown>] | undefined };
  };
  return { composio, call };
}

describe("the Apps page's listing routes", () => {
  it("answers the catalog with how connected apps are set up here", async () => {
    const { composio, call } = setup();
    const { answer } = await call("GET", "/api/connectors/catalog");
    expect(answer![1]).toBe(200);
    expect(answer![2]).toEqual({
      configured: true, mode: "managed", setup: "ready", source: "api",
      cards: [expect.objectContaining({ slug: "gmail" })], pagination: { items: 1, stalled: false, complete: true },
    });
    expect(composio.connectorSetup).toHaveBeenCalledWith({}, true);
  });

  it("answers the connected apps from the shared read, and reads anew only for Refresh", async () => {
    const { composio, call } = setup();
    const { answer } = await call("GET", "/api/connectors/connected");
    expect(answer![2]).toEqual({ configured: true, credentialStore: "ok", inventoryComplete: true, services: { gmail: expect.objectContaining({ connected: true }) } });
    expect(composio.sharedConnectedInventory).toHaveBeenLastCalledWith({}, { fresh: false });
    await call("GET", "/api/connectors/connected", { "cache-control": "no-cache" });
    expect(composio.sharedConnectedInventory).toHaveBeenLastCalledWith({}, { fresh: true });
  });

  it.each([["unconfigured", "ok"], ["unreadable", "unavailable"]] as const)("reads nothing when connected apps are %s", async (availability, credentialStore) => {
    const { composio, call } = setup({ connectorAvailability: () => availability });
    expect((await call("GET", "/api/connectors/connected")).answer![2]).toEqual({ configured: false, credentialStore, services: {} });
    expect(composio.sharedConnectedInventory).not.toHaveBeenCalled();
  });

  it("leaves every other connector route to its own handler", async () => {
    const { call } = setup();
    for (const [method, path] of [["POST", "/api/connectors/catalog"], ["GET", "/api/connectors"], ["GET", "/api/connectors/tools"], ["GET", "/api/connectors/suggestions"], ["DELETE", "/api/connectors/connected"]] as const) {
      expect((await call(method, path)).out).toBe(PASS);
    }
  });
});

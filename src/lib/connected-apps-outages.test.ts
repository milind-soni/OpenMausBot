import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), disk: vi.fn(), write: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api }));
vi.mock("@/lib/connected-apps-cache", () => ({ readCachedInventory: fixture.disk, writeCachedInventory: fixture.write }));

const old = { gmail: { connected: true, accounts: [{ id: "removed", status: "ACTIVE" }] } };
const current = { gmail: { connected: false, accounts: [] } };

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  fixture.disk.mockReturnValue({ at: 1, services: old });
});

describe("connected app refresh failures", () => {
  it("keeps the memory cache non-authoritative after a rejected forced refresh", async () => {
    const { rememberConnectorStatus, preloadConnectedApps, connectorStatusMemory } = await import("./connected-apps");
    rememberConnectorStatus(current, true);
    fixture.api.mockRejectedValue(new Error("offline"));
    expect(await preloadConnectedApps(true)).toEqual({ services: current, authoritative: false });
    expect(connectorStatusMemory()).toEqual({ services: current, authoritative: false });
    expect(await preloadConnectedApps()).toEqual({ services: current, authoritative: false });
  });

  it.each([{ credentialStore: "unavailable" }, { inventoryComplete: false }])("keeps newer panel state when the server returns %j", async (outage) => {
    const { rememberConnectorStatus, preloadConnectedApps } = await import("./connected-apps");
    rememberConnectorStatus(current, true);
    fixture.api.mockResolvedValue({ ...outage, services: {} });
    expect(await preloadConnectedApps(true)).toEqual({ services: current, authoritative: false });
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it("uses saved inventory when the page has not read any live state", async () => {
    const { preloadConnectedApps } = await import("./connected-apps");
    fixture.api.mockRejectedValue(new Error("offline"));
    expect(await preloadConnectedApps()).toEqual({ services: old, authoritative: false });
  });

  it("restores an authoritative cache after a complete successful refresh", async () => {
    const { rememberConnectorStatus, preloadConnectedApps, connectorStatusMemory } = await import("./connected-apps");
    rememberConnectorStatus(current, true);
    fixture.api.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ services: old });
    await preloadConnectedApps(true);
    expect(await preloadConnectedApps(true)).toEqual({ services: old, authoritative: true });
    expect(connectorStatusMemory()).toEqual({ services: old, authoritative: true });
    expect(fixture.write).toHaveBeenCalledExactlyOnceWith(old, expect.any(Number));
  });
});

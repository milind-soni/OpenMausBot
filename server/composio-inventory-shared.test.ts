import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetInventories } from "./composio-inventory-cache.ts";
import { authorizeService, connectedServicesInventory, connectionStatus, removeAccount, removeService, setManagedBrokerAccess, sharedConnectedInventory } from "./composio.ts";
import { startFakeCatalogService, waitedOnService, type FakeCatalogService } from "./testing/fake-catalog-service.ts";

let fake: FakeCatalogService;
let installation = 0;
let clock = 0;
const later = (ms: number) => { clock += ms; };
const reads = () => fake.requests.connected;

beforeAll(async () => {
  fake = await startFakeCatalogService();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  const start = Date.now();
  clock = 0;
  vi.spyOn(Date, "now").mockImplementation(() => start + clock);
  Object.assign(fake, { down: false, connected: { gmail: { connected: true, status: "ACTIVE" } }, inventoryComplete: undefined });
  installation += 1;
  setManagedBrokerAccess({ url: fake.url, token: installation.toString(16).padStart(64, "a") });
  fake.requests.connected = 0;
});
afterEach(() => {
  setManagedBrokerAccess(null);
  forgetInventories();
  vi.restoreAllMocks();
});

describe("the connected-apps inventory the Apps page reads", () => {
  it("is read once for readers one after another, and once for readers asking together", async () => {
    for (let read = 0; read < 5; read += 1) {
      expect(await sharedConnectedInventory({})).toMatchObject({ complete: true, services: { gmail: { connected: true } } });
    }
    expect(reads()).toBe(1);

    later(21_000);
    const together = await waitedOnService(fake, () => Promise.all(Array.from({ length: 5 }, () => sharedConnectedInventory({}))));
    expect(together.waited).toBe(true);
    expect(reads()).toBe(2);
  });

  it("reads again for Refresh, and leaves the plain read uncached for a bot's own checks", async () => {
    await sharedConnectedInventory({});
    await sharedConnectedInventory({}, { fresh: true });
    expect(reads()).toBe(2);
    await sharedConnectedInventory({});
    expect(reads()).toBe(2);
    await connectedServicesInventory({});
    await connectedServicesInventory({});
    expect(reads()).toBe(4);
  });

  it.each([
    ["a connection is started", () => authorizeService({}, "slack")],
    ["an app is removed", () => removeService({}, "gmail")],
    ["an account is removed", () => removeAccount({}, "gmail", "ca_fixture")],
  ])("reads again once %s", async (_name, change) => {
    await sharedConnectedInventory({});
    await change();
    fake.connected = { gmail: { connected: true, status: "ACTIVE" }, slack: { connected: false, status: "INITIATED" } };
    expect((await sharedConnectedInventory({})).services).toHaveProperty("slack");
    expect(reads()).toBe(2);
  });

  it("reads again when a status check says other than it holds, and not when it says the same", async () => {
    await sharedConnectedInventory({});
    await connectionStatus({}, ["gmail", "slack"]);
    await sharedConnectedInventory({});
    expect(reads()).toBe(1);

    fake.connected = { gmail: { connected: true, status: "ACTIVE" }, slack: { connected: true, status: "ACTIVE" } };
    expect((await sharedConnectedInventory({})).services).not.toHaveProperty("slack");
    await connectionStatus({}, ["slack"]);
    expect((await sharedConnectedInventory({})).services).toMatchObject({ slack: { connected: true } });
    expect(reads()).toBe(2);

    fake.connected = { slack: { connected: true, status: "ACTIVE" } };
    await connectionStatus({}, ["gmail"]);
    expect((await sharedConnectedInventory({})).services).not.toHaveProperty("gmail");
    expect(reads()).toBe(3);
  });

  it("does not keep a read that was running when a connection changed", async () => {
    const open = fake.hold();
    const arrival = fake.arrival();
    const running = sharedConnectedInventory({});
    await arrival;
    open();
    await removeService({}, "gmail");
    await running;
    fake.connected = {};
    expect((await sharedConnectedInventory({})).services).toEqual({});
    expect(reads()).toBe(2);
  });

  it("keeps neither an incomplete inventory nor a failed read", async () => {
    fake.inventoryComplete = false;
    expect(await sharedConnectedInventory({})).toMatchObject({ complete: false });
    fake.inventoryComplete = true;
    expect(await sharedConnectedInventory({})).toMatchObject({ complete: true });
    expect(reads()).toBe(2);

    later(21_000);
    fake.down = true;
    await expect(sharedConnectedInventory({})).rejects.toThrow();
    fake.down = false;
    expect(await sharedConnectedInventory({})).toMatchObject({ complete: true });
    expect(reads()).toBe(4);
  });

  it("keeps one installation's inventory from another's", async () => {
    await sharedConnectedInventory({});
    setManagedBrokerAccess({ url: fake.url, token: "b".repeat(64) });
    await sharedConnectedInventory({});
    expect(reads()).toBe(2);
  });
});

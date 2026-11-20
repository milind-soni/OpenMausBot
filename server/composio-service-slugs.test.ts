import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CONNECTOR_SERVICE_SLUGS_ENV } from "./connector-advertisement.ts";
import {
  CONNECTOR_SERVICE_SLUGS_STALE_MS,
  authorizeService,
  connectedServiceSlugs,
  connectionStatus,
  mcpIntegration,
  removeService,
  serviceSlugsReadSettled,
  setManagedBrokerAccess,
  sharedConnectedInventory,
} from "./composio.ts";
import { forgetInventories } from "./composio-inventory-cache.ts";
import { startFakeCatalogService, waitedOnService, type FakeCatalogService } from "./testing/fake-catalog-service.ts";

let fake: FakeCatalogService;
let installation = 0;
let clock = 0;
const later = (ms: number) => { clock += ms; };
const reads = () => fake.requests.connected;
const ACTIVE = { connected: true, status: "ACTIVE" };
const turn = { harnessUrl: "http://127.0.0.1:1", commsToken: "fixture", botId: "bot", threadId: "thread", connectorTools: { bland: { tools: "*" as const } } };
const advertised = async () => (await mcpIntegration({}, turn))!.env[CONNECTOR_SERVICE_SLUGS_ENV];

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
  Object.assign(fake, { down: false, connected: { bland: ACTIVE }, inventoryComplete: undefined });
  installation += 1;
  setManagedBrokerAccess({ url: fake.url, token: installation.toString(16).padStart(64, "c") });
  fake.requests.connected = 0;
});
afterEach(async () => {
  await serviceSlugsReadSettled();
  setManagedBrokerAccess(null);
  forgetInventories();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the connected services a tool's name is read against", () => {
  it("waits for the first read, then uses it for a minute", async () => {
    const first = await waitedOnService(fake, () => connectedServiceSlugs({}));
    expect(first).toEqual({ waited: true, value: ["bland"] });
    later(59_000);
    expect(await connectedServiceSlugs({})).toEqual(["bland"]);
    expect(reads()).toBe(1);
  });

  it("uses the list it has while one read brings the new one, from a minute old to five", async () => {
    await connectedServiceSlugs({});
    later(61_000);
    fake.connected = { bland: ACTIVE, bland_ai: ACTIVE };
    const old = await waitedOnService(fake, () => Promise.all([connectedServiceSlugs({}), connectedServiceSlugs({}), connectedServiceSlugs({})]));
    expect(old).toEqual({ waited: false, value: [["bland"], ["bland"], ["bland"]] });
    await serviceSlugsReadSettled();
    expect(reads()).toBe(2);
    expect(await connectedServiceSlugs({})).toEqual(["bland", "bland_ai"]);
    expect(reads()).toBe(2);
  });

  it("never judges by a list older than five minutes: it waits for the read", async () => {
    await connectedServiceSlugs({});
    later(CONNECTOR_SERVICE_SLUGS_STALE_MS);
    fake.connected = { bland: ACTIVE, bland_ai: ACTIVE };
    const read = await waitedOnService(fake, () => connectedServiceSlugs({}));
    expect(read).toEqual({ waited: true, value: ["bland", "bland_ai"] });
  });

  it.each([
    ["a connection is started here", () => authorizeService({}, "bland_ai")],
    ["an app is removed here", () => removeService({}, "bland")],
    ["a status check says other than the Apps page holds", async () => {
      await sharedConnectedInventory({});
      fake.connected = { bland: ACTIVE, bland_ai: ACTIVE };
      await connectionStatus({}, ["bland_ai"]);
    }],
  ])("waits for a new read once %s, however new its list", async (_name, change) => {
    await connectedServiceSlugs({});
    await change();
    fake.connected = { bland_ai: ACTIVE };
    fake.requests.connected = 0;
    const read = await waitedOnService(fake, () => connectedServiceSlugs({}));
    expect(read).toEqual({ waited: true, value: ["bland_ai"] });
    expect(reads()).toBe(1);
  });

  it("does not keep a read that was running when a connection changed", async () => {
    const open = fake.hold();
    const arrival = fake.arrival();
    const overtaken = connectedServiceSlugs({});
    await arrival;
    open();
    await removeService({}, "bland");
    expect(await overtaken).toEqual(["bland"]);
    fake.connected = { bland_ai: ACTIVE };
    fake.requests.connected = 0;
    expect(await waitedOnService(fake, () => connectedServiceSlugs({}))).toEqual({ waited: true, value: ["bland_ai"] });
    expect(reads()).toBe(1);
  });

  it("answers the last good list when the read it waited for fails", async () => {
    await connectedServiceSlugs({});
    await removeService({}, "bland");
    fake.down = true;
    expect(await connectedServiceSlugs({})).toEqual(["bland"]);
    later(CONNECTOR_SERVICE_SLUGS_STALE_MS);
    expect(await connectedServiceSlugs({})).toEqual(["bland"]);
  });
});

describe("a turn's start, for a bot with tool grants", () => {
  it("does not wait on the service when it has a list under five minutes old", async () => {
    expect((await waitedOnService(fake, advertised)).waited).toBe(true);
    later(2 * 60_000);
    fake.connected = { bland: ACTIVE, bland_ai: ACTIVE };
    const next = await waitedOnService(fake, advertised);
    expect(next).toEqual({ waited: false, value: JSON.stringify(["bland"]) });
    await serviceSlugsReadSettled();
    expect(await advertised()).toBe(JSON.stringify(["bland", "bland_ai"]));
    expect(reads()).toBe(2);
  });

  it("waits a bounded time for its first list, then starts without one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const open = fake.hold();
    const arrival = fake.arrival();
    let started = false;
    const starting = advertised().finally(() => { started = true; });
    try {
      await arrival;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(started).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await starting).toBeUndefined();
    } finally {
      open();
    }
    await serviceSlugsReadSettled();
    expect(await advertised()).toBe(JSON.stringify(["bland"]));
  });

  it("reads nothing for a bot with no tool grants", async () => {
    const { connectorTools: _none, ...plain } = turn;
    expect((await mcpIntegration({}, plain))!.env).not.toHaveProperty(CONNECTOR_SERVICE_SLUGS_ENV);
    expect(reads()).toBe(0);
  });
});

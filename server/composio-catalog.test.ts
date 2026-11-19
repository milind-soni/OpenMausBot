import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { catalogWalksSettled, forgetCatalogs, onCatalogChange } from "./composio-catalog.ts";
import { listToolkits, setManagedBrokerAccess } from "./composio.ts";
import { startFakeCatalogService, waitedOnService, type FakeCatalogService } from "./testing/fake-catalog-service.ts";

let fake: FakeCatalogService;
let installation = 0;
let clock = 0;
const ELEVEN_MINUTES = 11 * 60_000;
const later = (ms: number) => { clock += ms; };
const labels = async () => (await listToolkits({})).cards.map((card) => card.label);

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
  vi.spyOn(console, "warn").mockImplementation(() => {});
  Object.assign(fake, { pages: [3, 3, 2], edition: 0, failPage: 0, dropPage: 0, down: false });
  installation += 1;
  setManagedBrokerAccess({ url: fake.url, token: installation.toString(16).padStart(64, "0") });
  fake.requests.catalog = 0;
});
afterEach(async () => {
  await catalogWalksSettled();
  setManagedBrokerAccess(null);
  forgetCatalogs();
  vi.restoreAllMocks();
});

describe("the catalog answers from the copy it holds", () => {
  it("makes its first read wait for the walk, one walk for every reader asking at once", async () => {
    const first = await waitedOnService(fake, () => Promise.all([listToolkits({}), listToolkits({}), listToolkits({})]));
    expect(first.waited).toBe(true);
    expect(first.value.map((catalog) => catalog.cards.length)).toEqual([8, 8, 8]);
    expect(first.value[0]).toMatchObject({ source: "api", fresh: true, pagination: { items: 8, complete: true } });
    expect(fake.requests.catalog).toBe(3);
  });

  it("answers an old copy at once and reads again behind it, once", async () => {
    await listToolkits({});
    fake.requests.catalog = 0;
    await listToolkits({});
    expect(fake.requests.catalog).toBe(0);

    later(ELEVEN_MINUTES);
    fake.edition = 1;
    const changed = vi.fn();
    const stop = onCatalogChange(changed);
    try {
      const stale = await waitedOnService(fake, () => Promise.all([listToolkits({}), listToolkits({}), listToolkits({})]));
      expect(stale.waited).toBe(false);
      expect(stale.value.map((catalog) => catalog.fresh)).toEqual([false, false, false]);
      expect(stale.value[0]!.cards[0]!.label).toBe("App 0 v0");
      await catalogWalksSettled();
      expect(fake.requests.catalog).toBe(3);
      expect(changed).toHaveBeenCalledTimes(1);
      expect((await labels())[0]).toBe("App 0 v1");
      expect((await listToolkits({})).fresh).toBe(true);
      expect(fake.requests.catalog).toBe(3);

      later(ELEVEN_MINUTES);
      await listToolkits({});
      await catalogWalksSettled();
      expect(fake.requests.catalog).toBe(6);
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it("keeps one installation's catalog from another's", async () => {
    await listToolkits({});
    setManagedBrokerAccess({ url: fake.url, token: "f".repeat(64) });
    fake.requests.catalog = 0;
    await listToolkits({});
    expect(fake.requests.catalog).toBe(3);
  });
});

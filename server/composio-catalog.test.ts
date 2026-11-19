import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG_FILE, catalogWalksSettled, forgetCatalogs, onCatalogChange, rememberCatalogIn } from "./composio-catalog.ts";
import { removeTempDir } from "./testing/cleanup.ts";
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
  Object.assign(fake, { pages: [3, 3, 2], edition: 0, failPage: 0, dropPage: 0, garblePage: 0, totals: true, down: false });
  installation += 1;
  setManagedBrokerAccess({ url: fake.url, token: installation.toString(16).padStart(64, "0") });
  fake.requests.catalog = 0;
});
afterEach(async () => {
  await catalogWalksSettled();
  setManagedBrokerAccess(null);
  rememberCatalogIn(null);
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

describe("the catalog kept in the data folder", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "omb-catalog-"));
    rememberCatalogIn(dataDir);
  });
  afterEach(async () => {
    await catalogWalksSettled();
    await removeTempDir(dataDir);
  });

  it("answers the first read after a restart from the file, without waiting", async () => {
    await listToolkits({});
    const file = join(dataDir, CATALOG_FILE);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(installation.toString(16).padStart(64, "0"));

    forgetCatalogs();
    fake.requests.catalog = 0;
    const afterRestart = await listToolkits({});
    expect(afterRestart).toMatchObject({ source: "api", fresh: true, pagination: { items: 8, complete: true } });
    expect(afterRestart.cards).toHaveLength(8);
    expect(fake.requests.catalog).toBe(0);

    forgetCatalogs();
    later(ELEVEN_MINUTES);
    fake.edition = 1;
    const old = await waitedOnService(fake, () => listToolkits({}));
    expect(old.waited).toBe(false);
    expect(old.value).toMatchObject({ fresh: false });
    expect(old.value.cards[0]!.label).toBe("App 0 v0");
    await catalogWalksSettled();
    expect(fake.requests.catalog).toBe(3);

    forgetCatalogs();
    expect((await labels())[0]).toBe("App 0 v1");
    expect(fake.requests.catalog).toBe(3);
  });

  it("starts from nothing when the file is another installation's, or is not a catalog", async () => {
    await listToolkits({});
    forgetCatalogs();
    setManagedBrokerAccess({ url: fake.url, token: "e".repeat(64) });
    fake.requests.catalog = 0;
    expect((await waitedOnService(fake, () => listToolkits({}))).waited).toBe(true);
    expect(fake.requests.catalog).toBe(3);

    await catalogWalksSettled();
    forgetCatalogs();
    writeFileSync(join(dataDir, CATALOG_FILE), "{ not json");
    fake.requests.catalog = 0;
    expect((await listToolkits({})).cards).toHaveLength(8);
    expect(fake.requests.catalog).toBe(3);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining("saved catalog could not be read"));
  });

  it("starts from a saved catalog whose labels, blurbs and logo links are as long as the service sends them", async () => {
    await listToolkits({});
    const file = join(dataDir, CATALOG_FILE);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { cards: Array<Record<string, unknown>> };
    saved.cards[0] = { ...saved.cards[0], label: "L".repeat(5_000), logo: `https://logos.example/${"x".repeat(20_000)}`, categories: Array.from({ length: 30 }, (_, index) => `Category ${index}`) };
    writeFileSync(file, JSON.stringify(saved));
    forgetCatalogs();
    fake.requests.catalog = 0;
    expect((await listToolkits({})).cards[0]!.label).toHaveLength(5_000);
    expect(fake.requests.catalog).toBe(0);
  });

  it("still answers when the file can't be written", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    chmodSync(dataDir, 0o500);
    try {
      expect((await listToolkits({})).cards).toHaveLength(8);
    } finally {
      chmodSync(dataDir, 0o700);
    }
  });
});

describe("a walk that fails or comes up short", () => {
  const SHORT = { stalled: true, complete: false, reason: "http-error" };

  it.each([
    ["an error on page 2", { failPage: 2 }],
    ["a connection dropped on page 2", { dropPage: 2 }],
    ["a page 2 that is not JSON", { garblePage: 2 }],
    ["a page 2 that is not JSON, in a catalog that reports no totals", { garblePage: 2, totals: false }],
    ["an outage", { down: true }],
  ])("keeps the whole list after %s, and tries again later, less often each time", async (_name, failure) => {
    await listToolkits({});
    later(ELEVEN_MINUTES);
    Object.assign(fake, failure);
    const changed = vi.fn();
    const stop = onCatalogChange(changed);
    try {
      fake.requests.catalog = 0;
      expect(await listToolkits({})).toMatchObject({ source: "api", fresh: false, pagination: { items: 8, complete: true } });
      await catalogWalksSettled();
      const oneWalk = fake.requests.catalog;
      expect(oneWalk).toBeGreaterThan(0);
      expect(await listToolkits({})).toMatchObject({ source: "api", fresh: false, pagination: { items: 8, complete: true } });
      await catalogWalksSettled();
      expect(fake.requests.catalog).toBe(oneWalk);

      later(31_000);
      await listToolkits({});
      await catalogWalksSettled();
      expect(fake.requests.catalog).toBe(2 * oneWalk);
      later(31_000);
      await listToolkits({});
      await catalogWalksSettled();
      expect(fake.requests.catalog).toBe(2 * oneWalk);
      later(31_000);
      await listToolkits({});
      await catalogWalksSettled();
      expect(fake.requests.catalog).toBe(3 * oneWalk);
      expect(changed).not.toHaveBeenCalled();

      Object.assign(fake, { failPage: 0, dropPage: 0, garblePage: 0, down: false, edition: 1 });
      later(2 * 60_000 + 1_000);
      expect((await labels())[0]).toBe("App 0 v0");
      await catalogWalksSettled();
      expect(await listToolkits({})).toMatchObject({ fresh: true, pagination: { items: 8, complete: true } });
      expect((await labels())[0]).toBe("App 0 v1");
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it.each([
    ["an error", { failPage: 3 }, 3],
    ["a dropped connection", { dropPage: 3 }, 3],
  ])("keeps the pages read before %s on a first read, and reads again behind the next reader", async (_name, failure, walkRequests) => {
    Object.assign(fake, failure);
    expect(await listToolkits({})).toMatchObject({ source: "api", pagination: { items: 6, totalItems: 8, ...SHORT } });
    expect(fake.requests.catalog).toBe(walkRequests);
    expect((await listToolkits({})).cards).toHaveLength(6);
    await catalogWalksSettled();
    expect(fake.requests.catalog).toBe(walkRequests);

    Object.assign(fake, { failPage: 0, dropPage: 0 });
    later(31_000);
    const short = await waitedOnService(fake, () => listToolkits({}));
    expect(short.waited).toBe(false);
    expect(short.value.cards).toHaveLength(6);
    await catalogWalksSettled();
    expect(await listToolkits({})).toMatchObject({ fresh: true, pagination: { items: 8, complete: true } });
  });

  it("reads a page that is not JSON as a walk cut short, with or without totals to show it", async () => {
    fake.garblePage = 2;
    expect((await listToolkits({})).pagination).toMatchObject({ items: 3, complete: false, reason: "bad-page" });
    forgetCatalogs();
    fake.totals = false;
    expect((await listToolkits({})).pagination).toEqual({ items: 3, stalled: false, complete: false });
  });

  it("goes on when a listener of the change throws", async () => {
    await listToolkits({});
    later(ELEVEN_MINUTES);
    fake.edition = 1;
    const heard = vi.fn();
    const stops = [onCatalogChange(() => { throw new Error("listener down"); }), onCatalogChange(heard)];
    try {
      await listToolkits({});
      await catalogWalksSettled();
      expect(heard).toHaveBeenCalledTimes(1);
      expect((await labels())[0]).toBe("App 0 v1");
    } finally {
      for (const stop of stops) stop();
    }
  });

  it("never puts a shorter partial list in place of a longer one", async () => {
    fake.failPage = 3;
    await listToolkits({});
    fake.failPage = 2;
    later(31_000);
    await listToolkits({});
    await catalogWalksSettled();
    expect((await listToolkits({})).cards).toHaveLength(6);
  });

  it("answers the curated list when nothing was ever read, and waits for the walk on the next read", async () => {
    fake.down = true;
    expect(await listToolkits({})).toMatchObject({ source: "curated" });
    fake.down = false;
    const next = await waitedOnService(fake, () => listToolkits({}));
    expect(next.waited).toBe(true);
    expect(next.value).toMatchObject({ source: "api", pagination: { items: 8, complete: true } });
  });

  it("does not let a partial list on disk stand in for long after a restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-catalog-"));
    rememberCatalogIn(dataDir);
    try {
      fake.failPage = 3;
      await listToolkits({});
      fake.failPage = 0;
      forgetCatalogs();
      fake.requests.catalog = 0;
      expect((await listToolkits({})).cards).toHaveLength(6);
      await catalogWalksSettled();
      expect(fake.requests.catalog).toBe(3);
      expect((await listToolkits({})).cards).toHaveLength(8);
    } finally {
      await removeTempDir(dataDir);
    }
  });
});

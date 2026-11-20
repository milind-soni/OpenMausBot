import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ label: "Gmail", fail: false, requests: 0, answers: [] as Array<() => void>, hold: false }));
vi.mock("@/state/store", () => ({
  api: vi.fn(async (path: string) => {
    if (path !== "/api/connectors/catalog") throw new Error(`unexpected ${path}`);
    fixture.requests += 1;
    if (fixture.hold) await new Promise<void>((resolve) => fixture.answers.push(resolve));
    if (fixture.fail) throw new Error("down");
    return { cards: [{ slug: "gmail", label: fixture.label, blurb: "mail", logo: null, domain: null }], source: "api", configured: true, mode: "managed", setup: "ready", pagination: { items: 1, stalled: false } };
  }),
}));

let cache: typeof import("./app-catalog-cache");
let signal: typeof import("./app-catalog-signal");
const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); };

beforeEach(async () => {
  vi.resetModules();
  Object.assign(fixture, { label: "Gmail", fail: false, requests: 0, answers: [], hold: false });
  cache = await import("./app-catalog-cache");
  signal = await import("./app-catalog-signal");
});

describe("the Apps catalog this page holds", () => {
  it("is read once however many ask at once, and then answers a bot's apps from memory", async () => {
    fixture.hold = true;
    const readers = [cache.loadAppCatalog(), cache.loadAppCards(), cache.loadAppCards()];
    await settle();
    expect(fixture.requests).toBe(1);
    expect(cache.appCatalogMemory()).toBeNull();
    fixture.answers.shift()!();
    const [catalog, cards] = await Promise.all(readers) as [Awaited<ReturnType<typeof cache.loadAppCatalog>>, Map<string, unknown>, Map<string, unknown>];
    expect(catalog).toMatchObject({ source: "api", configured: true, mode: "managed", setup: "ready", pagination: { items: 1 } });
    expect(cards.get("gmail")).toBe(catalog.cards[0]);

    fixture.hold = false;
    expect(await cache.loadAppCards()).toBe(cards);
    expect(fixture.requests).toBe(1);
  });

  it("keeps the same cards when a later read brings the same list, and tells listeners of every read", async () => {
    const first = await cache.loadAppCatalog();
    const heard = vi.fn();
    const stop = cache.onAppCatalog(heard);
    const same = await cache.loadAppCatalog();
    expect(same.cards).toBe(first.cards);
    expect(cache.cardsBySlug(same)).toBe(cache.cardsBySlug(first));
    fixture.label = "Google Mail";
    const changed = await cache.loadAppCatalog();
    expect(changed.cards).not.toBe(first.cards);
    expect(changed.cards[0]!.label).toBe("Google Mail");
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    await cache.loadAppCatalog();
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("reads again when the server says its catalog changed, only where a copy is held or shown", async () => {
    signal.appCatalogAnnounced();
    await settle();
    expect(fixture.requests).toBe(0);

    await cache.loadAppCatalog();
    fixture.label = "Google Mail";
    signal.appCatalogAnnounced();
    await settle();
    expect(fixture.requests).toBe(2);
    expect(cache.appCatalogMemory()!.cards[0]!.label).toBe("Google Mail");
    expect((await cache.loadAppCards()).get("gmail")!.label).toBe("Google Mail");
    expect(fixture.requests).toBe(2);
  });

  it("answers no cards when the first read fails, keeps what it held when a later one does, and asks again", async () => {
    fixture.fail = true;
    expect((await cache.loadAppCards()).size).toBe(0);
    await expect(cache.loadAppCatalog()).rejects.toThrow("down");
    fixture.fail = false;
    expect((await cache.loadAppCards()).size).toBe(1);
    expect(fixture.requests).toBe(3);
    fixture.fail = true;
    await expect(cache.loadAppCatalog()).rejects.toThrow("down");
    expect((await cache.loadAppCards()).size).toBe(1);
  });
});

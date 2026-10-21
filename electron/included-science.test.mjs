import { describe, expect, it, vi } from "vitest";
import { createDesktopIncludedServices, createIncludedScienceSync } from "./included-science.mjs";

const HOUR = 3600_000, MIN = 60_000;
const section = (locked) => ({ version: 1, sections: [{ id: "science", title: "Science", locked, groups: [], entries: [] }] });
const tokenFor = (expiresAt) => ({ url: "https://cloud.example.com/api/cloud/services/science", token: `omb_sd_${"a".repeat(43)}`, expiresAt });
const state = (deviceId = "d1", version = 1) => ({ status: "connected", deviceId, entitlement: { plan: "pro", status: "active", tier: "max", version } });

function setup({ catalog = section(false), access } = {}) {
  let clock = 1_000_000_000;
  const sent = [];
  const fetchCatalog = vi.fn(async () => catalog);
  const fetchAccess = vi.fn(async () => (access === undefined ? tokenFor(clock + HOUR) : access));
  const sync = createIncludedScienceSync({ fetchCatalog, fetchAccess, send: (m) => sent.push(m), now: () => clock });
  return { sync, sent, fetchCatalog, fetchAccess, advance: (ms) => { clock += ms; }, clock: () => clock };
}
const types = (sent) => sent.map((m) => m.type.replace("openmausbot:", ""));

describe("science sync on the desktop", () => {
  it("fetches the catalog once per sign-in and plan version, and refreshes it after 6 hours", async () => {
    const t = setup();
    await t.sync.onState(state());
    await t.sync.onState(state());
    expect(t.fetchCatalog).toHaveBeenCalledTimes(1);
    await t.sync.onState(state("d1", 2));
    expect(t.fetchCatalog).toHaveBeenCalledTimes(2);
    t.advance(6 * HOUR - MIN);
    await t.sync.onState(state("d1", 2));
    expect(t.fetchCatalog).toHaveBeenCalledTimes(2);
    t.advance(MIN);
    await t.sync.onState(state("d1", 2));
    expect(t.fetchCatalog).toHaveBeenCalledTimes(3);
  });

  it("asks for a relay token only while the served Science section is unlocked", async () => {
    const locked = setup({ catalog: section(true) });
    await locked.sync.onState(state());
    expect(locked.fetchAccess).not.toHaveBeenCalled();
    expect(types(locked.sent)).toEqual(["science-catalog"]);
    const open = setup();
    await open.sync.onState(state());
    expect(open.fetchAccess).toHaveBeenCalledTimes(1);
    expect(types(open.sent)).toEqual(["science-catalog", "included-science"]);
    expect(open.sent[1].access.token).toMatch(/^omb_sd_/);
  });

  it("clears the access when the section turns locked", async () => {
    const t = setup();
    await t.sync.onState(state());
    t.fetchCatalog.mockResolvedValue(section(true));
    await t.sync.onState(state("d1", 2));
    expect(t.sent.at(-1)).toEqual({ type: "openmausbot:included-science", access: null });
  });

  it("renews before expiry", async () => {
    const t = setup();
    await t.sync.onState(state());
    const first = t.sent.at(-1).access;
    t.advance(HOUR - 16 * MIN);
    await t.sync.onState(state());
    expect(t.fetchAccess).toHaveBeenCalledTimes(1);
    t.advance(MIN);
    t.fetchAccess.mockRejectedValueOnce(new Error("offline"));
    const before = t.sent.length;
    await t.sync.onState(state());
    expect(t.fetchAccess).toHaveBeenCalledTimes(2);
    expect(t.sent).toHaveLength(before);
    t.sync.serverStarted();
    expect(t.sent.at(-1).access).toEqual(first);
    t.advance(MIN);
    await t.sync.onState(state());
    expect(t.fetchAccess).toHaveBeenCalledTimes(3);
    expect(t.sent.at(-1).access.expiresAt).toBe(t.clock() + HOUR);
  });

  it("backs off failed token requests: 1, 2 and 5 minutes, then every 10", async () => {
    const t = setup();
    t.fetchAccess.mockRejectedValue(new Error("offline"));
    await t.sync.onState(state());
    expect(t.fetchAccess).toHaveBeenCalledTimes(1);
    let calls = 1;
    for (const wait of [1, 2, 5, 10, 10]) {
      t.advance(wait * MIN - 1);
      await t.sync.onState(state());
      expect(t.fetchAccess).toHaveBeenCalledTimes(calls);
      t.advance(1);
      await t.sync.onState(state());
      expect(t.fetchAccess).toHaveBeenCalledTimes(++calls);
    }
    t.fetchAccess.mockResolvedValue(tokenFor(t.clock() + 20 * MIN));
    t.advance(10 * MIN);
    await t.sync.onState(state());
    expect(t.sent.at(-1).access.token).toMatch(/^omb_sd_/);
    t.fetchAccess.mockRejectedValue(new Error("offline"));
    t.advance(5 * MIN + 1);
    await t.sync.onState(state());
    expect(t.fetchAccess).toHaveBeenCalledTimes(calls + 2);
    t.advance(MIN);
    await t.sync.onState(state());
    expect(t.fetchAccess).toHaveBeenCalledTimes(calls + 3);
  });

  it("a new plan version asks for a token at once, whatever failed before", async () => {
    const t = setup();
    t.fetchAccess.mockRejectedValueOnce(new Error("offline"));
    await t.sync.onState(state());
    await t.sync.onState(state("d1", 2));
    expect(t.fetchAccess).toHaveBeenCalledTimes(2);
  });

  it("keeps renewing the token while the catalog refresh keeps failing", async () => {
    const t = setup();
    await t.sync.onState(state());
    t.advance(6 * HOUR);
    t.fetchCatalog.mockRejectedValue(new Error("offline"));
    await t.sync.onState(state());
    expect(t.fetchCatalog).toHaveBeenCalledTimes(2);
    expect(t.fetchAccess).toHaveBeenCalledTimes(2);
    expect(t.sent.at(-1).access.expiresAt).toBe(t.clock() + HOUR);
    t.advance(MIN);
    await t.sync.onState(state());
    expect(t.fetchCatalog).toHaveBeenCalledTimes(2);
  });

  it("a new plan version is not held back by an earlier failure", async () => {
    const t = setup();
    t.fetchCatalog.mockRejectedValueOnce(new Error("offline"));
    await t.sync.onState(state());
    await t.sync.onState(state("d1", 2));
    expect(t.fetchCatalog).toHaveBeenCalledTimes(2);
  });

  it("a refusal stands until the plan version changes", async () => {
    const t = setup({ access: null });
    await t.sync.onState(state());
    await t.sync.onState(state());
    expect(t.fetchAccess).toHaveBeenCalledTimes(1);
    expect(t.sent.filter((m) => m.type === "openmausbot:included-science")).toEqual([{ type: "openmausbot:included-science", access: null, offered: false }]);
    await t.sync.onState(state("d1", 2));
    expect(t.fetchAccess).toHaveBeenCalledTimes(2);
  });

  it("sign-out clears both", async () => {
    const t = setup();
    await t.sync.onState(state());
    await t.sync.onState({ status: "signed-out" });
    expect(t.sent.slice(-2)).toEqual([{ type: "openmausbot:science-catalog", catalog: null }, { type: "openmausbot:included-science", access: null }]);
    const n = t.sent.length;
    await t.sync.onState({ status: "signed-out" });
    expect(t.sent).toHaveLength(n);
  });

  it("sign-out during a request sends nothing from its answer", async () => {
    const t = setup();
    let finish;
    t.fetchAccess.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = t.sync.onState(state());
    await vi.waitFor(() => expect(finish).toBeDefined());
    await t.sync.onState({ status: "signed-out" });
    finish(tokenFor(t.clock() + HOUR));
    await first;
    expect(t.sent.filter((m) => m.access)).toEqual([]);
  });

  it("a failed catalog fetch sends nothing and is retried after 5 minutes", async () => {
    const t = setup();
    t.fetchCatalog.mockRejectedValueOnce(new Error("offline"));
    await t.sync.onState(state());
    expect(t.sent).toEqual([]);
    t.advance(5 * MIN - 1);
    await t.sync.onState(state());
    expect(t.fetchCatalog).toHaveBeenCalledTimes(1);
    t.advance(1);
    await t.sync.onState(state());
    expect(t.fetchCatalog).toHaveBeenCalledTimes(2);
    expect(types(t.sent)).toEqual(["science-catalog", "included-science"]);
  });

  it("a server restart gets the held catalog and token again, and nothing before then", async () => {
    const t = setup();
    t.sync.serverStarted();
    expect(t.sent).toEqual([]);
    await t.sync.onState(state());
    t.sync.serverStarted();
    expect(types(t.sent)).toEqual(["science-catalog", "included-science", "science-catalog", "included-science"]);
  });

  it("an answer for a state that changed meanwhile is dropped", async () => {
    const t = setup();
    let finish;
    t.fetchCatalog.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = t.sync.onState(state("d1"));
    await vi.waitFor(() => expect(finish).toBeDefined());
    const second = t.sync.onState(state("d2"));
    finish(section(true));
    await Promise.all([first, second]);
    expect(t.sent.filter((m) => m.catalog)).toHaveLength(1);
    expect(t.sent.filter((m) => m.catalog)[0].catalog.sections[0].locked).toBe(false);
  });
});

describe("desktop wiring", () => {
  it("posts science messages to the running server and runs the X sync too", async () => {
    const posted = [];
    const account = { xResearchAccess: vi.fn(async () => null), scienceCatalog: vi.fn(async () => section(true)), scienceAccess: vi.fn(async () => null) };
    const services = createDesktopIncludedServices({ account: () => account, server: () => ({ postMessage: (m) => posted.push(m) }), log: () => {} });
    await services.onState(state());
    expect(account.xResearchAccess).toHaveBeenCalled();
    expect(posted.map((m) => m.type)).toContain("openmausbot:science-catalog");
    const none = createDesktopIncludedServices({ account: () => account, server: () => null, log: () => {} });
    await expect(none.onState(state())).resolves.toBeUndefined();
  });
});

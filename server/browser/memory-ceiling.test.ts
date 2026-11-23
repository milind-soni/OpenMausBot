import { describe, expect, it } from "vitest";

import { ceilingLines, createBrowserCeiling, FORCE_OVER, mustForceClose, type BrowserCeilingDeps, type CeilingTab } from "./memory-ceiling.ts";

const MB = 1_048_576;

function harness(options: { sizes?: Record<number, number | null>; quiet?: boolean; tabs?: CeilingTab[] | null; closes?: boolean; short?: boolean; forces?: boolean } = {}) {
  const sizes: Record<number, number | null> = options.sizes ?? { 10: 300 * MB, 11: 500 * MB };
  const state = { now: 0, short: options.short ?? false, quiet: options.quiet ?? true, tabs: options.tabs === undefined ? [
    { tabId: "t1", title: "Inbox", url: "https://mail.example/", active: false },
    { tabId: "t2", title: "Report", url: "https://example.com/report", active: true },
    { tabId: "t3", title: "", url: "https://news.example/a", active: false },
  ] : options.tabs };
  const closedTabs: string[] = [], closed: string[] = [], forced: string[] = [], logs: string[] = [];
  const deps: BrowserCeilingDeps = {
    lines: { softBytes: 700 * MB, hardBytes: 1000 * MB },
    browsers: async () => [{ session: "bot-a", pids: Object.keys(sizes).map(Number), daemon: 10 }],
    pss: (pid) => sizes[pid] ?? null,
    quiet: () => state.quiet,
    tabs: async () => state.tabs,
    closeTab: async (_session, tabId) => { closedTabs.push(tabId); return true; },
    close: async (session) => { closed.push(session); return options.closes ?? true; },
    memoryShort: () => state.short,
    forceClose: async (browser, used) => { forced.push(`${browser.session} ${Math.round(used / MB)} MB, daemon ${browser.daemon}`); return options.forces ?? true; },
    log: (line) => logs.push(line),
    now: () => state.now,
  };
  return { ceiling: createBrowserCeiling(deps), state, sizes, closedTabs, closed, forced, logs };
}

describe("a bot browser's memory ceiling", () => {
  it("is a share of the server's memory, never below a browser on one page", () => {
    expect(ceilingLines(2048 * MB)).toEqual({ softBytes: Math.round(2048 * MB / 3), hardBytes: 1024 * MB });
    expect(ceilingLines(8192 * MB)).toEqual({ softBytes: Math.round(8192 * MB / 3), hardBytes: 4096 * MB });
    expect(ceilingLines(1024 * MB)).toEqual({ softBytes: 600 * MB, hardBytes: 900 * MB });
  });

  it("leaves a browser under its soft line alone", async () => {
    const run = harness({ sizes: { 10: 300 * MB, 11: 300 * MB } });
    await run.ceiling.tick();
    expect(run.closedTabs).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.ceiling.takeNote("bot-a")).toBeNull();
  });

  it("over its soft line closes only background tabs, between calls, and tells the bot once which", async () => {
    const run = harness();
    await run.ceiling.tick();
    expect(run.closedTabs).toEqual(["t1", "t3"]);
    expect(run.closed).toEqual([]);
    const note = run.ceiling.takeNote("bot-a")!;
    expect(note).toContain("800 MB");
    expect(note).toContain("Inbox (https://mail.example/)");
    expect(note).toContain("https://news.example/a");
    expect(note).not.toContain("Report");
    expect(note).toContain("take a new snapshot");
    expect(run.ceiling.takeNote("bot-a")).toBeNull();
  });

  it("waits while a call runs or a person holds the browser", async () => {
    const run = harness({ quiet: false });
    await run.ceiling.tick();
    expect(run.closedTabs).toEqual([]);
    run.state.quiet = true;
    await run.ceiling.tick();
    expect(run.closedTabs).toEqual(["t1", "t3"]);
  });

  it("acts on one browser at most once a minute", async () => {
    const run = harness();
    await run.ceiling.tick();
    run.closedTabs.length = 0;
    run.state.now = 30_000;
    await run.ceiling.tick();
    expect(run.closedTabs).toEqual([]);
    run.state.now = 61_000;
    await run.ceiling.tick();
    expect(run.closedTabs).toEqual(["t1", "t3"]);
  });

  it("over its hard line with no background tab to close, asks memory relief's close and logs what it kept", async () => {
    const run = harness({ sizes: { 10: 600 * MB, 11: 500 * MB }, tabs: [{ tabId: "t2", title: "Only", url: "https://example.com/", active: true }] });
    await run.ceiling.tick();
    expect(run.closed).toEqual(["bot-a"]);
    expect(run.logs.at(-1)).toMatch(/1100 MB, over its hard line of 1000 MB; closed it/u);
    const kept = harness({ sizes: { 10: 600 * MB, 11: 500 * MB }, tabs: [], closes: false });
    await kept.ceiling.tick();
    expect(kept.logs.at(-1)).toMatch(/kept open/u);
  });

  it("over its hard line closes background tabs first, and the browser only on a later look", async () => {
    const run = harness({ sizes: { 10: 600 * MB, 11: 500 * MB } });
    await run.ceiling.tick();
    expect(run.closedTabs).toEqual(["t1", "t3"]);
    expect(run.closed).toEqual([]);
    run.state.tabs = [{ tabId: "t2", title: "Report", url: "https://example.com/report", active: true }];
    run.state.now = 61_000;
    await run.ceiling.tick();
    expect(run.closed).toEqual(["bot-a"]);
  });

  it("measures nothing it cannot read, and survives a browser whose tabs do not answer", async () => {
    const unread = harness({ sizes: { 10: null } });
    await unread.ceiling.tick();
    expect(unread.closedTabs).toEqual([]);
    const silent = harness({ tabs: null });
    await silent.ceiling.tick();
    expect(silent.closedTabs).toEqual([]);
    expect(silent.ceiling.takeNote("bot-a")).toBeNull();
  });

  it("closes a browser whatever holds it only over its hard line with memory short, or a quarter over it", () => {
    const lines = { softBytes: 700 * MB, hardBytes: 1000 * MB };
    const table: Array<[number, boolean, boolean]> = [
      // used MB, memory short, closed whatever holds it
      [690, true, false], [900, true, false], [999, true, false],
      [1000, true, true], [1100, true, true],
      [1000, false, false], [1249, false, false],
      [1250, false, true], [3000, false, true],
    ];
    for (const [used, short, force] of table) expect([used, short, mustForceClose(used * MB, lines, short)]).toEqual([used, short, force]);
    expect(FORCE_OVER).toBe(1.25);
  });

  it("a turn's browser over its hard line on a healthy machine is kept open, as before", async () => {
    const run = harness({ sizes: { 10: 600 * MB, 11: 500 * MB }, quiet: false, closes: false });
    await run.ceiling.tick();
    expect(run.forced).toEqual([]);
    expect(run.logs.at(-1)).toMatch(/kept open/u);
  });

  it("over its hard line with memory short, a turn's browser is closed at once, with no minute's wait after a refused close", async () => {
    const run = harness({ sizes: { 10: 600 * MB, 11: 500 * MB }, quiet: false, closes: false });
    await run.ceiling.tick();
    expect(run.forced).toEqual([]);
    run.state.short = true;
    run.state.now = 3_000;
    await run.ceiling.tick();
    expect(run.forced).toEqual(["bot-a 1100 MB, daemon 10"]);
    expect(run.logs.at(-1)).toMatch(/1100 MB, over its hard line of 1000 MB with memory short; closed it at once/u);
  });

  it("a quarter over its hard line, a turn's browser is closed with memory plentiful", async () => {
    const run = harness({ sizes: { 10: 800 * MB, 11: 500 * MB }, quiet: false });
    await run.ceiling.tick();
    expect(run.forced).toEqual(["bot-a 1300 MB, daemon 10"]);
    expect(run.logs.at(-1)).toMatch(/over its hard line of 1000 MB by 30%; closed it at once/u);
    expect(run.closedTabs).toEqual([]);
  });

  it("falls back to the usual steps when the forced close fails, and tries it again on the next look", async () => {
    const run = harness({ sizes: { 10: 800 * MB, 11: 500 * MB }, quiet: false, forces: false, closes: false });
    await run.ceiling.tick();
    expect(run.logs.at(-1)).toMatch(/kept open/u);
    run.state.now = 3_000;
    await run.ceiling.tick();
    expect(run.forced).toHaveLength(2);
  });

  it("asks for a sooner look only while a browser is over its soft line", async () => {
    expect(await harness({ sizes: { 10: 300 * MB, 11: 300 * MB } }).ceiling.tick()).toBe(false);
    expect(await harness().ceiling.tick()).toBe(true);
    expect(await harness({ sizes: { 10: 800 * MB, 11: 500 * MB } }).ceiling.tick()).toBe(true);
  });
});

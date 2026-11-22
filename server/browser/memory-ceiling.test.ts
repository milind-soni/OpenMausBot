import { describe, expect, it } from "vitest";

import { ceilingLines, createBrowserCeiling, type BrowserCeilingDeps, type CeilingTab } from "./memory-ceiling.ts";

const MB = 1_048_576;

function harness(options: { sizes?: Record<number, number | null>; quiet?: boolean; tabs?: CeilingTab[] | null; closes?: boolean } = {}) {
  const sizes: Record<number, number | null> = options.sizes ?? { 10: 300 * MB, 11: 500 * MB };
  const state = { now: 0, quiet: options.quiet ?? true, tabs: options.tabs === undefined ? [
    { tabId: "t1", title: "Inbox", url: "https://mail.example/", active: false },
    { tabId: "t2", title: "Report", url: "https://example.com/report", active: true },
    { tabId: "t3", title: "", url: "https://news.example/a", active: false },
  ] : options.tabs };
  const closedTabs: string[] = [], closed: string[] = [], logs: string[] = [];
  const deps: BrowserCeilingDeps = {
    lines: { softBytes: 700 * MB, hardBytes: 1000 * MB },
    browsers: async () => [{ session: "bot-a", pids: Object.keys(sizes).map(Number) }],
    pss: (pid) => sizes[pid] ?? null,
    quiet: () => state.quiet,
    tabs: async () => state.tabs,
    closeTab: async (_session, tabId) => { closedTabs.push(tabId); return true; },
    close: async (session) => { closed.push(session); return options.closes ?? true; },
    log: (line) => logs.push(line),
    now: () => state.now,
  };
  return { ceiling: createBrowserCeiling(deps), state, sizes, closedTabs, closed, logs };
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
});

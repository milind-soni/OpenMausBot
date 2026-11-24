import { describe, expect, it, vi } from "vitest";

import { ceilingLines, createBrowserCeiling, killChrome, mustForceClose, startCeilingLoop, statmBytes, type BrowserCeilingDeps, type CeilingTab } from "./memory-ceiling.ts";

const MB = 1_048_576;

function harness(options: { sizes?: Record<number, number | null>; quiet?: boolean; tabs?: CeilingTab[] | null; closes?: boolean; short?: boolean; tight?: boolean; forces?: boolean; quick?: number } = {}) {
  const sizes: Record<number, number | null> = options.sizes ?? { 10: 300 * MB, 11: 500 * MB };
  const state = { now: 0, short: options.short ?? false, tight: options.tight ?? false, quiet: options.quiet ?? true, tabs: options.tabs === undefined ? [
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
    memoryShort: (times = 1) => state.short || (times >= 2 && state.tight),
    ...(options.quick === undefined ? {} : { quickSize: () => options.quick! * MB }),
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

  it("closes a browser whatever holds it only over its hard line with memory short, never for its size alone", () => {
    const lines = { softBytes: 700 * MB, hardBytes: 1000 * MB };
    const table: Array<[number, boolean, boolean]> = [
      // used MB, memory short, closed whatever holds it
      [690, true, false], [999, true, false],
      [1000, true, true], [1100, true, true],
      [1000, false, false], [1250, false, false], [9800, false, false],
    ];
    for (const [used, short, force] of table) expect([used, short, mustForceClose(used * MB, lines, short)]).toEqual([used, short, force]);
  });

  it("a turn's browser over its hard line on a healthy machine is kept open, as before", async () => {
    const run = harness({ sizes: { 10: 600 * MB, 11: 500 * MB }, quiet: false, closes: false });
    await run.ceiling.tick();
    expect(run.forced).toEqual([]);
    expect(run.logs.at(-1)).toMatch(/kept open/u);
  });

  it("however large a turn's browser grows, with memory plentiful it is kept", async () => {
    const run = harness({ sizes: { 10: 1800 * MB, 11: 700 * MB }, quiet: false, closes: false });
    await run.ceiling.tick();
    expect(run.forced).toEqual([]);
    expect(run.logs.at(-1)).toMatch(/2500 MB, over its hard line of 1000 MB; kept open/u);
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

  it("with memory short, sizes a browser without its memory map's lock", async () => {
    const run = harness({ sizes: { 10: 100 * MB, 11: 100 * MB }, quiet: false, short: true, quick: 1500 });
    await run.ceiling.tick();
    expect(run.forced).toEqual(["bot-a 1500 MB, daemon 10"]);
  });

  it("falls back to the usual steps when the forced close fails, and tries it again on the next look", async () => {
    const run = harness({ sizes: { 10: 800 * MB, 11: 500 * MB }, quiet: false, short: true, forces: false, closes: false });
    await run.ceiling.tick();
    expect(run.logs.at(-1)).toMatch(/kept open/u);
    run.state.now = 3_000;
    await run.ceiling.tick();
    expect(run.forced).toHaveLength(2);
  });

  it("asks for a sooner look only while a browser is over its soft line and memory is under twice the floor", async () => {
    expect(await harness({ sizes: { 10: 300 * MB, 11: 300 * MB }, tight: true }).ceiling.tick()).toBe(false);
    expect(await harness().ceiling.tick()).toBe(false);
    expect(await harness({ tight: true }).ceiling.tick()).toBe(true);
  });

  it("looks every 15 s, and 3 s after a look that asks for a sooner one", async () => {
    vi.useFakeTimers();
    try {
      const answers = [true, false, false];
      const at: number[] = [];
      const loop = startCeilingLoop(async () => { at.push(Date.now()); return answers.shift() ?? false; });
      const start = Date.now();
      for (let i = 0; i < 4; i++) await vi.advanceTimersToNextTimerAsync();
      loop.stop();
      expect(at.map((time) => time - start)).toEqual([15_000, 18_000, 33_000, 48_000]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(at).toHaveLength(4);
    } finally { vi.useRealTimers(); }
  });

  it("sizes a browser from statm: each process's own pages, and the shared ones once", () => {
    const files: Record<string, string> = { "/proc/10/statm": "1000 300 100 1 0 200 0\n", "/proc/11/statm": "2000 500 150 1 0 400 0\n" };
    const read = (path: string) => { if (!(path in files)) throw new Error("gone"); return files[path]!; };
    expect(statmBytes([10, 11, 12], read)).toBe((200 + 350 + 150) * 4096);
    expect(statmBytes([12], read)).toBeNull();
  });

  it("kills a browser's Chrome, never its daemon, a zombie, or a pid that now runs another program", () => {
    const stat = (state: string, started: string) => `1 (chrome --type=renderer (x)) ${state} 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${started} 0 0`;
    const files: Record<string, string> = { "/proc/10/stat": stat("S", "500"), "/proc/11/stat": stat("S", "600"), "/proc/12/stat": stat("S", "999"), "/proc/13/stat": stat("Z", "700"), "/proc/15/stat": stat("S", "800") };
    const killed: string[] = [];
    const count = killChrome({ session: "bot-a", pids: [10, 11, 12, 13, 14, 15], daemon: 10, started: new Map([[10, "500"], [11, "600"], [12, "650"], [13, "700"], [14, "750"]]) },
      (path) => { if (!(path in files)) throw new Error("gone"); return files[path]!; }, (pid, signal) => killed.push(`${pid} ${signal}`));
    // 12 was reused, 13 has exited, 14 is gone, 15 has no start time listed.
    expect(killed).toEqual(["11 SIGKILL"]);
    expect(count).toBe(1);
  });

  it("after the kernel kills at the browsers' limit, closes the browser that lost processes, with the turn that held it", async () => {
    let kills = 0;
    const contained: string[] = [];
    const sizes: Record<number, number> = { 10: 30 * MB, 11: 200 * MB, 12: 400 * MB };
    const forced: string[] = [];
    const ceiling = createBrowserCeiling({
      lines: { softBytes: 700 * MB, hardBytes: 1000 * MB },
      browsers: async () => [{ session: "bot-a", pids: Object.keys(sizes).map(Number), daemon: 10 }, { session: "bot-b", pids: [20, 21], daemon: 20 }],
      pss: (pid) => sizes[pid] ?? (pid >= 20 ? 100 * MB : null),
      quiet: () => false, tabs: async () => [], closeTab: async () => false, close: async () => false,
      forceClose: async (browser, used) => { forced.push(`${browser.session} [${browser.pids.join(",")}] ${Math.round(used / MB)} MB`); return true; },
      kernelKills: () => kills,
      contain: (browser) => contained.push(browser.session),
      log: () => {},
    });
    await ceiling.tick();
    expect(forced).toEqual([]);
    expect(contained).toEqual(["bot-a", "bot-b"]);
    // The kernel killed bot-a's largest renderer at the group's limit.
    delete sizes[12];
    kills = 1;
    await ceiling.tick();
    expect(forced).toEqual(["bot-a [10,11] 630 MB"]);
    // No new kill: nothing more is closed.
    await ceiling.tick();
    expect(forced).toHaveLength(1);
  });

  function twoBrowsers() {
    let kills = 0;
    const a: Record<number, number> = { 10: 30 * MB, 11: 200 * MB, 12: 400 * MB };
    const b: Record<number, number> = { 20: 30 * MB, 21: 800 * MB, 22: 20 * MB };
    const forced: string[] = [];
    const ceiling = createBrowserCeiling({
      lines: { softBytes: 700 * MB, hardBytes: 1000 * MB },
      browsers: async () => [{ session: "bot-a", pids: Object.keys(a).map(Number), daemon: 10 }, { session: "bot-b", pids: Object.keys(b).map(Number), daemon: 20 }],
      pss: (pid) => a[pid] ?? b[pid] ?? null,
      quiet: () => false, tabs: async () => [], closeTab: async () => false, close: async () => false,
      forceClose: async (browser) => { forced.push(browser.session); return true; },
      kernelKills: () => kills,
      log: () => {},
    });
    return { ceiling, a, b, forced, kill: () => { kills += 1; } };
  }

  it("after a kernel kill, closes the browser whose lost process was the victim, not one that swapped a small renderer", async () => {
    const run = twoBrowsers();
    await run.ceiling.tick();
    // The kernel kills bot-a's 400 MB renderer while bot-b swaps a 20 MB renderer on a normal navigation.
    delete run.a[12];
    delete run.b[22]; run.b[23] = 20 * MB;
    run.kill();
    await run.ceiling.tick();
    expect(run.forced).toEqual(["bot-a"]);
  });

  it("closes nothing when no process lost since could have been the victim, and looks once more against the earlier look", async () => {
    const run = twoBrowsers();
    await run.ceiling.tick();
    // The kill is counted before its victim is reaped: only a small renderer is gone at this look.
    delete run.b[22];
    run.kill();
    await run.ceiling.tick();
    expect(run.forced).toEqual([]);
    // Reaped by the next look: found against the sizes from before the kill.
    delete run.a[12];
    await run.ceiling.tick();
    expect(run.forced).toEqual(["bot-a"]);
  });

  it("lets a kill nothing explains go after one more look, so a later large loss is not taken for it", async () => {
    const run = twoBrowsers();
    await run.ceiling.tick();
    delete run.b[22];
    run.kill();
    await run.ceiling.tick();
    await run.ceiling.tick();
    expect(run.forced).toEqual([]);
    // bot-b closes its 800 MB tab itself afterwards, with no new kill: nothing is closed for it.
    delete run.b[21];
    await run.ceiling.tick();
    expect(run.forced).toEqual([]);
  });
});

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createConversationFolderCleanup, type LiveRecords } from "./conversation-folder-cleanup.ts";
import { describeOrphanReport, orphanSweepMaxShare, orphanSweepMode, sweepOrphans, type OrphanSweepDeps, type OrphanSweepMode } from "./orphan-sweep.ts";

const DAY = 24 * 60 * 60 * 1000;
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(path: string, text = "x"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** Sets everything under `path` (itself included) to `days` ago, never through a link. */
function age(path: string, days: number): void {
  const at = new Date(Date.now() - days * DAY);
  const walk = (one: string) => {
    const stats = lstatSync(one);
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) for (const name of readdirSync(one)) walk(join(one, name));
    utimesSync(one, at, at);
  };
  walk(path);
}

function fixture(over: Partial<OrphanSweepDeps> = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "omb-orphan-sweep-"));
  made.push(sandbox);
  const dataDir = join(sandbox, "data");
  const outside = join(sandbox, "outside");
  mkdirSync(outside, { recursive: true });
  const bots: Array<LiveRecords["bots"][number]> = [{ id: "scout", tasks: [{ threadId: "live" }] }];
  const groups: Array<LiveRecords["groups"][number]> = [];
  const stored = new Set<string>(["live", "only-in-transcripts"]);
  const records = () => ({ bots, groups });
  // The same pause the server gives both (index.ts).
  const cleanup = createConversationFolderCleanup({ dataDir, records, paused: () => over.paused?.() ?? null, drainAfterMs: false, pause: async () => {}, log: () => {}, warn: () => {} });
  let now = Date.now();
  let mode: OrphanSweepMode = "report";
  const warnings: string[] = [];
  const deps: OrphanSweepDeps = {
    dataDir, mode: () => mode, records, storedThreadIds: async () => stored, cleanup, maxShare: () => 100, now: () => now, pause: async () => {}, log: () => {},
    warn: (line) => { warnings.push(line); },
    ...over,
  };
  const install = (at: string, size = "1234") => {
    put(join(at, "package.json"), "{}");
    put(join(at, "node_modules", ".package-lock.json"), "{}");
    return put(join(at, "node_modules", "x", "index.js"), size);
  };
  const files = {
    orphanResults: put(join(dataDir, "tool-results", "gone1", "r.txt"), "12345"),
    liveResults: put(join(dataDir, "tool-results", "live", "r.txt")),
    transcriptResults: put(join(dataDir, "tool-results", "only-in-transcripts", "r.txt")),
    gateFallback: put(join(dataDir, "tool-results", "thread", "r.txt")),
    orphanEvents: put(join(dataDir, "events", "gone1.ndjson"), "1234567890"),
    orphanNative: put(join(dataDir, "native", "gone2.ndjson"), "12345"),
    liveEvents: put(join(dataDir, "events", "live.ndjson")),
    transcriptEvents: put(join(dataDir, "events", "only-in-transcripts.ndjson")),
    orphanWork: put(join(dataDir, "task-workspaces", "scout", "gone1", "report.md"), "abc"),
    orphanDeps: install(join(dataDir, "task-workspaces", "scout", "gone1", "app")),
    deletedBotDeps: install(join(dataDir, "task-workspaces", "removed-bot", "gone5")),
    liveDeps: install(join(dataDir, "task-workspaces", "scout", "live")),
    transcriptDeps: install(join(dataDir, "task-workspaces", "scout", "only-in-transcripts")),
  };
  age(dataDir, 30);
  const sweep = () => sweepOrphans(deps);
  /** `count` passes, one a day; the report of the last. */
  const daily = async (count: number) => {
    let last;
    for (let i = 0; i < count; i++) { last = await sweep(); now += DAY; }
    now -= DAY;
    return last!;
  };
  const later = (days: number) => { now += days * DAY; };
  const state = () => JSON.parse(readFileSync(join(dataDir, "orphan-sweep.json"), "utf8")) as { seen: Record<string, { first: number; days: string[] }>; mode: string; cursor?: string; last: { at: number } };
  return { sandbox, dataDir, outside, bots, groups, stored, files, warnings, sweep, daily, later, state, install, setMode: (next: OrphanSweepMode) => { mode = next; }, nowIs: () => now };
}
type Fixture = ReturnType<typeof fixture>;

const present = (paths: Record<string, string>) => Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, existsSync(path)]));
const allThere = (f: Fixture) => Object.values(present(f.files)).every(Boolean);

describe("the orphan sweep's switches", () => {
  it("is off unless set, and reads report (or dry-run) and remove", () => {
    expect(orphanSweepMode({})).toBe("off");
    expect(orphanSweepMode({ OMB_ORPHAN_SWEEP: "yes" })).toBe("off");
    expect(orphanSweepMode({ OMB_ORPHAN_SWEEP: " Report " })).toBe("report");
    expect(orphanSweepMode({ OMB_ORPHAN_SWEEP: "dry-run" })).toBe("report");
    expect(orphanSweepMode({ OMB_ORPHAN_SWEEP: "remove" })).toBe("remove");
  });

  it("removes at most 10% of the conversations on disk unless told otherwise", () => {
    expect(orphanSweepMaxShare({})).toBe(10);
    expect(orphanSweepMaxShare({ OMB_ORPHAN_SWEEP_MAX_SHARE: "60" })).toBe(60);
    expect(orphanSweepMaxShare({ OMB_ORPHAN_SWEEP_MAX_SHARE: "lots" })).toBe(10);
    expect(orphanSweepMaxShare({ OMB_ORPHAN_SWEEP_MAX_SHARE: "150" })).toBe(10);
  });

  it("off: reads and changes nothing", async () => {
    const f = fixture();
    f.setMode("off");
    expect((await f.sweep()).skipped).toBe("off");
    expect(allThere(f)).toBe(true);
    expect(existsSync(join(f.dataDir, "orphan-sweep.json"))).toBe(false);
  });
});

describe("report", () => {
  it("counts only orphans, with their bytes, and changes nothing", async () => {
    const f = fixture();
    const report = await f.sweep();
    expect(report.toolResults).toEqual({ count: 1, bytes: 5 });
    expect(report.eventLogs).toEqual({ count: 2, bytes: 15 });
    expect(report.workspaces.folders).toBe(2);
    expect(report.workspaces.rebuildableBytes).toBeGreaterThanOrEqual(8);
    expect(report.workspaces.keptFileBytes).toBeGreaterThanOrEqual(3);
    expect(report.conversations).toEqual({ onDisk: 5, orphaned: 3 });
    expect(report.removed).toBe(false);
    expect(allThere(f)).toBe(true);
    expect(describeOrphanReport(report)).toMatch(/^orphan sweep \(report\): conversations on disk 5, orphaned 3; tool results 1 folder/);
    expect(Object.keys(f.state().seen).sort()).toEqual(["events:gone1", "native:gone2", "results:gone1", "workspace:removed-bot/gone5", "workspace:scout/gone1"]);
    expect(f.state().mode).toBe("report");
  });
});

describe("remove", () => {
  it("waits a week and seven passes on different days, then removes orphans and keeps the person's files and everything live", async () => {
    const f = fixture();
    f.setMode("remove");
    expect((await f.daily(7)).waiting).toBe(5);
    expect(allThere(f)).toBe(true);
    f.later(1);
    const due = await f.sweep();
    expect(due.waiting).toBe(0);
    expect(due.removed).toBe(true);
    expect(present(f.files)).toEqual({
      orphanResults: false, liveResults: true, transcriptResults: true, gateFallback: true,
      orphanEvents: false, orphanNative: false, liveEvents: true, transcriptEvents: true,
      orphanWork: true, orphanDeps: false, deletedBotDeps: false, liveDeps: true, transcriptDeps: true,
    });
  });

  it("is not hurried by a clock that jumps ahead", async () => {
    const f = fixture();
    f.setMode("remove");
    await f.sweep();
    f.later(30);
    expect((await f.sweep()).waiting).toBe(5);
    expect(allThere(f)).toBe(true);
  });

  it("starts over on notes from the future, from another machine, or from report mode", async () => {
    // The next pass is dated before the notes' last one (a clock set back): they are dropped.
    const restored = fixture();
    restored.setMode("remove");
    await restored.sweep();
    const notes = restored.state();
    writeFileSync(join(restored.dataDir, "orphan-sweep.json"), JSON.stringify({ ...notes, last: { ...notes.last, at: restored.nowIs() + 30 * DAY },
      seen: Object.fromEntries(Object.keys(notes.seen).map((key) => [key, { first: restored.nowIs() - 30 * DAY, days: Array.from({ length: 7 }, (_, i) => new Date(restored.nowIs() - (i + 1) * DAY).toISOString().slice(0, 10)) }])) }));
    expect((await restored.sweep()).waiting).toBe(5);
    expect(allThere(restored)).toBe(true);

    const copied = fixture();
    copied.setMode("remove");
    put(join(copied.dataDir, "environment-id"), "machine-a");
    await copied.daily(8);
    expect(existsSync(copied.files.orphanEvents)).toBe(false);
    const other = fixture();
    other.setMode("remove");
    put(join(other.dataDir, "environment-id"), "machine-b");
    await other.daily(7);
    const aged = other.state();
    put(join(other.dataDir, "environment-id"), "machine-c");
    writeFileSync(join(other.dataDir, "orphan-sweep.json"), JSON.stringify(aged));
    other.later(1);
    expect((await other.sweep()).waiting).toBe(5);

    const reported = fixture();
    await reported.daily(8);
    reported.setMode("remove");
    reported.later(1);
    expect((await reported.sweep()).waiting).toBe(5);
    expect(allThere(reported)).toBe(true);
  });

  it("clamps a first sight noted in the future to now", async () => {
    const f = fixture();
    f.setMode("remove");
    await f.sweep();
    const notes = f.state();
    for (const key of Object.keys(notes.seen)) notes.seen[key] = { first: f.nowIs() + 365 * DAY, days: [] };
    writeFileSync(join(f.dataDir, "orphan-sweep.json"), JSON.stringify(notes));
    f.later(1);
    await f.daily(8);
    expect(existsSync(f.files.orphanEvents)).toBe(false);
  });

  it("keeps an orphan changed within the week, however long it has been known", async () => {
    const f = fixture();
    f.setMode("remove");
    await f.daily(7);
    f.later(1);
    const recent = new Date(f.nowIs() - DAY);
    utimesSync(put(f.files.orphanEvents, "written again"), recent, recent);
    utimesSync(put(join(dirname(f.files.orphanDeps), "fresh.js")), recent, recent);
    await f.sweep();
    expect(existsSync(f.files.orphanEvents)).toBe(true);
    expect(existsSync(f.files.orphanDeps)).toBe(true);
    expect(existsSync(f.files.orphanResults)).toBe(false);
  });

  it("keeps a folder a remaining conversation works in, and tool results a remaining thread's results share", async () => {
    const f = fixture();
    const long = `${"g".repeat(80)}x`;
    const shared = put(join(f.dataDir, "tool-results", "g".repeat(80), "r.txt"));
    age(dirname(shared), 30);
    f.bots.push({ id: "fork-bot", tasks: [{ threadId: long, cwd: join(f.dataDir, "task-workspaces", "scout", "gone1") }] });
    f.setMode("remove");
    const report = await f.daily(8);
    expect(report.workspaces.folders).toBe(1);
    expect(existsSync(f.files.orphanDeps)).toBe(true);
    expect(existsSync(shared)).toBe(true);
    expect(existsSync(f.files.deletedBotDeps)).toBe(false);
  });

  it("treats an archived bot's conversations as live", async () => {
    const f = fixture();
    f.bots.push({ id: "archived", hidden: true, tasks: [{ threadId: "kept-thread" }] } as LiveRecords["bots"][number]);
    const deps = f.install(join(f.dataDir, "task-workspaces", "archived", "kept-thread"));
    age(join(f.dataDir, "task-workspaces", "archived"), 30);
    f.setMode("remove");
    await f.daily(8);
    expect(existsSync(deps)).toBe(true);
  });
});

describe("failing closed", () => {
  it("does nothing while the transcripts cannot be read or no conversation is registered", async () => {
    const unreadable = fixture({ storedThreadIds: async () => { throw new Error("database is locked"); } });
    unreadable.setMode("remove");
    expect((await unreadable.sweep()).skipped).toMatch(/transcripts could not be read: database is locked/);
    expect(allThere(unreadable)).toBe(true);
    const empty = fixture();
    empty.bots.splice(0);
    empty.setMode("remove");
    expect((await empty.sweep()).skipped).toBe("no conversation is registered");
    expect(allThere(empty)).toBe(true);
  });

  it("reports only, loudly, when more than its share of the conversations on disk look orphaned", async () => {
    const f = fixture({ maxShare: () => 50 });
    f.setMode("remove");
    const report = await f.daily(8);
    expect(report.held).toMatch(/3 of 5 conversations on disk look orphaned \(60%, more than 50%\)/);
    expect(describeOrphanReport(report)).toMatch(/REMOVED NOTHING/);
    expect(f.warnings.join("\n")).toMatch(/records may be unreadable/);
    expect(allThere(f)).toBe(true);
  });

  it("does nothing while the workspace must not change, checked again before each removal", async () => {
    let paused: string | null = null;
    const f = fixture({ paused: () => paused });
    f.setMode("remove");
    await f.daily(7);
    f.later(1);
    paused = "frozen after a move";
    expect((await f.sweep()).skipped).toBe("frozen after a move");
    expect(allThere(f)).toBe(true);
    // Not paused when the pass starts, nor at the last look before removing, but at each removal itself.
    let asks = 0, counting = false;
    const g = fixture({ paused: () => (counting && ++asks > 2 ? "a backup is being made or restored" : null) });
    g.setMode("remove");
    await g.daily(7);
    g.later(1);
    counting = true;
    const report = await g.sweep();
    expect(report.removed).toBe(true);
    expect(allThere(g)).toBe(true);
    // And at the last look before removing: nothing is handed over.
    let looks = 0;
    const h = fixture({ paused: () => (counting && ++looks === 2 ? "frozen after a move" : null) });
    h.setMode("remove");
    counting = false;
    await h.daily(7);
    h.later(1);
    counting = true;
    expect((await h.sweep()).held).toBe("frozen after a move");
    expect(allThere(h)).toBe(true);
  });

  it("checks an event log again just before removing it: come back, or no longer a plain file", async () => {
    let step = 0, armed = false;
    const f = fixture({
      paused: () => {
        if (armed && ++step === 3) {
          f.bots.push({ id: "merged", tasks: [{ threadId: "gone1" }] });
          unlinkSync(f.files.orphanNative);
          symlinkSync(put(join(f.outside, "precious.ndjson")), f.files.orphanNative);
        }
        return null;
      },
    });
    f.setMode("remove");
    await f.daily(7);
    f.later(1);
    armed = true;
    await f.sweep();
    expect(step).toBeGreaterThanOrEqual(3);
    expect(existsSync(f.files.orphanEvents)).toBe(true);
    expect(lstatSync(f.files.orphanNative).isSymbolicLink()).toBe(true);
    expect(existsSync(join(f.outside, "precious.ndjson"))).toBe(true);
  });

  it("never follows a link out of the data folder, in its listings or its measures", async () => {
    const f = fixture();
    const victims = [put(join(f.outside, "results", "r.txt"), "x".repeat(10_000)), put(join(f.outside, "log.ndjson")), f.install(join(f.outside, "bot", "t9"))];
    symlinkSync(join(f.outside, "results"), join(f.dataDir, "tool-results", "linked"), "dir");
    symlinkSync(join(f.outside, "results"), join(f.dataDir, "tool-results", "gone1", "inner-link"), "dir");
    symlinkSync(join(f.outside, "log.ndjson"), join(f.dataDir, "events", "linked.ndjson"));
    symlinkSync(join(f.outside, "bot"), join(f.dataDir, "task-workspaces", "linked-bot"), "dir");
    f.setMode("remove");
    const first = await f.sweep();
    expect(first.toolResults.count).toBe(1);
    expect(first.toolResults.bytes).toBeLessThan(1_000);
    expect(first.eventLogs.count).toBe(2);
    expect(first.conversations.onDisk).toBe(6);
    // The links were made after the fixture's clock was read: one more day for their own week.
    await f.daily(9);
    expect(victims.filter((path) => !existsSync(path))).toEqual([]);
    expect(existsSync(f.files.orphanResults)).toBe(false);
  });

  it("keeps an item past its own budget, and carries on after a pass that ran out of budget", async () => {
    const small = fixture({ limits: { perItem: 3 } });
    small.setMode("remove");
    const report = await small.daily(8);
    expect(report.tooLarge).toBeGreaterThan(0);
    expect(existsSync(small.files.orphanDeps)).toBe(true);
    expect(existsSync(small.files.orphanEvents)).toBe(false);

    const short = fixture({ limits: { perPass: 12 } });
    const partial = await short.sweep();
    expect(partial.partial).toBe(true);
    const cursor = short.state().cursor;
    expect(cursor).toBeTruthy();
    short.later(1);
    const next = await short.sweep();
    expect(next.partial).toBe(true);
    expect(short.state().cursor).not.toBe(cursor);
    expect(describeOrphanReport(next)).toMatch(/stopped at its budget/);
  });

  it("leaves everything when a pass stops in the middle, and the next pass carries on", async () => {
    let crash = true;
    const f = fixture({ pause: async () => { if (crash) throw new Error("power cut"); } });
    for (let i = 0; i < 5_000; i++) put(join(f.dataDir, "task-workspaces", "scout", "gone1", "app", "node_modules", "big", `${i}.js`));
    age(join(f.dataDir, "task-workspaces"), 30);
    f.setMode("remove");
    await expect(f.sweep()).rejects.toThrow(/power cut/);
    expect(allThere(f)).toBe(true);
    crash = false;
    await f.daily(8);
    expect(existsSync(f.files.orphanDeps)).toBe(false);
    expect(existsSync(f.files.orphanWork)).toBe(true);
  });
});

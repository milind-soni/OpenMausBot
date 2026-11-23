import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createConversationFolderCleanup, type LiveRecords } from "./conversation-folder-cleanup.ts";
import { describeOrphanReport, orphanSweepMode, sweepOrphans, type OrphanSweepDeps, type OrphanSweepMode } from "./orphan-sweep.ts";

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
  const cleanup = createConversationFolderCleanup({ dataDir, records, drainAfterMs: false, pause: async () => {}, log: () => {}, warn: () => {} });
  let now = Date.now();
  let mode: OrphanSweepMode = "report";
  const deps: OrphanSweepDeps = {
    dataDir, mode: () => mode, records, storedThreadIds: () => stored, cleanup, now: () => now, pause: async () => {}, log: () => {}, warn: () => {},
    ...over,
  };
  const files = {
    orphanResults: put(join(dataDir, "tool-results", "gone1", "r.txt"), "12345"),
    liveResults: put(join(dataDir, "tool-results", "live", "r.txt")),
    transcriptResults: put(join(dataDir, "tool-results", "only-in-transcripts", "r.txt")),
    orphanEvents: put(join(dataDir, "events", "gone1.ndjson"), "1234567890"),
    orphanNative: put(join(dataDir, "native", "gone2.ndjson"), "12345"),
    liveEvents: put(join(dataDir, "events", "live.ndjson")),
    transcriptEvents: put(join(dataDir, "events", "only-in-transcripts.ndjson")),
    orphanWork: put(join(dataDir, "task-workspaces", "scout", "gone1", "report.md"), "abc"),
    orphanDeps: put(join(dataDir, "task-workspaces", "scout", "gone1", "app", "node_modules", "x", "index.js"), "1234"),
    deletedBotDeps: put(join(dataDir, "task-workspaces", "removed-bot", "gone3", "node_modules", "y.js"), "12"),
    liveDeps: put(join(dataDir, "task-workspaces", "scout", "live", "node_modules", "z.js")),
    transcriptDeps: put(join(dataDir, "task-workspaces", "scout", "only-in-transcripts", "node_modules", "z.js")),
  };
  age(dataDir, 30);
  const sweep = () => sweepOrphans(deps);
  return { dataDir, outside, bots, groups, stored, files, sweep, setMode: (next: OrphanSweepMode) => { mode = next; }, later: (days: number) => { now += days * DAY; } };
}

const present = (paths: Record<string, string>) => Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, existsSync(path)]));

describe("the orphan sweep's switch", () => {
  it("is off unless set, and reads report (or dry-run) and remove", () => {
    expect(orphanSweepMode({})).toBe("off");
    expect(orphanSweepMode({ OMB_ORPHAN_SWEEP: "yes" })).toBe("off");
    expect(orphanSweepMode({ OMB_ORPHAN_SWEEP: " Report " })).toBe("report");
    expect(orphanSweepMode({ OMB_ORPHAN_SWEEP: "dry-run" })).toBe("report");
    expect(orphanSweepMode({ OMB_ORPHAN_SWEEP: "remove" })).toBe("remove");
  });

  it("off: reads and changes nothing", async () => {
    const f = fixture();
    f.setMode("off");
    const report = await f.sweep();
    expect(report.skipped).toBe("off");
    expect(Object.values(present(f.files)).every(Boolean)).toBe(true);
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
    expect(report.workspaces.rebuildableBytes).toBeGreaterThanOrEqual(6);
    expect(report.workspaces.keptFileBytes).toBeGreaterThanOrEqual(3);
    expect(report.removed).toBe(false);
    expect(Object.values(present(f.files)).every(Boolean)).toBe(true);
    expect(describeOrphanReport(report)).toMatch(/^orphan sweep \(report\): tool results 1 folder/);
    const saved = JSON.parse(readFileSync(join(f.dataDir, "orphan-sweep.json"), "utf8")) as { firstSeen: Record<string, number>; last: { mode: string } };
    expect(Object.keys(saved.firstSeen).sort()).toEqual(["events:gone1", "native:gone2", "results:gone1", "workspace:removed-bot/gone3", "workspace:scout/gone1"]);
    expect(saved.last.mode).toBe("report");
  });
});

describe("remove", () => {
  it("waits a week after first seeing an orphan, then removes it and keeps the person's files and everything live", async () => {
    const f = fixture();
    f.setMode("remove");
    const first = await f.sweep();
    expect(first.waiting).toBe(5);
    expect(Object.values(present(f.files)).every(Boolean)).toBe(true);
    f.later(8);
    const second = await f.sweep();
    expect(second.waiting).toBe(0);
    expect(second.removed).toBe(true);
    expect(present(f.files)).toEqual({
      orphanResults: false, liveResults: true, transcriptResults: true,
      orphanEvents: false, orphanNative: false, liveEvents: true, transcriptEvents: true,
      orphanWork: true, orphanDeps: false, deletedBotDeps: false, liveDeps: true, transcriptDeps: true,
    });
  });

  it("keeps an orphan changed within the week, however long it has been known", async () => {
    const f = fixture();
    f.setMode("remove");
    await f.sweep();
    f.later(8);
    // Changed a day before the sweep's "now".
    const recent = new Date(Date.now() + 7 * DAY);
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
    await f.sweep();
    f.later(8);
    const report = await f.sweep();
    expect(report.workspaces.folders).toBe(1);
    expect(existsSync(f.files.orphanDeps)).toBe(true);
    expect(existsSync(shared)).toBe(true);
    expect(existsSync(f.files.deletedBotDeps)).toBe(false);
  });
});

describe("failing closed", () => {
  it("does nothing while the transcripts cannot be read or no conversation is registered", async () => {
    const unreadable = fixture({ storedThreadIds: () => { throw new Error("database is locked"); } });
    unreadable.setMode("remove");
    unreadable.later(30);
    expect((await unreadable.sweep()).skipped).toMatch(/transcripts could not be read: database is locked/);
    expect(Object.values(present(unreadable.files)).every(Boolean)).toBe(true);
    const empty = fixture();
    empty.bots.splice(0);
    empty.setMode("remove");
    expect((await empty.sweep()).skipped).toBe("no conversation is registered");
    expect(Object.values(present(empty.files)).every(Boolean)).toBe(true);
  });

  it("does nothing while the workspace must not change (frozen after a move, a backup under way)", async () => {
    let paused: string | null = null;
    const f = fixture({ paused: () => paused });
    f.setMode("remove");
    await f.sweep();
    f.later(8);
    paused = "frozen after a move";
    expect((await f.sweep()).skipped).toBe("frozen after a move");
    paused = "a backup is being made or restored";
    expect((await f.sweep()).skipped).toBe("a backup is being made or restored");
    expect(Object.values(present(f.files)).every(Boolean)).toBe(true);
    paused = null;
    await f.sweep();
    expect(existsSync(f.files.orphanDeps)).toBe(false);
  });

  it("treats an archived bot's conversations as live", async () => {
    const f = fixture();
    f.bots.push({ id: "archived", hidden: true, tasks: [{ threadId: "kept-thread" }] } as LiveRecords["bots"][number]);
    const deps = put(join(f.dataDir, "task-workspaces", "archived", "kept-thread", "node_modules", "a.js"));
    age(join(f.dataDir, "task-workspaces", "archived"), 30);
    f.setMode("remove");
    await f.sweep();
    f.later(8);
    await f.sweep();
    expect(existsSync(deps)).toBe(true);
  });

  it("never follows a link out of the data folder", async () => {
    const f = fixture();
    const victims = [put(join(f.outside, "results", "r.txt")), put(join(f.outside, "log.ndjson")), put(join(f.outside, "bot", "t9", "node_modules", "a.js"))];
    symlinkSync(join(f.outside, "results"), join(f.dataDir, "tool-results", "linked"), "dir");
    symlinkSync(join(f.outside, "log.ndjson"), join(f.dataDir, "events", "linked.ndjson"));
    symlinkSync(join(f.outside, "bot"), join(f.dataDir, "task-workspaces", "linked-bot"), "dir");
    f.setMode("remove");
    await f.sweep();
    f.later(8);
    const report = await f.sweep();
    expect(victims.filter((path) => !existsSync(path))).toEqual([]);
    expect(report.toolResults.count).toBe(1);
    expect(report.eventLogs.count).toBe(2);
  });

  it("leaves everything when a pass stops in the middle, and the next pass carries on", async () => {
    let crash = true;
    const f = fixture({ pause: async () => { if (crash) throw new Error("power cut"); } });
    for (let i = 0; i < 5_000; i++) put(join(f.dataDir, "task-workspaces", "scout", "gone1", "app", "node_modules", "big", `${i}.js`));
    age(join(f.dataDir, "task-workspaces"), 30);
    f.setMode("remove");
    await expect(f.sweep()).rejects.toThrow(/power cut/);
    expect(Object.values(present(f.files)).every(Boolean)).toBe(true);
    crash = false;
    await f.sweep();
    f.later(8);
    await f.sweep();
    expect(existsSync(f.files.orphanDeps)).toBe(false);
    expect(existsSync(f.files.orphanWork)).toBe(true);
  });
});

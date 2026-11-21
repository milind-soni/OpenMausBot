// The watch's own thread, for real: the main thread is held in a loop well past the threshold, and the record it leaves in
// the data folder names that loop's function, as a frozen Cloud home's would name the code that froze it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readStallRecords, STALL_FILE, startStallWatch, stallReportLines, type StallWatch } from "./stall-watch.ts";

const dirs: string[] = [];
const watches: StallWatch[] = [];
afterEach(() => {
  for (const watch of watches.splice(0)) watch.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "omb-stall-")); dirs.push(dir); return dir; };

function heldMainThreadForStallWatchTest(ms: number): number {
  const until = Date.now() + ms;
  let spins = 0;
  while (Date.now() < until) spins += Math.sqrt(spins + 1) > 0 ? 1 : 0;
  return spins;
}

const waitFor = async (check: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
};

describe("stall watch", () => {
  it("records where the main thread is stuck, in the data folder, while it is stuck", async () => {
    const dir = tempDir();
    const watch = startStallWatch({ dataDir: dir, thresholdMs: 2_000, profileMs: 1_000, log: () => undefined });
    expect(watch).not.toBeNull();
    watches.push(watch!);
    // Let the thread start before the main thread is held.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    heldMainThreadForStallWatchTest(9_000);
    await waitFor(() => readStallRecords(join(dir, STALL_FILE)).length > 0, 10_000);
    const [record] = readStallRecords(join(dir, STALL_FILE));
    expect(record).toBeDefined();
    expect(record!.kind).toBe("js");
    expect(record!.blockedSinceMs).toBeGreaterThanOrEqual(2_000);
    // The loop's own frame, or the test's where V8 inlined it: this file, by its place in the app, either way.
    expect(record!.top[0]!.at).toMatch(/server\/perf\/stall-watch\.test\.ts:\d+:\d+$/);
    expect(record!.top[0]!.samples).toBeGreaterThan(record!.top.slice(1).reduce((sum, frame) => sum + frame.samples, 0));
    expect(record!.stack.at(-1)).toMatch(/stall-watch\.test\.ts/);
    // Nothing of this machine's paths.
    expect(JSON.stringify(record)).not.toContain(dir);
    expect(JSON.stringify(record)).not.toContain(process.cwd());
    expect(stallReportLines([record!])[1]).toMatch(/main thread blocked \d+s, in JavaScript: .*stall-watch\.test\.ts/);
  }, 60_000);

  it("records nothing while the main thread keeps running", async () => {
    const dir = tempDir();
    const watch = startStallWatch({ dataDir: dir, thresholdMs: 2_000, profileMs: 500, log: () => undefined });
    watches.push(watch!);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(readStallRecords(join(dir, STALL_FILE))).toEqual([]);
  }, 30_000);

  it("logs the records a restart cut off when it starts, and none older than a day", () => {
    const dir = tempDir(), now = 1_800_000_000_000;
    const record = (at: number) => ({ at, blockedSinceMs: 30_000, kind: "outside-js", top: [], stack: [], thread: { state: "D", wchan: null },
      machine: { availableMB: 5, memoryFull10: 80, cpuSome10: null, stealPct: null }, memory: [{ bucket: "browser", rssMB: 2800, procs: 3 }] });
    writeFileSync(join(dir, STALL_FILE), JSON.stringify({ v: 1, records: [record(now - 2 * 86_400_000), record(now - 600_000)] }));
    const logged: string[] = [];
    const watch = startStallWatch({ dataDir: dir, now: () => now, log: (line) => logged.push(line) });
    if (watch) watches.push(watch);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("stall before this start");
    expect(logged[0]).toContain("outside JavaScript (thread state D)");
    expect(logged[0]).toContain("largest: browser 2800 MB");
  });

  it("reads a missing or broken file as no records", () => {
    const dir = tempDir();
    expect(readStallRecords(join(dir, STALL_FILE))).toEqual([]);
    writeFileSync(join(dir, STALL_FILE), "{not json");
    expect(readStallRecords(join(dir, STALL_FILE))).toEqual([]);
  });
});

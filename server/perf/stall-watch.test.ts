// The watch's own thread, for real: the main thread is held in a loop well past the threshold, and the record it leaves in
// the data folder names that loop's function, as a frozen Cloud home's would name the code that froze it.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { StallRecord } from "./stall-sample.ts";
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
    const watch = startStallWatch({ dataDir: dir, thresholdMs: 2_000, profileMs: 1_000, profileFloorMB: 0, log: () => undefined });
    expect(watch).not.toBeNull();
    watches.push(watch!);
    // Let the thread start before the main thread is held.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    // Long enough for a slow, busy machine (a shared CI runner): the record needs the threshold, a tick, and the profile.
    heldMainThreadForStallWatchTest(12_000);
    // Done: a profile, or the reason there is none (never "pending").
    const done = (record: StallRecord) => record.kind !== "not-profiled" || record.why !== "pending";
    await waitFor(() => readStallRecords(join(dir, STALL_FILE)).some(done), 20_000);
    const record = readStallRecords(join(dir, STALL_FILE)).find(done);
    expect(record).toBeDefined();
    expect(record!.blockedSinceMs).toBeGreaterThanOrEqual(2_000);
    // On Linux (the Cloud's own platform) it must be profiled; elsewhere a runner short of memory may skip the profile,
    // and then the record says so.
    if (process.platform === "linux" || record!.kind !== "not-profiled") {
      expect(record!.kind).toBe("js");
      // The loop's own frame, or the test's where V8 inlined it: this file, by its place in the app, either way.
      expect(record!.top.some((frame) => /server\/perf\/stall-watch\.test\.ts/.test(frame.at))).toBe(true);
      expect(stallReportLines([record!])[1]).toMatch(/main thread blocked \d+s, in JavaScript: .*stall-watch\.test\.ts/);
    } else {
      expect(record!.why).toBe("memory");
    }
    // Nothing of this machine's paths.
    expect(JSON.stringify(record)).not.toContain(dir);
    expect(JSON.stringify(record)).not.toContain(process.cwd());
  }, 60_000);

  it("saves the record at once and takes no profile while memory is short", async () => {
    const dir = tempDir();
    // A floor no machine has: memory counts as short.
    const watch = startStallWatch({ dataDir: dir, thresholdMs: 2_000, profileMs: 1_000, profileFloorMB: 10_000_000, log: () => undefined });
    watches.push(watch!);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    heldMainThreadForStallWatchTest(8_000);
    await waitFor(() => readStallRecords(join(dir, STALL_FILE)).length > 0, 10_000);
    const records = readStallRecords(join(dir, STALL_FILE));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "not-profiled", why: "memory", top: [], stack: [] });
    expect(stallReportLines(records)[1]).toContain("not profiled, memory too short to profile");
  }, 60_000);

  it("records nothing while the main thread keeps running", async () => {
    const dir = tempDir();
    const watch = startStallWatch({ dataDir: dir, log: () => undefined });
    watches.push(watch!);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(readStallRecords(join(dir, STALL_FILE))).toEqual([]);
  }, 30_000);

  it.skipIf(process.platform === "win32")("records nothing for a process that was stopped and continued", async () => {
    const dir = tempDir();
    const script = join(dir, "child.mjs");
    writeFileSync(script, `import { startStallWatch } from ${JSON.stringify(new URL("./stall-watch.ts", import.meta.url).href)};
const watch = startStallWatch({ dataDir: ${JSON.stringify(dir)}, thresholdMs: 2_000, profileMs: 500, profileFloorMB: 0, log: () => undefined });
process.stdout.write(watch ? "started\\n" : "none\\n");
setTimeout(() => { watch?.stop(); process.exit(0); }, 12_000);
`);
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
    const said = await new Promise<string>((resolve) => child.stdout!.once("data", (chunk: Buffer) => resolve(chunk.toString())));
    expect(said.trim()).toBe("started");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    child.kill("SIGSTOP");
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    child.kill("SIGCONT");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(readStallRecords(join(dir, STALL_FILE))).toEqual([]);
  }, 40_000);

  it("logs the records a restart cut off when it starts, none older than a day, and never throws on a broken one", () => {
    const dir = tempDir(), now = 1_800_000_000_000;
    const record = (at: number) => ({ at, blockedSinceMs: 30_000, kind: "outside-js", top: [], stack: [], thread: { state: "D", wchan: null },
      machine: { availableMB: 5, memoryFull10: 80, cpuSome10: null, stealPct: null }, memory: [{ bucket: "browser", rssMB: 2800, procs: 3 }] });
    writeFileSync(join(dir, STALL_FILE), JSON.stringify({ v: 1, records: [record(now - 2 * 86_400_000), { at: now - 900_000 }, "junk", record(now - 600_000)] }));
    writeFileSync(join(dir, ".perf-stalls.99999.tmp"), "{");
    const logged: string[] = [];
    const watch = startStallWatch({ dataDir: dir, now: () => now, log: (line) => logged.push(line) });
    if (watch) watches.push(watch);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("main thread blocked 0s, not profiled, profile to follow (thread state ?)");
    expect(logged[1]).toContain("outside JavaScript (thread state D)");
    expect(logged[1]).toContain("largest: browser 2800 MB");
  });

  it("reads a missing or broken file as no records, and its thread clears a temporary file left behind", async () => {
    const dir = tempDir();
    expect(readStallRecords(join(dir, STALL_FILE))).toEqual([]);
    writeFileSync(join(dir, STALL_FILE), "{not json");
    expect(readStallRecords(join(dir, STALL_FILE))).toEqual([]);
    writeFileSync(join(dir, ".perf-stalls.99999.tmp"), "{");
    const watch = startStallWatch({ dataDir: dir, log: () => undefined });
    watches.push(watch!);
    await waitFor(() => !existsSync(join(dir, ".perf-stalls.99999.tmp")), 5_000);
    expect(existsSync(join(dir, ".perf-stalls.99999.tmp"))).toBe(false);
  }, 20_000);
});

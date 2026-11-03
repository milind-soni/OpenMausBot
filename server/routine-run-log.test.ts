import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";
import { appendRunLog, compactRunLog, readRunLog, runLogPathFor } from "./routine-run-log.ts";
import type { RoutineRun } from "./routines.ts";

function run(id: string, overrides: Partial<RoutineRun> = {}): RoutineRun {
  return {
    id,
    routineId: "r1",
    routineName: "Daily sweep",
    target: "bot",
    botId: "b1",
    runOn: "maus",
    scheduledFor: Date.now(),
    status: "completed",
    manual: false,
    ...overrides,
  } as RoutineRun;
}

describe("routine run log", () => {
  let dataDir: string;
  let routinesFile: string;
  let logPath: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "omb-routine-log-"));
    routinesFile = join(dataDir, "routines.json");
    logPath = runLogPathFor(routinesFile);
  });
  afterEach(async () => { await removeTempDir(dataDir); });

  it("sits next to routines.json under its own name", () => {
    expect(logPath).toBe(join(dataDir, "routine-runs.jsonl"));
  });

  it("reads an empty or missing log as no rows", () => {
    expect(readRunLog(logPath, 10)).toEqual([]);
  });

  it("appends rows and reads them back oldest first", () => {
    appendRunLog(logPath, run("a"));
    appendRunLog(logPath, run("b"));
    appendRunLog(logPath, run("c"));
    expect(readRunLog(logPath, -1).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps only the most recent rows when asked for fewer than the log holds", () => {
    for (const id of ["a", "b", "c", "d"]) appendRunLog(logPath, run(id));
    expect(readRunLog(logPath, 2).map((r) => r.id)).toEqual(["c", "d"]);
  });

  it("skips a line that cannot parse instead of losing the rows around it", () => {
    appendRunLog(logPath, run("a"));
    appendFileSync(logPath, "not json\n");
    appendRunLog(logPath, run("b"));
    expect(readRunLog(logPath, -1).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("leaves a log under its compaction threshold untouched", () => {
    for (let i = 0; i < 50; i++) appendRunLog(logPath, run(`r${i}`));
    compactRunLog(logPath, 2_000);
    expect(readRunLog(logPath, -1)).toHaveLength(50);
  });

  it("compacts a log once it has grown well past what it should keep", () => {
    for (let i = 0; i < 600; i++) appendRunLog(logPath, run(`r${i}`));
    compactRunLog(logPath, 10);
    const rows = readRunLog(logPath, -1);
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `r${590 + i}`));
  });
});

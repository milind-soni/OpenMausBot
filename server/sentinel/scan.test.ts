import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { runScan } from "./scan.ts";
import { readIssues, STATE_FILE, STATE_VERSION } from "./store.ts";
import { fixtureDataDir, type FixtureDataDir } from "./testing.ts";

describe("sentinel scan", () => {
  let dir: string;
  let out: string;
  let fixture: FixtureDataDir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-sentinel-scan-"));
    out = join(dir, "out");
    fixture = fixtureDataDir(join(dir, "data"), [{ id: "b1", name: "Probe", threadId: "t1" }]);
  });
  afterEach(() => {
    fixture.close();
    removeTempDir(dir);
  });

  it("reports a wait that crosses the threshold while no source file changes", () => {
    const enqueued = Date.UTC(2026, 9, 14, 12);
    fixture.assignment({ id: "a1", status: "queued", botId: "b1", threadId: "t1", events: [{ kind: "enqueued", at: enqueued }] });
    const options = { dataDir: fixture.dataDir, out, queueWaitMs: 300_000 };

    const early = runScan({ ...options, now: enqueued + 60_000 });
    expect(early.scanned).toBe(true);
    expect(early.touched.filter((issue) => issue.kind === "queue_wait")).toEqual([]);

    expect(runScan({ ...options, now: enqueued + 120_000 }).scanned).toBe(false);

    const late = runScan({ ...options, now: enqueued + 360_000 });
    expect(late.scanned).toBe(true);
    expect(late.touched.map((issue) => issue.kind)).toEqual(["queue_wait"]);

    expect(runScan({ ...options, now: enqueued + 420_000 }).scanned).toBe(false);
  });

  it("does not count an occurrence again after reading a state file from another version", () => {
    const at = Date.UTC(2026, 9, 14, 12);
    fixture.activity({ threadId: "t1", id: "m1", at, name: "mcp__agents__send", ok: false, output: "no layer 90" });
    const options = { dataDir: fixture.dataDir, out };
    expect(runScan({ ...options, now: at + 60_000 }).added).toBe(1);
    const state = JSON.parse(readFileSync(join(out, STATE_FILE), "utf8"));
    writeFileSync(join(out, STATE_FILE), JSON.stringify({ ...state, version: STATE_VERSION - 1, seen: { "tool:m1": at } }));
    fixture.activity({ threadId: "t1", id: "m2", at: at + 90_000, name: "mcp__agents__send", ok: false, output: "no layer 91" });

    expect(runScan({ ...options, now: at + 120_000 }).added).toBe(1);
    expect([...readIssues(out).values()].map((issue) => issue.count)).toEqual([2]);
    fixture.activity({ threadId: "t1", id: "m3", at: at + 150_000, name: "mcp__agents__send", ok: false, output: "no layer 92" });

    expect(runScan({ ...options, now: at + 180_000 }).added).toBe(1);
    expect([...readIssues(out).values()].map((issue) => issue.count)).toEqual([3]);
  });
});

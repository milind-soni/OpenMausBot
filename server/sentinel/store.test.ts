import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { emptyState, ISSUES_FILE, pruneSeen, readIssues, readState, STATE_FILE, STATE_VERSION, upsertIssues, writeSentinelFiles } from "./store.ts";
import { DETECTORS } from "./detectors/index.ts";
import type { Observation, SentinelRecord } from "./types.ts";

function observation(occurrence: string, at: number, extra: Partial<Observation> = {}): Observation {
  return {
    kind: "tool_error", signature: "tool_error:0123456789abcdef", title: "no layer <n>", origin: "harness", severity: "high", tool: "mcp__agents__send",
    threadId: "t1", botId: "b1", at, occurrence, evidence: { source: "messages", id: occurrence }, ...extra,
  };
}

describe("sentinel issue store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-sentinel-store-"));
  });
  afterEach(() => removeTempDir(dir));

  it("upserts by signature and counts each occurrence once, however often it is observed", () => {
    const issues = readIssues(dir);
    const state = emptyState();
    const batch = [observation("m1", 1_000, { turnId: "u1" }), observation("m2", 2_000, { turnId: "u1" }), observation("m3", 1_500, { turnId: "u2" })];
    expect(upsertIssues(issues, state, batch).added).toBe(3);
    expect(upsertIssues(issues, state, batch)).toEqual({ touched: new Set(), added: 0 });
    const issue = issues.get("tool_error:0123456789abcdef")!;
    expect(issue).toMatchObject({ count: 3, wastedTurns: 2, firstAt: 1_000, lastAt: 2_000, evidenceRef: { source: "messages", id: "m2" }, turnId: "u1" });

    // written and read back, a rerun is still a no-op
    writeSentinelFiles(dir, issues, state);
    const again = readIssues(dir);
    const reread = readState(dir);
    expect(upsertIssues(again, reread, batch).added).toBe(0);
    expect(again.get(issue.sig)).toEqual(issue);
    upsertIssues(again, reread, [observation("m4", 3_000)]);
    expect(again.get(issue.sig)).toMatchObject({ count: 4, wastedTurns: 2, lastAt: 3_000 });
    // the newest occurrence has no turn: the issue does not keep an older one
    expect(again.get(issue.sig)!.turnId).toBeUndefined();
  });

  it("keeps every detector's issue for one record", () => {
    const issues = new Map();
    const timedOutAndCostly: SentinelRecord = { type: "turn", id: "e1", threadId: "t1", turnId: "u1", botId: "b1", at: 2_000, ok: false, stopReason: "timeout", cost: 9 };
    const observations = DETECTORS.flatMap((detector) => detector.detect([timedOutAndCostly], { queueWaitMs: 300_000, costUsd: 5, retryLoopMin: 3, now: 10_000 }));
    expect(upsertIssues(issues, emptyState(), observations).added).toBe(2);
    expect([...issues.values()].map((issue) => issue.kind).sort()).toEqual(["cost", "turn_timeout"]);
  });

  it("forgets occurrences only once no scan can see them again", () => {
    const state = emptyState();
    upsertIssues(new Map(), state, [observation("old", 1_000), observation("new", 9_000)]);
    pruneSeen(state, 5_000);
    expect(Object.keys(state.seen)).toEqual(["tool_error:new"]);
  });

  it("writes owner-only files that hold references, not text", () => {
    const issues = new Map();
    const state = emptyState();
    upsertIssues(issues, state, [observation("m1", 1_000)]);
    writeSentinelFiles(dir, issues, state);
    const line = readFileSync(join(dir, ISSUES_FILE), "utf8").trim();
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(["botId", "count", "evidenceRef", "firstAt", "kind", "lastAt", "origin", "severity", "sig", "threadId", "title", "tool", "wastedTurns"]);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, ISSUES_FILE)).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, STATE_FILE)).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it("starts over from a damaged state file and skips a damaged issue line", () => {
    writeFileSync(join(dir, STATE_FILE), "{half");
    writeFileSync(join(dir, ISSUES_FILE), `{broken\n${JSON.stringify({ sig: "cost:1", kind: "cost", count: 1 })}\n`);
    expect(readState(dir)).toEqual(emptyState());
    expect([...readIssues(dir).keys()]).toEqual(["cost:1"]);
    // the right version with a field of the wrong shape would fail every scan
    for (const damaged of [{ seen: null }, { logs: [] }, { seen: [] }, { lastScanAt: "x" }, { fingerprint: 1 }]) {
      writeFileSync(join(dir, STATE_FILE), JSON.stringify({ ...emptyState(), lastScanAt: 5, ...damaged }));
      expect(readState(dir)).toEqual(emptyState());
    }
    // 1e309 parses to Infinity: no finite scan window can start there
    for (const damaged of ["null", "[]", "1", `{"version":${STATE_VERSION},"lastScanAt":1e309,"fingerprint":null,"logs":{},"seen":{}}`]) {
      writeFileSync(join(dir, STATE_FILE), damaged);
      expect(readState(dir)).toEqual(emptyState());
    }
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ ...emptyState(), lastScanAt: 5 }));
    expect(readState(dir).lastScanAt).toBe(5);
  });
});

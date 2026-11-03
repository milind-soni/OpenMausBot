import { describe, expect, it } from "vitest";

import { HARNESS_NOTICE } from "../normalize.ts";
import type { DetectorConfig, SentinelRecord } from "../types.ts";
import { cost } from "./cost.ts";
import { DETECTORS } from "./index.ts";
import { queueWait } from "./queue-wait.ts";
import { retryLoop } from "./retry-loop.ts";
import { toolError } from "./tool-error.ts";
import { heldMemberLine } from "../../room-holds.ts";
import { turnStop } from "./turn-stop.ts";

const config: DetectorConfig = { queueWaitMs: 300_000, costUsd: 5, retryLoopMin: 3, now: 10_000_000 };

function tool(id: string, name: string, text: string, extra: Partial<Extract<SentinelRecord, { type: "tool" }>> = {}): SentinelRecord {
  return { type: "tool", id, threadId: "t1", botId: "b1", at: 1_000 + Number(id.replace(/\D/g, "") || 0), tool: name, ok: false, text, ...extra };
}

function turn(id: string, extra: Partial<Extract<SentinelRecord, { type: "turn" }>> = {}): SentinelRecord {
  return { type: "turn", id, threadId: "t1", turnId: `turn-${id}`, botId: "b1", at: 2_000, ok: true, stopReason: "end_turn", cost: 0.1, ...extra };
}

describe("sentinel detectors", () => {
  it("tool_error groups one failure across values and ranks harness tools as bugs", () => {
    const observations = toolError.detect([
      tool("m1", "mcp__agents__send", "no layer 90", { turnId: "x" }),
      tool("m2", "mcp__agents__send", "no layer 104"),
      tool("m3", "Bash", "exit code 1"),
      tool("m4", "mcp__linear__get", "rate limited"),
      tool("m5", "Bash", "fine", { ok: true }),
    ], config);
    expect(observations).toHaveLength(4);
    const [a, b, shell, external] = observations;
    expect(a!.signature).toBe(b!.signature);
    expect(a).toMatchObject({ kind: "tool_error", origin: "harness", severity: "high", tool: "mcp__agents__send", turnId: "x", occurrence: "tool:m1", evidence: { source: "messages", id: "m1" } });
    expect(shell).toMatchObject({ origin: "shell", severity: "low" });
    expect(external).toMatchObject({ origin: "external", severity: "medium" });
  });

  it("tool_error merges differently worded shell timeouts into one issue with a readable title", () => {
    const observations = toolError.detect([
      tool("m1", "Bash", "Command timed out after 2m 0.0s"),
      tool("m2", "Bash", "Error: command timed out after 120000ms\n/path/to/project/build.sh"),
      tool("m3", "Bash", "Exit code 124\ntimeout: sending signal TERM to command 'make'"),
    ], config);
    expect(new Set(observations.map((o) => o.signature)).size).toBe(1);
    expect(observations[0]).toMatchObject({ origin: "shell", severity: "low", title: "timed out" });
  });

  it("tool_error never reports a member the person held on purpose", () => {
    expect(toolError.detect([tool("m1", heldMemberLine("Reviewer"), "")], config)).toEqual([]);
  });

  it("turn_stop reports failed and budget-stopped turns, a stopped room turn as a timeout, and never the person's own stop", () => {
    const observations = turnStop.detect([
      turn("e1", { ok: false, stopReason: "exit_before_result" }),
      turn("e2", { ok: false, stopReason: "interrupted" }),
      turn("e3", { ok: false, stopReason: "cancelled" }),
      turn("e4", { ok: false, stopReason: "quota" }),
      turn("e5", { ok: true, stopReason: "max_turns" }),
      turn("e6"),
      turn("e7", { ok: false, stopReason: "timeout" }),
      tool("m1", HARNESS_NOTICE, "<bot>'s room turn exceeded 20 minutes and was stopped"),
    ], config);
    expect(observations.map((o) => [o.kind, o.origin, o.severity, o.occurrence])).toEqual([
      ["turn_stop", "harness", "high", "turn:e1"],
      ["turn_stop", "external", "medium", "turn:e4"],
      ["turn_stop", "harness", "medium", "turn:e5"],
      ["turn_timeout", "harness", "high", "turn:e7"],
      ["turn_timeout", "harness", "medium", "tool:m1"],
    ]);
    // the stopped room turn is not also a tool error
    expect(toolError.detect([tool("m1", HARNESS_NOTICE, "<bot>'s room turn exceeded 20 minutes and was stopped")], config)).toEqual([]);
    // different limits are one timeout
    const [x] = turnStop.detect([tool("m2", HARNESS_NOTICE, "<bot>'s room turn exceeded 5 minutes and was stopped")], config);
    expect(x!.signature).toBe(observations[4]!.signature);
    // a turn stopped for making no progress is a timeout too
    const [idle] = turnStop.detect([tool("m3", HARNESS_NOTICE, "<bot>'s room turn made no progress for 5 minutes and was stopped")], config);
    expect(idle!.kind).toBe("turn_timeout");
    expect(toolError.detect([tool("m3", HARNESS_NOTICE, "<bot>'s room turn made no progress for 5 minutes and was stopped")], config)).toEqual([]);
  });

  it("queue_wait flags waits over the threshold, finished or still waiting, one issue per bot", () => {
    const observations = queueWait.detect([
      { type: "queue", id: "a1:1", assignmentId: "a1", threadId: "t1", botId: "b1", at: 1, waitMs: 301_000, started: true },
      { type: "queue", id: "a2:4", assignmentId: "a2", threadId: "t1", botId: "b1", at: 1, waitMs: 900_000, started: false },
      { type: "queue", id: "a3:7", assignmentId: "a3", threadId: "t1", botId: "b1", at: 1, waitMs: 299_000, started: true },
      { type: "queue", id: "a4:9", assignmentId: "a4", threadId: "t2", botId: "b2", at: 1, waitMs: 400_000, started: true },
    ], config);
    expect(observations.map((o) => o.evidence.id)).toEqual(["a1", "a2", "a4"]);
    expect(observations[0]!.signature).toBe(observations[1]!.signature);
    expect(observations[2]!.signature).not.toBe(observations[0]!.signature);
    expect(queueWait.detect([{ type: "queue", id: "a1:1", assignmentId: "a1", threadId: "t1", at: 1, waitMs: 301_000, started: true }], { ...config, queueWaitMs: 600_000 })).toEqual([]);
  });

  it("cost flags a single turn over the threshold", () => {
    const observations = cost.detect([turn("e1", { cost: 12.5 }), turn("e2", { cost: 4.99 }), turn("e3", { cost: null })], config);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ kind: "cost", turnId: "turn-e1", evidence: { source: "events", id: "e1" } });
    expect(cost.detect([turn("e2", { cost: 4.99 })], { ...config, costUsd: 1 })).toHaveLength(1);
  });

  it("retry_loop needs the same failure three times in one turn, and counts the loop once", () => {
    const records = [
      tool("m1", "mcp__agents__send", "no layer 1", { turnId: "x" }),
      tool("m2", "mcp__agents__send", "no layer 2", { turnId: "x" }),
      tool("m3", "mcp__agents__send", "no layer 3", { turnId: "x" }),
      tool("m4", "mcp__agents__send", "no layer 4", { turnId: "y" }),
      tool("m5", "mcp__agents__send", "no layer 5", { turnId: "y" }),
      tool("m6", "Bash", "no layer 6", { turnId: "y" }),
    ];
    const observations = retryLoop.detect(records, config);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ kind: "retry_loop", origin: "harness", severity: "high", turnId: "x", evidence: { id: "m3" }, occurrence: expect.stringMatching(/^retry:x:/) });
    expect(retryLoop.detect([...records, tool("m7", "mcp__agents__send", "no layer 7", { turnId: "x" })], config)[0]!.occurrence).toBe(observations[0]!.occurrence);
  });

  it("keeps every title within 160 characters, prefix included", () => {
    const long = "x".repeat(400);
    const loop = retryLoop.detect([1, 2, 3].map((n) => tool(`m${n}`, "mcp__agents__send", long, { turnId: "x" })), config);
    expect(loop[0]!.title).toMatch(/^repeated in one turn: x+$/);
    expect(loop[0]!.title.length).toBe(160);
    const [stop] = turnStop.detect([turn("e1", { ok: false, stopReason: long })], config);
    expect(stop!.title.length).toBe(160);
  });

  it("runs every detector", () => {
    expect(DETECTORS.map((d) => d.name)).toEqual(["tool_error", "turn_stop", "queue_wait", "cost", "retry_loop"]);
  });
});

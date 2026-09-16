// Phase 3 part 4: a graph run is a fixed list of nodes with a checkpoint
// per node in SQLite, so a crash resumes at the first unfinished node and a
// finished node's output is reused instead of recomputed.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as graphs from "./graph-runner.ts";

const DATA = mkdtempSync(join(tmpdir(), "omb-graphs-"));
const ROUTINE_NODES = [
  { name: "intake", kind: "decision" as const },
  { name: "work", kind: "bot_turn" as const },
  { name: "check", kind: "check" as const },
  { name: "judge", kind: "verify" as const },
  { name: "ship", kind: "code" as const },
];

describe("the graph runner", () => {
  beforeEach(() => graphs.openGraphs(join(DATA, `g-${Math.random()}.db`)));

  it("starts a run with its nodes pending, in order, and reports the first pending node", () => {
    const run = graphs.startGraphRun({ kind: "routine", subjectId: "run-1", nodes: ROUTINE_NODES });
    expect(run.status).toBe("running");
    expect(run.nodes.map((n) => `${n.name}:${n.status}`)).toEqual(["intake:pending", "work:pending", "check:pending", "judge:pending", "ship:pending"]);
    expect(graphs.nextPending(run.id)?.name).toBe("intake");
  });

  it("checkpoints each node with its output and moves on; a finished node's output is reused", () => {
    const run = graphs.startGraphRun({ kind: "routine", subjectId: "run-2", nodes: ROUTINE_NODES });
    graphs.finishNode(run.id, "intake", { acceptance: "say hi" });
    graphs.beginNode(run.id, "work");
    expect(graphs.getGraphRun(run.id)?.nodes[1].status).toBe("running");
    graphs.finishNode(run.id, "work", { threadId: "t" });
    expect(graphs.nextPending(run.id)?.name).toBe("check");
    expect(graphs.nodeOutput(run.id, "intake")).toEqual({ acceptance: "say hi" });
    expect(graphs.nodeOutput(run.id, "check")).toBeNull();
  });

  it("fails the run at a failed node and records the reason", () => {
    const run = graphs.startGraphRun({ kind: "routine", subjectId: "run-3", nodes: ROUTINE_NODES });
    graphs.failNode(run.id, "work", "the turn did not finish");
    const after = graphs.getGraphRun(run.id)!;
    expect(after.status).toBe("failed");
    expect(after.nodes[1]).toMatchObject({ status: "failed", error: "the turn did not finish" });
  });

  it("finishes the run when the last node finishes", () => {
    const run = graphs.startGraphRun({ kind: "routine", subjectId: "run-4", nodes: ROUTINE_NODES });
    for (const node of ROUTINE_NODES) graphs.finishNode(run.id, node.name, {});
    expect(graphs.getGraphRun(run.id)?.status).toBe("completed");
    expect(graphs.nextPending(run.id)).toBeNull();
  });

  it("lists the runs a restart can resume: running, with the bot's turn done and later nodes still pending", () => {
    const cold = graphs.startGraphRun({ kind: "routine", subjectId: "run-5", nodes: ROUTINE_NODES });
    graphs.finishNode(cold.id, "intake", {});
    graphs.beginNode(cold.id, "work"); // died mid-turn: not resumable, the turn is gone
    const warm = graphs.startGraphRun({ kind: "routine", subjectId: "run-6", nodes: ROUTINE_NODES });
    graphs.finishNode(warm.id, "intake", {});
    graphs.finishNode(warm.id, "work", { threadId: "t6" });
    graphs.beginNode(warm.id, "check"); // died while checking: resumable at check
    const done = graphs.startGraphRun({ kind: "routine", subjectId: "run-7", nodes: ROUTINE_NODES });
    for (const node of ROUTINE_NODES) graphs.finishNode(done.id, node.name, {});
    expect(graphs.resumable("routine").map((r) => r.subjectId)).toEqual(["run-6"]);
    // resuming resets the interrupted node to pending so it runs again
    graphs.resetRunningNodes(warm.id);
    expect(graphs.nextPending(warm.id)?.name).toBe("check");
  });

  it("survives a reopen", () => {
    const file = join(DATA, "persist.db");
    graphs.openGraphs(file);
    const run = graphs.startGraphRun({ kind: "routine", subjectId: "run-8", nodes: ROUTINE_NODES });
    graphs.finishNode(run.id, "intake", { acceptance: "x" });
    graphs.openGraphs(file);
    expect(graphs.bySubject("routine", "run-8")?.nodes[0].status).toBe("done");
  });
});

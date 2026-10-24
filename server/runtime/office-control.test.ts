import { describe, expect, it } from "vitest";

import { Runtime } from "./runtime.ts";
import { openRuntimeStore } from "./store.ts";
import type { Assignment, TurnRunner } from "./types.ts";

function fixture(enabled = true) {
  let now = 1_000_000;
  const store = openRuntimeStore(":memory:");
  const runs: Array<{ node: Assignment; signal: AbortSignal }> = [];
  const reports: Assignment[] = [];
  const runner: TurnRunner = {
    validate: () => undefined, canStart: () => true,
    run: (node, _input, signal) => { runs.push({ node, signal }); return new Promise(() => {}); },
    park: () => {}, report: node => { reports.push(node); }, changed: () => {}, names: () => ({ requester: "Chief", assignee: "Builder" }),
  };
  const runtime = new Runtime(store, runner, { clock: { now: () => now, monotonic: () => now } });
  if (enabled) runtime.enableOfficeControl(30_000);
  runtime.open();
  const root = runtime.begin({ id: "root", origin: { kind: "person", source: "chat" }, requester: { kind: "person", threadId: "chief-thread" },
    assignee: { botId: "chief", destination: { kind: "standing_thread", threadId: "chief-thread" } }, brief: "Work", level: "ask", requestMessageId: "message" });
  return { runtime, root, store, runner, runs, reports, advance: (ms: number) => { now += ms; } };
}

describe("office runtime boundaries", () => {
  it("leaves native behavior unchanged when control is disabled", () => {
    const f = fixture(false); expect(f.root.office).toBeUndefined();
    expect(f.store.get("root")?.requestMessageId).toBe("message");
    f.runtime.close(); f.store.close();
  });

  it("inherits the original deadline and delivers native results after work expiry without a new model turn", () => {
    const f = fixture(); f.advance(10_000);
    const queued = f.runtime.enqueue({ parentId: f.root.id, origin: f.root.origin, requester: { kind: "bot_turn", botId: "chief", threadId: "chief-thread" },
      assignee: { botId: "builder", destination: { kind: "work_thread", threadId: "builder-thread" } }, brief: "Build", levels: { own: "ask" } });
    if (!queued.ok) throw new Error(queued.reason);
    expect(queued.assignment.office?.rootDeadline).toBe(f.root.office?.rootDeadline);
    f.runtime.tick(); f.runtime.end(f.root.id, { ok: true, text: "Waiting for builder" });
    expect(f.runs).toHaveLength(1);
    f.advance(20_000); f.runtime.tick();
    expect(f.store.get(queued.assignment.id)).toMatchObject({ status: "failed", outcome: "expired" });
    expect(f.runs[0]!.signal.aborted).toBe(true);
    expect(f.reports.some(node => node.id === queued.assignment.id)).toBe(true);
    expect(f.runs).toHaveLength(1);
    f.runtime.close(); f.store.close();
  });

  it("marks an interrupted consumed attempt uncertain and never reruns it", () => {
    const f = fixture(); const row = f.store.get(f.root.id)!;
    row.office!.attempts.push({ version: 1, attemptId: "attempt", assignmentId: row.id, rootId: row.id, botId: "chief", threadId: "chief-thread",
      generation: "generation", workerId: "hel1", instanceId: "selected", driverKind: "codex", profileId: "chief", profileDigest: "a".repeat(64),
      assignmentDigest: "d".repeat(64),
      cwd: "/work", rootDeadline: row.office!.rootDeadline, startBefore: row.createdAt + 1000, kind: "work", digest: "b".repeat(64),
      capabilityHash: "c".repeat(64), state: "consumed", preparedAt: row.createdAt, consumedAt: row.createdAt });
    f.store.update(row); f.runtime.close();
    const restarted = new Runtime(f.store, f.runner, { clock: { now: () => row.createdAt + 2000, monotonic: () => 2000 } });
    restarted.enableOfficeControl(30_000); restarted.open(); restarted.tick();
    expect(f.store.get(row.id)).toMatchObject({ status: "failed", outcome: "interrupted", office: { rootDeadline: row.office!.rootDeadline,
      attempts: [{ state: "uncertain" }] } });
    expect(f.runs).toHaveLength(0);
    restarted.close(); f.store.close();
  });
});

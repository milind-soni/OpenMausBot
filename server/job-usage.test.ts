import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attributionForJobTurn, bindJobUsageTurn, completeJobUsageTurn, readJobUsage, summarizeJobUsage, tokenObservation } from "./job-usage.ts";
import type { Assignment, OfficeAttempt } from "./runtime/types.ts";
import { appendUsage, type UsageRow } from "./usage-ledger.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const start = Date.parse("2026-10-01T00:00:00Z");
const attempt = (id: string, patch: Partial<OfficeAttempt> = {}): OfficeAttempt => ({
  version: 1, attemptId: id, assignmentId: "root", rootId: "root", botId: "chief", threadId: "office", generation: "g1",
  workerId: "hel1", instanceId: "codex", driverKind: "codex", profileId: "p", assignmentDigest: "d", profileDigest: "d",
  cwd: "/work", rootDeadline: start + 1800000, startBefore: start + 30000, kind: "work", digest: "d", capabilityHash: "h",
  state: "consumed", preparedAt: start, consumedAt: start + 1, finishedAt: start + 100,
  ...patch,
});
const node = (patch: Partial<Assignment> = {}): Assignment => ({
  id: "root", rootId: "root", depth: 0, origin: { kind: "person", source: "chat" }, requester: { kind: "person", threadId: "office" },
  assignee: { botId: "chief", destination: { kind: "standing_thread", threadId: "office" } }, mode: "work", reply: "resume",
  brief: "synthetic job", status: "completed", outcome: "done", level: "ask", levelSource: "own", executions: 1, restarts: 0,
  createdAt: start, lastActivityAt: start + 100, finishedAt: start + 100, result: "done", rework: false, version: 1,
  office: { rootDeadline: start + 1800000, attempts: [attempt("a1")] }, ...patch,
});
const usage = (patch: Partial<UsageRow> = {}): UsageRow => ({
  at: new Date(start + 100).toISOString(), botId: "chief", botName: "Chief", threadId: "office", instanceId: "codex",
  driverKind: "codex", model: "m", input: 100, output: 20, cachedInput: 60, costUsd: 0.1, costSource: "reported",
  trigger: { kind: "owner" }, job: { rootId: "root", assignmentId: "root", attemptId: "a1", turnId: "turn1" },
  tokenObservation: { input: true, output: true, cachedInput: true }, ...patch,
});

describe("native per-job usage", () => {
  it("sums native parent and descendant turns once without adding cached input twice", () => {
    const child = node({ id: "child", parentId: "root", depth: 1, assignee: { botId: "engineer", destination: { kind: "work_thread", threadId: "code" } },
      office: { rootDeadline: start + 1800000, attempts: [attempt("a2", { assignmentId: "child", botId: "engineer", threadId: "code" })] } });
    const childRow = usage({ botId: "engineer", threadId: "code", costSource: "estimated", costUsd: 0.2,
      job: { rootId: "root", assignmentId: "child", attemptId: "a2", turnId: "turn2" } });
    const result = summarizeJobUsage("root", [node(), child, child], [usage(), usage(), childRow]);
    expect(result.total).toMatchObject({ turns: 2, input: 200, output: 40, cachedInput: 120, totalTokens: 240, reportedUsd: 0.1, estimatedUsd: 0.2 });
    expect(result.assignments).toBe(2);
    expect(result.observations.map(row => [row.assignmentId, row.attemptId, row.turnId, row.model])).toEqual([
      ["root", "a1", "turn1", "m"], ["child", "a2", "turn2", "m"],
    ]);
    expect(result.coverage).toMatchObject({ state: "complete", expectedAttempts: 2, observedAttempts: 2, missingAttempts: 0 });
  });

  it("preserves failed and cancelled reported usage", () => {
    for (const status of ["failed", "cancelled"] as const) {
      const result = summarizeJobUsage("root", [node({ status, outcome: status === "failed" ? "provider_error" : "stopped" })], [usage()]);
      expect(result.total.turns).toBe(1);
      expect(result.total.reportedUsd).toBe(0.1);
      expect(result.attempts[0]?.status).toBe(status);
    }
  });

  it("retains unknown token measurements and unknown prices instead of treating them as zero", () => {
    const result = summarizeJobUsage("root", [node()], [usage({ input: 0, output: 0, cachedInput: undefined, costUsd: null,
      tokenObservation: { input: false, output: false, cachedInput: false } })]);
    expect(result.total).toMatchObject({ input: 0, output: 0, totalTokens: 0, unknownInputTurns: 1, unknownOutputTurns: 1,
      unknownCachedInputTurns: 1, unknownCostTurns: 1, reportedUsd: null, estimatedUsd: null });
    expect(result.coverage).toMatchObject({ state: "partial", tokens: "partial", costs: "partial" });
  });

  it("recognizes explicitly reported zero as observed", () => {
    const result = summarizeJobUsage("root", [node()], [usage({ input: 0, output: 0, cachedInput: 0, costUsd: 0 })]);
    expect(result.total).toMatchObject({ reportedUsd: 0, unknownInputTurns: 0, unknownOutputTurns: 0, unknownCostTurns: 0 });
    expect(result.coverage.state).toBe("complete");
  });

  it("marks a consumed attempt cut by restart as missing without inventing its tokens", () => {
    const cut = node({ status: "failed", outcome: "interrupted", office: { rootDeadline: start + 1800000,
      attempts: [attempt("a1", { state: "uncertain", finishedAt: undefined })] } });
    expect(summarizeJobUsage("root", [cut], []).coverage).toEqual({ state: "partial", expectedAttempts: 1, observedAttempts: 0,
      missingAttempts: 1, pendingAttempts: 0, untrackedExecutions: 0, scopeComplete: true, tokens: "partial", costs: "partial" });
  });

  it("separates a live pending attempt from a missing final receipt", () => {
    const live = node({ status: "running", finishedAt: undefined, office: { rootDeadline: start + 1800000,
      attempts: [attempt("a1", { finishedAt: undefined })] } });
    expect(summarizeJobUsage("root", [live], []).coverage).toMatchObject({ state: "pending", pendingAttempts: 1, missingAttempts: 0 });
  });

  it("counts untracked historical executions as gaps and prepared refusals as not started", () => {
    const refused = node({ executions: 3, office: { rootDeadline: start + 1800000,
      attempts: [attempt("a1", { state: "cancelled", consumedAt: undefined })] } });
    const result = summarizeJobUsage("root", [refused], [usage()]);
    expect(result.total.turns).toBe(0);
    expect(result.coverage).toMatchObject({ state: "partial", untrackedExecutions: 2, expectedAttempts: 2 });
    expect(result.attempts[0]?.state).toBe("not_started");
  });

  it("includes rework attempts and native non-office executions separately", () => {
    const reworked = node({ executions: 2, office: { rootDeadline: start + 1800000, attempts: [attempt("a1"), attempt("a2", { generation: "g2" })] } });
    const rows = [usage(), usage({ job: { rootId: "root", assignmentId: "root", attemptId: "a2", turnId: "turn2" } })];
    expect(summarizeJobUsage("root", [reworked], rows).total.turns).toBe(2);
    const native = node({ office: undefined, executions: 2 });
    const nativeRows = [1, 2].map(execution => usage({ job: { rootId: "root", assignmentId: "root", attemptId: `native:root:${execution}`, turnId: `turn${execution}` } }));
    expect(summarizeJobUsage("root", [native], nativeRows).coverage.state).toBe("complete");
  });

  it("rejects mismatched roots, bots, threads, assignments and unconsumed attempts", () => {
    const rows = [usage({ botId: "other" }), usage({ threadId: "other" }), usage({ job: { rootId: "root", assignmentId: "other", attemptId: "a1", turnId: "bad" } }),
      usage({ job: { rootId: "other", assignmentId: "root", attemptId: "a1", turnId: "bad" } }),
      usage({ job: { rootId: "root", assignmentId: "root", attemptId: "other", turnId: "bad" } })];
    expect(summarizeJobUsage("root", [node()], rows).total.turns).toBe(0);
  });

  it("caps cached input to its measured input subset", () => {
    const result = summarizeJobUsage("root", [node()], [usage({ cachedInput: 999 })]);
    expect(result.total).toMatchObject({ input: 100, output: 20, cachedInput: 100, totalTokens: 120 });
  });

  it("does not claim full-job coverage from a descendant-only view", () => {
    const child = node({ id: "child", parentId: "root" });
    expect(summarizeJobUsage("root", [child], []).coverage).toMatchObject({ state: "partial", scopeComplete: false });
  });

  it("binds only exact native generations and keeps absence distinct from zero", () => {
    expect(attributionForJobTurn(node(), { generation: "g1", turnId: "t" })).toEqual({ rootId: "root", assignmentId: "root", attemptId: "a1", turnId: "t" });
    expect(attributionForJobTurn(node(), { generation: "other", turnId: "t" })).toBeUndefined();
    expect(attributionForJobTurn(node(), { generation: "g1" })).toBeUndefined();
    expect(attributionForJobTurn(undefined, { generation: "g1", turnId: "t" })).toBeUndefined();
    expect(tokenObservation({ input: 0, output: NaN })).toEqual({ input: true, output: false, cachedInput: false });
  });

  it("captures an issued prelaunch identity and requires its exact consumed attempt at final completion", () => {
    const issued = node({ office: { rootDeadline: start + 1800000, attempts: [attempt("a1", { state: "issued", consumedAt: undefined, finishedAt: undefined })] } });
    const binding = bindJobUsageTurn(issued, { generation: "g1", turnId: "codex-turn" });
    expect(binding).toMatchObject({ attemptId: "a1", office: true, generation: "g1" });
    expect(completeJobUsageTurn(binding, issued)).toBeUndefined();
    expect(attributionForJobTurn(issued, { generation: "g1", turnId: "codex-turn" })).toBeUndefined();
    expect(completeJobUsageTurn(binding, node())).toEqual({ rootId: "root", assignmentId: "root", attemptId: "a1", turnId: "codex-turn" });
    expect(completeJobUsageTurn(binding, node({ office: { rootDeadline: start + 1800000, attempts: [attempt("a2")] } }))).toBeUndefined();
    expect(completeJobUsageTurn(binding, node({ id: "replacement" }))).toBeUndefined();
  });

  it("does not credit unconsumed prelaunch cancellations but retains a consumed cancellation", () => {
    const issued = node({ office: { rootDeadline: start + 1800000, attempts: [attempt("a1", { state: "issued", consumedAt: undefined })] } });
    const binding = bindJobUsageTurn(issued, { generation: "g1", turnId: "codex-turn" });
    expect(completeJobUsageTurn(binding, node({ status: "cancelled", office: { rootDeadline: start + 1800000,
      attempts: [attempt("a1", { state: "cancelled", consumedAt: undefined })] } }))).toBeUndefined();
    expect(completeJobUsageTurn(binding, node({ status: "cancelled", office: { rootDeadline: start + 1800000,
      attempts: [attempt("a1", { state: "cancelled" })] } }))).toMatchObject({ attemptId: "a1", turnId: "codex-turn" });
  });

  it("keeps a native execution ordinal frozen when settlement has already resumed its assignment", () => {
    const running = node({ office: undefined });
    const binding = bindJobUsageTurn(running, { generation: "g1", turnId: "first-turn" });
    expect(completeJobUsageTurn(binding, { ...running, executions: 2 })).toMatchObject({ attemptId: "native:root:1", turnId: "first-turn" });
  });
});

describe("durable job usage read-back", () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map(removeTempDir)); });
  it("reads the existing ledger after native assignment serialization", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-job-usage-")); directories.push(dataDir);
    await appendUsage(dataDir, usage());
    const before = readJobUsage(dataDir, [node()], "root", new Date(start + 1000));
    const after = readJobUsage(dataDir, JSON.parse(JSON.stringify([node()])), "root", new Date(start + 1000));
    expect(after).toEqual(before);
    expect(after.coverage.state).toBe("complete");
  });
});

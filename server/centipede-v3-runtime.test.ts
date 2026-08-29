import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCentipedeV3Runtime } from "./centipede-v3-runtime.ts";

const directories: string[] = [];
const runtimes: Array<ReturnType<typeof createCentipedeV3Runtime>> = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function capture(captureId = "capture-runtime-1", summary = "The requested Centipede receipt is ready.") {
  return {
    kind: "capture" as const,
    evidence: {
      captureId,
      source: "local-fixture",
      reference: `fixture:${captureId}`,
      summary,
      contentHash: captureId === "capture-runtime-1" ? "a".repeat(64) : "c".repeat(64),
      confidence: "high" as const,
      criterionIds: ["receipt"],
      artifacts: [{ reference: `fixture:${captureId}`, kind: "receipt", contentHash: captureId === "capture-runtime-1" ? "b".repeat(64) : "d".repeat(64) }],
      observedAt: 1_000,
    },
  };
}

describe("Centipede V3 runtime seam", () => {
  it("captures into the graph, completes through real adapters, and recovers exactly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "centipede-v3-runtime-"));
    directories.push(directory);
    const first = createCentipedeV3Runtime({ dataDir: directory, now: () => 1_000 });
    runtimes.push(first);

    const captured = await first.dispatch(capture());
    expect(captured.status).toBe("ok");
    if (captured.status !== "ok") throw new Error("capture did not complete");
    expect(captured.view.state).toBe("running");

    const verified = await first.dispatch({
      kind: "verify",
      outcomeId: captured.view.contract.outcomeId,
      contractVersion: captured.view.contract.version,
    });
    expect(verified).toMatchObject({ status: "ok", view: { state: "completed" } });
    if (verified.status !== "ok" || !verified.receipt) throw new Error("expected a verified runtime receipt");
    const canonicalWork = first.inspectCanonicalWork("capture-runtime-1");
    expect(canonicalWork).toHaveLength(1);
    expect(canonicalWork[0]?.status).toBe("completed");
    expect(canonicalWork[0]?.evidence[0]?.kind).toBe("worker-batch");
    expect(verified.receipt.record.executionTrace.complete).toBe(true);
    expect(verified.receipt.record.executionTrace.traceIdentity).toBe(verified.receipt.record.verifiedOutput.traceIdentity);
    expect(verified.receipt.record.executionTrace.traceIdentity).toBe(verified.receipt.record.retrospective.traceIdentity);
    expect(verified.receipt.record.retrospective.metrics.find((metric) => metric.name === "aws")?.value.status).toBe("unknown");
    const graphBefore = first.inspectContext();
    expect(graphBefore.nodes.some((node) => node.id === "capture:capture-runtime-1")).toBe(true);
    expect(graphBefore.nodes.some((node) => node.type === "verified-outcome")).toBe(true);
    expect(graphBefore.nodes.some((node) => node.id === "receipt:capture-runtime-1:v1")).toBe(true);
    expect(graphBefore.nodes.some((node) => node.id === "learning:capture-runtime-1:v1")).toBe(true);
    expect(graphBefore.edges).toContainEqual({
      from: "capture:capture-runtime-1",
      to: "outcome:capture-runtime-1",
      kind: "supports",
    });
    const projectionBefore = first.inspectOutcome("capture-runtime-1");

    const restarted = createCentipedeV3Runtime({ dataDir: directory, now: () => 1_000 });
    runtimes.push(restarted);
    expect(restarted.inspectOutcome("capture-runtime-1")).toEqual(projectionBefore);
    expect(restarted.inspectOutcomeReceipt("capture-runtime-1")).toEqual(verified.receipt);
    expect(restarted.inspectContext()).toEqual(graphBefore);
    await expect(restarted.dispatch(capture())).resolves.toMatchObject({ status: "ok", view: { state: "completed" } });
    expect(restarted.workExecutionCount()).toBe(1);

    const later = await restarted.dispatch(capture("capture-runtime-2", "A second requested receipt is ready."));
    expect(later).toMatchObject({ status: "ok", view: { state: "running" } });
    if (later.status !== "ok") throw new Error("expected the later outcome to run");
    const laterVerified = await restarted.dispatch({ kind: "verify", outcomeId: later.view.contract.outcomeId, contractVersion: later.view.contract.version });
    expect(laterVerified).toMatchObject({ status: "ok", view: { state: "completed" } });
    if (laterVerified.status !== "ok" || !laterVerified.receipt) throw new Error("expected the later outcome to verify");
    expect(laterVerified.receipt.record.executionTrace.entries.some((entry) => entry.detail?.includes("route=known-safe"))).toBe(true);
  });

  it("keeps low-confidence captures fail-closed and supports declared user outcomes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "centipede-v3-runtime-"));
    directories.push(directory);
    const runtime = createCentipedeV3Runtime({ dataDir: directory, now: () => 1_000 });
    runtimes.push(runtime);
    const lowConfidence = { ...capture(), evidence: { ...capture().evidence, confidence: "low" as const } };
    await expect(runtime.dispatch(lowConfidence)).resolves.toMatchObject({ status: "blocked", reason: "capture_ambiguous" });

    const declared = await runtime.dispatch({
      kind: "declare",
      contract: runtime.userContract("user-outcome", "Produce the user-stated result"),
    });
    expect(declared).toMatchObject({ status: "ok", view: { state: "declared" } });
  });

  it("ingests graph deltas and lets an explicit conflict defeat lexical relevance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "centipede-v3-runtime-"));
    directories.push(directory);
    const runtime = createCentipedeV3Runtime({ dataDir: directory, now: () => 1_000 });
    runtimes.push(runtime);
    const first = await runtime.dispatch(capture("capture-graph-first", "The requested receipt is ready."));
    expect(first).toMatchObject({ status: "ok", view: { state: "running", contract: { outcomeId: "capture-graph-first" } } });
    const second = await runtime.dispatch({
      ...capture("capture-graph-conflict", "The requested receipt is ready."),
      evidence: {
        ...capture("capture-graph-conflict", "The requested receipt is ready.").evidence,
        contentHash: "e".repeat(64),
        contextDelta: {
          nodes: [{ id: "capture:capture-graph-conflict", type: "capture" }, { id: "outcome:capture-graph-first", type: "outcome" }],
          edges: [{ from: "capture:capture-graph-conflict", to: "outcome:capture-graph-first", kind: "conflicts" }],
        },
      },
    });
    expect(second).toMatchObject({ status: "ok", view: { contract: { outcomeId: "capture-graph-conflict" } } });
    expect(runtime.inspectContext().edges).toContainEqual({ from: "capture:capture-graph-conflict", to: "outcome:capture-graph-first", kind: "conflicts" });
  });

  it("reconciles a slow canonical worker when the public verify command arrives after dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "centipede-v3-runtime-"));
    directories.push(directory);
    const runtime = createCentipedeV3Runtime({
      dataDir: directory,
      now: () => 1_000,
      workerRunner: async () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 20)),
    });
    runtimes.push(runtime);
    const captured = await runtime.dispatch(capture("capture-runtime-slow", "A slow requested receipt is ready."));
    expect(captured.status).toBe("blocked");
    if (captured.status !== "blocked" || !captured.view) throw new Error("expected slow worker dispatch to remain observable");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const verified = await runtime.dispatch({ kind: "verify", outcomeId: captured.view.contract.outcomeId, contractVersion: captured.view.contract.version });
    expect(verified).toMatchObject({ status: "ok", view: { state: "completed" } });
  });
});

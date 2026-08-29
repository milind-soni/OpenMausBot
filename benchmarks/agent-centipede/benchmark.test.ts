import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assertSandboxIsolated, createBenchmarkSandbox } from "./sandbox.ts";
import { runAllScenarios, runDeterministicTopologyCoverage, runScenarioById, runTopology } from "./runner.ts";
import { createBaseline, evaluatePromotionGate } from "./evaluation.ts";
import { getScenario } from "./scenarios.ts";
import { scoreScenario } from "./scorer.ts";
import { CHIEF_CAPTURE_TEMPLATE, getTopology } from "./topologies.ts";

describe("Agent Centipede benchmark lab", () => {
  it("creates isolated profile, storage, database, and config paths", async () => {
    const sandbox = await createBenchmarkSandbox();
    expect(sandbox.env.OMB_BENCHMARK).toBe("1");
    expect(sandbox.paths.database).toContain(sandbox.paths.root);
    expect(sandbox.paths.config).toContain(sandbox.paths.root);
    expect(await readFile(sandbox.paths.config, "utf8")).toContain('"production": false');
    await sandbox.dispose();
  });

  it("allows arbitrary user topology names in the sandbox path", async () => {
    const base = join(tmpdir(), "chief");
    await mkdir(base, { recursive: true });
    const sandbox = await createBenchmarkSandbox(base);
    try {
      expect(sandbox.paths.root).toContain("chief");
    } finally {
      await sandbox.dispose();
    }
  });

  it("rejects a tampered sandbox marker before a live adapter can run", async () => {
    const sandbox = await createBenchmarkSandbox();
    try {
      await writeFile(sandbox.paths.marker, "not-a-benchmark\n", "utf8");
      expect(() => assertSandboxIsolated(sandbox.paths)).toThrow(/marker/i);
    } finally {
      await sandbox.dispose();
    }
  });

  it("passes every deterministic scenario with evidence and metrics", async () => {
    const results = await runAllScenarios();
    expect(results).toHaveLength(7);
    expect(results.every((result) => result.passed)).toBe(true);
    expect(results.every((result) => result.events.length > 0)).toBe(true);
    expect(results.every((result) => result.metrics.costUsd >= 0 && result.metrics.latencyMs > 0)).toBe(true);
  });

  it("does not mistake fixture success for independently verified outcome proof", async () => {
    const result = await runScenarioById("browser-workflow");
    expect(result.score).toBe(100);
    expect(result.evidence.mode).toBe("fixture");
    expect(result.evidence.outcomeScore).toBe(0);
    expect(result.evidence.e2eVerified).toBe(false);
    const gate = evaluatePromotionGate([result], createBaseline([result]));
    expect(gate.promotable).toBe(false);
    expect(gate.reasons).toContain("browser-workflow:evidence-unverified");
  });

  it("counts only explicit independent postcondition evidence", async () => {
    const fixture = await runScenarioById("browser-workflow");
    const verifiedEvents = fixture.events.map((event) => ({
      ...event,
      data: { ...event.data, outcomeVerified: true, verificationRef: `fixture-verifier://${event.actionId}` },
    }));
    const scored = scoreScenario(getScenario("browser-workflow"), verifiedEvents, {}, "independent");
    expect(scored.evidence.outcomeScore).toBe(100);
    expect(scored.evidence.e2eVerified).toBe(true);
    expect(scored.evidence.unverifiedActionIds).toHaveLength(0);
  });

  it("records auth recovery retries and never advances a failed cursor", async () => {
    const result = await runScenarioById("auth-tool-recovery");
    expect(result.passed).toBe(true);
    expect(result.metrics.retries).toBeGreaterThanOrEqual(2);
    expect(result.events.some((event) => event.status === "needs-auth")).toBe(true);
    expect(result.events.some((event) => event.actionId === "record-cursor" && event.data.advancedOnlyAfterSuccess === true)).toBe(true);
  });

  it("blocks external actions without approval and supports dry-run", async () => {
    const result = await runScenarioById("privacy-approval-boundary");
    expect(result.events.find((event) => event.actionId === "send-external-message")?.status).toBe("blocked");
    const dryRun = await runScenarioById("windows-software", { dryRun: true });
    expect(dryRun.events.filter((event) => event.status === "dry-run")).not.toHaveLength(0);
    expect(dryRun.metrics.safetyViolations).toBe(0);
  });

  it("passes the required topology matrix without role-name assumptions", async () => {
    const coverage = await runDeterministicTopologyCoverage();
    expect(coverage).toHaveLength(4);
    expect(coverage.every((entry) => entry.passed)).toBe(true);
    expect(coverage.every((entry) => entry.results.length === 7)).toBe(true);
    for (const entry of coverage) {
      expect(entry.results).toHaveLength(7);
      expect(entry.results.every((result) => result.topology?.id === entry.topology.id)).toBe(true);
      expect(entry.results.flatMap((result) => result.events).every((event) => typeof event.agentId === "string")).toBe(true);
    }
  });

  it("keeps Chief + Capture as an optional compatibility template", async () => {
    expect(getTopology("chief-capture-template")).toBe(CHIEF_CAPTURE_TEMPLATE);
    const coverage = await runTopology(CHIEF_CAPTURE_TEMPLATE);
    expect(coverage.passed).toBe(true);
    expect(coverage.results).toHaveLength(7);
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessSandboxAdapter } from "./adapters.ts";
import { createBaseline, evaluatePromotionGate } from "./evaluation.ts";
import { readTrace } from "./trace.ts";
import { runScenarioById } from "./runner.ts";

async function makeProfile(): Promise<{ root: string; profileDir: string; dataRoot: string; traceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "omb-agent-centipede-test-"));
  const dataRoot = join(root, "data");
  return { root, profileDir: join(dataRoot, "profile"), dataRoot, traceDir: join(dataRoot, "traces") };
}

describe("live benchmark adapters and promotion", () => {
  it("runs an allowlisted process in an explicit sandbox and writes a replay trace", async () => {
    const profile = await makeProfile();
    try {
      const adapter = createProcessSandboxAdapter({
        ...profile,
        dryRun: false,
        allowNetwork: false,
        allowSideEffects: true,
        approvedActionIds: ["launch-editor"],
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({status:'ok',tokens:7,data:{proof:'sandbox'}}))"],
      });
      const event = await adapter.perform("windows-software", { id: "launch-editor", kind: "windows", target: "fixture-editor", latencyMs: 1, costUsd: 0 }, 1);
      expect(event.status).toBe("ok");
      expect(event.tokens).toBe(7);
      const tracePath = typeof event.data.tracePath === "string" ? event.data.tracePath : "";
      const records = await readTrace(tracePath);
      expect(records).toHaveLength(1);
      expect(records[0]?.event.id).toBe(event.id);
      expect(await readFile(tracePath, "utf8")).toContain("sandbox");
    } finally {
      await rm(profile.root, { recursive: true, force: true });
    }
  });

  it("does not start a process for side effects during dry-run", async () => {
    const profile = await makeProfile();
    try {
      const adapter = createProcessSandboxAdapter({
        ...profile,
        dryRun: true,
        allowNetwork: false,
        command: process.execPath,
        args: ["-e", "throw new Error('must not run')"],
      });
      const event = await adapter.perform("windows-software", { id: "save", kind: "windows", target: "sandbox/file", latencyMs: 1, costUsd: 0 }, 1);
      expect(event.status).toBe("dry-run");
      expect(event.data.dryRun).toBe(true);
    } finally {
      await rm(profile.root, { recursive: true, force: true });
    }
  });

  it("rebinds live adapters to the runner sandbox and excludes parent secrets", async () => {
    const suppliedProfile = await makeProfile();
    const secretName = "OPENMAUS_BENCHMARK_PARENT_SECRET";
    const previousSecret = process.env[secretName];
    process.env[secretName] = "must-not-cross";
    try {
      const result = await runScenarioById("browser-workflow", {
        retainSandbox: true,
        adapterFactory: () => createProcessSandboxAdapter({
          ...suppliedProfile,
          dryRun: false,
          allowNetwork: false,
          command: process.execPath,
          args: ["-e", "process.stdout.write(JSON.stringify({data:{boundDataRoot:process.env.OMB_DATA_DIR,parentSecret:process.env.OPENMAUS_BENCHMARK_PARENT_SECRET ?? null}}))"],
        }),
      });
      expect(result.events).toHaveLength(3);
      expect(result.events.every((event) => event.data.boundDataRoot === result.sandbox.storage)).toBe(true);
      expect(result.events.every((event) => event.data.parentSecret === null)).toBe(true);
      expect(result.sandbox.storage).not.toBe(suppliedProfile.dataRoot);
      await rm(result.sandbox.root, { recursive: true, force: true });
    } finally {
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
      await rm(suppliedProfile.root, { recursive: true, force: true });
    }
  });

  it("fails closed when budgets, evidence, or baseline regress", async () => {
    const result = await runScenarioById("product-build-qa", { budgets: { maxAttempts: 1 } });
    expect(result.passed).toBe(false);
    expect(result.metrics.budgetViolations).toContain("attempts>1");
    const baseline = createBaseline([result]);
    const gate = evaluatePromotionGate([result], baseline);
    expect(gate.promotable).toBe(false);
    expect(gate.reasons.some((reason) => reason.includes("scenario-failed"))).toBe(true);
    const empty = evaluatePromotionGate([]);
    expect(empty.promotable).toBe(false);
  });
});

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const requiredRuntimeJobs = ["vitest", "behavior-evals", "packaged-server", "windows-cua", "electron-smokes"];

function runGate(needs: Record<string, unknown>) {
  // Execute the actual gate, not a duplicate of its success/failure logic.
  const command = workflow.jobs.gate.steps[0].run as string;
  const script = command.match(/node --input-type=module -e '([\s\S]+)'/);
  expect(script).not.toBeNull();
  const check = spawnSync(process.execPath, ["--input-type=module", "-e", script![1]], {
    env: { ...process.env, NEEDS: JSON.stringify(needs) },
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(check.error).toBeUndefined();
  return check;
}

function gateNeeds(runtime: string) {
  return {
    static: { result: "success", outputs: { runtime } },
    ...Object.fromEntries(requiredRuntimeJobs.map((job) => [job, { result: runtime === "true" ? "success" : "skipped" }])),
  };
}

describe("CI concurrency", () => {
  it("supersedes old main and PR checks without cancelling merge-queue checks", () => {
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on).toHaveProperty("merge_group");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' || github.event_name == 'push' }}",
    );
  });

  it("keeps each PR and merge-queue group separate from main", () => {
    expect(workflow.concurrency.group).toBe(
      "ci-${{ github.event_name == 'merge_group' && github.event.merge_group.head_ref || github.ref }}",
    );
  });

  it("allows cancelled summary jobs to stop without skipping failure reporting", () => {
    expect(workflow.jobs.gate.if).toBe("${{ !cancelled() }}");
    expect(workflow.jobs.gate.needs).toEqual(["static", ...requiredRuntimeJobs]);
  });

  it("schedules one read-only final gate without changing the platform test matrix", () => {
    expect(workflow.jobs.gate.name).toBe("CI");
    expect(workflow.jobs.gate.strategy).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.vitest.strategy.matrix).toEqual({
      os: ["macos-latest", "ubuntu-latest", "windows-latest"], shard: [1, 2, 3, 4],
    });
  });

  it.each(requiredRuntimeJobs)("fails closed for every required %s outcome", (job) => {
    for (const result of ["success", "failure", "cancelled", "skipped"]) {
      const check = runGate({ ...gateNeeds("true"), [job]: { result } });
      expect(check.status, check.stderr).toBe(result === "success" ? 0 : 1);
    }
  });

  it("accepts only deliberately unselected jobs on docs-only PRs", () => {
    expect(runGate(gateNeeds("false")).status).toBe(0);
    for (const result of ["success", "failure", "cancelled"]) {
      expect(runGate({ ...gateNeeds("false"), vitest: { result } }).status).toBe(1);
    }
  });

  it("rejects failed preflight and missing or malformed selection", () => {
    for (const result of ["failure", "cancelled", "skipped"]) {
      expect(runGate({ ...gateNeeds("false"), static: { result, outputs: { runtime: "false" } } }).status).toBe(1);
    }
    for (const runtime of ["", "yes", "TRUE"]) expect(runGate(gateNeeds(runtime)).status).toBe(1);
    expect(runGate({ ...gateNeeds("false"), static: { result: "success", outputs: {} } }).status).toBe(1);
  });

  it("always starts the workflow and validates selection and docs before fanout", () => {
    expect(workflow.on.pull_request).toBeNull();
    expect(workflow.jobs.static.if).toBeUndefined();
    expect(workflow.jobs.static.steps[0].with["fetch-depth"]).toBe(0);
    expect(workflow.jobs.static.steps.find((step: { id?: string }) => step.id === "scope").run).toBe("node scripts/ci-scope.mjs");
    expect(workflow.jobs.static.outputs).toEqual({
      runtime: "${{ steps.scope.outputs.runtime }}", mobile: "${{ steps.scope.outputs.mobile }}",
    });
    expect(workflow.jobs.static.steps.some((step: { run?: string }) =>
      step.run === "pnpm exec vitest run scripts/ci-scope.test.ts scripts/ci-workflow.test.ts scripts/testing/verification-docs.test.ts",
    )).toBe(true);
    for (const [name, job] of Object.entries(workflow.jobs) as [string, { needs?: string; if?: string }][]) {
      if (["static", "gate"].includes(name)) continue;
      expect(job.needs).toBe("static");
      expect(job.if).toBe(`needs.static.outputs.${["ios", "android"].includes(name) ? "mobile" : "runtime"} == 'true'`);
    }
  });

  it("keeps the redundant Windows workflow available only for manual debugging", () => {
    const smoke = parse(readFileSync(new URL("../.github/workflows/shared-terminal-smoke.yml", import.meta.url), "utf8"));
    expect(smoke.on).toEqual({ workflow_dispatch: null });
    const commands = smoke.jobs.windows.steps.map((step: { run?: string }) => step.run);
    expect(commands).toContain("node --test electron/shared-computer-access.node-test.mjs");
    expect(commands).toContain("pnpm exec vitest run server/shared-computers.e2e.test.ts");
  });
});

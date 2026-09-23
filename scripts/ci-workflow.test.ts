import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

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
    expect(workflow.jobs.gate.needs).toEqual([
      "static", "vitest", "packaged-server", "windows-cua", "electron-smokes",
    ]);
  });

  it.each(["success", "failure", "cancelled", "skipped"])("reports a dependency result of %s honestly", (result) => {
    // Execute the actual gate, not a duplicate of its success/failure logic.
    const command = workflow.jobs.gate.steps[0].run as string;
    const script = command.match(/node --input-type=module -e '([\s\S]+)'/);
    expect(script).not.toBeNull();
    const needs = Object.fromEntries(workflow.jobs.gate.needs.map((job: string) => [job, { result: job === "vitest" ? result : "success" }]));
    const check = spawnSync(process.execPath, ["--input-type=module", "-e", script![1]], {
      env: { ...process.env, NEEDS: JSON.stringify(needs) },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(check.error).toBeUndefined();
    expect(check.status, check.stderr).toBe(result === "success" ? 0 : 1);
  });
});

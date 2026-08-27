import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runAutomatedFakePilot, type AutomatedFakePilotResult } from "./scenario.ts";
import { AUTOMATED_FAKE_PENDING_CHECKS, OUT_OF_SCOPE_CHECKS, validateAcceptanceReport } from "./report-schema.ts";

let active: AutomatedFakePilotResult | undefined;
const scratch: string[] = [];

afterEach(() => {
  active?.dispose();
  active = undefined;
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("automated fake non-production pilot", () => {
  it("runs the production-isomorphic lifecycle and leaves real checks pending", async () => {
    active = await runAutomatedFakePilot();
    validateAcceptanceReport(active.report);

    expect(active.report).toMatchObject({
      scope: "automated_fake",
      status: "pending",
      ownerSignOff: { status: "pending", signedAt: null, evidenceHash: null },
      recovery: { status: "pass", restartCount: 1 },
      outbox: { retries: { status: "pass", attempts: 2 }, supersession: { status: "pass" } },
    });
    for (const id of AUTOMATED_FAKE_PENDING_CHECKS) expect(active.report.checks[id].status).toBe("pending");
    for (const id of OUT_OF_SCOPE_CHECKS) expect(active.report.checks[id].status).toBe("not_applicable");
    expect(active.report.controlPolicy.ownerOutcomes.map((outcome) => outcome.action)).toEqual([
      "stale_action",
      "audit_write_failure",
      "pause",
      "pause_replay",
      "resume",
      "retry",
      "reject",
      "cancel",
      "accept",
    ]);
    expect(active.report.controlPolicy.nonOwnerOutcomes.map((outcome) => outcome.action)).toEqual([
      "pause", "resume", "retry", "reject", "cancel", "accept",
    ]);
    expect(active.report.controlPolicy.nonOwnerOutcomes.every((outcome) =>
      outcome.status === "pass" && outcome.stateChanged === false && outcome.auditEventIds.length > 0,
    )).toBe(true);
    expect(active.report.targetRepository.final).toEqual(active.report.targetRepository.initial);
    expect(active.report.trace.planRevisionId).toMatch(/-plan-2$/u);
    expect(active.report.trace.scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      "primary_candidate", "retry_reject", "cancel", "restart_recovery",
    ]);
    const scenarioRunIds = new Set(active.report.trace.scenarios.flatMap((scenario) => scenario.runIds));
    expect(new Set(active.report.trace.nodes.map((node) => node.runId))).toEqual(scenarioRunIds);
    expect(active.report.trace.nodes[0]).toMatchObject({
      changedPaths: ["src/value.txt"],
      tests: [expect.objectContaining({ commandId: "pilot:target", exitCode: 0 })],
    });

    const serialized = JSON.stringify(active.report);
    expect(serialized).not.toMatch(/actionToken|clientSecret|sessionWebhook|Authorization|Bearer /iu);
    expect(serialized).not.toContain(active.scratchDirectory);
    const scratch = active.scratchDirectory;
    active.dispose();
    active = undefined;
    expect(existsSync(scratch)).toBe(false);
  });

  it("writes Owner-only artifacts without echoing their absolute paths", () => {
    const output = mkdtempSync(join(tmpdir(), "openmausbot-pilot-cli-"));
    scratch.push(output);
    const stdout = execFileSync(process.execPath, [
      "--experimental-strip-types",
      resolve("scripts/collaboration-pilot/run-fake.ts"),
      "--output",
      output,
    ], { cwd: resolve("."), encoding: "utf8" });
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(result).toMatchObject({
      scope: "automated_fake",
      status: "pending",
      jsonFile: "acceptance-report.json",
      markdownFile: "acceptance-report.md",
    });
    expect(stdout).not.toContain(output);
    expect(Object.keys(result)).not.toContain("jsonPath");
    expect(Object.keys(result)).not.toContain("markdownPath");
    expect(lstatSync(join(output, "acceptance-report.json")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(output, "acceptance-report.md")).mode & 0o777).toBe(0o600);

    const failure = spawnSync(process.execPath, [
      "--experimental-strip-types",
      resolve("scripts/collaboration-pilot/run-fake.ts"),
      "--bad",
      output,
    ], { cwd: resolve("."), encoding: "utf8" });
    expect(failure.status).toBe(1);
    expect(failure.stderr.trim()).toBe(JSON.stringify({ status: "fail", errorCode: "pilot_invalid_arguments" }));
    expect(failure.stderr).not.toContain(resolve("."));
    expect(failure.stderr).not.toContain(output);
  });
});

// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { reconcileExecution } from "./execution-controller";
import { integrationBridge } from "./integration-bridge";
import { finalizeRunPullRequest, readRunDeployment, reconcileMergedRunPullRequest } from "./github-execution";
import { effectiveExecutionPolicy } from "./execution-policy";
import { executionDeploymentRuns, executionRuns, readExecutionRun, saveExecutionRun, type ExecutionPrincipal, type PrivateRun } from "./execution-store";

vi.mock("./integration-bridge", () => ({ integrationBridge: vi.fn() }));
vi.mock("./github-execution", () => ({ finalizeRunPullRequest: vi.fn(), readRunDeployment: vi.fn(), reconcileMergedRunPullRequest: vi.fn() }));
vi.mock("./execution-cloud-runtime", () => ({ cloudExecutionStopProof: vi.fn(), maintainCloudExecution: vi.fn() }));
vi.mock("./execution-common", () => ({
  ExecutionError: class extends Error {}, executionId: {}, observedExecutionHost: vi.fn(value => value), revalidateExecutionPrincipal: vi.fn(),
}));
vi.mock("./execution-store", () => ({
  acquireExecutionLock: vi.fn(() => "lock"), releaseExecutionLock: vi.fn(), atomicExecution: (fn: () => unknown) => fn(),
  appendExecutionEvent: vi.fn(), executionAccounts: vi.fn(() => []), executionHosts: vi.fn(() => []),
  executionRuns: vi.fn(), executionDeploymentRuns: vi.fn(), readExecutionRun: vi.fn(), saveExecutionRun: vi.fn(),
  executionTokenHash: vi.fn(), readExecutionHost: vi.fn(), saveExecutionHost: vi.fn(),
}));
const now = Date.UTC(2026, 10, 8, 12), headSha = "a".repeat(40), mergeSha = "c".repeat(40);
const repoUrl = "https://github.com/fixture/execution";
let record: PrivateRun, principal: ExecutionPrincipal;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  record = {
    run: { id: "run", teamId: "team", projectId: "project", taskId: "task", requestedBy: "owner", title: "Verified change", status: "awaiting_checks",
      createdAt: now - 120000, updatedAt: now - 120000, attempt: 1, repositoryUrl: repoUrl, baseBranch: "release", branch: "origin/run", environment: "default",
      checkpoint: { sha: headSha }, verification: [{ command: "npm test", kind: "test", exitCode: 0 }, { command: "npm run smoke", kind: "smoke", exitCode: 0 }],
      deployment: { status: "unknown" }, approvals: [], usage: { inputTokens: 0, outputTokens: 0, estimatedApiUsd: null }, processStopped: true },
    policy: effectiveExecutionPolicy({ autoMerge: true, baseBranch: "release", verificationCommands: ["npm test"], smokeCommand: "npm run smoke" }),
    prompt: "Implement", grantId: "grant", attempted: [], leaseHash: null, leaseExpiresAt: 0, sequence: 0, cancelRequested: false, logBytes: 0,
  };
  principal = { userId: "owner", teamId: "team", workspaceRole: "member", admin: false, projectAdmin: false, write: true, projectIds: ["project"],
    project: { id: "project", name: "Fixture", status: "active", repositoryUrl: repoUrl }, task: { id: "task", title: "Issue", description: "", done: true } };
  vi.mocked(integrationBridge).mockImplementation(async operation => {
    if (operation !== "executionContext") throw new Error(`Unexpected mutation: ${operation}`);
    return structuredClone(principal);
  });
  vi.mocked(executionRuns).mockImplementation(() => record.run.status === "merged" ? [] : [structuredClone(record)]);
  vi.mocked(executionDeploymentRuns).mockImplementation(() => record.run.status === "merged" ? [structuredClone(record)] : []);
  vi.mocked(readExecutionRun).mockImplementation(() => structuredClone(record));
  vi.mocked(saveExecutionRun).mockImplementation(value => { record = structuredClone(value); });
  vi.mocked(reconcileMergedRunPullRequest).mockImplementation(async input => {
    await input.authorize();
    return { state: "merged", number: 9, url: `${repoUrl}/pull/9`, mergeSha };
  });
  vi.mocked(readRunDeployment).mockImplementation(async input => {
    await input.authorize();
    return { status: "succeeded", mergeSha: input.mergeSha, observedAt: Date.now(), evidenceAt: now - 1000, url: "https://api.github.com/repos/fixture/execution/deployments/10/statuses/20" };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

test("lost merge response plus GitHub auto-close recovers a stopped verified run without another merge", async () => {
  expect(principal.task!.completionPullRequest).toBeUndefined();
  await reconcileExecution("team");
  expect(record.run).toMatchObject({ status: "merged", merge: { state: "merged", mergeSha }, deployment: { status: "unknown" } });
  expect(record.cancelRequested).toBe(false);
  expect(reconcileMergedRunPullRequest).toHaveBeenCalledWith(expect.objectContaining({ repositoryUrl: repoUrl, headSha, baseBranch: "release", branch: "origin/run" }));
  expect(finalizeRunPullRequest).not.toHaveBeenCalled();
  expect(integrationBridge).toHaveBeenCalledWith("executionContext", { userId: "owner", teamId: "team", projectId: "project", taskId: "task", grantId: "grant" });
});

test("closed issue without a merged match is cancelled without creating or merging anything", async () => {
  vi.mocked(reconcileMergedRunPullRequest).mockResolvedValueOnce({ state: "blocked", reason: "No merged match" });
  await reconcileExecution("team");
  expect(record.run.status).toBe("cancelled");
  expect(record.cancelRequested).toBe(true);
  expect(finalizeRunPullRequest).not.toHaveBeenCalled();
});

test("transient read failure retains uncertain awaiting_checks rather than false cancellation", async () => {
  vi.mocked(reconcileMergedRunPullRequest).mockResolvedValueOnce({ state: "awaiting_checks", reason: "Merge outcome is uncertain" });
  await reconcileExecution("team");
  expect(record.run).toMatchObject({ status: "awaiting_checks", reason: "Merge outcome is uncertain" });
  expect(record.cancelRequested).toBe(false);
  expect(finalizeRunPullRequest).not.toHaveBeenCalled();
});

test.each(["unverified", "running", "missing checkpoint"])("closed %s run cannot use receipt recovery", async scenario => {
  if (scenario === "unverified") record.run.verification[0].exitCode = 1;
  if (scenario === "running") { record.run.processStopped = false; record.leaseExpiresAt = now + 60000; }
  if (scenario === "missing checkpoint") record.run.checkpoint = undefined;
  await reconcileExecution("team");
  expect(reconcileMergedRunPullRequest).not.toHaveBeenCalled();
  expect(finalizeRunPullRequest).not.toHaveBeenCalled();
  expect(record.run.status).toBe(scenario === "running" ? "blocked" : "cancelled");
});

test.each(["grant", "repository", "project", "task"])("receipt recovery preserves %s authorization", async changed => {
  if (changed === "grant") principal.write = false;
  if (changed === "repository") principal.project!.repositoryUrl = "https://github.com/fixture/other";
  if (changed === "project") principal.project!.status = "archived";
  if (changed === "task") principal.task!.id = "another-task";
  await reconcileExecution("team");
  expect(reconcileMergedRunPullRequest).not.toHaveBeenCalled();
  expect(finalizeRunPullRequest).not.toHaveBeenCalled();
  expect(record.run.status).toBe("awaiting_checks");
});

test("already-merged runs refresh deployment evidence and a later failure supersedes success", async () => {
  record.run.status = "merged";
  record.run.merge = { state: "merged", mergeSha, number: 9 };
  await reconcileExecution("team");
  expect(record.run.deployment).toMatchObject({ status: "succeeded", mergeSha });
  expect(record.controllerCheckedAt).toBe(now);
  vi.spyOn(Date, "now").mockReturnValue(now + 60001);
  vi.mocked(readRunDeployment).mockResolvedValueOnce({ status: "failed", mergeSha, observedAt: now + 60001, evidenceAt: now + 60000 });
  await reconcileExecution("team");
  expect(record.run.status).toBe("merged");
  expect(record.run.deployment).toMatchObject({ status: "failed", mergeSha, evidenceAt: now + 60000 });
  expect(record.controllerCheckedAt).toBe(now + 60001);
  expect(finalizeRunPullRequest).not.toHaveBeenCalled();
});

test("deployment read unavailability persists freshness and advances polling fairness without claiming success", async () => {
  record.run.status = "merged"; record.run.merge = { state: "merged", mergeSha };
  record.run.deployment = { status: "succeeded", mergeSha, observedAt: now - 120000 };
  vi.mocked(readRunDeployment).mockResolvedValueOnce({ status: "unknown", mergeSha, observedAt: now, message: "Evidence unavailable" });
  await reconcileExecution("team");
  expect(record.run.deployment.status).toBe("unknown");
  expect(record.controllerCheckedAt).toBe(now);
  await reconcileExecution("team");
  expect(readRunDeployment).toHaveBeenCalledTimes(1);
});

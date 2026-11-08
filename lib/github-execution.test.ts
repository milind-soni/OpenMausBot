// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest";
import { finalizeRunPullRequest, prepareRunRepository, readRunDeployment, reconcileMergedRunPullRequest } from "./github-execution";
import { contextWithToken, createGitHubTask } from "./github-sync";
import { githubRequest } from "./github-workspace";
import { integrationBridge } from "./integration-bridge";
import { projectInstallationToken, revokeInstallationToken } from "./github-app";
import { openPR } from "./github-prs";
vi.mock("./github-sync", () => ({ contextWithToken: vi.fn(), createGitHubTask: vi.fn() }));
vi.mock("./github-workspace", () => ({ githubRequest: vi.fn(), GitHubHttpError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("./integration-bridge", () => ({ integrationBridge: vi.fn() }));
vi.mock("./github-app", () => ({ projectInstallationToken: vi.fn(), revokeInstallationToken: vi.fn(), repositoryPath: (url: string) => `/repos${new URL(url).pathname}` }));
vi.mock("./github-prs", () => ({ openPR: vi.fn() }));
const headSha = "a".repeat(40), baseSha = "b".repeat(40), mergeSha = "c".repeat(40), repoUrl = "https://github.com/fixture/execution";
const authorize = vi.fn(async () => {});
const input = { projectId: "project", taskId: "task", branch: "origin/run-1", baseBranch: "main", headSha, title: "Verified change", verification: [{ command: "npm test", exitCode: 0, kind: "test" as const }, { command: "npm run smoke", exitCode: 0, kind: "smoke" as const }], smokePassed: true, authorize };
let check: { status: string; conclusion: string | null }, review: string, changedHead: boolean, merged: boolean, ambiguous: boolean;
beforeEach(() => {
  vi.resetAllMocks();
  authorize.mockResolvedValue(undefined);
  check = { status: "completed", conclusion: "success" }; review = "APPROVED"; changedHead = false; merged = false; ambiguous = false;
  vi.mocked(contextWithToken).mockResolvedValue({ project: { _id: "project", name: "Fixture", status: "active", repoUrl, githubRepoId: 1, githubWorkspaceAccess: true }, task: { _id: "task", title: "Issue", done: false, githubIssueNumber: 7, githubIssueUrl: `${repoUrl}/issues/7`, githubIssueNodeId: "issue-7", githubIssueRepoId: 1 }, repo: { owner: "fixture", repo: "execution" }, token: "fixture-read", expiresAt: undefined, credentialAllowed: true, legacyOwner: false, connection: null });
  vi.mocked(projectInstallationToken).mockResolvedValue({ token: "fixture-scoped", expiresAt: new Date(Date.now() + 3600000).toISOString() });
  vi.mocked(openPR).mockResolvedValue({ number: 9, url: `${repoUrl}/pull/9`, branch: input.branch, headSha, baseSha, state: "open", checks: "success", review: "approved", mergeable: true, githubUpdatedAt: 1 });
  vi.mocked(githubRequest).mockImplementation(async (path, _token, options) => {
    if (path === "/repos/fixture/execution") return { id: 1, full_name: "fixture/execution" };
    if (path.endsWith("/issues/7")) return { number: 7, node_id: "issue-7" };
    if (path.includes("/git/ref/heads/")) return { ref: `refs/heads/${decodeURIComponent(path.split("/git/ref/heads/")[1])}`, object: { sha: path.endsWith("main") ? baseSha : headSha } };
    if (path.includes("/pulls?")) return [];
    if (path.endsWith("/pulls/9")) return { number: 9, node_id: "pr-9", html_url: `${repoUrl}/pull/9`, body: "<!-- origin-task:task -->", state: merged ? "closed" : "open", draft: false, merged, merged_at: merged ? "2026-11-01T12:00:00Z" : null, merge_commit_sha: merged ? mergeSha : null, mergeable: true, mergeable_state: "clean", head: { sha: changedHead ? "d".repeat(40) : headSha, ref: input.branch, repo: { id: 1 } }, base: { ref: "main", sha: baseSha, repo: { id: 1 } } };
    if (path.includes("/check-runs?")) return { total_count: 1, check_runs: [{ name: "ci", app: { id: 100 }, ...check }] };
    if (path.includes("/statuses?")) return [];
    if (path === "/graphql") return { data: { node: { reviewDecision: review, mergeStateStatus: "CLEAN", baseRef: { branchProtectionRule: { id: "protection" } } } } };
    if (path.endsWith("/protection")) return { required_status_checks: { contexts: ["ci"], checks: [{ context: "ci", app_id: 100 }] }, required_pull_request_reviews: { required_approving_review_count: 1 } };
    if (path.includes("/rules/branches/")) return [];
    if (path.endsWith("/merge")) {
      expect(options?.method).toBe("PUT");
      expect(JSON.parse(options!.body as string)).toEqual({ sha: headSha, merge_method: "squash" });
      merged = true;
      if (ambiguous) throw new TypeError("response lost after merge");
      return { merged: true, sha: mergeSha };
    }
    throw new Error(`Unexpected synthetic GitHub request: ${path}`);
  });
});

test("prepare returns only a repository-scoped expiring push credential after validating issue identity", async () => {
  const prepared = await prepareRunRepository(input);
  expect(prepared).toMatchObject({ repositoryUrl: repoUrl, baseBranch: "main", issueNumber: 7, gitCredential: { username: "x-access-token", token: "fixture-scoped" } });
  expect(prepared.gitCredential.expiresAt).toBeGreaterThan(Date.now());
  expect(projectInstallationToken).toHaveBeenCalledWith("project", repoUrl, true, {});
});

test.each(["pending", "failure", "approval", "missing verification"])("%s never sends a merge", async scenario => {
  if (scenario === "pending") check = { status: "in_progress", conclusion: null };
  if (scenario === "failure") check = { status: "completed", conclusion: "failure" };
  if (scenario === "approval") review = "REVIEW_REQUIRED";
  const result = await finalizeRunPullRequest({ ...input, verification: scenario === "missing verification" ? [] : input.verification });
  expect(result.state).toBe(scenario === "pending" ? "awaiting_checks" : "blocked");
  expect(vi.mocked(githubRequest).mock.calls.some(([path]) => path.endsWith("/merge"))).toBe(false);
});

test("a push between gate reads invalidates the verified head and prevents merge", async () => {
  const request = vi.mocked(githubRequest).getMockImplementation()!;
  vi.mocked(githubRequest).mockImplementation(async (...args) => {
    const result = await request(...args);
    if (args[0].includes("/rules/branches/")) changedHead = true;
    return result;
  });
  expect(await finalizeRunPullRequest(input)).toMatchObject({ state: "blocked", reason: expect.stringContaining("changed") });
  expect(merged).toBe(false);
});

test.each([false, true])("an exact-head merge has a verified receipt, never a deployment claim (ambiguous response: %s)", async lost => {
  ambiguous = lost;
  const result = await finalizeRunPullRequest(input);
  expect(result).toEqual({ state: "merged", number: 9, url: `${repoUrl}/pull/9`, mergeSha });
  expect(result).not.toHaveProperty("deployment");
  expect(integrationBridge).toHaveBeenCalledWith("completeMergedIssue", expect.objectContaining({ issueNumber: 7, pullRequest: expect.objectContaining({ headSha, mergeSha }) }));
  expect(revokeInstallationToken).toHaveBeenCalledWith("fixture-scoped");
});

test("changed repository identity blocks before any pull request or merge mutation", async () => {
  const request = vi.mocked(githubRequest).getMockImplementation()!;
  vi.mocked(githubRequest).mockImplementation(async (...args) => args[0] === "/repos/fixture/execution" ? { id: 2, full_name: "fixture/execution" } : request(...args));
  expect(await finalizeRunPullRequest(input)).toMatchObject({ state: "blocked", reason: expect.stringContaining("identity changed") });
  expect(openPR).not.toHaveBeenCalled();
  expect(revokeInstallationToken).toHaveBeenCalledWith("fixture-scoped");
});

test("revocation during GitHub checks prevents the final merge", async () => {
  authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Requester grant revoked"));
  expect(await finalizeRunPullRequest(input)).toMatchObject({ state: "blocked", reason: "Requester grant revoked" });
  expect(merged).toBe(false);
});

test("prepare verifies the configured base ref instead of assuming main", async () => {
  expect(await prepareRunRepository({ ...input, baseBranch: "release/next" })).toMatchObject({ baseBranch: "release/next" });
  expect(githubRequest).toHaveBeenCalledWith("/repos/fixture/execution/git/ref/heads/release%2Fnext", "fixture-scoped");
  const request = vi.mocked(githubRequest).getMockImplementation()!;
  vi.mocked(githubRequest).mockImplementation(async (...args) => args[0].includes("/git/ref/heads/") ? { ref: "refs/heads/main" } : request(...args));
  await expect(prepareRunRepository({ ...input, baseBranch: "release/next" })).rejects.toThrow("base branch");
  expect(revokeInstallationToken).toHaveBeenCalledWith("fixture-scoped");
});

const readInput = { ...input, repositoryUrl: repoUrl };
async function closedIssueWithMergedPull() {
  merged = true;
  const context = await contextWithToken("project", "task", "read");
  vi.mocked(contextWithToken).mockResolvedValue({ ...context, task: { ...context.task!, done: true } });
  const request = vi.mocked(githubRequest).getMockImplementation()!;
  vi.mocked(githubRequest).mockImplementation(async (...args) => args[0].includes("/pulls?")
    ? [await request("/repos/fixture/execution/pulls/9", "fixture-read")] : request(...args));
}

function expectReadOnly() {
  expect(openPR).not.toHaveBeenCalled();
  expect(createGitHubTask).not.toHaveBeenCalled();
  expect(projectInstallationToken).not.toHaveBeenCalled();
  expect(integrationBridge).not.toHaveBeenCalled();
  expect(vi.mocked(githubRequest).mock.calls.every(([, , options]) => !options?.method || options.method === "GET")).toBe(true);
}

test("closed issue with lost completion receipt recovers only the exact task-marked merge, read-only", async () => {
  await closedIssueWithMergedPull();
  expect(await reconcileMergedRunPullRequest(readInput)).toEqual({ state: "merged", number: 9, url: `${repoUrl}/pull/9`, mergeSha });
  expect(authorize).toHaveBeenCalledTimes(2);
  expectReadOnly();
});

test("closed issue without a matching merged PR never creates a PR or repairs a missing issue", async () => {
  const context = await contextWithToken("project", "task", "read");
  vi.mocked(contextWithToken).mockResolvedValue({ ...context, task: { ...context.task!, done: true, githubIssueNumber: undefined, githubIssueUrl: undefined } });
  expect(await reconcileMergedRunPullRequest(readInput)).toMatchObject({ state: "blocked" });
  expectReadOnly();
});

test.each(["head", "base", "head repository", "base repository", "marker", "unmerged"])("read-only recovery rejects mismatched %s", async mismatch => {
  await closedIssueWithMergedPull();
  const request = vi.mocked(githubRequest).getMockImplementation()!;
  vi.mocked(githubRequest).mockImplementation(async (...args) => {
    const result = await request(...args);
    if (!args[0].endsWith("/pulls/9")) return result;
    const pr = result as { head: { sha: string; repo: { id: number } }; base: { ref: string; repo: { id: number } }; body: string; merged: boolean };
    if (mismatch === "head") pr.head.sha = "d".repeat(40);
    if (mismatch === "base") pr.base.ref = "other";
    if (mismatch === "head repository") pr.head.repo.id = 2;
    if (mismatch === "base repository") pr.base.repo.id = 2;
    if (mismatch === "marker") pr.body = "<!-- origin-task:someone-else -->";
    if (mismatch === "unmerged") pr.merged = false;
    return pr;
  });
  expect(await reconcileMergedRunPullRequest(readInput)).toMatchObject({ state: "blocked" });
  expectReadOnly();
});

test.each(["transport", "authorization", "repository"])("recovery retains uncertainty on %s failure", async failure => {
  await closedIssueWithMergedPull();
  const request = vi.mocked(githubRequest).getMockImplementation()!;
  if (failure === "authorization") authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Grant revoked"));
  else vi.mocked(githubRequest).mockImplementation(async (...args) => {
    if (failure === "repository" && args[0] === "/repos/fixture/execution") return { id: 2, full_name: "fixture/execution" };
    if (failure === "transport" && args[0].includes("/pulls?")) throw new TypeError("Connection lost");
    return request(...args);
  });
  expect(await reconcileMergedRunPullRequest(readInput)).toMatchObject({ state: "awaiting_checks" });
  expectReadOnly();
});

const deploymentInput = { projectId: "project", taskId: "task", repositoryUrl: repoUrl, mergeSha, authorize };
function deploymentsFixture(deployments: unknown[], statuses: Record<number, unknown[]>) {
  const request = vi.mocked(githubRequest).getMockImplementation()!;
  vi.mocked(githubRequest).mockImplementation(async (...args) => {
    if (args[0].includes("/deployments?")) return deployments;
    const match = args[0].match(/\/deployments\/(\d+)\/statuses\?/);
    if (match) return statuses[Number(match[1])] || [];
    return request(...args);
  });
}
const deployed = { id: 10, sha: mergeSha, environment: "production", created_at: "2026-11-01T12:01:00Z" };
const success = { id: 20, state: "success", created_at: "2026-11-01T12:02:00Z" };

test("deployment success requires exact merge SHA evidence, with event time, read freshness and evidence URL", async () => {
  deploymentsFixture([deployed], { 10: [success] });
  const before = Date.now();
  const result = await readRunDeployment(deploymentInput);
  expect(result).toMatchObject({
    status: "succeeded", mergeSha, evidenceAt: Date.parse(success.created_at), environment: "production",
    url: "https://api.github.com/repos/fixture/execution/deployments/10/statuses/20",
  });
  expect(result.observedAt).toBeGreaterThanOrEqual(before);
  expect(result.observedAt).toBeLessThanOrEqual(Date.now());
  expect(vi.mocked(githubRequest).mock.calls.every(([, , options]) => !options?.method || options.method === "GET")).toBe(true);
  expect(openPR).not.toHaveBeenCalled();
});

test.each(["same deployment", "new deployment"])("newer deployment failure supersedes older success (%s)", async scenario => {
  const failure = { id: 21, state: "failure", created_at: "2026-11-01T12:03:00Z" };
  deploymentsFixture(scenario === "same deployment" ? [deployed] : [deployed, { ...deployed, id: 11 }],
    scenario === "same deployment" ? { 10: [success, failure] } : { 10: [success], 11: [failure] });
  expect(await readRunDeployment(deploymentInput)).toMatchObject({ status: "failed", evidenceAt: Date.parse(failure.created_at), mergeSha });
});

test.each(["absent", "different SHA", "no status", "inactive", "unavailable"])("deployment remains unknown when evidence is %s", async scenario => {
  deploymentsFixture(scenario === "absent" ? [] : [{ ...deployed, sha: scenario === "different SHA" ? headSha : mergeSha }],
    { 10: scenario === "no status" ? [] : [{ ...success, state: scenario === "inactive" ? "inactive" : "success" }] });
  if (scenario === "unavailable") vi.mocked(projectInstallationToken).mockRejectedValueOnce(new Error("Deployments read permission unavailable"));
  expect(await readRunDeployment(deploymentInput)).toMatchObject({ status: "unknown", mergeSha, observedAt: expect.any(Number) });
});

test("new deployment without status supersedes an older successful deployment without claiming pending", async () => {
  deploymentsFixture([deployed, { ...deployed, id: 11, created_at: "2026-11-01T12:04:00Z" }], { 10: [success] });
  expect(await readRunDeployment(deploymentInput)).toMatchObject({ status: "unknown", evidenceAt: Date.parse("2026-11-01T12:04:00Z") });
});

test("a newer deployment for another SHA cannot supersede exact-merge evidence", async () => {
  deploymentsFixture([deployed, { ...deployed, id: 11, sha: headSha, created_at: "2026-11-01T12:05:00Z" }],
    { 10: [success], 11: [{ id: 21, state: "failure", created_at: "2026-11-01T12:06:00Z" }] });
  expect(await readRunDeployment(deploymentInput)).toMatchObject({ status: "succeeded", mergeSha, evidenceAt: Date.parse(success.created_at) });
  expect(vi.mocked(githubRequest).mock.calls.some(([path]) => path.includes("/deployments/11/statuses"))).toBe(false);
});

test("shared deployment credentials request read-only deployment permission", async () => {
  const context = await contextWithToken("project", "task", "read");
  vi.mocked(contextWithToken).mockResolvedValue({ ...context, sharedConnection: true });
  vi.mocked(integrationBridge).mockResolvedValue({ token: "fixture-shared-deployment-read", repoUrl });
  deploymentsFixture([deployed], { 10: [success] });
  expect(await readRunDeployment(deploymentInput)).toMatchObject({ status: "succeeded" });
  expect(integrationBridge).toHaveBeenCalledWith("githubToken", { projectId: "project", access: "read", extra: { deployments: "read" } });
  expect(projectInstallationToken).not.toHaveBeenCalled();
  expect(revokeInstallationToken).toHaveBeenCalledWith("fixture-shared-deployment-read");
});

test("deployment evidence is discarded if the requester grant changes during the read", async () => {
  deploymentsFixture([deployed], { 10: [success] });
  authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Grant revoked"));
  expect(await readRunDeployment(deploymentInput)).toMatchObject({ status: "unknown" });
  expect(revokeInstallationToken).toHaveBeenCalledWith("fixture-scoped");
});

test("merge succeeds but all receipt reads are lost; auto-closed issue is recovered later without a second mutation", async () => {
  ambiguous = true;
  let readsUnavailable = true;
  const request = vi.mocked(githubRequest).getMockImplementation()!;
  vi.mocked(githubRequest).mockImplementation(async (...args) => {
    if (merged && readsUnavailable && args[0].endsWith("/pulls/9")) throw new TypeError("Receipt response lost");
    if (merged && args[0].includes("/pulls?")) return [await request("/repos/fixture/execution/pulls/9", "fixture-read")];
    return request(...args);
  });
  expect(await finalizeRunPullRequest(input)).toMatchObject({ state: "awaiting_checks" });
  expect(merged).toBe(true);
  expect(integrationBridge).not.toHaveBeenCalledWith("completeMergedIssue", expect.anything());
  const mutations = vi.mocked(githubRequest).mock.calls.filter(([, , options]) => options?.method && options.method !== "GET").length;
  const context = await contextWithToken("project", "task", "read");
  vi.mocked(contextWithToken).mockResolvedValue({ ...context, task: { ...context.task!, done: true } });
  readsUnavailable = false;
  expect(await reconcileMergedRunPullRequest(readInput)).toMatchObject({ state: "merged", mergeSha });
  expect(vi.mocked(githubRequest).mock.calls.filter(([, , options]) => options?.method && options.method !== "GET")).toHaveLength(mutations);
  expect(vi.mocked(githubRequest).mock.calls.filter(([path]) => path.endsWith("/merge"))).toHaveLength(1);
  expect(openPR).toHaveBeenCalledTimes(1);
  expect(createGitHubTask).not.toHaveBeenCalled();
});

// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { handlePullRequestPayload, handlePushPayload } from "./github-prs";
import { integrationBridge } from "./integration-bridge";
import { verifiedRepositoryProjects } from "./github-access";
import { withInstallation } from "./github-app";

vi.mock("./integration-bridge", () => ({ integrationBridge: vi.fn() }));
vi.mock("./github-access", () => ({ verifiedRepositoryProjects: vi.fn() }));
vi.mock("./github-app", () => ({ withInstallation: vi.fn(), repositoryPath: (url: string) => `/repos${new URL(url).pathname}` }));
vi.mock("./github-workspace", () => ({ githubRequest: vi.fn(), GitHubHttpError: class extends Error {}, lockGitHubJob: vi.fn(), readGitHubJob: vi.fn(), saveGitHubJob: vi.fn() }));

const pr = { number: 3, html_url: "https://github.com/acme/widgets/pull/3", node_id: "n", state: "closed", draft: false, merged: true, merged_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:01Z",
  title: "Fix login", body: "Closes ORI-AB12", user: { login: "octo", id: 99 },
  head: { ref: "origin/ORI-AB12-fix", sha: "a".repeat(40), repo: { full_name: "acme/widgets" } }, base: { sha: "b".repeat(40), repo: { full_name: "acme/widgets" } } };
const payload = { action: "closed", repository: { full_name: "acme/widgets" }, pull_request: pr };

beforeEach(() => {
  vi.mocked(integrationBridge).mockImplementation(async op => op === "prEventTargets" ? [] : []);
  vi.mocked(verifiedRepositoryProjects).mockResolvedValue(["project-1"]);
});
afterEach(() => vi.resetAllMocks());

test("a merged PR payload links through verified projects only, with the state taken from the signed payload", async () => {
  await handlePullRequestPayload(payload);
  expect(verifiedRepositoryProjects).toHaveBeenCalledWith("https://github.com/acme/widgets");
  const [op, args] = vi.mocked(integrationBridge).mock.calls[0];
  expect(op).toBe("prLinkReferences");
  expect(args).toMatchObject({ projectIds: ["project-1"], title: "Fix login", body: "Closes ORI-AB12", authorLogin: "octo", authorId: 99,
    snapshot: { number: 3, state: "merged", branch: "origin/ORI-AB12-fix", checks: "unknown", review: "unknown", githubUpdatedAt: Date.parse(pr.updated_at) } });
  expect(withInstallation).not.toHaveBeenCalled(); // No linked rows were returned, so there is nothing to refresh.
});

test("without a project that proved repository access, nothing is linked", async () => {
  vi.mocked(verifiedRepositoryProjects).mockResolvedValue([]);
  await handlePullRequestPayload(payload);
  expect(integrationBridge).not.toHaveBeenCalled();
});

test("a payload for another repository than the PR's base is rejected", async () => {
  await expect(handlePullRequestPayload({ ...payload, repository: { full_name: "evil/fork" } })).rejects.toThrow();
  expect(integrationBridge).not.toHaveBeenCalled();
});

test("only closing commits pushed to the default branch are forwarded", async () => {
  const push = (ref: string, message: string) => handlePushPayload({ ref, repository: { full_name: "acme/widgets", default_branch: "main" }, commits: [{ message, timestamp: "2026-11-01T10:00:00Z" }] });
  await push("refs/heads/feature", "Fixes ORI-AB12");
  await push("refs/heads/main", "Tidy up");
  expect(integrationBridge).not.toHaveBeenCalled();
  await push("refs/heads/main", "Fixes ORI-AB12");
  expect(integrationBridge).toHaveBeenCalledWith("commitClosers", { repoUrl: "https://github.com/acme/widgets", projectIds: ["project-1"], commits: [{ message: "Fixes ORI-AB12", timestamp: Date.parse("2026-11-01T10:00:00Z") }] });
});

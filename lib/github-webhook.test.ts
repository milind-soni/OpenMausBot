// @vitest-environment node
import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { parseGitHubEvent, verifyGitHubSignature } from "./github-webhook";
import { checksSummary, githubPR, toSnapshot } from "./github-pr-snapshot";
const secret = "fixture-secret-not-a-real-credential";
const pr = { number: 12, html_url: "https://github.com/test/prs/pull/12", node_id: "node-12", state: "open", draft: true, merged: false, updated_at: "2026-10-15T10:00:00Z", head: { ref: "origin/task", sha: "a".repeat(40), repo: { full_name: "test/prs" } }, base: { sha: "b".repeat(40), repo: { full_name: "test/prs" } }, mergeable: null };
describe("signed GitHub webhook fixtures", () => {
  for (const kind of ["issues", "pull_request", "pull_request_review", "check_run", "check_suite"]) test(kind, () => {
    const payload = { repository: { full_name: "test/prs" }, issue: { number: 42 }, pull_request: pr, check_run: { head_sha: pr.head.sha, pull_requests: [{ number: 12 }] }, check_suite: { head_sha: pr.head.sha, pull_requests: [{ number: 12 }] } };
    const body = JSON.stringify(payload), signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyGitHubSignature(body, signature, secret)).toBe(true);
    expect(verifyGitHubSignature(`${body} `, signature, secret)).toBe(false);
    expect(verifyGitHubSignature(body, "sha256=wrong", secret)).toBe(false);
    expect(parseGitHubEvent(body, kind, "delivery-signed-1")).toMatchObject({ repoUrl: "https://github.com/test/prs", numbers: [kind === "issues" ? 42 : 12] });
    expect(() => parseGitHubEvent(body, kind, "")).toThrow("Delivery");
  });
  test("reject malformed numbers, SHA and repository", () => {
    expect(() => parseGitHubEvent('{"repository":{"full_name":"../bad"},"issue":{"number":1}}', "issues", "delivery-1")).toThrow();
    expect(() => parseGitHubEvent('{"repository":{"full_name":"test/prs"},"check_run":{"head_sha":"bad"}}', "check_run", "delivery-1")).toThrow();
    expect(() => parseGitHubEvent('{"repository":{"full_name":"test/prs"},"issue":{"number":-1}}', "issues", "delivery-1")).toThrow();
  });
});
test("checks never show success when pending, failed, truncated or absent; snapshot has exact repo/SHAs", () => {
  expect(checksSummary([], [], false)).toBe("none");
  expect(checksSummary([{ status: "completed", conclusion: "success" }], [], true)).toBe("unknown");
  expect(checksSummary([{ status: "queued", conclusion: null }], [], false)).toBe("pending");
  expect(checksSummary([{ status: "completed", conclusion: "success" }], [{ state: "failure" }], false)).toBe("failure");
  expect(checksSummary([{ status: "completed", conclusion: "success" }], [], false)).toBe("success");
  expect(toSnapshot(githubPR.parse(pr), "test/prs", "pending", "review_required")).toMatchObject({ state: "draft", headSha: pr.head.sha, baseSha: pr.base.sha });
  expect(() => toSnapshot(githubPR.parse(pr), "test/other", "success", "approved")).toThrow();
});

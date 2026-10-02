import { describe, expect, it } from "vitest";
import { githubApi, waitForReleaseCi } from "./release-ci.mjs";

const SHA = "a".repeat(40);
type Run = { id: number; event: string; status: string; head_branch: string; created_at: string };

/** A scripted GitHub: each poll returns the next state of the runs. */
function fakeGitHub(polls: Array<{ runs: Run[]; gates?: Record<number, string | null> }>) {
  const calls: string[] = [];
  let poll = -1;
  let clock = 0;
  const api = {
    async runsForCommit(sha: string) {
      expect(sha).toBe(SHA);
      poll = Math.min(poll + 1, polls.length - 1);
      return polls[poll].runs;
    },
    async gateConclusion(runId: number) { return polls[poll].gates?.[runId] ?? null; },
    async pointBranch(branch: string, sha: string) { calls.push(`branch ${branch} ${sha === SHA ? "@sha" : sha}`); },
    async dispatchCi(branch: string) { calls.push(`dispatch ${branch}`); },
    async deleteBranch(branch: string) { calls.push(`delete ${branch}`); },
  };
  const options = {
    api, sha: SHA, version: "0.1.94", log: () => {}, maxWaitMs: 10 * 60_000,
    now: () => clock, sleep: async (ms: number) => { clock += ms; },
  };
  return { calls, options };
}

const run = (id: number, event: string, status: string, head_branch = "main", minute = 0): Run =>
  ({ id, event, status, head_branch, created_at: `2026-10-02T10:${String(minute).padStart(2, "0")}:00Z` });

describe("release CI gate", () => {
  it("passes on the commit's own green run without starting anything", async () => {
    const { calls, options } = fakeGitHub([{ runs: [run(1, "push", "completed")], gates: { 1: "success" } }]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 1 });
    expect(calls).toEqual([]);
  });

  it("waits for a run that is still going, then passes", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [run(1, "push", "queued")] },
      { runs: [run(1, "push", "in_progress")] },
      { runs: [run(1, "push", "completed")], gates: { 1: "success" } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 1 });
    expect(calls).toEqual([]);
  });

  it("counts a re-run that passed after a failed first attempt", async () => {
    const { options } = fakeGitHub([
      { runs: [run(1, "push", "in_progress")] },
      { runs: [run(1, "push", "completed")], gates: { 1: "success" } },
    ]);
    expect(await waitForReleaseCi(options)).toMatchObject({ ok: true });
  });

  it("stops on a red gate instead of retrying it", async () => {
    const { calls, options } = fakeGitHub([{ runs: [run(1, "push", "completed")], gates: { 1: "failure" } }]);
    expect(await waitForReleaseCi(options)).toMatchObject({ ok: false, reason: expect.stringContaining("failed: run 1") });
    expect(calls).toEqual([]);
  });

  it("ignores pull-request runs, which test a merge ref rather than this commit", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [run(9, "pull_request", "completed")], gates: { 9: "success" } },
      { runs: [run(9, "pull_request", "completed"), run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5)], gates: { 9: "success", 2: "success" } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2 });
    expect(calls).toEqual(["branch release-ci/v0.1.94 @sha", "dispatch release-ci/v0.1.94", "delete release-ci/v0.1.94"]);
  });

  it.each([
    ["no CI run at all", [] as Run[]],
    ["a run a newer merge replaced", [run(1, "push", "completed")]],
  ])("starts CI in its own lane when there is %s, and cleans the lane up", async (_, first) => {
    const { calls, options } = fakeGitHub([
      { runs: first, gates: { 1: "cancelled" } },
      { runs: [...first, run(2, "workflow_dispatch", "queued", "release-ci/v0.1.94", 5)], gates: { 1: "cancelled" } },
      { runs: [...first, run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5)], gates: { 1: "cancelled", 2: "success" } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2 });
    expect(calls).toEqual(["branch release-ci/v0.1.94 @sha", "dispatch release-ci/v0.1.94", "delete release-ci/v0.1.94"]);
  });

  it("fails when its own lane's CI fails, and still cleans the lane up", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [] },
      { runs: [run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94")], gates: { 2: "failure" } },
    ]);
    expect(await waitForReleaseCi(options)).toMatchObject({ ok: false, reason: expect.stringContaining("release lane did not pass (failure)") });
    expect(calls.at(-1)).toBe("delete release-ci/v0.1.94");
  });

  it("gives up after the wait limit with no verdict", async () => {
    const { calls, options } = fakeGitHub([{ runs: [run(1, "push", "in_progress")] }]);
    expect(await waitForReleaseCi(options)).toMatchObject({ ok: false, reason: expect.stringContaining("within 10 minutes") });
    expect(calls).toEqual([]);
  });
});

describe("GitHub calls", () => {
  it("moves an existing lane branch instead of failing, and reads the gate from the latest attempt", async () => {
    const requests: string[] = [];
    const fetchImpl = async (url: string, init: { method: string; body?: string }) => {
      requests.push(`${init.method} ${url.replace("https://api.github.com/repos/o/r", "")} ${init.body ?? ""}`.trim());
      if (init.method === "POST" && url.endsWith("/git/refs")) return new Response("{}", { status: 422 });
      if (url.includes("/jobs")) return Response.json({ jobs: [{ name: "vitest", conclusion: "success" }, { name: "CI", conclusion: "success" }] });
      return new Response(null, { status: 204 });
    };
    const api = githubApi({ token: "t", repository: "o/r", fetchImpl: fetchImpl as typeof fetch });
    await api.pointBranch("release-ci/v1.2.3", SHA);
    expect(await api.gateConclusion(7)).toBe("success");
    await api.dispatchCi("release-ci/v1.2.3");
    expect(requests).toEqual([
      `POST /git/refs {"ref":"refs/heads/release-ci/v1.2.3","sha":"${SHA}"}`,
      `PATCH /git/refs/heads/release-ci/v1.2.3 {"sha":"${SHA}","force":true}`,
      "GET /actions/runs/7/jobs?per_page=100",
      'POST /actions/workflows/ci.yml/dispatches {"ref":"release-ci/v1.2.3"}',
    ]);
  });
});

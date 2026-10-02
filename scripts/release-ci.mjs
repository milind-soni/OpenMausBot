// The release's CI gate (release.yml, job `ci`): ship only a commit whose own
// `CI` check (ci.yml's gate job) passed.
//
// Main keeps at most one CI run going and one waiting, and each merge
// replaces the waiting one, so the release commit's own push run can be
// skipped. When that happens (or no run exists), this starts CI on the commit
// in its own lane: a `release-ci/v<version>` branch at the pinned commit,
// whose concurrency group no merge on main can touch. The branch is deleted
// at the end.
import { pathToFileURL } from "node:url";

const RELEASE_EVENTS = new Set(["push", "merge_group", "workflow_dispatch"]);
export const POLL_MS = 60_000;
export const MAX_WAIT_MS = 170 * 60_000;

/**
 * @param {{
 *   api: {
 *     runsForCommit(sha: string): Promise<Array<{ id: number, event: string, status: string, head_branch: string, created_at: string }>>,
 *     gateConclusion(runId: number): Promise<string | null>,
 *     pointBranch(branch: string, sha: string): Promise<void>,
 *     dispatchCi(branch: string): Promise<void>,
 *     deleteBranch(branch: string): Promise<void>,
 *   },
 *   sha: string, version: string,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, log?: (line: string) => void, maxWaitMs?: number,
 * }} options
 * @returns {Promise<{ ok: true, runId: number } | { ok: false, reason: string }>}
 */
export async function waitForReleaseCi({ api, sha, version, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = console.log, maxWaitMs = MAX_WAIT_MS }) {
  const lane = `release-ci/v${version}`;
  const started = now();
  let dispatched = false;
  try {
    while (now() - started < maxWaitMs) {
      const runs = (await api.runsForCommit(sha))
        .filter((run) => RELEASE_EVENTS.has(run.event))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      // Any finished run of this exact commit whose gate passed is proof.
      for (const run of runs.filter((run) => run.status === "completed")) {
        if (await api.gateConclusion(run.id) === "success") {
          log(`CI passed on ${sha} (run ${run.id}).`);
          return { ok: true, runId: run.id };
        }
      }
      if (dispatched) {
        const own = runs.find((run) => run.event === "workflow_dispatch" && run.head_branch === lane);
        if (own?.status === "completed") {
          const gate = await api.gateConclusion(own.id);
          return { ok: false, reason: `CI in the release lane did not pass (${gate ?? "no gate job"}): run ${own.id}` };
        }
        log(own ? `Release-lane CI run ${own.id} is ${own.status}; waiting.` : "Waiting for the release-lane CI run to appear.");
      } else {
        // Red is red: a failed gate on this commit stops the release rather
        // than being retried until it passes.
        for (const run of runs.filter((run) => run.status === "completed")) {
          const gate = await api.gateConclusion(run.id);
          if (gate === "failure") return { ok: false, reason: `The CI check on ${sha} failed: run ${run.id}` };
        }
        const live = runs.find((run) => run.status !== "completed");
        if (live) {
          log(`CI run ${live.id} on ${sha} is ${live.status}; waiting.`);
        } else {
          // No run, or only cancelled/skipped ones (a newer merge replaced it).
          log(`No finished or running CI on ${sha}; starting it on ${lane}.`);
          await api.pointBranch(lane, sha);
          await api.dispatchCi(lane);
          dispatched = true;
        }
      }
      await sleep(POLL_MS);
    }
    return { ok: false, reason: `No CI verdict on ${sha} within ${Math.round(maxWaitMs / 60_000)} minutes.` };
  } finally {
    if (dispatched) await api.deleteBranch(lane).catch((error) => log(`Could not delete ${lane}: ${error.message}`));
  }
}

/** GitHub REST calls for the release job's GITHUB_TOKEN. */
export function githubApi({ token, repository, apiUrl = "https://api.github.com", fetchImpl = fetch }) {
  const call = async (method, path, body) => {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const error = new Error(`${method} ${path}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  };
  return {
    async runsForCommit(sha) {
      return (await call("GET", `/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`)).workflow_runs;
    },
    async gateConclusion(runId) {
      // The jobs list is the latest attempt, so a re-run of failed jobs counts.
      const { jobs } = await call("GET", `/actions/runs/${runId}/jobs?per_page=100`);
      return jobs.find((job) => job.name === "CI")?.conclusion ?? null;
    },
    async pointBranch(branch, sha) {
      try {
        await call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha });
      } catch (error) {
        if (error.status !== 422) throw error;
        await call("PATCH", `/git/refs/heads/${branch}`, { sha, force: true });
      }
    },
    async dispatchCi(branch) {
      await call("POST", "/actions/workflows/ci.yml/dispatches", { ref: branch });
    },
    async deleteBranch(branch) {
      await call("DELETE", `/git/refs/heads/${branch}`);
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, SHA, VERSION } = process.env;
  if (!GH_TOKEN || !GITHUB_REPOSITORY || !/^[0-9a-f]{40}$/.test(SHA ?? "") || !/^\d+\.\d+\.\d+$/.test(VERSION ?? "")) {
    console.error("::error::release-ci needs GH_TOKEN, GITHUB_REPOSITORY, a full SHA and an X.Y.Z VERSION");
    process.exit(1);
  }
  const result = await waitForReleaseCi({
    api: githubApi({ token: GH_TOKEN, repository: GITHUB_REPOSITORY, apiUrl: GITHUB_API_URL }),
    sha: SHA, version: VERSION,
  });
  if (!result.ok) {
    console.error(`::error::${result.reason}. Fix main or re-run CI, then re-run this job.`);
    process.exit(1);
  }
}

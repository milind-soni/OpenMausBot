// The release's CI gate: ship only a commit whose code passed CI with every
// platform's vitest shards run, on the commit itself, on a commit with the same
// tree, or (for a version-only bump) on its parent.
//
// A push to main or a merge group runs Linux's shards only, so the release
// commit's own run proves nothing; CI then starts on a `release-ci/v<version>`
// branch no merge on main can touch, as a manual run of every platform. A main
// run is never re-run in place: the re-run would join main's group and cancel
// the newest merge's waiting run.
import { pathToFileURL } from "node:url";
import { FULL_LANE_EVENTS, VITEST_SHARDS, versionOnlyPackageJson } from "./ci-scope.mjs";

const RELEASE_EVENTS = new Set(["push", "merge_group", ...FULL_LANE_EVENTS]);
/** Every platform's every shard, by job name. */
const FULL_MATRIX = Object.entries(VITEST_SHARDS)
  .flatMap(([os, shards]) => Array.from({ length: shards }, (_, i) => `vitest (${os}, shard ${i + 1}/${shards})`));
export const POLL_MS = 60_000;
export const MAX_WAIT_MS = 170 * 60_000;

/** @typedef {{ name: string, status?: string, conclusion: string | null, steps?: Array<{ status?: string, conclusion?: string | null }> }} Job */
/** @typedef {{ id: number, event: string, status: string, head_branch: string, head_sha?: string, created_at: string, run_attempt?: number, head_commit?: { tree_id?: string } | null }} Run */

const isVitestJob = (job) => job.name === "vitest" || job.name.startsWith("vitest (");
/** A job that never started a step never got a runner: GitHub gave up acquiring one. */
const neverStarted = (job) => !(job.steps ?? []).some((step) => step.conclusion != null || step.status === "in_progress");

/**
 * What one finished CI run proves.
 * - "green": the gate passed and every platform's every vitest shard ran and passed.
 * - "partial": the gate passed and every vitest job that ran passed, but not every platform's shards ran (a push to
 *   main or a merge group runs Linux's only).
 * - "scoped": the gate passed but vitest did not run (docs- or version-only).
 * - "runner-lost": the gate failed, and every other failed job never started.
 * - "red": the gate failed for any other reason.
 * - anything else: the gate's own conclusion, or "no gate job".
 * @param {Job[]} jobs
 */
export function judgeRun(jobs) {
  const gate = jobs.find((job) => job.name === "CI");
  if (!gate) return "no gate job";
  if (gate.conclusion === "success") {
    const vitest = jobs.filter(isVitestJob);
    if (vitest.length === 0 || !vitest.every((job) => job.conclusion === "success")) return "scoped";
    return FULL_MATRIX.every((name) => vitest.some((job) => job.name === name)) ? "green" : "partial";
  }
  if (gate.conclusion === "failure") {
    const failed = jobs.filter((job) => job !== gate && !["success", "skipped", "neutral"].includes(job.conclusion ?? ""));
    return failed.length > 0 && failed.every(neverStarted) ? "runner-lost" : "red";
  }
  return gate.conclusion ?? "no gate job";
}

/**
 * @param {{
 *   api: {
 *     runsForCommit(sha: string): Promise<Run[]>,
 *     recentRuns(): Promise<Run[]>,
 *     runJobs(runId: number): Promise<Job[]>,
 *     commit(sha: string): Promise<{ tree: string, parents: string[], files: string[] }>,
 *     fileAt(path: string, sha: string): Promise<string | null>,
 *     rerunFailedJobs(runId: number): Promise<void>,
 *     pointBranch(branch: string, sha: string): Promise<void>,
 *     dispatchCi(branch: string): Promise<void>,
 *     deleteBranch(branch: string): Promise<void>,
 *   },
 *   sha: string, version: string,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, log?: (line: string) => void, maxWaitMs?: number,
 * }} options
 * @returns {Promise<{ ok: true, runId: number, via: "commit" | "tree" | "parent" } | { ok: false, reason: string }>}
 */
export async function waitForReleaseCi({ api, sha, version, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = console.log, maxWaitMs = MAX_WAIT_MS }) {
  const lane = `release-ci/v${version}`;
  const started = now();
  let dispatched = false;
  /** run id -> the attempt that was re-run */
  const rerun = new Map();
  /** "id/attempt" -> verdict; a finished attempt never changes */
  const verdicts = new Map();
  const verdict = async (run) => {
    const key = `${run.id}/${run.run_attempt ?? 1}`;
    if (!verdicts.has(key)) verdicts.set(key, judgeRun(await api.runJobs(run.id)));
    return verdicts.get(key);
  };
  const releaseRuns = (runs) => runs.filter((run) => RELEASE_EVENTS.has(run.event))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  /** The run this gate starts: its own concurrency group, so a re-run there cancels nothing on main. */
  const inLane = (run) => run.event === "workflow_dispatch" && run.head_branch === lane;
  /** Still waiting for a re-run we asked for to show up as a new attempt. */
  const awaitingRerun = (run) => rerun.has(run.id) && rerun.get(run.id) === (run.run_attempt ?? 1);
  /** A finished green run on `target` itself, or on another commit with its tree. */
  const proof = async (target, tree, runsFor, recent) => {
    for (const run of (await runsFor(target)).filter((run) => run.status === "completed")) {
      if (await verdict(run) === "green") return { run, sameTree: false };
    }
    if (!tree) return null;
    for (const run of await recent()) {
      if (run.status !== "completed" || run.head_commit?.tree_id !== tree || run.head_sha === target) continue;
      if (await verdict(run) === "green") return { run, sameTree: true };
    }
    return null;
  };

  let tree = null;
  let parent = null;
  try {
    const commit = await api.commit(sha);
    tree = commit.tree;
    if (commit.parents.length === 1 && commit.files.length === 1 && commit.files[0] === "package.json") {
      const [before, after] = await Promise.all([api.fileAt("package.json", commit.parents[0]), api.fileAt("package.json", sha)]);
      if (before !== null && after !== null && versionOnlyPackageJson(before, after)) {
        parent = { sha: commit.parents[0], tree: (await api.commit(commit.parents[0])).tree };
        log(`${sha} only changes package.json's version from ${parent.sha}; that commit's green CI counts too.`);
      }
    }
  } catch (error) {
    log(`Could not read ${sha} from GitHub (${error instanceof Error ? error.message : String(error)}); only its own CI counts.`);
  }

  try {
    while (now() - started < maxWaitMs) {
      const cache = new Map();
      const memo = (key, read) => (cache.has(key) ? cache.get(key) : cache.set(key, read()).get(key));
      const runsFor = (target) => memo(target, async () => releaseRuns(await api.runsForCommit(target)));
      const recent = () => memo("recent", async () => releaseRuns(await api.recentRuns()));

      const own = await proof(sha, tree, runsFor, recent);
      if (own) {
        log(own.sameTree
          ? `CI passed on ${own.run.head_sha} (run ${own.run.id}), which has the same tree as ${sha}.`
          : `CI passed on ${sha} (run ${own.run.id}).`);
        return { ok: true, runId: own.run.id, via: own.sameTree ? "tree" : "commit" };
      }
      if (parent) {
        const inherited = await proof(parent.sha, parent.tree, runsFor, recent);
        if (inherited) {
          log(`CI passed on ${inherited.run.head_sha ?? parent.sha} (run ${inherited.run.id}); ${sha} differs from it only in package.json's version.`);
          return { ok: true, runId: inherited.run.id, via: "parent" };
        }
      }

      const runs = await runsFor(sha);
      // The lane's run that lost a runner gets its failed jobs re-run once;
      // any other red is a verdict.
      const settle = async (run) => {
        if (awaitingRerun(run)) return { wait: true };
        const result = await verdict(run);
        if (result === "runner-lost" && inLane(run) && !rerun.has(run.id)) {
          log(`CI run ${run.id} on ${sha} failed only because jobs never got a runner; re-running its failed jobs once.`);
          await api.rerunFailedJobs(run.id);
          rerun.set(run.id, run.run_attempt ?? 1);
          return { wait: true };
        }
        return { result };
      };

      if (dispatched) {
        const laneRun = runs.find(inLane);
        if (laneRun?.status === "completed") {
          const { wait, result } = await settle(laneRun);
          if (!wait) return { ok: false, reason: `CI in the release lane did not pass (${result}): run ${laneRun.id}` };
        } else {
          log(laneRun ? `Release-lane CI run ${laneRun.id} is ${laneRun.status}; waiting.` : "Waiting for the release-lane CI run to appear.");
        }
      } else {
        // Red is red: a failed gate stops the release rather than being retried.
        let rerunning = false;
        for (const run of runs.filter((run) => run.status === "completed")) {
          const { wait, result } = await settle(run);
          if (wait) rerunning = true;
          else if (result === "red" || (result === "runner-lost" && inLane(run))) return { ok: false, reason: `The CI check on ${sha} failed: run ${run.id}` };
          else if (result === "runner-lost") log(`CI run ${run.id} on ${sha} failed only because jobs never got a runner; it is not re-run in ${run.head_branch}'s queue.`);
        }
        // Only a run of every platform can prove the commit, so a push's or merge group's run still going is not waited for.
        const provable = (run) => run.status !== "completed" && FULL_LANE_EVENTS.includes(run.event);
        const live = runs.find(provable);
        const parentLive = parent && (await runsFor(parent.sha)).find(provable);
        if (live || rerunning) {
          log(`CI on ${sha} is ${live ? `${live.status} (run ${live.id})` : "re-running"}; waiting.`);
        } else if (parentLive) {
          log(`CI run ${parentLive.id} on the parent ${parent.sha} is ${parentLive.status}; waiting.`);
        } else {
          log(`No usable finished or running CI for ${sha}; starting it on ${lane}.`);
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

/** GitHub REST calls for the release job's GITHUB_TOKEN. A 5xx or a dropped
 * connection is retried after each of `retryDelaysMs`. */
export function githubApi({ token, repository, apiUrl = "https://api.github.com", fetchImpl = fetch,
  retryDelaysMs = [5_000, 15_000, 45_000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const call = async (method, path, body) => {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(`${apiUrl}/repos/${repository}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (cause) {
        if (attempt < retryDelaysMs.length) { await sleep(retryDelaysMs[attempt]); continue; }
        throw new Error(`${method} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
      if (response.status >= 500 && attempt < retryDelaysMs.length) { await sleep(retryDelaysMs[attempt]); continue; }
      if (!response.ok) {
        const error = new Error(`${method} ${path}: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      // 204s, and the 201 a re-run answers with, carry no body.
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
  };
  return {
    async runsForCommit(sha) {
      return (await call("GET", `/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`)).workflow_runs;
    },
    async recentRuns() {
      // Finished runs carry head_commit.tree_id; one page per release event.
      const pages = await Promise.all([...RELEASE_EVENTS].map((event) =>
        call("GET", `/actions/workflows/ci.yml/runs?status=completed&event=${event}&per_page=100`)));
      return pages.flatMap((page) => page.workflow_runs);
    },
    async runJobs(runId) {
      // The jobs list is the latest attempt, so a re-run of failed jobs counts.
      return (await call("GET", `/actions/runs/${runId}/jobs?per_page=100`)).jobs;
    },
    async commit(sha) {
      const commit = await call("GET", `/commits/${sha}`);
      return { tree: commit.commit.tree.sha, parents: commit.parents.map((p) => p.sha), files: (commit.files ?? []).map((f) => f.filename) };
    },
    async fileAt(path, sha) {
      const file = await call("GET", `/contents/${path}?ref=${sha}`);
      return file?.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : null;
    },
    async rerunFailedJobs(runId) {
      await call("POST", `/actions/runs/${runId}/rerun-failed-jobs`);
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

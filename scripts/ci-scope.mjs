import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function selectCiScope(files) {
  let runtime = false;
  if (!Array.isArray(files) || files.length === 0) return { runtime: true };
  for (const file of files) {
    if (typeof file !== "string" || file.split("/").some((part) => !part || part === "." || part === "..")) {
      return { runtime: true };
    }
    if (/^(?:[^/]+\.md|docs\/.+\.md|\.github\/FUNDING\.yml)$/.test(file)) continue;
    runtime = true;
  }
  return { runtime };
}

/** True when two package.json texts differ only in the top-level "version"
 * (the release bump, prepare-release.yml). Anything else that changed, a
 * reordered key included, or text that is not a JSON object, is false. */
export function versionOnlyPackageJson(before, after) {
  let a, b;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return false;
  }
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(a) || !isObject(b)) return false;
  if (typeof a.version !== "string" || typeof b.version !== "string" || a.version === b.version) return false;
  const { version: _before, ...restBefore } = a;
  const { version: _after, ...restAfter } = b;
  return JSON.stringify(restBefore) === JSON.stringify(restAfter);
}

/** A push's own diff (before..after) needs no runtime jobs when it is docs
 * only or only bumps package.json's version. `show(rev, path)` reads a file. */
export function selectPushScope(files, show) {
  const scope = selectCiScope(files);
  if (scope.runtime && files.length === 1 && files[0] === "package.json") {
    try {
      if (versionOnlyPackageJson(show("before", "package.json"), show("after", "package.json"))) return { runtime: false };
    } catch { /* unreadable: run everything */ }
  }
  return scope;
}

// macOS runners are the scarce ones (five at a time for the whole account),
// and only a couple of test blocks are macOS-only, so a PR runs the suite on
// Linux and Windows. Main pushes, merge groups and manual runs add macOS, and
// every PR still runs the macOS smokes.
const ALL_OS = ["macos-latest", "ubuntu-latest", "windows-latest"];
const PR_OS = ["ubuntu-latest", "windows-latest"];
const SHA = /^[a-f\d]{40}(?:[a-f\d]{24})?$/i;

const git = (args) => execFileSync("git", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });

function changedFiles(range) {
  // Disabling rename detection retains both old and new paths, including deletions.
  const diff = git(["diff", "--name-only", "--no-renames", "-z", range, "--"]);
  if (!diff || !diff.endsWith("\0")) throw new Error("Empty or invalid changed-path output");
  return diff.slice(0, -1).split("\0");
}

/** Did the commit before this push get a green CI run of its own? Main keeps
 * one run going and one waiting, and a push replaces the waiting run: if the
 * previous commit's run was replaced, its changes were never tested, so this
 * push must run everything even when its own diff is docs or a version. */
async function previousCommitGreen(sha) {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL = "https://api.github.com" } = process.env;
  if (!GH_TOKEN || !GITHUB_REPOSITORY) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are needed to read the previous commit's CI");
  const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`, {
    headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} reading CI runs`);
  const { workflow_runs: runs } = await response.json();
  return runs.some((run) => ["push", "merge_group", "workflow_dispatch"].includes(run.event)
    && run.status === "completed" && run.conclusion === "success");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let scope = { runtime: true };
  let vitestOs = ALL_OS;
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    try {
      const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
      const base = pr?.base?.sha;
      const head = pr?.head?.sha;
      if (![base, head].every((sha) => typeof sha === "string" && SHA.test(sha))) {
        throw new Error("Missing or invalid pull request commit SHAs");
      }
      scope = selectCiScope(changedFiles(`${base}...${head}`));
      vitestOs = PR_OS;
    } catch (error) {
      console.warn(`CI scope: using all checks because the pull request diff is unavailable: ${error.message}`);
    }
  } else if (process.env.GITHUB_EVENT_NAME === "push") {
    // A push to main is scoped by its own commits (before..after): a docs-only
    // merge or the release's version bump skips the runtime jobs. The release
    // gate never counts such a run as tested (scripts/release-ci.mjs).
    try {
      const { before, after } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
      if (![before, after].every((sha) => typeof sha === "string" && SHA.test(sha)) || /^0+$/.test(before)) {
        throw new Error("Missing or invalid push commit SHAs");
      }
      const revs = { before, after };
      const selected = selectPushScope(changedFiles(`${before}..${after}`), (rev, path) => git(["show", `${revs[rev]}:${path}`]));
      if (!selected.runtime && !(await previousCommitGreen(before))) {
        console.warn(`CI scope: using all checks because ${before} has no green CI run of its own`);
      } else {
        scope = selected;
      }
    } catch (error) {
      console.warn(`CI scope: using all checks because the push diff is unavailable: ${error.message}`);
    }
  }
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `runtime=${scope.runtime}\nvitest_os=${JSON.stringify(vitestOs)}\n`,
  );
}

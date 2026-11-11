import type { Doc } from "../convex/_generated/dataModel";
import { integrationBridge } from "./integration-bridge";
import { GitHubHttpError, githubRequest, lockGitHubJob, readGitHubJob, saveGitHubJob } from "./github-workspace";
import { repositoryPath, withInstallation } from "./github-app";
import { githubPR, checksSummary, toSnapshot, type PRSnapshot } from "./github-pr-snapshot";
import { taskBranch } from "./task-branch";
export { taskBranch } from "./task-branch";

type Context = { project: Doc<"projects">; task: Doc<"tasks">; existingPR?: Doc<"taskPullRequests"> | null };
type Target = Doc<"taskPullRequests">;
export type OpenedPR = { status: "opened"; number: number; url: string; state: string; id: string };

export async function readPRSnapshot(repoUrl: string, number: number, token: string): Promise<PRSnapshot> {
  const path = repositoryPath(repoUrl), repo = path.slice("/repos/".length);
  const pr = githubPR.parse(await githubRequest(`${path}/pulls/${number}`, token));
  const [checks, review] = await Promise.all([
    githubRequest<{ total_count: number; check_runs: { status: string; conclusion: string | null }[] }>(`${path}/commits/${pr.head.sha}/check-runs?filter=latest&per_page=100`, token),
    githubRequest<{ data?: { node?: { reviewDecision?: string | null } }; errors?: unknown[] }>("/graphql", token, { method: "POST", body: JSON.stringify({ query: "query($id:ID!){node(id:$id){... on PullRequest{reviewDecision}}}", variables: { id: pr.node_id } }) }),
  ]);
  // PR and check/review API reads are not atomic. Reject a snapshot straddling a push.
  const latest = githubPR.parse(await githubRequest(`${path}/pulls/${number}`, token));
  if (latest.head.sha !== pr.head.sha || latest.updated_at !== pr.updated_at || latest.state !== pr.state || latest.draft !== pr.draft || latest.merged_at !== pr.merged_at) throw new Error("PR changed while synchronizing; retry");
  const decision = review.errors?.length ? "unknown" : review.data?.node?.reviewDecision?.toLowerCase() ?? "review_required";
  // Commit statuses are a different GitHub permission (statuses:read). The requested
  // App grant includes checks:read, so this field summarizes Check Runs only.
  return toSnapshot(latest, repo, checksSummary(checks.check_runs, [], checks.total_count > checks.check_runs.length), decision);
}

async function openPR(repoUrl: string, taskId: string, branch: string, title: string, body: string, token: string, draft: boolean, baseBranch?: string) {
  const path = repositoryPath(repoUrl), repo = path.slice(7), owner = repo.split("/")[0];
  // URL-encode branch data, never concatenate it into a path or shell command.
  const metadata = await githubRequest<{ default_branch: string }>(path, token);
  const base = baseBranch ?? metadata.default_branch;
  if (branch === base) throw new Error("Task branch must differ from the base branch");
  await githubRequest(`${path}/git/ref/heads/${encodeURIComponent(base)}`, token);
  const head = await githubRequest<{ object: { sha: string } }>(`${path}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (!head.object.sha) throw new Error("Push the task branch first");
  const marker = `<!-- origin-task:${taskId} -->`;
  const key = `pr:${taskId}:${repo.toLowerCase()}:${branch}`;
  if (!lockGitHubJob(key)) throw new Error("PR operation in progress; retry the same request ID");
  try {
    const previous = readGitHubJob(key), saved = previous?.payload ? JSON.parse(previous.payload) : {};
    const matches = await githubRequest<{ number: number; body?: string; head: { ref: string } }[]>(`${path}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`, token);
    let number = saved.number as number | undefined;
    if (!number) number = matches.find(pr => pr.head.ref === branch && pr.body?.includes(marker))?.number;
    if (!number && saved.started) throw new Error("Previous PR creation result is uncertain; reconciliation or owner inspection required before retrying");
    if (!number) {
      saveGitHubJob(key, "working", { started: true });
      try {
        const pr = await githubRequest<{ number: number }>(`${path}/pulls`, token, { method: "POST", body: JSON.stringify({ head: branch, base, title, body: `${body}\n\n${marker}`.trim(), draft }) });
        number = pr.number;
        saveGitHubJob(key, "working", { number });
      } catch (error) {
        if (error instanceof GitHubHttpError && [400, 401, 403, 404, 422, 429].includes(error.status)) saveGitHubJob(key, "working");
        throw error;
      }
    }
    const snapshot = await readPRSnapshot(repoUrl, number, token);
    if (snapshot.branch !== branch) throw new Error("GitHub returned an unexpected task branch");
    saveGitHubJob(key, "done", { number });
    return snapshot;
  } catch (error) {
    const previous = readGitHubJob(key);
    saveGitHubJob(key, "error", previous?.payload ? JSON.parse(previous.payload) : undefined);
    throw error;
  }
}

async function prepareDraftBranch(context: Context, appToken: string) {
  const { project, task } = context, path = repositoryPath(project.repoUrl!), branch = taskBranch(task);
  const metadata = await githubRequest<{ default_branch: string }>(path, appToken);
  const base = await githubRequest<{ object: { sha: string } }>(`${path}/git/ref/heads/${encodeURIComponent(metadata.default_branch)}`, appToken);
  try { await githubRequest(`${path}/git/refs`, appToken, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }) }); }
  catch (error) { if (!(error instanceof GitHubHttpError) || error.status !== 422) throw error; }
  const file = `.origin/tasks/${task._id}.md`, marker = `<!-- origin-task:${task._id} -->`;
  let existing: { content?: string; encoding?: string } | undefined;
  try { existing = await githubRequest(`${path}/contents/${file}?ref=${encodeURIComponent(branch)}`, appToken); }
  catch (error) { if (!(error instanceof GitHubHttpError) || error.status !== 404) throw error; }
  if (existing) {
    if (existing.encoding !== "base64" || !Buffer.from(existing.content ?? "", "base64").toString().includes(marker)) throw new Error("Existing task branch has an unrelated plan");
  } else {
    const head = await githubRequest<{ object: { sha: string } }>(`${path}/git/ref/heads/${encodeURIComponent(branch)}`, appToken);
    if (head.object.sha !== base.object.sha) throw new Error("Existing branch is not an empty task branch");
    // GitHub cannot open a PR without a diff: create a visible task plan commit.
    await githubRequest(`${path}/contents/${file}`, appToken, { method: "PUT", body: JSON.stringify({ branch, message: `Plan Origin task: ${task.title}`, content: Buffer.from(`# ${task.title}\n\n${task.description ?? ""}\n\n${marker}\n`).toString("base64") }) });
  }
  return branch;
}
export async function createTaskPR(sessionToken: string, projectId: string, taskId: string) {
  const context = await integrationBridge<Context>("prHumanContext", { sessionToken, projectId, taskId, choosePR: true });
  const repoUrl = context.project.repoUrl!;
  const key = `draft-task:${taskId}:${repoUrl.toLowerCase()}`;
  if (!lockGitHubJob(key)) throw new Error("Task PR creation in progress; retry shortly");
  try {
    const snapshot = await withInstallation(projectId, repoUrl, async appToken => {
      const current = await integrationBridge<Context>("prHumanContext", { sessionToken, projectId, taskId });
      if (repositoryPath(current.project.repoUrl ?? "") !== repositoryPath(repoUrl)) throw new Error("PR repository changed during authorization");
      if (context.existingPR) return readPRSnapshot(repoUrl, context.existingPR.number, appToken);
      const branch = await prepareDraftBranch(context, appToken);
      return openPR(repoUrl, taskId, branch, context.task.title, context.task.description ?? "", appToken, true);
    });
    const result = await integrationBridge<OpenedPR>("prFinalize", { sessionToken, projectId, taskId, snapshot });
    return { ...result, ok: true, message: `Linked draft PR #${result.number}` };
  } finally { saveGitHubJob(key, "done"); }
}

async function syncPRTarget(target: Target, eventHeadSha?: string) {
  const repoUrl = target.url.split("/pull/")[0];
  const sequence = await integrationBridge<number | null>("prBeginSync", { id: target._id });
  if (sequence === null) return;
  const snapshot = await withInstallation(target.projectId, repoUrl, token => readPRSnapshot(repoUrl, target.number, token));
  // An old check event must never attach old check results to a new head.
  if (eventHeadSha && eventHeadSha !== snapshot.headSha) return;
  await integrationBridge("prSync", { id: target._id, sequence, snapshot });
}
export async function syncPREvent(repoUrl: string, numbers: number[], headSha?: string) {
  const targets = await integrationBridge<Target[]>("prEventTargets", { repoUrl, numbers, ...(headSha ? { headSha } : {}) });
  for (const target of targets) await syncPRTarget(target, headSha);
}
export async function syncPRPage() {
  const key = "pr-sync-cursor", saved = readGitHubJob(key);
  const { cursor = null, state = "draft" } = saved?.payload ? JSON.parse(saved.payload) : {};
  const page = await integrationBridge<{ rows: Target[]; nextCursor: string | null }>("prTargets", { cursor, state });
  const results = await Promise.allSettled(page.rows.map(t => syncPRTarget(t)));
  // Don't starve later pages because one repository needs permission reapproval.
  // Every draft/open/closed-unmerged row is revisited when the cursor wraps.
  const failed = results.filter(r => r.status === "rejected").length;
  if (failed) console.warn(`GitHub PR reconciliation: ${failed} targets need retry or App permission approval`);
  // Closed-unmerged PRs can be reopened even when their webhook is missed.
  saveGitHubJob(key, "done", { cursor: page.nextCursor, state: page.nextCursor ? state : state === "draft" ? "open" : state === "open" ? "closed" : "draft" });
}

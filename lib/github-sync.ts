import { githubConnectionInfo, githubConnectionToken } from "./githubConnection";
import { GitHubHttpError, githubRequest, lockGitHubJob, readGitHubJob, saveGitHubJob, workspaceGitHubToken } from "./github-workspace";
import { integrationBridge } from "./integration-bridge";
import { parseGitHubRepo } from "./githubLocal";
import { githubBody, remoteIssue, type IssuePatch } from "./github-issue-sync";

type Context = {
  credentialAllowed: boolean;
  legacyOwner: boolean;
  project: { _id: string; teamId?: string; name: string; status?: string; description?: string; repoUrl?: string; githubRepoId?: number; githubWorkspaceAccess?: boolean };
  connection: { teamId: string; login: string; connectedBy: string; autoCreate: boolean } | null;
  task: { _id: string; title: string; description?: string; done: boolean; draft?: boolean; labels?: string[]; githubIssueNumber?: number; githubIssueUrl?: string } | null;
};
type GitHubIssue = { number: number; html_url: string; state: "open" | "closed"; updated_at: string; title?: string; body?: string | null; labels?: (string | { name?: string | null })[]; node_id?: string; pull_request?: unknown };
type SyncPlan = { action: "none" | "create" | "sync" | "push"; number?: number; patch?: IssuePatch };
type Target = { projectId: string; taskId: string; repoUrl: string; number: number; connection: Context["connection"] };

async function createOnGitHub<T>(key: string, path: string, token: string, body: unknown): Promise<T> {
  try { return await githubRequest<T>(path, token, { method: "POST", body: JSON.stringify(body) }); }
  catch (error) {
    // Definitive rejections can be retried; unknown network outcomes retain their intent marker.
    if (error instanceof GitHubHttpError && [400, 401, 403, 404, 422, 429].includes(error.status)) await saveGitHubJob(key, "working");
    throw error;
  }
}

export async function contextWithToken(projectId: string, taskId?: string) {
  let context = await integrationBridge<Context>("context", { projectId, taskId });
  const repo = parseGitHubRepo(context.project.repoUrl);
  let token: string | undefined;
  if (repo) {
    const name = `${repo.owner}/${repo.repo}`.toLowerCase();
    const existing = await githubConnectionInfo(projectId, name);
    if (existing) {
      context = await integrationBridge<Context>("context", { projectId, taskId, credentialOwner: existing.connectedBy });
      if (context.credentialAllowed) token = await githubConnectionToken(projectId, name);
    }
  }
  if (!token && context.project.githubWorkspaceAccess && context.connection) token = await workspaceGitHubToken(context.connection.teamId, context.connection.connectedBy);
  if (!token && context.legacyOwner) token = process.env.GITHUB_TOKEN;
  if (repo && context.task?.githubIssueUrl && context.task.githubIssueUrl.split("/issues/")[0].toLowerCase() !== `https://github.com/${repo.owner}/${repo.repo}`.toLowerCase()) throw new Error("This issue is linked to the previous repository");
  return { ...context, token, repo };
}

export async function createProjectRepository(projectId: string, manual = false): Promise<{ state: "ready" | "working" | "awaiting_connection" | "error"; repoUrl?: string; error?: string }> {
  const key = `repo:${projectId}`;
  if (!await lockGitHubJob(key)) return { state: "working" };
  try {
    const context = await integrationBridge<Context>("context", { projectId });
    if (context.project.status && context.project.status !== "active") { await saveGitHubJob(key, "waiting"); return { state: "error", error: "Reactivate the project before creating a repository" }; }
    if (context.project.repoUrl) { await saveGitHubJob(key, "done"); return { state: "ready", repoUrl: context.project.repoUrl }; }
    if (!context.connection || (!manual && !context.connection.autoCreate)) {
      await integrationBridge("repoResult", { projectId, state: "awaiting_connection" });
      await saveGitHubJob(key, "waiting"); return { state: "awaiting_connection" };
    }
    const token = await workspaceGitHubToken(context.connection.teamId, context.connection.connectedBy);
    if (!token) throw new Error("Reconnect GitHub in workspace settings");
    const previous = await readGitHubJob(key);
    let repo: { id: number; html_url: string; description: string; owner: { login: string }; private: boolean } | undefined;
    const name = `${context.project.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "project"}-${projectId.slice(-6)}`;
    const marker = `Origin project: ${projectId}`;
    if (previous?.payload) {
      const saved = JSON.parse(previous.payload);
      if (saved.repo) repo = saved.repo;
      else if (saved.started) {
        try { repo = await githubRequest(`/repos/${context.connection.login}/${saved.name || name}`, token); }
        catch { throw new Error("The previous repository request could not be confirmed. Check GitHub before retrying."); }
        if (!repo?.description?.includes(marker) || repo.owner.login.toLowerCase() !== context.connection.login.toLowerCase()) throw new Error("A repository with this name already exists and was not created by this project");
      }
    }
    if (!repo) {
      await saveGitHubJob(key, "working", { started: true, name });
      const description = [context.project.description?.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 200), marker].filter(Boolean).join(" | ");
      repo = await createOnGitHub(key, "/user/repos", token, { name, description, private: true, has_issues: true, auto_init: true });
      await saveGitHubJob(key, "working", { repo });
    }
    if (!repo) throw new Error("GitHub did not return a repository");
    if (repo.owner.login.toLowerCase() !== context.connection.login.toLowerCase() || !repo.private) throw new Error("GitHub returned an unexpected repository owner or visibility. Review it on GitHub before linking.");
    await integrationBridge("repoResult", { projectId, state: "ready", repoUrl: repo.html_url, repoId: repo.id });
    await saveGitHubJob(key, "done", { repo });
    return { state: "ready", repoUrl: repo.html_url };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Repository creation failed";
    const previous = await readGitHubJob(key);
    await saveGitHubJob(key, "error", previous?.payload ? JSON.parse(previous.payload) : undefined);
    await integrationBridge("repoResult", { projectId, state: "error", error: message });
    return { state: "error", error: message };
  }
}

async function link(projectId: string, taskId: string, repoUrl: string, issue: GitHubIssue) {
  const updatedAt = Date.parse(issue.updated_at);
  if (!Number.isFinite(updatedAt) || !Number.isInteger(issue.number)) throw new Error("Invalid GitHub issue response");
  await integrationBridge("linkIssue", { projectId, taskId, repoUrl, number: issue.number, issueUrl: `${repoUrl}/issues/${issue.number}`, state: issue.state, updatedAt });
}

export async function createGitHubTask(projectId: string, taskId: string) {
  const { task, repo, token, connection, project } = await contextWithToken(projectId, taskId);
  if (project.status && project.status !== "active") throw new Error("Reactivate the project before creating GitHub issues");
  if (!task || !repo) throw new Error("Connect a GitHub repository first");
  if (task.draft && !task.githubIssueNumber) throw new Error("Draft issues stay in Origin. Move this issue out of Backlog before publishing it.");
  const repoUrl = `https://github.com/${repo.owner}/${repo.repo}`;
  if (task.githubIssueNumber) return { ok: true, issueNumber: task.githubIssueNumber, issueUrl: task.githubIssueUrl, message: `Already linked to GitHub #${task.githubIssueNumber}` };
  if (!token) throw new Error(connection && !project.githubWorkspaceAccess
    ? "GitHub is connected. A workspace admin must enable this repository in the project's Code tab."
    : "A workspace admin needs to reconnect GitHub in Settings > Integrations");
  const key = `issue:${taskId}:${repoUrl.toLowerCase()}`;
  if (!await lockGitHubJob(key)) throw new Error("This issue is already being created. Wait a moment before retrying.");
  try {
    const previous = await readGitHubJob(key);
    let issue: GitHubIssue | undefined;
    const marker = `<!-- origin-task:${taskId} -->`;
    if (previous?.payload) {
      const saved = JSON.parse(previous.payload);
      if (saved.issue) issue = saved.issue;
      else if (saved.started) {
        const recent = await githubRequest<GitHubIssue[]>(`/repos/${repo.owner}/${repo.repo}/issues?state=all&sort=created&direction=desc&per_page=100`, token);
        issue = recent.find(i => !i.pull_request && i.body?.includes(marker));
        if (!issue) throw new Error("The previous GitHub request has an unknown result. Check the repository before trying another issue; Origin will not create a duplicate.");
      }
    }
    if (!issue) {
      await saveGitHubJob(key, "working", { started: true });
      issue = await createOnGitHub<GitHubIssue>(key, `/repos/${repo.owner}/${repo.repo}/issues`, token, { title: task.title, body: githubBody(taskId, task.description), ...(task.labels?.length ? { labels: task.labels } : {}) });
      await saveGitHubJob(key, "working", { issue });
    }
    await link(projectId, taskId, repoUrl, issue);
    // What GitHub stored is what both sides now agree on, so the issues webhook for our own create is not an edit.
    await integrationBridge("githubIssuePushed", { taskId, remote: remoteIssue(issue) });
    await saveGitHubJob(key, "done", { issue });
    return { ok: true, issueNumber: issue.number, issueUrl: issue.html_url, message: `Created GitHub issue #${issue.number}` };
  } catch (error) {
    const previous = await readGitHubJob(key);
    await saveGitHubJob(key, "error", previous?.payload ? JSON.parse(previous.payload) : undefined);
    throw error;
  }
}

/**
 * Reads one linked GitHub issue and reconciles it with its Origin issue both ways: GitHub's state and content changes
 * land in Origin (integrations.linkIssue, then githubIssueSync.reconcile), then Origin's changes are PATCHed to GitHub.
 */
async function syncTarget(target: Pick<Target, "projectId" | "taskId" | "number">) {
  const { token, repo } = await contextWithToken(target.projectId, target.taskId);
  if (!repo || !token) throw new Error("Repository sync needs an authorized GitHub connection");
  const path = `/repos/${repo.owner}/${repo.repo}/issues/${target.number}`;
  const issue = await githubRequest<GitHubIssue>(path, token);
  if (issue.pull_request) return;
  await link(target.projectId, target.taskId, `https://github.com/${repo.owner}/${repo.repo}`, issue);
  const plan = await integrationBridge<SyncPlan>("githubIssueReconcile", { taskId: target.taskId, remote: remoteIssue(issue) });
  if (plan.action !== "push" || !plan.patch) return;
  const updated = await githubRequest<GitHubIssue>(path, token, { method: "PATCH", body: JSON.stringify(plan.patch) });
  await integrationBridge("githubIssuePushed", { taskId: target.taskId, remote: remoteIssue(updated) });
}

/** Mirrors one Origin issue to GitHub: creates its GitHub issue once it is outside Backlog, else pushes what changed. */
export async function pushGitHubTask(projectId: string, taskId: string): Promise<"none" | "created" | "synced"> {
  let created = false;
  for (let step = 0; step < 2; step++) {
    const plan = await integrationBridge<SyncPlan>("githubIssueReconcile", { taskId });
    if (plan.action === "create" && !created) { await createGitHubTask(projectId, taskId); created = true; continue; }
    if (plan.action !== "sync" || !plan.number) break;
    await syncTarget({ projectId, taskId, number: plan.number });
    return "synced";
  }
  return created ? "created" : "none";
}

/**
 * The GitHub side of deleting an Origin issue: closes its GitHub issue as not planned. GitHub's REST API cannot delete
 * issues; with ORIGIN_GITHUB_DELETE_ISSUES=true the worker deletes it with GraphQL `deleteIssue` instead (the token
 * needs admin rights on the repository) and falls back to closing when GitHub refuses.
 */
export async function closeDeletedIssue(projectId: string, deleted: { repoUrl: string; number: number }): Promise<"closed" | "deleted" | "gone" | "skipped"> {
  const { token, repo } = await contextWithToken(projectId);
  if (!repo || !token) throw new Error("Closing the GitHub issue needs an authorized GitHub connection");
  if (`https://github.com/${repo.owner}/${repo.repo}`.toLowerCase() !== deleted.repoUrl.toLowerCase()) return "skipped";
  const path = `/repos/${repo.owner}/${repo.repo}/issues/${deleted.number}`;
  let issue: GitHubIssue;
  try { issue = await githubRequest<GitHubIssue>(path, token); }
  catch (error) { if (error instanceof GitHubHttpError && [404, 410].includes(error.status)) return "gone"; throw error; }
  if (issue.pull_request) return "skipped";
  if (process.env.ORIGIN_GITHUB_DELETE_ISSUES === "true" && issue.node_id) {
    const result = await githubRequest<{ errors?: unknown[] }>("/graphql", token, {
      method: "POST", body: JSON.stringify({ query: "mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}", variables: { id: issue.node_id } }),
    }).catch(() => ({ errors: ["refused"] }));
    if (!result.errors?.length) return "deleted";
  }
  if (issue.state !== "closed") await githubRequest(path, token, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "not_planned" }) });
  return "closed";
}

type Deleted = { repoUrl: string; number: number };
type OutboxRow = { taskId: string; projectId: string; revision: number; deleted?: Deleted };
const OUTBOX_LOCK = "issue-outbox-lock";
const OUTBOX_BUDGET_MS = 40000;

/** Drains the GitHub issue outbox (convex/githubIssueSync.ts) in leased batches, until it is empty or out of time. */
export async function syncGitHubOutbox() {
  if (!await lockGitHubJob(OUTBOX_LOCK)) return { busy: true, processed: 0 };
  const started = Date.now();
  let processed = 0;
  try {
    while (Date.now() - started < OUTBOX_BUDGET_MS) {
      const rows = await integrationBridge<OutboxRow[]>("githubOutboxClaim", { limit: 10 });
      if (!rows.length) break;
      for (const row of rows) {
        let { revision, deleted } = row;
        // An issue edited (or deleted) while it was being pushed goes again, at most three times per claim.
        for (let round = 0; round < 3; round++) {
          let error: string | undefined;
          try {
            if (deleted) await closeDeletedIssue(row.projectId, deleted);
            else await pushGitHubTask(row.projectId, row.taskId);
          } catch (cause) { error = cause instanceof Error ? cause.message : "GitHub sync failed"; }
          const next = await integrationBridge<{ again: boolean; revision: number; deleted?: Deleted }>("githubOutboxFinish", { taskId: row.taskId, revision, ...(error === undefined ? {} : { error }) });
          processed++;
          if (!next.again) break;
          revision = next.revision; deleted = next.deleted;
        }
      }
    }
  } finally { await saveGitHubJob(OUTBOX_LOCK, "done"); }
  return { busy: false, processed };
}

export async function syncGitHubEvent(repoUrl: string, number: number) {
  const targets = await integrationBridge<Target[]>("webhookTargets", { repoUrl, number });
  for (const target of targets) await syncTarget(target);
}

export async function syncGitHubPage() {
  const cursorKey = "sync-cursor";
  const old = await readGitHubJob(cursorKey);
  const cursor = old?.payload ? JSON.parse(old.payload).cursor : null;
  const page = await integrationBridge<{ rows: Target[]; nextCursor: string | null }>("targets", { cursor: cursor || null });
  await Promise.all(page.rows.map(async target => {
    try { await syncTarget(target); }
    catch (error) { console.warn("GitHub issue sync failed", target.taskId, error instanceof Error ? error.message : "Unknown error"); }
  }));
  await saveGitHubJob(cursorKey, "done", { cursor: page.nextCursor });
}

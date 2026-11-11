import { githubConnectionInfo, githubConnectionToken } from "./githubConnection";
import { GitHubHttpError, githubRequest, lockGitHubJob, readGitHubJob, saveGitHubJob, workspaceGitHubToken } from "./github-workspace";
import { integrationBridge } from "./integration-bridge";
import { parseGitHubRepo } from "./githubLocal";

type Context = {
  credentialAllowed: boolean;
  legacyOwner: boolean;
  project: { _id: string; teamId?: string; name: string; status?: string; description?: string; repoUrl?: string; githubRepoId?: number; githubWorkspaceAccess?: boolean };
  connection: { teamId: string; login: string; connectedBy: string; autoCreate: boolean } | null;
  task: { _id: string; title: string; description?: string; done: boolean; githubIssueNumber?: number; githubIssueUrl?: string } | null;
};
type GitHubIssue = { number: number; html_url: string; state: "open" | "closed"; updated_at: string; body?: string; pull_request?: unknown };
type Target = { projectId: string; taskId: string; repoUrl: string; number: number; connection: Context["connection"] };

async function createOnGitHub<T>(key: string, path: string, token: string, body: unknown): Promise<T> {
  try { return await githubRequest<T>(path, token, { method: "POST", body: JSON.stringify(body) }); }
  catch (error) {
    // Definitive rejections can be retried; unknown network outcomes retain their intent marker.
    if (error instanceof GitHubHttpError && [400, 401, 403, 404, 422, 429].includes(error.status)) saveGitHubJob(key, "working");
    throw error;
  }
}

async function contextWithToken(projectId: string, taskId?: string) {
  let context = await integrationBridge<Context>("context", { projectId, taskId });
  const repo = parseGitHubRepo(context.project.repoUrl);
  let token: string | undefined;
  if (repo) {
    const name = `${repo.owner}/${repo.repo}`.toLowerCase();
    const existing = githubConnectionInfo(projectId, name);
    if (existing) {
      context = await integrationBridge<Context>("context", { projectId, taskId, credentialOwner: existing.connectedBy });
      if (context.credentialAllowed) token = githubConnectionToken(projectId, name);
    }
  }
  if (!token && context.project.githubWorkspaceAccess && context.connection) token = await workspaceGitHubToken(context.connection.teamId, context.connection.connectedBy);
  if (!token && context.legacyOwner) token = process.env.GITHUB_TOKEN;
  if (repo && context.task?.githubIssueUrl && context.task.githubIssueUrl.split("/issues/")[0].toLowerCase() !== `https://github.com/${repo.owner}/${repo.repo}`.toLowerCase()) throw new Error("This issue is linked to the previous repository");
  return { ...context, token, repo };
}

export async function createProjectRepository(projectId: string, manual = false): Promise<{ state: "ready" | "working" | "awaiting_connection" | "error"; repoUrl?: string; error?: string }> {
  const key = `repo:${projectId}`;
  if (!lockGitHubJob(key)) return { state: "working" };
  try {
    const context = await integrationBridge<Context>("context", { projectId });
    if (context.project.status && context.project.status !== "active") { saveGitHubJob(key, "waiting"); return { state: "error", error: "Reactivate the project before creating a repository" }; }
    if (context.project.repoUrl) { saveGitHubJob(key, "done"); return { state: "ready", repoUrl: context.project.repoUrl }; }
    if (!context.connection || (!manual && !context.connection.autoCreate)) {
      await integrationBridge("repoResult", { projectId, state: "awaiting_connection" });
      saveGitHubJob(key, "waiting"); return { state: "awaiting_connection" };
    }
    const token = await workspaceGitHubToken(context.connection.teamId, context.connection.connectedBy);
    if (!token) throw new Error("Reconnect GitHub in workspace settings");
    const previous = readGitHubJob(key);
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
      saveGitHubJob(key, "working", { started: true, name });
      const description = [context.project.description?.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 200), marker].filter(Boolean).join(" | ");
      repo = await createOnGitHub(key, "/user/repos", token, { name, description, private: true, has_issues: true, auto_init: true });
      saveGitHubJob(key, "working", { repo });
    }
    if (!repo) throw new Error("GitHub did not return a repository");
    if (repo.owner.login.toLowerCase() !== context.connection.login.toLowerCase() || !repo.private) throw new Error("GitHub returned an unexpected repository owner or visibility. Review it on GitHub before linking.");
    await integrationBridge("repoResult", { projectId, state: "ready", repoUrl: repo.html_url, repoId: repo.id });
    saveGitHubJob(key, "done", { repo });
    return { state: "ready", repoUrl: repo.html_url };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Repository creation failed";
    const previous = readGitHubJob(key);
    saveGitHubJob(key, "error", previous?.payload ? JSON.parse(previous.payload) : undefined);
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
  const repoUrl = `https://github.com/${repo.owner}/${repo.repo}`;
  if (task.githubIssueNumber) return { ok: true, issueNumber: task.githubIssueNumber, issueUrl: task.githubIssueUrl, message: `Already linked to GitHub #${task.githubIssueNumber}` };
  if (!token) throw new Error(connection && !project.githubWorkspaceAccess
    ? "GitHub is connected. A workspace admin must enable this repository in the project's Repo tab."
    : "A workspace admin needs to reconnect GitHub in Settings > Integrations");
  const key = `issue:${taskId}:${repoUrl.toLowerCase()}`;
  if (!lockGitHubJob(key)) throw new Error("This issue is already being created. Wait a moment before retrying.");
  try {
    const previous = readGitHubJob(key);
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
      saveGitHubJob(key, "working", { started: true });
      issue = await createOnGitHub<GitHubIssue>(key, `/repos/${repo.owner}/${repo.repo}/issues`, token, { title: task.title, body: `${task.description || ""}\n\n${marker}`.trim() });
      saveGitHubJob(key, "working", { issue });
    }
    await link(projectId, taskId, repoUrl, issue);
    saveGitHubJob(key, "done", { issue });
    return { ok: true, issueNumber: issue.number, issueUrl: issue.html_url, message: `Created GitHub issue #${issue.number}` };
  } catch (error) {
    const previous = readGitHubJob(key);
    saveGitHubJob(key, "error", previous?.payload ? JSON.parse(previous.payload) : undefined);
    throw error;
  }
}

async function syncTarget(target: Target) {
  const { token, repo } = await contextWithToken(target.projectId, target.taskId);
  if (!repo || !token) throw new Error("Repository sync needs an authorized GitHub connection");
  const issue = await githubRequest<GitHubIssue>(`/repos/${repo.owner}/${repo.repo}/issues/${target.number}`, token);
  if (!issue.pull_request) await link(target.projectId, target.taskId, `https://github.com/${repo.owner}/${repo.repo}`, issue);
}

export async function syncGitHubEvent(repoUrl: string, number: number) {
  const targets = await integrationBridge<Target[]>("webhookTargets", { repoUrl, number });
  for (const target of targets) await syncTarget(target);
}

export async function syncGitHubPage() {
  const cursorKey = "sync-cursor";
  const old = readGitHubJob(cursorKey);
  const cursor = old?.payload ? JSON.parse(old.payload).cursor : null;
  const page = await integrationBridge<{ rows: Target[]; nextCursor: string | null }>("targets", { cursor: cursor || null });
  await Promise.all(page.rows.map(async target => {
    try { await syncTarget(target); }
    catch (error) { console.warn("GitHub issue sync failed", target.taskId, error instanceof Error ? error.message : "Unknown error"); }
  }));
  saveGitHubJob(cursorKey, "done", { cursor: page.nextCursor });
}

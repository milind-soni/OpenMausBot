import { githubConnectionInfo, githubConnectionToken } from "./githubConnection";
import { GitHubHttpError, githubRequest, lockGitHubJob, readGitHubJob, saveGitHubJob, workspaceGitHubToken } from "./github-workspace";
import { integrationBridge } from "./integration-bridge";
import { parseGitHubRepo } from "./github-repo";
import type { Doc } from "../convex/_generated/dataModel";
import { repositoryPath } from "./github-app";

type Context = {
  credentialAllowed: boolean;
  legacyOwner: boolean;
  sharedConnection?: boolean;
  project: { _id: string; teamId?: string; name: string; status?: string; description?: string; repoUrl?: string; githubRepoId?: number; githubWorkspaceAccess?: boolean };
  connection: { teamId: string; login: string; connectedBy: string; autoCreate: boolean } | null;
  task: { _id: string; title: string; description?: string; done: boolean; githubIssueNumber?: number; githubIssueUrl?: string; githubIssueNodeId?: string; githubIssueRepoId?: number } | null;
};
export type GitHubIssue = { number: number; node_id: string; title: string; html_url: string; state: "open" | "closed"; updated_at: string; body?: string | null; pull_request?: unknown };
type Target = { projectId: string; taskId: string; repoUrl: string; number: number };

async function createOnGitHub<T>(key: string, path: string, token: string, body: unknown): Promise<T> {
  try { return await githubRequest<T>(path, token, { method: "POST", body: JSON.stringify(body) }); }
  catch (error) {
    // Definitive rejections can be retried; unknown network outcomes retain their intent marker.
    if (error instanceof GitHubHttpError && [400, 401, 403, 404, 422, 429].includes(error.status)) saveGitHubJob(key, "working");
    throw error;
  }
}

export async function contextWithToken(projectId: string, taskId?: string, access: "read" | "write" | "push" = "write") {
  let context = await integrationBridge<Context>("context", { projectId, taskId });
  const repo = parseGitHubRepo(context.project.repoUrl);
  let token: string | undefined;
  let expiresAt: number | undefined;
  if (context.sharedConnection) {
    const credential = await integrationBridge<{ token: string; expiresAt: string; repoUrl: string }>("githubToken", { projectId, access });
    if (!repo || repositoryPath(credential.repoUrl).toLowerCase() !== repositoryPath(context.project.repoUrl!).toLowerCase()) throw new Error("Repository authorization changed");
    token = credential.token; expiresAt = Date.parse(credential.expiresAt);
  }
  if (repo && !token) {
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
  if (context.project.status && context.project.status !== "active") throw new Error("Reactivate the project before synchronizing GitHub");
  return { ...context, token, repo, expiresAt };
}

export async function createProjectRepository(projectId: string, manual = false): Promise<{ state: "ready" | "working" | "awaiting_connection" | "error"; repoUrl?: string; error?: string }> {
  const key = `repo:${projectId}`;
  if (!lockGitHubJob(key)) return { state: "working" };
  try {
    const context = await integrationBridge<Context>("context", { projectId });
    if (context.project.status && context.project.status !== "active") { saveGitHubJob(key, "waiting"); return { state: "error", error: "Reactivate the project before creating a repository" }; }
    if (context.project.repoUrl) { saveGitHubJob(key, "done"); return { state: "ready", repoUrl: context.project.repoUrl }; }
    if (context.sharedConnection) {
      const result = await integrationBridge<{ state: "ready" | "working" | "awaiting_connection" | "error"; repoUrl?: string; error?: string }>("createRepository", { projectId, manual });
      saveGitHubJob(key, result.state === "ready" ? "done" : "waiting");
      return result;
    }
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

async function metadata(projectId: string, taskId?: string) {
  const context = await contextWithToken(projectId, taskId);
  if (!context.repo || !context.token) throw new Error("Repository sync needs an authorized GitHub connection");
  const path = repositoryPath(context.project.repoUrl!);
  const remote = await githubRequest<{ id: number; full_name: string }>(path, context.token);
  if (!Number.isSafeInteger(remote.id) || remote.full_name.toLowerCase() !== path.slice(7).toLowerCase()
    || context.project.githubRepoId && context.project.githubRepoId !== remote.id
    || context.task?.githubIssueRepoId && context.task.githubIssueRepoId !== remote.id) throw new Error("Repository identity changed; sync stopped");
  return { ...context, path, repoId: remote.id, token: context.token };
}

function incomingIssue(projectId: string, repoUrl: string, repoId: number, issue: GitHubIssue, taskId?: string, options: { sequence?: number; importOnly?: boolean } = {}) {
  if (issue.pull_request || !Number.isSafeInteger(issue.number) || !Number.isFinite(Date.parse(issue.updated_at))
    || issue.html_url.toLowerCase() !== `${repoUrl}/issues/${issue.number}`.toLowerCase()) throw new Error("Unexpected GitHub issue identity");
  const marker = issue.body?.match(/<!-- origin-task:([a-z0-9]+) -->/);
  return integrationBridge("lifecycleIncoming", { projectId, repoUrl, repoId, number: issue.number, nodeId: issue.node_id,
    title: issue.title, description: (issue.body || "").replace(/<!-- origin-task:[a-z0-9]+ -->/g, "").trim(), state: issue.state,
    updatedAt: Date.parse(issue.updated_at), ...options, ...(taskId || marker ? { taskId: taskId || marker![1] } : {}) });
}

/** Ambiguous creations are reconciled by their persisted marker, never blindly repeated. */
async function findCreatedIssue(path: string, token: string, taskId: string, page: number) {
  const issues = await githubRequest<GitHubIssue[]>(`${path}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`, token);
  return { issue: issues.find(issue => !issue.pull_request && issue.body?.includes(`<!-- origin-task:${taskId} -->`)), nextPage: issues.length < 100 ? 1 : page + 1 };
}

async function deletedNode(nodeId: string, token: string) {
  const response = await githubRequest<{ data?: { node: { id: string } | null }; errors?: { type?: string }[] }>("/graphql", token, { method: "POST", body: JSON.stringify({ query: "query($id:ID!){node(id:$id){id}}", variables: { id: nodeId } }) });
  if (response.errors?.some(error => error.type !== "NOT_FOUND") || !response.data) throw new Error("Cannot confirm issue deletion; GitHub access may have changed");
  return response.data.node === null;
}

async function authorizeWorkWrite(work: Doc<"githubIssueWork"> & { lease: string }, repoId: number, create = false) {
  const context = await contextWithToken(work.projectId);
  if (!context.token || !context.project.repoUrl || repositoryPath(context.project.repoUrl).toLowerCase() !== repositoryPath(work.repoUrl).toLowerCase()) throw new Error("Repository authorization changed before synchronization");
  await integrationBridge("lifecycleStart", { id: work._id, lease: work.lease, repoId, create });
  return context.token;
}

export async function processGitHubWork(taskId?: string) {
  const work = await integrationBridge<(Doc<"githubIssueWork"> & { lease: string }) | null>("lifecycleClaim", taskId ? { taskId } : {});
  if (!work) return false;
  let issue: GitHubIssue | undefined;
  let creating = false;
  let searchPage = work.searchPage || 1;
  try {
    const context = await metadata(work.projectId);
    const { path, repoId } = context;
    let token = context.token;
    if (repositoryPath(work.repoUrl).toLowerCase() !== path.toLowerCase() || work.repoId && work.repoId !== repoId) throw new Error("Repository changed; the original issue has not been modified");
    await integrationBridge("lifecycleStart", { id: work._id, lease: work.lease, repoId, create: false });
    if (work.number) {
      try { issue = await githubRequest<GitHubIssue>(`${path}/issues/${work.number}`, token); }
      catch (error) {
        if (!(error instanceof GitHubHttpError) || ![404, 410].includes(error.status) || !work.nodeId || !await deletedNode(work.nodeId, token)) throw error;
        if (!work.deleted) {
          await integrationBridge("lifecycleIncoming", { projectId: work.projectId, repoUrl: work.repoUrl, repoId, number: work.number, nodeId: work.nodeId, state: "deleted", updatedAt: Date.now(), taskId: work.taskId });
          return true;
        }
      }
    } else if (work.createStarted) {
      const recovered = await findCreatedIssue(path, token, work.taskId, searchPage);
      issue = recovered.issue;
      searchPage = recovered.nextPage;
      if (!issue) throw new Error("Previous GitHub creation has an unknown result. Durable reconciliation continues through the repository; Origin will not create a duplicate.");
    }
    if (issue && (issue.pull_request || work.nodeId && issue.node_id !== work.nodeId || work.number && issue.number !== work.number)) throw new Error("GitHub issue identity changed");
    if (work.deleted) {
      if (issue) {
        token = await authorizeWorkWrite(work, repoId);
        const response = await githubRequest<{ data?: { deleteIssue?: { clientMutationId: string | null } }; errors?: unknown[] }>("/graphql", token, { method: "POST", body: JSON.stringify({
          query: "mutation($id:ID!,$key:String!){deleteIssue(input:{issueId:$id,clientMutationId:$key}){clientMutationId}}", variables: { id: issue.node_id, key: work._id },
        }) });
        if (response.errors?.length || !response.data?.deleteIssue) throw new Error("GitHub did not delete the issue. Repository admin/issue deletion permission is required; the issue was not closed instead.");
      }
    } else {
      const body = `${work.description}\n\n<!-- origin-task:${work.taskId} -->`.trim();
      if (!issue) {
        token = await authorizeWorkWrite(work, repoId, true);
        creating = true;
        issue = await githubRequest<GitHubIssue>(`${path}/issues`, token, { method: "POST", body: JSON.stringify({ title: work.title, body }) });
        creating = false;
      }
      if (issue.title !== work.title || issue.body !== body || issue.state !== (work.done ? "closed" : "open")) {
        token = await authorizeWorkWrite(work, repoId);
        issue = await githubRequest<GitHubIssue>(`${path}/issues/${issue.number}`, token, { method: "PATCH", body: JSON.stringify({ title: work.title, body, state: work.done ? "closed" : "open" }) });
      }
    }
    await integrationBridge("lifecycleFinish", { id: work._id, lease: work.lease, revision: work.revision,
      ...(issue ? { number: issue.number, nodeId: issue.node_id, updatedAt: Date.parse(issue.updated_at) } : {}) });
    return true;
  } catch (error) {
    await integrationBridge("lifecycleFinish", { id: work._id, lease: work.lease, revision: work.revision,
      error: error instanceof Error ? error.message : "GitHub synchronization failed",
      searchPage,
      rejectedCreate: creating && error instanceof GitHubHttpError && [400, 401, 403, 404, 422, 429].includes(error.status),
      ...(issue ? { number: issue.number, nodeId: issue.node_id } : {}) });
    throw error;
  }
}

export async function createGitHubTask(projectId: string, taskId: string) {
  const context = await contextWithToken(projectId, taskId);
  if (!context.task || !context.repo) throw new Error("Connect a repository and choose an existing issue");
  await integrationBridge("lifecycleReconcile", { cursor: null, taskId });
  await processGitHubWork(taskId);
  const result = await integrationBridge<Context>("context", { projectId, taskId });
  if (!result.task?.githubIssueNumber) throw new Error("GitHub synchronization pending; check the issue sync status");
  return { ok: true, issueNumber: result.task.githubIssueNumber, issueUrl: result.task.githubIssueUrl, message: `Linked GitHub issue #${result.task.githubIssueNumber}` };
}

async function syncTarget(target: Target) {
  try {
    const { token, path, repoId, task } = await metadata(target.projectId, target.taskId);
    const sequence = await integrationBridge<number>("lifecycleBegin", { projectId: target.projectId, repoUrl: target.repoUrl, number: target.number });
    let issue: GitHubIssue;
    try { issue = await githubRequest<GitHubIssue>(`${path}/issues/${target.number}`, token); }
    catch (error) {
      if (!(error instanceof GitHubHttpError) || ![404, 410].includes(error.status) || !task?.githubIssueNodeId || !await deletedNode(task.githubIssueNodeId, token)) throw error;
      await integrationBridge("lifecycleIncoming", { projectId: target.projectId, taskId: target.taskId, repoUrl: target.repoUrl, repoId, number: target.number, nodeId: task.githubIssueNodeId, state: "deleted", updatedAt: Date.now() });
      return;
    }
    await incomingIssue(target.projectId, `https://github.com/${path.slice(7)}`, repoId, issue, target.taskId, { sequence });
  } catch (error) {
    await integrationBridge("lifecycleError", { taskId: target.taskId, error: error instanceof Error ? error.message : "GitHub synchronization failed" });
    throw error;
  }
}

export async function syncGitHubEvent(repoUrl: string, number: number, event?: { deleted: boolean; repoId: number; nodeId: string; updatedAt: number }) {
  let cursor: string | null = null;
  do {
    const page: { rows: { projectId: string; repoUrl: string }[]; nextCursor: string | null } = await integrationBridge("lifecycleProjects", { cursor, repoUrl });
    for (const target of page.rows) {
      try {
        const { token, path, repoId } = await metadata(target.projectId);
        if (event && repoId !== event.repoId) throw new Error("Webhook repository identity changed");
        if (event?.deleted) await integrationBridge("lifecycleIncoming", { projectId: target.projectId, repoUrl, repoId, number, nodeId: event.nodeId, state: "deleted", updatedAt: event.updatedAt });
        else {
          const sequence = await integrationBridge<number>("lifecycleBegin", { projectId: target.projectId, repoUrl, number });
          await incomingIssue(target.projectId, repoUrl, repoId, await githubRequest<GitHubIssue>(`${path}/issues/${number}`, token), undefined, { sequence });
        }
      } catch (error) {
        await integrationBridge("lifecycleError", { projectId: target.projectId, error: error instanceof Error ? error.message : "GitHub webhook sync failed" });
        throw error;
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
}

export async function syncGitHubPage() {
  const key = "sync-cursor", old = readGitHubJob(key);
  const cursor = old?.payload ? JSON.parse(old.payload).cursor : null;
  const page = await integrationBridge<{ rows: Target[]; nextCursor: string | null }>("targets", { cursor: cursor || null });
  await Promise.allSettled(page.rows.map(syncTarget));
  saveGitHubJob(key, "done", { cursor: page.nextCursor });
}

export async function reconcileGitHubLifecycle() {
  const key = "lifecycle-reconcile", old = readGitHubJob(key);
  const saved = old?.payload ? JSON.parse(old.payload) : {};
  const result = await integrationBridge<{ nextCursor: string | null }>("lifecycleReconcile", { cursor: saved.cursor || null });
  saveGitHubJob(key, "done", { cursor: result.nextCursor });
  for (let count = 0; count < 5; count++) {
    try { if (!await processGitHubWork()) break; } catch { /* Durable row contains the error and retry deadline. */ }
  }
  // Import a bounded page of GitHub-created issues on every sweep, not just already-linked tasks.
  const projectsKey = "lifecycle-projects", projectState = readGitHubJob(projectsKey);
  const projectCursor = projectState?.payload ? JSON.parse(projectState.payload).cursor : null;
  const projects = await integrationBridge<{ rows: { projectId: string; repoUrl: string }[]; nextCursor: string | null }>("lifecycleProjects", { cursor: projectCursor || null });
  for (const project of projects.rows) {
    const repoKey = `lifecycle-import:${project.projectId}:${project.repoUrl.toLowerCase()}`, oldRepo = readGitHubJob(repoKey);
    const page = oldRepo?.payload ? JSON.parse(oldRepo.payload).page || 1 : 1;
    try {
      const { token, path, repoId } = await metadata(project.projectId);
      const issues = await githubRequest<GitHubIssue[]>(`${path}/issues?state=all&sort=created&direction=asc&per_page=30&page=${page}`, token);
      for (const issue of issues) if (!issue.pull_request) await incomingIssue(project.projectId, `https://github.com/${path.slice(7)}`, repoId, issue, undefined, { importOnly: true });
      saveGitHubJob(repoKey, "done", { page: issues.length === 30 ? page + 1 : 1 });
      await integrationBridge("lifecycleError", { projectId: project.projectId, error: "" });
    } catch (error) {
      saveGitHubJob(repoKey, "error", { page, error: error instanceof Error ? error.message : "GitHub import failed" });
      await integrationBridge("lifecycleError", { projectId: project.projectId, error: error instanceof Error ? error.message : "GitHub import failed" });
    }
  }
  saveGitHubJob(projectsKey, "done", { cursor: projects.nextCursor });
}

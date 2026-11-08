import { ConvexError, v } from "convex/values";
import { action, internalMutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { canEdit, requireMember, touchProject } from "./lib/permissions";
import { DEFAULT_OWNER_EMAIL } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { applyIncoming } from "./githubLifecycle";

type ParsedRepo = { owner: string; repo: string };
type GitHubIssueSnapshot = {
  number: number;
  title: string;
  body?: string;
  state: "open" | "closed";
  url: string;
  author?: string;
  updatedAt: number;
};
type GitHubPullRequestSnapshot = {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  url: string;
  author?: string;
  branch?: string;
  createdAt: number;
  updatedAt: number;
};

async function requireEditor(ctx: QueryCtx | MutationCtx, projectId: Id<"projects">, sessionToken: string) {
  const result = await requireMember(ctx, projectId, sessionToken);
  if (!canEdit(result.member)) throw new ConvexError("You have view-only access");
  return result;
}

function parseGitHubRepo(repoUrl?: string): ParsedRepo | null {
  if (!repoUrl) return null;
  const value = repoUrl.trim();
  const shorthand = value.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2].replace(/\.git$/i, "") };
  const match = value.match(/github\.com[:/]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#]|$)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, "") };
}

function githubHeaders(useServerToken = false) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "origin-dashboard",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token && useServerToken) headers.Authorization = `Bearer ${token}`;
  return headers;
}


export const listPullRequests = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.projectId, args.sessionToken);
    return await ctx.db
      .query("githubPullRequests")
      .withIndex("by_project_and_updatedAt", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(50);
  },
});

export const syncRepo = action({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    const project = (await ctx.runQuery(api.projects.get, args)) as Doc<"projects"> & { memberRole: string };
    const parsed = parseGitHubRepo(project.repoUrl);
    if (!parsed) {
      return { ok: false, repo: "", issueCount: 0, pullRequestCount: 0, error: "Add a valid GitHub repo URL in Settings." };
    }

    if (project.memberRole === "viewer") throw new ConvexError("You have view-only access");
    const user = await ctx.runQuery(api.auth.me, { sessionToken: args.sessionToken });
    const headers = githubHeaders(user?.email === DEFAULT_OWNER_EMAIL && project.ownerEmail === DEFAULT_OWNER_EMAIL);
    const [issuesResponse, pullRequestsResponse] = await Promise.all([
      fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues?state=all&per_page=50`, { headers }),
      fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls?state=all&per_page=50`, { headers }),
    ]);

    if (!issuesResponse.ok || !pullRequestsResponse.ok) {
      const status = !issuesResponse.ok ? issuesResponse.status : pullRequestsResponse.status;
      const error = status === 404
        ? "Repo not found or private. Add GITHUB_TOKEN to Convex env for private repositories."
        : `GitHub sync failed (${status}).`;
      return { ok: false, repo: `${parsed.owner}/${parsed.repo}`, issueCount: 0, pullRequestCount: 0, error };
    }

    const issuesPayload = (await issuesResponse.json()) as Array<{
      number: number;
      title?: string;
      body?: string | null;
      state?: "open" | "closed";
      html_url?: string;
      updated_at?: string;
      user?: { login?: string };
      pull_request?: unknown;
    }>;
    const pullRequestsPayload = (await pullRequestsResponse.json()) as Array<{
      number: number;
      title?: string;
      state?: "open" | "closed";
      merged_at?: string | null;
      html_url?: string;
      created_at?: string;
      updated_at?: string;
      user?: { login?: string };
      head?: { ref?: string };
    }>;

    const issues: GitHubIssueSnapshot[] = issuesPayload
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title || `Issue #${issue.number}`,
        body: issue.body || undefined,
        state: issue.state === "closed" ? "closed" : "open",
        url: issue.html_url || `https://github.com/${parsed.owner}/${parsed.repo}/issues/${issue.number}`,
        author: issue.user?.login,
        updatedAt: issue.updated_at ? new Date(issue.updated_at).getTime() : Date.now(),
      }));
    const pullRequests: GitHubPullRequestSnapshot[] = pullRequestsPayload.map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title || `PR #${pullRequest.number}`,
      state: pullRequest.merged_at ? "merged" : pullRequest.state === "closed" ? "closed" : "open",
      url: pullRequest.html_url || `https://github.com/${parsed.owner}/${parsed.repo}/pull/${pullRequest.number}`,
      author: pullRequest.user?.login,
      branch: pullRequest.head?.ref,
      createdAt: pullRequest.created_at ? new Date(pullRequest.created_at).getTime() : Date.now(),
      updatedAt: pullRequest.updated_at ? new Date(pullRequest.updated_at).getTime() : Date.now(),
    }));

    await ctx.runMutation(internal.github.upsertRepoSnapshot, {
      projectId: args.projectId,
      sessionToken: args.sessionToken,
      repoUrl: project.repoUrl!,
      issues,
      pullRequests,
    });
    return {
      ok: true,
      repo: `${parsed.owner}/${parsed.repo}`,
      issueCount: issues.length,
      pullRequestCount: pullRequests.length,
      error: "",
    };
  },
});

export const createIssueForTask = action({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    taskId: v.id("tasks"),
    origin: v.optional(v.string()),
  },
  returns: v.object({ ok: v.boolean(), issueUrl: v.string(), manualUrl: v.string(), message: v.string() }),
  handler: async (ctx, args) => {
    const project = (await ctx.runQuery(api.projects.get, {
      projectId: args.projectId,
      sessionToken: args.sessionToken,
    })) as Doc<"projects"> & { memberRole: string };
    const details = (await ctx.runQuery(api.tasks.details, {
      projectId: args.projectId,
      sessionToken: args.sessionToken,
      taskId: args.taskId,
    })) as { task: Doc<"tasks">; columns: Doc<"columns">[] };
    const parsed = parseGitHubRepo(project.repoUrl);
    if (!parsed) return { ok: false, issueUrl: "", manualUrl: "", message: "Add a valid GitHub repo URL in Settings." };

    if (project.memberRole === "viewer") throw new ConvexError("You have view-only access");
    if (details.task.githubIssueNumber) {
      return {
        ok: true,
        issueUrl: details.task.githubIssueUrl || `https://github.com/${parsed.owner}/${parsed.repo}/issues/${details.task.githubIssueNumber}`,
        manualUrl: "",
        message: `Already linked to GitHub issue #${details.task.githubIssueNumber}.`,
      };
    }
    await ctx.runMutation(api.githubLifecycle.retry, { sessionToken: args.sessionToken, projectId: args.projectId, taskId: args.taskId });
    return { ok: false, issueUrl: "", manualUrl: "", message: "GitHub issue synchronization queued. Draft issues are included; check the issue sync status for the result." };
  },
});

export const linkTaskIssue = internalMutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    repoUrl: v.string(),
    taskId: v.id("tasks"),
    githubIssueNumber: v.number(),
    githubIssueUrl: v.string(),
    githubIssueState: v.union(v.literal("open"), v.literal("closed")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { project } = await requireEditor(ctx, args.projectId, args.sessionToken);
    if (project.repoUrl !== args.repoUrl) throw new ConvexError("Repository changed; sync cancelled");
    await applyIncoming(ctx, { projectId: args.projectId, taskId: args.taskId, repoUrl: args.repoUrl, number: args.githubIssueNumber, state: args.githubIssueState, updatedAt: Date.now() });
    return null;
  },
});

export const upsertRepoSnapshot = internalMutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    repoUrl: v.string(),
    issues: v.array(
      v.object({
        number: v.number(),
        title: v.string(),
        body: v.optional(v.string()),
        state: v.union(v.literal("open"), v.literal("closed")),
        url: v.string(),
        author: v.optional(v.string()),
        updatedAt: v.number(),
      }),
    ),
    pullRequests: v.array(
      v.object({
        number: v.number(),
        title: v.string(),
        state: v.union(v.literal("open"), v.literal("closed"), v.literal("merged")),
        url: v.string(),
        author: v.optional(v.string()),
        branch: v.optional(v.string()),
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { project } = await requireEditor(ctx, args.projectId, args.sessionToken);
    if (project.repoUrl !== args.repoUrl) throw new ConvexError("Repository changed; sync cancelled");
    const now = Date.now();
    for (const issue of args.issues) await applyIncoming(ctx, { projectId: args.projectId, repoUrl: args.repoUrl, number: issue.number, title: issue.title, description: issue.body ?? "", state: issue.state, updatedAt: issue.updatedAt });

    for (const pullRequest of args.pullRequests) {
      const existing = await ctx.db
        .query("githubPullRequests")
        .withIndex("by_project_number", (q) => q.eq("projectId", args.projectId).eq("number", pullRequest.number))
        .unique();
      const patch = {
        title: pullRequest.title,
        state: pullRequest.state,
        url: pullRequest.url,
        author: pullRequest.author,
        branch: pullRequest.branch,
        createdAt: pullRequest.createdAt,
        updatedAt: pullRequest.updatedAt,
        syncedAt: now,
      };
      if (existing) {
        await ctx.db.patch(existing._id, patch);
      } else {
        await ctx.db.insert("githubPullRequests", {
          projectId: args.projectId,
          number: pullRequest.number,
          ...patch,
        });
      }
    }

    await touchProject(ctx, args.projectId);
    return null;
  },
});

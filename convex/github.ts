import { ConvexError, v } from "convex/values";
import { action, internalMutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { canEdit, changeOpenIssueCount, requireMember, touchProject } from "./lib/permissions";
import { DEFAULT_OWNER_EMAIL } from "./lib/auth";
import { recordCompletion } from "./lib/completions";
import { isDraftColumn } from "./lib/columns";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

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

function taskKey(id: string) {
  return `ORI-${id.slice(-4).toUpperCase()}`;
}

function manualIssueUrl(repo: ParsedRepo, task: Doc<"tasks">, origin?: string) {
  const title = encodeURIComponent(task.title);
  const lines = [
    task.description || "",
    "",
    `Origin task: ${taskKey(task._id)}`,
    origin ? `Origin workspace: ${origin.replace(/\/$/, "")}` : "",
  ].filter(Boolean);
  return `https://github.com/${repo.owner}/${repo.repo}/issues/new?title=${title}&body=${encodeURIComponent(lines.join("\n"))}`;
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
    const column = details.columns.find(item => item._id === details.task.columnId);
    if (column && isDraftColumn(column)) throw new ConvexError("Draft issues stay in Origin. Move this issue to an active column before publishing it.");
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
    return {
      ok: false,
      issueUrl: "",
      manualUrl: manualIssueUrl(parsed, details.task, args.origin),
      message: "Use Origin's connected repository integration for automatic issue creation, or open this prefilled GitHub issue.",
    };
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
    const task = await ctx.db.get(args.taskId);
    if (!task || task.projectId !== args.projectId) throw new ConvexError("Issue not found");
    if (task.githubIssueNumber && task.githubIssueNumber !== args.githubIssueNumber) throw new ConvexError("Issue already linked");
    await ctx.db.patch(args.taskId, {
      githubIssueNumber: args.githubIssueNumber,
      githubIssueUrl: args.githubIssueUrl,
      githubIssueState: args.githubIssueState,
      githubIssueSyncedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await touchProject(ctx, args.projectId);
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
    const columns = await ctx.db
      .query("columns")
      .withIndex("by_project_order", (q) => q.eq("projectId", args.projectId))
      .take(20);
    const open = columns.filter(column => !(column.isDone ?? column.title.toLowerCase() === "done"));
    const todoColumn = open.find(column => !isDraftColumn(column)) ?? open[0] ?? columns[0];
    const existingTasks = await ctx.db
      .query("tasks")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(500);
    let nextOrder = existingTasks.length ? Math.max(...existingTasks.map((task) => task.order)) + 1 : 0;

    if (todoColumn) {
      for (const issue of args.issues) {
        const existing = await ctx.db
          .query("tasks")
          .withIndex("by_project_githubIssueNumber", (q) =>
            q.eq("projectId", args.projectId).eq("githubIssueNumber", issue.number),
          )
          .unique();
        const patch = {
          title: issue.title,
          description: issue.body,
          githubIssueNumber: issue.number,
          githubIssueUrl: issue.url,
          githubIssueState: issue.state,
          githubIssueSyncedAt: now,
          githubIssueUpdatedAt: issue.updatedAt,
          done: false,
          columnId: todoColumn._id,
          updatedAt: issue.updatedAt || now,
        };
        if (existing) {
          if ((existing.githubIssueUpdatedAt || 0) > issue.updatedAt) continue;
          const column = await ctx.db.get(existing.columnId);
          patch.done = existing.done;
          if (issue.state === "open" && existing.githubIssueState === "closed") patch.done = false;
          if (column && isDraftColumn(column)) patch.done = existing.done;
          if (existing.githubTaskMode === "pull_request" || await ctx.db.query("taskPullRequests").withIndex("by_taskId", q => q.eq("taskId", existing._id)).first()) patch.done = existing.done;
          if (issue.state === "open" && existing.githubIssueState !== "closed") patch.done = existing.done;
          patch.columnId = existing.columnId;
          await recordCompletion(ctx, existing, patch.done, issue.updatedAt);
          await ctx.db.patch(existing._id, { ...patch, ...(issue.state === "open" ? { githubIssueReopenRequested: undefined,
            ...(existing.githubIssueState === "closed" ? { completionPullRequest: undefined } : {}) } : {}) });
          if (existing.done !== patch.done) await changeOpenIssueCount(ctx, args.projectId, patch.done ? -1 : 1);
        } else {
          await ctx.db.insert("tasks", {
            teamId: (await ctx.db.get(args.projectId))?.teamId,
            projectId: args.projectId,
            columnId: patch.columnId,
            title: issue.title,
            description: issue.body,
            priority: "medium",
            done: false,
            githubIssueNumber: issue.number,
            githubIssueUrl: issue.url,
            githubIssueState: issue.state,
            githubIssueSyncedAt: now,
            githubIssueUpdatedAt: issue.updatedAt,
            order: nextOrder,
            createdAt: now,
            updatedAt: issue.updatedAt || now,
          });
          nextOrder += 1;
          await changeOpenIssueCount(ctx, args.projectId, patch.done ? 0 : 1);
        }
      }
    }

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

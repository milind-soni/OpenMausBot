import { ConvexError, v } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { DEFAULT_OWNER_EMAIL } from "./lib/auth";
import { canEdit, requireMember, touchProject } from "./lib/permissions";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

async function requireEditor(ctx: QueryCtx | MutationCtx, projectId: Id<"projects">, sessionToken: string) {
  const result = await requireMember(ctx, projectId, sessionToken);
  if (!canEdit(result.member)) throw new ConvexError("You have view-only access");
  return result;
}

function parseGitHubRepo(repoUrl?: string) {
  if (!repoUrl) return null;
  const url = repoUrl.trim();
  const shorthand = url.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2].replace(/\.git$/i, "") };
  const match = url.match(/github\.com[:/]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#]|$)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, "") };
}

export const list = query({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.projectId, args.sessionToken);
    const commits = await ctx.db
      .query("commits")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    return commits.sort((a, b) => b.committedAt - a.committedAt);
  },
});

export const addManual = mutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    sha: v.optional(v.string()),
    message: v.string(),
    author: v.string(),
    url: v.optional(v.string()),
    committedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireEditor(ctx, args.projectId, args.sessionToken);
    const now = Date.now();
    const sha = args.sha?.trim() || `manual-${now}`;
    const existing = await ctx.db
      .query("commits")
      .withIndex("by_project_sha", (q) => q.eq("projectId", args.projectId).eq("sha", sha))
      .unique();
    const data = {
      message: args.message.trim(),
      author: args.author.trim() || user.name || user.email,
      url: args.url?.trim() || undefined,
      committedAt: args.committedAt ?? now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, data);
    } else {
      await ctx.db.insert("commits", {
        projectId: args.projectId,
        sha,
        ...data,
        createdAt: now,
      });
    }
    await touchProject(ctx, args.projectId);
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects"), sessionToken: v.string(), commitId: v.id("commits") },
  handler: async (ctx, args) => {
    await requireEditor(ctx, args.projectId, args.sessionToken);
    const commit = await ctx.db.get(args.commitId);
    if (!commit || commit.projectId !== args.projectId) throw new ConvexError("Commit not found");
    await ctx.db.delete(args.commitId);
    await touchProject(ctx, args.projectId);
  },
});

export const upsertMany = internalMutation({
  args: {
    projectId: v.id("projects"),
    sessionToken: v.string(),
    repoUrl: v.string(),
    commits: v.array(
      v.object({
        sha: v.string(),
        message: v.string(),
        author: v.string(),
        url: v.optional(v.string()),
        committedAt: v.number(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { project } = await requireEditor(ctx, args.projectId, args.sessionToken);
    if (project.repoUrl !== args.repoUrl) throw new ConvexError("Repository changed; sync cancelled");
    const now = Date.now();
    for (const commit of args.commits) {
      const existing = await ctx.db
        .query("commits")
        .withIndex("by_project_sha", (q) => q.eq("projectId", args.projectId).eq("sha", commit.sha))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          message: commit.message,
          author: commit.author,
          url: commit.url,
          committedAt: commit.committedAt,
        });
      } else {
        await ctx.db.insert("commits", {
          projectId: args.projectId,
          sha: commit.sha,
          message: commit.message,
          author: commit.author,
          url: commit.url,
          committedAt: commit.committedAt,
          createdAt: now,
        });
      }
    }
    await touchProject(ctx, args.projectId);
    return null;
  },
});

export const syncGitHub = action({
  args: { projectId: v.id("projects"), sessionToken: v.string() },
  handler: async (ctx, args) => {
    const project = await ctx.runQuery(api.projects.get, args);
    if (project.memberRole === "viewer") throw new ConvexError("You have view-only access");
    const user = await ctx.runQuery(api.auth.me, { sessionToken: args.sessionToken });
    const parsed = parseGitHubRepo(project.repoUrl);
    if (!parsed) return { ok: false, count: 0, repo: "", error: "Add a valid GitHub repo URL in Settings, e.g. https://github.com/owner/repo" };

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "origin-dashboard",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token && user?.email === DEFAULT_OWNER_EMAIL && project.ownerEmail === DEFAULT_OWNER_EMAIL) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits?per_page=30`,
      { headers },
    );
    if (!response.ok) {
      const hint = response.status === 404
        ? "Repo not found or private. Check URL, or set GITHUB_TOKEN in Convex env with repo access."
        : `GitHub sync failed (${response.status}).`;
      return { ok: false, count: 0, repo: `${parsed.owner}/${parsed.repo}`, error: hint };
    }

    const payload = (await response.json()) as Array<{
      sha: string;
      html_url?: string;
      commit?: {
        message?: string;
        author?: { name?: string; date?: string };
      };
    }>;

    const commits = payload.map((item) => ({
      sha: item.sha,
      message: item.commit?.message?.split("\n")[0] || "No message",
      author: item.commit?.author?.name || "Unknown",
      url: item.html_url,
      committedAt: item.commit?.author?.date ? new Date(item.commit.author.date).getTime() : Date.now(),
    }));

    await ctx.runMutation(internal.commits.upsertMany, { ...args, repoUrl: project.repoUrl!, commits });
    return { ok: true, count: commits.length, repo: `${parsed.owner}/${parsed.repo}`, error: "" };
  },
});

import { ConvexError, v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { mutation, query } from "./_generated/server";
import { canEdit, requireMember, requireTeamAdmin, requireTeamMember, visibleProjectRows } from "./lib/permissions";
import { cleanText, requireWorkspaceEditor, validDay, workspaceProject } from "./lib/features";

const scope = { sessionToken: v.string(), teamId: v.id("teams") };
const state = v.union(v.literal("planned"), v.literal("active"), v.literal("completed"));
const issue = v.object({ _id: v.id("tasks"), title: v.string(), done: v.boolean(), projectId: v.id("projects"), projectName: v.string(), githubIssueUrl: v.optional(v.string()) });

export const milestones = query({
  args: { ...scope, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ _id: v.id("milestones"), title: v.string(), description: v.string(), targetDate: v.string(), status: state, issues: v.array(issue), truncated: v.boolean() })),
  handler: async (ctx, args) => {
    const { user } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    const rows = await ctx.db.query("milestones").withIndex("by_teamId_and_targetDate", q => q.eq("teamId", args.teamId)).paginate({ ...args.paginationOpts, numItems: Math.min(10, args.paginationOpts.numItems) });
    const page = await Promise.all(rows.page.map(async row => {
      const tasks = await ctx.db.query("tasks").withIndex("by_milestoneId", q => q.eq("milestoneId", row._id)).take(201);
      const issues = await Promise.all((await visibleProjectRows(ctx, tasks.slice(0, 200), user, true)).map(async task => ({ _id: task._id, title: task.title, done: task.done, projectId: task.projectId, projectName: (await ctx.db.get(task.projectId))!.name, githubIssueUrl: task.githubIssueUrl })));
      return { _id: row._id, title: row.title, description: row.description, targetDate: row.targetDate, status: row.status, issues, truncated: tasks.length > 200 };
    }));
    return { ...rows, page };
  },
});

export const saveMilestone = mutation({
  args: { ...scope, milestoneId: v.optional(v.id("milestones")), title: v.string(), description: v.string(), targetDate: v.string(), status: state },
  returns: v.id("milestones"),
  handler: async (ctx, args) => {
    await requireWorkspaceEditor(ctx, args.teamId, args.sessionToken);
    const fields = { title: cleanText(args.title, 120, "Title"), description: args.description.trim().slice(0, 12000), targetDate: validDay(args.targetDate), status: args.status, updatedAt: Date.now() };
    if (args.milestoneId) {
      const row = await ctx.db.get(args.milestoneId);
      if (row?.teamId !== args.teamId) throw new ConvexError("Milestone not found");
      await ctx.db.patch(row._id, fields);
      return row._id;
    }
    const existing = await ctx.db.query("milestones").withIndex("by_teamId_and_targetDate", q => q.eq("teamId", args.teamId)).take(100);
    if (existing.length >= 100) throw new ConvexError("A workspace can have up to 100 milestones");
    return ctx.db.insert("milestones", { teamId: args.teamId, ...fields, createdAt: Date.now() });
  },
});

export const assignMilestone = mutation({
  args: { ...scope, taskId: v.id("tasks"), milestoneId: v.union(v.id("milestones"), v.null()) }, returns: v.null(),
  handler: async (ctx, args) => {
    await requireWorkspaceEditor(ctx, args.teamId, args.sessionToken);
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new ConvexError("Issue not found");
    await workspaceProject(ctx, args.teamId, task.projectId);
    if (!canEdit((await requireMember(ctx, task.projectId, args.sessionToken)).member)) throw new ConvexError("You have view-only access");
    if (args.milestoneId) {
      if ((await ctx.db.get(args.milestoneId))?.teamId !== args.teamId) throw new ConvexError("Milestone not found");
      if (task.milestoneId !== args.milestoneId && (await ctx.db.query("tasks").withIndex("by_milestoneId", q => q.eq("milestoneId", args.milestoneId!)).take(200)).length >= 200) throw new ConvexError("Split milestones with more than 200 issues");
    }
    await ctx.db.patch(task._id, { milestoneId: args.milestoneId || undefined, updatedAt: Date.now() });
    return null;
  },
});

export const removeMilestone = mutation({
  args: { ...scope, milestoneId: v.id("milestones") }, returns: v.null(),
  handler: async (ctx, args) => {
    await requireTeamAdmin(ctx, args.teamId, args.sessionToken);
    if ((await ctx.db.get(args.milestoneId))?.teamId !== args.teamId) throw new ConvexError("Milestone not found");
    const tasks = await ctx.db.query("tasks").withIndex("by_milestoneId", q => q.eq("milestoneId", args.milestoneId)).take(201);
    if (tasks.length > 200) throw new ConvexError("Unlink issues before deleting this milestone");
    for (const task of tasks) await ctx.db.patch(task._id, { milestoneId: undefined });
    await ctx.db.delete(args.milestoneId);
    return null;
  },
});

export const releases = query({
  args: { ...scope, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ _id: v.id("releases"), projectId: v.id("projects"), projectName: v.string(), version: v.string(), body: v.string(), publishedAt: v.optional(v.number()), issues: v.array(issue) })),
  handler: async (ctx, args) => {
    const { user } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    const rows = await ctx.db.query("releases").withIndex("by_teamId_and_createdAt", q => q.eq("teamId", args.teamId)).order("desc").paginate({ ...args.paginationOpts, numItems: Math.min(10, args.paginationOpts.numItems) });
    const page = await Promise.all((await visibleProjectRows(ctx, rows.page, user)).map(async row => {
      const links = await ctx.db.query("releaseIssues").withIndex("by_releaseId", q => q.eq("releaseId", row._id)).take(200);
      const projectName = (await ctx.db.get(row.projectId))?.name || "Deleted project";
      const tasks = await Promise.all(links.map(link => ctx.db.get(link.taskId)));
      return { _id: row._id, projectId: row.projectId, projectName, version: row.version, body: row.body, publishedAt: row.publishedAt, issues: tasks.flatMap(task => task ? [{ _id: task._id, title: task.title, done: task.done, projectId: task.projectId, projectName, githubIssueUrl: task.githubIssueUrl }] : []) };
    }));
    return { ...rows, page };
  },
});

export const saveRelease = mutation({
  args: { ...scope, releaseId: v.optional(v.id("releases")), projectId: v.id("projects"), version: v.string(), body: v.string(), taskIds: v.array(v.id("tasks")), publish: v.boolean() },
  returns: v.id("releases"),
  handler: async (ctx, args) => {
    await requireWorkspaceEditor(ctx, args.teamId, args.sessionToken);
    await workspaceProject(ctx, args.teamId, args.projectId);
    if (!canEdit((await requireMember(ctx, args.projectId, args.sessionToken)).member)) throw new ConvexError("You have view-only access");
    const taskIds = [...new Set(args.taskIds)];
    if (taskIds.length > 200 || args.body.length > 60000) throw new ConvexError("Release is too large");
    for (const id of taskIds) {
      const task = await ctx.db.get(id);
      if (task?.projectId !== args.projectId || !task.done) throw new ConvexError("Releases include completed issues from this project only");
    }
    const existing = args.releaseId ? await ctx.db.get(args.releaseId) : null;
    if (args.releaseId && (!existing || existing.teamId !== args.teamId || existing.projectId !== args.projectId)) throw new ConvexError("Release not found");
    const fields = { version: cleanText(args.version, 80, "Version"), body: args.body.trim(), publishedAt: args.publish ? existing?.publishedAt || Date.now() : undefined, updatedAt: Date.now() };
    const releaseId = existing?._id || await ctx.db.insert("releases", { teamId: args.teamId, projectId: args.projectId, ...fields, createdAt: Date.now() });
    if (existing) await ctx.db.patch(releaseId, fields);
    const previous = await ctx.db.query("releaseIssues").withIndex("by_releaseId", q => q.eq("releaseId", releaseId)).take(201);
    if (previous.length > 200) throw new ConvexError("Release is too large");
    for (const row of previous) await ctx.db.delete(row._id);
    for (const taskId of taskIds) await ctx.db.insert("releaseIssues", { releaseId, taskId });
    return releaseId;
  },
});

export const removeRelease = mutation({
  args: { ...scope, releaseId: v.id("releases") }, returns: v.null(),
  handler: async (ctx, args) => {
    await requireWorkspaceEditor(ctx, args.teamId, args.sessionToken);
    const release = await ctx.db.get(args.releaseId);
    if (release?.teamId !== args.teamId) throw new ConvexError("Release not found");
    if (!canEdit((await requireMember(ctx, release.projectId, args.sessionToken)).member)) throw new ConvexError("You have view-only access");
    const links = await ctx.db.query("releaseIssues").withIndex("by_releaseId", q => q.eq("releaseId", args.releaseId)).take(201);
    if (links.length > 200) throw new ConvexError("Release is too large");
    for (const row of links) await ctx.db.delete(row._id);
    await ctx.db.delete(args.releaseId);
    return null;
  },
});

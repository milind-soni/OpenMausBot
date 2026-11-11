import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { canEdit, projectMember, requireMember, requireTeamMember, visibleProjectRows } from "./lib/permissions";
import { isDoneColumn, isDraftColumn } from "./lib/columns";
import { createTaskRecord } from "./tasks";
import { issuesForKey } from "../lib/issue-route";
import { priorityValidator } from "./lib/validators";

const match = v.object({ projectId: v.id("projects"), taskId: v.id("tasks"), title: v.string(), done: v.boolean() });

/**
 * Finds the issue an issue page URL names. An id in the URL is exact; a bare key (`ORI-1A2B`) is looked up among the
 * workspace's issues the person can see and may match more than one.
 */
export const resolve = query({
  args: { sessionToken: v.string(), teamId: v.id("teams"), key: v.string(), taskId: v.optional(v.string()) },
  returns: v.union(
    v.object({ status: v.literal("found"), projectId: v.id("projects"), taskId: v.id("tasks") }),
    v.object({ status: v.literal("ambiguous"), matches: v.array(match) }),
    v.object({ status: v.literal("missing") }),
  ),
  handler: async (ctx, args) => {
    const { user } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    const id = args.taskId ? ctx.db.normalizeId("tasks", args.taskId) : null;
    if (id) {
      const task = await ctx.db.get(id);
      const project = task && await ctx.db.get(task.projectId);
      if (task && project?.teamId === args.teamId && await projectMember(ctx, project, user)) return { status: "found" as const, projectId: task.projectId, taskId: task._id };
      return { status: "missing" as const };
    }
    const candidates = issuesForKey(await ctx.db.query("tasks").withIndex("by_teamId_and_done", q => q.eq("teamId", args.teamId)).take(4000), args.key);
    const visible = await visibleProjectRows(ctx, candidates, user);
    if (visible.length === 1) return { status: "found" as const, projectId: visible[0]!.projectId, taskId: visible[0]!._id };
    if (!visible.length) return { status: "missing" as const };
    return { status: "ambiguous" as const, matches: visible.slice(0, 20).map(task => ({ projectId: task.projectId, taskId: task._id, title: task.title, done: task.done })) };
  },
});

const subIssue = v.object({
  _id: v.id("tasks"), relationId: v.id("taskRelations"), projectId: v.id("projects"), title: v.string(), done: v.boolean(), priority: priorityValidator,
  status: v.optional(v.string()), assignedToEmail: v.optional(v.string()), assignedToName: v.optional(v.string()),
});

/** An issue's sub-issues with what their rows show: status, assignee, priority. */
export const subIssues = query({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  returns: v.array(subIssue),
  handler: async (ctx, args) => {
    const parent = await ctx.db.get(args.taskId);
    if (!parent) throw new ConvexError("Issue not found");
    const { project, user } = await requireMember(ctx, parent.projectId, args.sessionToken);
    const rows = [];
    for (const relation of await ctx.db.query("taskRelations").withIndex("by_fromTaskId", q => q.eq("fromTaskId", parent._id)).take(30)) {
      if (relation.kind !== "parent" || relation.teamId !== project.teamId) continue;
      const child = await ctx.db.get(relation.toTaskId);
      const target = child && (child.projectId === project._id ? project : await ctx.db.get(child.projectId));
      if (!child || !target || target.teamId !== project.teamId || !await projectMember(ctx, target, user)) continue;
      const column = await ctx.db.get(child.columnId);
      rows.push({
        _id: child._id, relationId: relation._id, projectId: child.projectId, title: child.title, done: child.done, priority: child.priority,
        ...(column ? { status: isDraftColumn(column) ? "Draft" : column.title } : {}),
        ...(child.assignedToEmail ? { assignedToEmail: child.assignedToEmail } : {}), ...(child.assignedToName ? { assignedToName: child.assignedToName } : {}),
      });
    }
    return rows.sort((a, b) => Number(a.done) - Number(b.done));
  },
});

/** Which open issues of a project are sub-issues, so lists can hide or nest them. */
export const projectParents = query({
  args: { sessionToken: v.string(), projectId: v.id("projects") },
  returns: v.array(v.object({ taskId: v.id("tasks"), parentId: v.id("tasks") })),
  handler: async (ctx, args) => {
    await requireMember(ctx, args.projectId, args.sessionToken);
    const rows: { taskId: Id<"tasks">; parentId: Id<"tasks"> }[] = [];
    for (const task of await ctx.db.query("tasks").withIndex("by_project_and_done", q => q.eq("projectId", args.projectId).eq("done", false)).take(500)) {
      const parent = (await ctx.db.query("taskRelations").withIndex("by_toTaskId", q => q.eq("toTaskId", task._id)).take(30)).find(row => row.kind === "parent");
      if (parent) rows.push({ taskId: task._id, parentId: parent.fromTaskId });
    }
    return rows;
  },
});

/** Creates an issue as a sub-issue of `parentTaskId`, in the parent's project and (open) status. */
export const createSubIssue = mutation({
  args: { sessionToken: v.string(), parentTaskId: v.id("tasks"), title: v.string(), priority: v.optional(priorityValidator), assignedToEmail: v.optional(v.string()) },
  returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const parent = await ctx.db.get(args.parentTaskId);
    if (!parent) throw new ConvexError("Issue not found");
    const { member, user, project } = await requireMember(ctx, parent.projectId, args.sessionToken);
    if (!canEdit(member)) throw new ConvexError("You have view-only access");
    if (!project.teamId) throw new ConvexError("Sub-issues need a workspace project");
    const children = await ctx.db.query("taskRelations").withIndex("by_fromTaskId", q => q.eq("fromTaskId", parent._id)).take(31);
    if (children.length >= 30) throw new ConvexError("An issue can have up to 30 incoming or outgoing relationships");
    const column = await ctx.db.get(parent.columnId);
    const taskId = await createTaskRecord(ctx, {
      projectId: parent.projectId, title: args.title, priority: args.priority ?? parent.priority,
      ...(column && !isDoneColumn(column) ? { columnId: column._id } : {}),
      ...(args.assignedToEmail ? { assignedToEmail: args.assignedToEmail } : {}),
    }, user._id);
    await ctx.db.insert("taskRelations", { teamId: project.teamId, fromTaskId: parent._id, toTaskId: taskId, kind: "parent" });
    return taskId;
  },
});

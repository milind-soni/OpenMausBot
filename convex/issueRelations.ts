import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { canEdit, projectMember, requireMember } from "./lib/permissions";
import type { Id } from "./_generated/dataModel";
import { cleanLabels, projectLabels, registerLabels, workspaceLabelRows } from "./lib/labels";

const kind = v.union(v.literal("blocks"), v.literal("parent"));
export const list = query({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  returns: v.object({ labels: v.array(v.string()), relations: v.array(v.object({ _id: v.id("taskRelations"), kind, outgoing: v.boolean(), taskId: v.id("tasks"), projectId: v.id("projects"), title: v.string(), done: v.boolean() })) }),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new ConvexError("Issue not found");
    const { project, user } = await requireMember(ctx, task.projectId, args.sessionToken);
    const from = await ctx.db.query("taskRelations").withIndex("by_fromTaskId", q => q.eq("fromTaskId", args.taskId)).take(30);
    const to = await ctx.db.query("taskRelations").withIndex("by_toTaskId", q => q.eq("toTaskId", args.taskId)).take(30);
    const relations = [];
    for (const row of [...from, ...to]) {
      if (row.teamId !== project.teamId) continue;
      const outgoing = row.fromTaskId === args.taskId;
      const other = await ctx.db.get(outgoing ? row.toTaskId : row.fromTaskId);
      const target = other && await ctx.db.get(other.projectId);
      if (other && target && target.teamId === project.teamId && await projectMember(ctx, target, user)) relations.push({ _id: row._id, kind: row.kind, outgoing, taskId: other._id, projectId: other.projectId, title: other.title, done: other.done });
    }
    return { labels: task.labels || [], relations };
  },
});
export const labels = mutation({
  args: { sessionToken: v.string(), taskId: v.id("tasks"), labels: v.array(v.string()) }, returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    const access = task && await requireMember(ctx, task.projectId, args.sessionToken);
    if (!task || !access || !canEdit(access.member)) throw new ConvexError("You have view-only access");
    const teamId = access.project.teamId;
    // The workspace registry's spelling wins, then the project's; new names join the registry.
    const registry = teamId ? (await workspaceLabelRows(ctx, teamId)).map(row => row.name) : [];
    const labels = cleanLabels(args.labels, [...await projectLabels(ctx, task.projectId), ...registry]);
    await ctx.db.patch(task._id, { labels, updatedAt: Date.now() });
    if (teamId) await registerLabels(ctx, teamId, labels);
    return null;
  },
});
/** Labels already used in the project, for suggestions while labelling an issue. */
export const projectLabelOptions = query({
  args: { sessionToken: v.string(), projectId: v.id("projects") }, returns: v.array(v.string()),
  handler: async (ctx, args) => { await requireMember(ctx, args.projectId, args.sessionToken); return projectLabels(ctx, args.projectId); },
});
export const connect = mutation({
  args: { sessionToken: v.string(), fromTaskId: v.id("tasks"), toTaskId: v.id("tasks"), kind }, returns: v.null(),
  handler: async (ctx, args) => {
    const from = await ctx.db.get(args.fromTaskId), to = await ctx.db.get(args.toTaskId);
    if (!from || !to || from._id === to._id) throw new ConvexError("Choose another issue");
    const source = await requireMember(ctx, from.projectId, args.sessionToken);
    const target = await requireMember(ctx, to.projectId, args.sessionToken);
    if (!canEdit(source.member) || !canEdit(target.member)) throw new ConvexError("You have view-only access");
    if (!source.project.teamId || source.project.teamId !== target.project.teamId) throw new ConvexError("Issues must belong to the same workspace");
    const outgoing = await ctx.db.query("taskRelations").withIndex("by_fromTaskId", q => q.eq("fromTaskId", from._id)).take(31);
    if (outgoing.some(row => row.toTaskId === to._id && row.kind === args.kind)) return null;
    const incoming = await ctx.db.query("taskRelations").withIndex("by_toTaskId", q => q.eq("toTaskId", to._id)).take(31);
    if (outgoing.length >= 30 || incoming.length >= 30) throw new ConvexError("An issue can have up to 30 incoming or outgoing relationships");
    if (args.kind === "parent" && incoming.some(row => row.kind === "parent")) throw new ConvexError("This issue already has a parent");
    const queue: Id<"tasks">[] = [to._id]; const visited = new Set<string>();
    while (queue.length) {
      const current = queue.pop()!;
      if (current === from._id) throw new ConvexError("This relationship would create a cycle");
      if (visited.has(current)) continue;
      visited.add(current);
      if (visited.size > 64) throw new ConvexError("This dependency chain is too large. Split it into smaller groups.");
      const next = await ctx.db.query("taskRelations").withIndex("by_fromTaskId", q => q.eq("fromTaskId", current)).take(31);
      queue.push(...next.filter(row => row.kind === args.kind).map(row => row.toTaskId));
    }
    await ctx.db.insert("taskRelations", { teamId: source.project.teamId, fromTaskId: from._id, toTaskId: to._id, kind: args.kind });
    return null;
  },
});
export const disconnect = mutation({
  args: { sessionToken: v.string(), id: v.id("taskRelations") }, returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id); const task = row && await ctx.db.get(row.fromTaskId);
    if (!row || !task || !canEdit((await requireMember(ctx, task.projectId, args.sessionToken)).member)) throw new ConvexError("You have view-only access");
    await ctx.db.delete(row._id); return null;
  },
});

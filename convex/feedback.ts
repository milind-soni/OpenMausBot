import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { canEdit, requireMember, requireTeamAdmin, requireTeamMember, visibleProjectRows } from "./lib/permissions";
import { cleanText, requireWorkspaceEditor, workspaceProject } from "./lib/features";
import { createTaskRecord } from "./tasks";
import { priorityValidator } from "./lib/validators";

const scope = { sessionToken: v.string(), teamId: v.id("teams") };
const kind = v.union(v.literal("bug"), v.literal("idea"));
const status = v.union(v.literal("new"), v.literal("planned"), v.literal("completed"), v.literal("dismissed"));

export const portals = query({
  args: scope,
  returns: v.array(v.object({ _id: v.id("feedbackPortals"), projectId: v.id("projects"), slug: v.string(), title: v.string(), description: v.string(), enabled: v.boolean() })),
  handler: async (ctx, args) => {
    const { user } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
    const rows = await ctx.db.query("feedbackPortals").withIndex("by_teamId", q => q.eq("teamId", args.teamId)).take(200);
    return (await visibleProjectRows(ctx, rows, user)).map(({ _id, projectId, slug, title, description, enabled }) => ({ _id, projectId, slug, title, description, enabled }));
  },
});

export const configure = mutation({
  args: { ...scope, projectId: v.id("projects"), title: v.string(), description: v.string(), enabled: v.boolean() }, returns: v.string(),
  handler: async (ctx, args) => {
    await requireTeamAdmin(ctx, args.teamId, args.sessionToken);
    await workspaceProject(ctx, args.teamId, args.projectId);
    const existing = await ctx.db.query("feedbackPortals").withIndex("by_projectId", q => q.eq("projectId", args.projectId)).unique();
    const fields = { title: cleanText(args.title, 120, "Public title"), description: args.description.trim().slice(0, 3000), enabled: args.enabled };
    if (existing) { await ctx.db.patch(existing._id, fields); return existing.slug; }
    const slug = crypto.randomUUID().replace(/-/g, "");
    await ctx.db.insert("feedbackPortals", { teamId: args.teamId, projectId: args.projectId, slug, ...fields });
    return slug;
  },
});

export const publicPortal = query({
  args: { slug: v.string() }, returns: v.union(v.null(), v.object({ title: v.string(), description: v.string() })),
  handler: async (ctx, args) => {
    if (!/^[a-f0-9]{32}$/.test(args.slug)) return null;
    const portal = await ctx.db.query("feedbackPortals").withIndex("by_slug", q => q.eq("slug", args.slug)).unique();
    return portal?.enabled ? { title: portal.title, description: portal.description } : null;
  },
});

// Only the rate-limited Next.js endpoint can submit through the signed server bridge.
export const submit = internalMutation({
  args: { slug: v.string(), title: v.string(), body: v.string(), kind }, returns: v.null(),
  handler: async (ctx, args) => {
    const portal = await ctx.db.query("feedbackPortals").withIndex("by_slug", q => q.eq("slug", args.slug)).unique();
    if (!portal?.enabled) throw new ConvexError("This feedback form is closed");
    const recent = await ctx.db.query("feedbackEntries").withIndex("by_portalId_and_createdAt", q => q.eq("portalId", portal._id).gt("createdAt", Date.now() - 3600000)).take(100);
    if (recent.length >= 100) throw new ConvexError("Too many submissions right now. Try again later.");
    await ctx.db.insert("feedbackEntries", { portalId: portal._id, title: cleanText(args.title, 180, "Title"), body: cleanText(args.body, 8000, "Feedback"), kind: args.kind, status: "new", createdAt: Date.now() });
    return null;
  },
});

export const list = query({
  args: { ...scope, portalId: v.id("feedbackPortals") },
  returns: v.array(v.object({ _id: v.id("feedbackEntries"), title: v.string(), body: v.string(), kind, status, taskId: v.optional(v.id("tasks")), createdAt: v.number() })),
  handler: async (ctx, args) => {
    await requireTeamMember(ctx, args.teamId, args.sessionToken);
    const portal = await ctx.db.get(args.portalId);
    if (portal?.teamId !== args.teamId) throw new ConvexError("Feedback form not found");
    await requireMember(ctx, portal.projectId, args.sessionToken);
    const rows = await ctx.db.query("feedbackEntries").withIndex("by_portalId_and_createdAt", q => q.eq("portalId", portal._id)).order("desc").take(200);
    return Promise.all(rows.map(async row => {
      const task = row.taskId ? await ctx.db.get(row.taskId) : null;
      return { _id: row._id, title: row.title, body: row.body, kind: row.kind, status: task?.done ? "completed" as const : row.status, taskId: task?._id, createdAt: row.createdAt };
    }));
  },
});

export const dismiss = mutation({
  args: { ...scope, entryId: v.id("feedbackEntries"), dismissed: v.boolean() }, returns: v.null(),
  handler: async (ctx, args) => {
    await requireWorkspaceEditor(ctx, args.teamId, args.sessionToken);
    const entry = await ctx.db.get(args.entryId);
    const portal = entry && await ctx.db.get(entry.portalId);
    if (!entry || portal?.teamId !== args.teamId) throw new ConvexError("Feedback not found");
    if (!canEdit((await requireMember(ctx, portal.projectId, args.sessionToken)).member)) throw new ConvexError("You have view-only access");
    await ctx.db.patch(entry._id, { status: args.dismissed ? "dismissed" : entry.taskId ? "planned" : "new" });
    return null;
  },
});

export const convert = mutation({
  args: { ...scope, entryId: v.id("feedbackEntries"), columnId: v.optional(v.id("columns")), assignedToEmail: v.string(), dueDate: v.string(), priority: v.optional(priorityValidator) }, returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceEditor(ctx, args.teamId, args.sessionToken);
    const entry = await ctx.db.get(args.entryId);
    const portal = entry && await ctx.db.get(entry.portalId);
    if (!entry || !portal || portal.teamId !== args.teamId) throw new ConvexError("Feedback not found");
    if (!canEdit((await requireMember(ctx, portal.projectId, args.sessionToken)).member)) throw new ConvexError("You have view-only access");
    if (entry.taskId && await ctx.db.get(entry.taskId)) return entry.taskId;
    const taskId = await createTaskRecord(ctx, { projectId: portal.projectId, columnId: args.columnId, title: entry.title, description: `${entry.body}\n\nSource: customer feedback (${entry.kind})`, priority: args.priority ?? (entry.kind === "bug" ? "high" : "medium"), assignedToEmail: args.assignedToEmail, dueDate: args.dueDate }, user._id);
    await ctx.db.patch(entry._id, { taskId, status: "planned" });
    return taskId;
  },
});

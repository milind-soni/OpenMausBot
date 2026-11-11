import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireChat, requireChatWriter, type ChatAttachment, type ChatViewer } from "./lib/chatAccess";
import { projectMember } from "./lib/permissions";
import { issueUpload } from "./lib/storage";
import { requireRequestBudget } from "./lib/rateLimit";

// Workspace and direct chat for the web app (app/api/local-chat/*). Messages keep the payload format the desktop app and
// the retired local store used, so rows written by either read the same way.

type Ctx = QueryCtx | MutationCtx;
type Reference = { type: "project" | "issue"; id: string; projectId: string; label: string };
type Mention = { userId: Id<"users">; name: string };
export type ChatMessage = {
  id: string; authorUserId: Id<"users">; authorName: string; authorEmail: string; avatarUrl?: string | null;
  body: string; createdAt: number; editedAt?: number; replyTo?: string; pinned?: boolean;
  attachments?: ChatAttachment[]; references?: Reference[]; mentions?: Mention[]; reactions?: Record<string, string[]>;
};

const PAGE = 100;
const MAX_BODY = 8000;
const REACTIONS = ["like", "heart", "celebrate", "eyes"];
const scope = { sessionToken: v.string(), teamId: v.id("teams"), conversation: v.optional(v.string()) };

async function messageRow(ctx: Ctx, viewer: ChatViewer, id: string) {
  const row = await ctx.db.query("teamChatMessages").withIndex("by_team_conversation_message", q => q.eq("teamId", viewer.teamId).eq("conversation", viewer.conversation).eq("messageId", id)).first();
  if (!row) throw new ConvexError("Message not found");
  return row;
}
const parse = (row: Doc<"teamChatMessages">) => JSON.parse(row.payload) as ChatMessage;

/**
 * Up to PAGE messages before `before`, or the newest PAGE without it. The newest page must not be bounded by
 * Date.now(): Convex caches a query by its arguments and the index range it read, and a message sent later falls
 * outside a "created < now" range, so the cached (stale) page would keep being served.
 */
async function page(ctx: Ctx, viewer: ChatViewer, before?: number) {
  const rows = await ctx.db.query("teamChatMessages")
    .withIndex("by_team_conversation_created", q => {
      const conversation = q.eq("teamId", viewer.teamId).eq("conversation", viewer.conversation);
      return before === undefined ? conversation : conversation.lt("created", before);
    })
    .order("desc").take(PAGE);
  return rows.reverse().map(row => row.payload);
}

/** Up to 100 messages before `before` (or the newest), or the page ending at `focus`. Payloads are JSON strings. */
export const list = query({
  args: { ...scope, before: v.optional(v.number()), focus: v.optional(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    if (a.focus) return page(ctx, viewer, (await messageRow(ctx, viewer, a.focus)).created + 1);
    return page(ctx, viewer, a.before || undefined);
  },
});

/** Case-insensitive substring search over the 5,000 messages before `before`. A mutation so it can be rate limited. */
export const search = mutation({
  args: { ...scope, search: v.string(), before: v.optional(v.number()) },
  returns: v.array(v.string()),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    const text = a.search.trim().slice(0, 160).toLowerCase();
    if (!text) return [];
    await requireRequestBudget(ctx, `chat-search:${viewer.teamId}:${viewer.user._id}`, 90, 60000);
    const found: string[] = [];
    let scanned = 0;
    for await (const row of ctx.db.query("teamChatMessages")
      .withIndex("by_team_conversation_created", q => q.eq("teamId", viewer.teamId).eq("conversation", viewer.conversation).lt("created", a.before || Date.now() + 1))
      .order("desc")) {
      if (++scanned > 5000 || found.length === PAGE) break;
      if (String(parse(row).body ?? "").toLowerCase().includes(text)) found.push(row.payload);
    }
    return found.reverse();
  },
});

async function activeMembers(ctx: Ctx, teamId: Id<"teams">) {
  const rows = await ctx.db.query("teamMembers").withIndex("by_team", q => q.eq("teamId", teamId)).take(200);
  const members = [];
  for (const row of rows) {
    if (row.status !== "active" || !row.userId) continue;
    const user = await ctx.db.get(row.userId);
    members.push({ userId: row.userId, email: row.email, name: user?.username || user?.name || row.name });
  }
  return members;
}

async function resolveReference(ctx: MutationCtx, viewer: ChatViewer, input: { type: string; id: string; projectId: string }, members: { userId: Id<"users">; email: string }[], notify: Id<"users">[]): Promise<Reference> {
  const projectId = ctx.db.normalizeId("projects", input.projectId);
  const project = projectId ? await ctx.db.get(projectId) : null;
  if (!project || !await projectMember(ctx, project, viewer.user)) throw new ConvexError("You don't have access to this project");
  if (project.teamId !== viewer.teamId) throw new ConvexError("Reference must belong to this workspace");
  if (input.type === "project") return { type: "project", projectId: project._id, id: project._id, label: project.name };
  if (input.type !== "issue") throw new ConvexError("Unknown reference");
  const taskId = ctx.db.normalizeId("tasks", input.id);
  const task = taskId ? await ctx.db.get(taskId) : null;
  if (!task || task.projectId !== project._id) throw new ConvexError("Issue not found");
  const assignee = members.find(member => member.email === task.assignedToEmail);
  if (assignee) notify.push(assignee.userId);
  return { type: "issue", projectId: project._id, id: task._id, label: task.title };
}

export const send = mutation({
  args: {
    ...scope,
    body: v.string(),
    attachmentIds: v.optional(v.array(v.string())),
    references: v.optional(v.array(v.object({ type: v.string(), id: v.string(), projectId: v.string() }))),
    replyTo: v.optional(v.string()),
    mentionUserIds: v.optional(v.array(v.string())),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    requireChatWriter(viewer);
    await requireRequestBudget(ctx, `chat:${viewer.teamId}:${viewer.user._id}`, 40, 60000);
    if (a.body.length > MAX_BODY) throw new ConvexError("Message must be under 8,000 characters");
    if ((a.mentionUserIds?.length ?? 0) > 20) throw new ConvexError("Too many mentions");
    if ((a.references?.length ?? 0) > 12) throw new ConvexError("Too many references");
    const members = await activeMembers(ctx, viewer.teamId);
    if (viewer.conversation && !viewer.conversation.slice(3).split(":").every(id => members.some(member => member.userId === id))) throw new ConvexError("This member is no longer in the workspace");
    const mentions: Mention[] = [...new Set(a.mentionUserIds ?? [])].map(id => {
      const member = members.find(m => m.userId === id);
      if (!member) throw new ConvexError("Mention must belong to this workspace");
      return { userId: member.userId, name: member.name };
    });
    const notify: Id<"users">[] = [];
    const references: Reference[] = [];
    for (const reference of a.references ?? []) references.push(await resolveReference(ctx, viewer, reference, members, notify));
    const attachments: ChatAttachment[] = [];
    for (const id of (a.attachmentIds ?? []).slice(0, 8)) {
      const file = await ctx.db.query("teamChatFiles").withIndex("by_team_conversation_file", q => q.eq("teamId", viewer.teamId).eq("conversation", viewer.conversation).eq("fileId", id)).first();
      if (!file || file.author !== viewer.user._id) throw new ConvexError("Attachment not found");
      attachments.push(JSON.parse(file.payload) as ChatAttachment);
    }
    const body = a.body.trim();
    if (!body && !attachments.length && !references.length && !mentions.length) throw new ConvexError("Write a message or add an attachment");
    if (a.replyTo) await messageRow(ctx, viewer, a.replyTo);
    const message: ChatMessage = {
      id: crypto.randomUUID(), authorUserId: viewer.user._id, authorName: viewer.user.name || viewer.user.email, authorEmail: viewer.user.email,
      avatarUrl: viewer.avatarUrl, body, createdAt: Date.now(), attachments, references, mentions, ...(a.replyTo ? { replyTo: a.replyTo } : {}),
    };
    const payload = JSON.stringify(message);
    await ctx.db.insert("teamChatMessages", { teamId: viewer.teamId, conversation: viewer.conversation, messageId: message.id, created: message.createdAt, payload, webWrittenAt: message.createdAt });
    // Mentions in the workspace channel notify people; the scheduled mutation commits with this message or not at all.
    const userIds = [...new Set([...mentions.map(m => m.userId), ...notify])].filter(id => id !== viewer.user._id).slice(0, 20);
    if (userIds.length && !viewer.conversation) await ctx.scheduler.runAfter(0, internal.notifications.chatMentions, { teamId: viewer.teamId, actorId: viewer.user._id, messageId: message.id, userIds });
    return payload;
  },
});

/** Edits, reacts to, pins or deletes a message. Returns the new payload, or null after a delete. */
export const edit = mutation({
  args: { ...scope, id: v.string(), body: v.optional(v.string()), reaction: v.optional(v.string()), pinned: v.optional(v.boolean()), delete: v.optional(v.boolean()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    requireChatWriter(viewer);
    const row = await messageRow(ctx, viewer, a.id);
    const message = parse(row);
    if (a.delete || a.body !== undefined) {
      if (message.authorUserId !== viewer.user._id) throw new ConvexError("Only the author can edit or delete this message");
      if (a.delete) { await ctx.db.delete(row._id); return null; }
      if (!a.body?.trim() || a.body.length > MAX_BODY) throw new ConvexError("Enter a message under 8,000 characters");
      message.body = a.body.trim(); message.editedAt = Date.now();
    }
    if (a.reaction) {
      if (!REACTIONS.includes(a.reaction)) throw new ConvexError("Unknown reaction");
      message.reactions ||= {};
      const users = message.reactions[a.reaction] || [];
      message.reactions[a.reaction] = users.includes(viewer.user._id) ? users.filter(id => id !== viewer.user._id) : [...users, viewer.user._id];
    }
    if (typeof a.pinned === "boolean") message.pinned = a.pinned;
    const payload = JSON.stringify(message);
    await ctx.db.patch(row._id, { payload, webWrittenAt: Date.now() });
    return payload;
  },
});

export const directs = query({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.array(v.object({ id: v.string(), otherUserId: v.string(), lastMessage: v.optional(v.string()), unread: v.number() })),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    const me = viewer.user._id;
    const rows = [
      ...await ctx.db.query("teamDirectConversations").withIndex("by_team_userA", q => q.eq("teamId", a.teamId).eq("userA", me)).take(200),
      ...await ctx.db.query("teamDirectConversations").withIndex("by_team_userB", q => q.eq("teamId", a.teamId).eq("userB", me)).take(200),
    ];
    const seen = new Set<string>();
    const result = [];
    for (const row of rows) {
      if (seen.has(row.conversation)) continue;
      seen.add(row.conversation);
      const last = await ctx.db.query("teamChatMessages").withIndex("by_team_conversation_created", q => q.eq("teamId", a.teamId).eq("conversation", row.conversation)).order("desc").first();
      const read = await ctx.db.query("teamChatReads").withIndex("by_team_conversation_user", q => q.eq("teamId", a.teamId).eq("conversation", row.conversation).eq("userId", me)).first();
      const newer = await ctx.db.query("teamChatMessages").withIndex("by_team_conversation_created", q => q.eq("teamId", a.teamId).eq("conversation", row.conversation).gt("created", read?.seen ?? 0)).take(100);
      result.push({
        id: row.conversation, otherUserId: row.userA === me ? row.userB : row.userA,
        ...(last ? { lastMessage: last.payload } : {}),
        unread: newer.filter(message => parse(message).authorUserId !== me).length,
        sortKey: last?.created ?? 0,
      });
    }
    return result.sort((x, y) => y.sortKey - x.sortKey).map(({ sortKey: _sortKey, ...row }) => row);
  },
});

export const openDirect = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), recipientId: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    requireChatWriter(viewer);
    if (!a.recipientId || a.recipientId === viewer.user._id || !(await activeMembers(ctx, a.teamId)).some(member => member.userId === a.recipientId)) throw new ConvexError("Choose a member of this workspace");
    const [userA, userB] = [viewer.user._id as string, a.recipientId].sort();
    const conversation = `dm:${userA}:${userB}`;
    const existing = await ctx.db.query("teamDirectConversations").withIndex("by_team_conversation", q => q.eq("teamId", a.teamId).eq("conversation", conversation)).first();
    if (!existing) await ctx.db.insert("teamDirectConversations", { teamId: a.teamId, conversation, userA, userB });
    return conversation;
  },
});

export const markRead = mutation({
  args: { ...scope, messageId: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    const message = await messageRow(ctx, viewer, a.messageId);
    const read = await ctx.db.query("teamChatReads").withIndex("by_team_conversation_user", q => q.eq("teamId", viewer.teamId).eq("conversation", viewer.conversation).eq("userId", viewer.user._id)).first();
    if (!read) await ctx.db.insert("teamChatReads", { teamId: viewer.teamId, conversation: viewer.conversation, userId: viewer.user._id, seen: message.created });
    else if (read.seen < message.created) await ctx.db.patch(read._id, { seen: message.created });
    return null;
  },
});

const MAX_FILE = 15 * 1024 * 1024;

/**
 * Starts a chat or issue attachment upload. The browser sends the bytes straight to the returned Convex URL (frontend
 * functions cannot take 15 MB bodies); storage.completeUpload records the file once they arrive.
 */
export const beginUpload = mutation({
  args: { ...scope, projectId: v.optional(v.string()), name: v.string(), size: v.number(), contentType: v.string() },
  returns: v.object({ uploadUrl: v.string(), file: v.object({ id: v.string(), name: v.string(), size: v.number(), contentType: v.string(), projectId: v.optional(v.id("projects")) }) }),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    requireChatWriter(viewer);
    if (!Number.isFinite(a.size) || a.size <= 0 || a.size > MAX_FILE) throw new ConvexError("Choose a file between 1 byte and 15 MB");
    const projectId = a.projectId ? ctx.db.normalizeId("projects", a.projectId) : undefined;
    if (a.projectId && !projectId) throw new ConvexError("You have view-only access");
    await requireRequestBudget(ctx, `upload:${viewer.user._id}`, 30, 60000);
    const file = { id: crypto.randomUUID(), name: (a.name || "file").slice(0, 200), size: a.size, contentType: (a.contentType || "application/octet-stream").slice(0, 200), ...(projectId ? { projectId } : {}) };
    const uploadUrl = await issueUpload(ctx, a.sessionToken, { kind: "chat", teamId: viewer.teamId, conversation: viewer.conversation, fileId: file.id, name: file.name, ...(projectId ? { projectId } : {}) });
    return { uploadUrl, file };
  },
});

/** An attachment's metadata and a short-lived download URL, after the same checks the message view applies. */
export const file = query({
  args: { ...scope, fileId: v.string() },
  returns: v.union(v.null(), v.object({ name: v.string(), contentType: v.string(), url: v.string() })),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    const row = await ctx.db.query("teamChatFiles").withIndex("by_team_conversation_file", q => q.eq("teamId", viewer.teamId).eq("conversation", viewer.conversation).eq("fileId", a.fileId)).first();
    if (!row) return null;
    const file = JSON.parse(row.payload) as ChatAttachment;
    if (file.projectId) {
      const project = await ctx.db.get(file.projectId);
      if (!project || project.teamId !== viewer.teamId || !await projectMember(ctx, project, viewer.user)) return null;
    } else {
      // Issue attachments uploaded before files carried their project are tied to it through taskAssets.
      for (const asset of await ctx.db.query("taskAssets").withIndex("by_localFileId", q => q.eq("localFileId", a.fileId)).take(100)) {
        const project = await ctx.db.get(asset.projectId);
        if (project?.teamId !== viewer.teamId || !await projectMember(ctx, project, viewer.user)) return null;
      }
    }
    const url = await ctx.storage.getUrl(row.storageId);
    return url ? { name: file.name, contentType: file.contentType, url } : null;
  },
});

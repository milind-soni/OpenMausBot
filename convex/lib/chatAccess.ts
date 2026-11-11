import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireTeamMember } from "./permissions";

type Ctx = QueryCtx | MutationCtx;

// Workspace chat: conversation "" is the workspace channel, "dm:<userA>:<userB>" a direct conversation (ids sorted).

export async function directConversation(ctx: Ctx, teamId: Id<"teams">, conversation: string) {
  if (!conversation.startsWith("dm:")) return null;
  return ctx.db.query("teamDirectConversations").withIndex("by_team_conversation", q => q.eq("teamId", teamId).eq("conversation", conversation)).first();
}

export async function isConversationMember(ctx: Ctx, teamId: Id<"teams">, conversation: string, userId: Id<"users">) {
  const row = await directConversation(ctx, teamId, conversation);
  return Boolean(row && (row.userA === userId || row.userB === userId));
}

export type ChatViewer = { user: Doc<"users">; member: Doc<"teamMembers">; teamId: Id<"teams">; conversation: string; avatarUrl: string | null };

/** Session, active workspace membership and, for a direct conversation, being one of its two people. */
export async function requireChat(ctx: Ctx, a: { sessionToken: string; teamId: Id<"teams">; conversation?: string }): Promise<ChatViewer> {
  const { user, member } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
  const conversation = a.conversation ?? "";
  if (conversation && !await isConversationMember(ctx, a.teamId, conversation, user._id)) throw new ConvexError("Conversation not found");
  return { user, member, teamId: a.teamId, conversation, avatarUrl: user.avatarStorageId ? await ctx.storage.getUrl(user.avatarStorageId) : null };
}

export function requireChatWriter(viewer: ChatViewer) {
  if (viewer.member.role === "viewer") throw new ConvexError("View-only workspace access");
}

export type ChatAttachment = { id: string; name: string; size: number; contentType: string; projectId?: Id<"projects"> };

/** Records a completed chat upload. Called from storage.completeUpload inside the same transaction. */
export async function recordChatFile(ctx: MutationCtx, target: Extract<Doc<"storageUploadIntents">["target"], { kind: "chat" }>, author: Id<"users">, storageId: Id<"_storage">, size: number, contentType: string) {
  const existing = await ctx.db.query("teamChatFiles").withIndex("by_team_conversation_file", q => q.eq("teamId", target.teamId).eq("conversation", target.conversation).eq("fileId", target.fileId)).first();
  if (existing) throw new ConvexError("Upload rejected");
  const file: ChatAttachment = { id: target.fileId, name: target.name, size, contentType, ...(target.projectId ? { projectId: target.projectId } : {}) };
  await ctx.db.insert("teamChatFiles", { teamId: target.teamId, conversation: target.conversation, fileId: target.fileId, author: author, storageId, payload: JSON.stringify(file) });
}

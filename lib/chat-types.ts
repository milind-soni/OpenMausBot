import type { Id } from "@/convex/_generated/dataModel";

// Shapes of workspace chat and call payloads (convex/workspaceChat.ts, convex/workspaceCalls.ts), shared by the API
// routes and the browser.

export type ChatAttachment = { id: string; name: string; size: number; contentType: string; projectId?: Id<"projects"> };
export type ChatReference = { type: "project" | "issue"; id: string; projectId: string; label: string };
export type ChatMention = { userId: Id<"users">; name: string };
export type LocalChatMessage = {
  id: string; authorUserId: Id<"users">; authorName: string; authorEmail: string; avatarUrl?: string | null;
  body: string; createdAt: number; editedAt?: number; replyTo?: string; pinned?: boolean;
  attachments?: ChatAttachment[]; references?: ChatReference[]; mentions?: ChatMention[]; reactions?: Record<string, string[]>;
};
export type DirectConversation = { id: string; otherUserId: string; lastMessage?: LocalChatMessage; unread: number };
export type LocalVoiceParticipant = {
  userId: Id<"users">; name: string; username?: string; email: string; avatarUrl?: string | null;
  audioEnabled: boolean; videoEnabled: boolean; screenSharing?: boolean; joinedAt: number; lastSeenAt: number;
};
export type LocalVoiceSignal = { id: string; fromUserId: Id<"users">; toUserId: Id<"users">; fromJoinedAt?: number; toJoinedAt?: number; kind: "offer" | "answer" | "candidate"; payload: string; createdAt: number };

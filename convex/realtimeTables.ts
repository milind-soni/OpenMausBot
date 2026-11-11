import { defineTable } from "convex/server";
import { v } from "convex/values";

export const realtimeTables = {
  teamChatMessages: defineTable({
    teamId: v.id("teams"), conversation: v.string(), messageId: v.string(), created: v.number(), payload: v.string(),
    /** Set whenever the web app (convex/workspaceChat.ts) writes the row; the local-store import never changes such rows. */
    webWrittenAt: v.optional(v.number()),
  })
    .index("by_team_conversation_created", ["teamId", "conversation", "created"])
    .index("by_team_conversation_message", ["teamId", "conversation", "messageId"]),
  teamChatFiles: defineTable({ teamId: v.id("teams"), conversation: v.string(), fileId: v.string(), author: v.string(), storageId: v.id("_storage"), payload: v.string() })
    .index("by_team_conversation_file", ["teamId", "conversation", "fileId"]),
  teamDirectConversations: defineTable({ teamId: v.id("teams"), conversation: v.string(), userA: v.string(), userB: v.string() })
    .index("by_team_conversation", ["teamId", "conversation"])
    .index("by_team_userA", ["teamId", "userA"])
    .index("by_team_userB", ["teamId", "userB"]),
  teamChatReads: defineTable({ teamId: v.id("teams"), conversation: v.string(), userId: v.string(), seen: v.number() })
    .index("by_team_conversation_user", ["teamId", "conversation", "userId"]),
  teamCallParticipants: defineTable({ teamId: v.id("teams"), room: v.string(), userId: v.string(), seen: v.number(), payload: v.string() })
    .index("by_team_room_user", ["teamId", "room", "userId"])
    .index("by_seen", ["seen"]),
  teamCallSignals: defineTable({ teamId: v.id("teams"), room: v.string(), recipient: v.string(), sender: v.string(), signalId: v.string(), created: v.number(), payload: v.string() })
    .index("by_team_room_recipient_created", ["teamId", "room", "recipient", "created"])
    .index("by_team_room_sender", ["teamId", "room", "sender"])
    .index("by_created", ["created"]),
  teamCallAgents: defineTable({ teamId: v.id("teams"), room: v.string(), payload: v.string(), updatedAt: v.number() })
    .index("by_team_room", ["teamId", "room"]),
  teamCallLines: defineTable({ teamId: v.id("teams"), room: v.string(), lineId: v.number(), payload: v.string() })
    .index("by_team_room_line", ["teamId", "room", "lineId"]),
};

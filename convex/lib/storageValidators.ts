import { v } from "convex/values";

export const storageScope = v.union(
  v.object({ kind: v.literal("user"), userId: v.id("users") }),
  v.object({ kind: v.literal("project"), projectId: v.id("projects") }),
  v.object({ kind: v.literal("workspace"), teamId: v.id("teams") }),
);
export const uploadTarget = v.union(
  v.object({ kind: v.literal("profile"), userId: v.id("users") }),
  v.object({ kind: v.literal("icon"), projectId: v.id("projects") }),
  v.object({ kind: v.literal("asset"), projectId: v.id("projects") }),
  v.object({ kind: v.literal("agent"), agentId: v.id("workspaceAgents") }),
  v.object({ kind: v.literal("drawing"), teamId: v.id("teams"), canvasId: v.optional(v.id("canvases")) }),
  /** A chat or issue attachment; completing the upload records it in teamChatFiles (convex/workspaceChat.ts). */
  v.object({ kind: v.literal("chat"), teamId: v.id("teams"), conversation: v.string(), fileId: v.string(), name: v.string(), projectId: v.optional(v.id("projects")) }),
);

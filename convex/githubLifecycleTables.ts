import { defineTable } from "convex/server";
import { v } from "convex/values";

export const githubSyncState = v.union(v.literal("pending"), v.literal("syncing"), v.literal("synced"), v.literal("error"));
export const githubLifecycleTables = {
  githubIssueReads: defineTable({ projectId: v.id("projects"), repoUrl: v.string(), number: v.number(), sequence: v.number(), deletedNodeId: v.optional(v.string()) })
    .index("by_projectId_and_repoUrl_and_number", ["projectId", "repoUrl", "number"]),
  githubIssueWork: defineTable({
    projectId: v.id("projects"), taskId: v.id("tasks"), repoUrl: v.string(), repoId: v.optional(v.number()),
    title: v.string(), description: v.string(), done: v.boolean(), deleted: v.boolean(),
    number: v.optional(v.number()), nodeId: v.optional(v.string()), revision: v.number(),
    state: githubSyncState, error: v.optional(v.string()), attempts: v.number(), nextAt: v.number(),
    lease: v.optional(v.string()), leaseUntil: v.optional(v.number()), createStarted: v.optional(v.boolean()),
    searchPage: v.optional(v.number()),
    updatedAt: v.number(), remoteUpdatedAt: v.optional(v.number()),
  }).index("by_taskId", ["taskId"]).index("by_nextAt", ["nextAt"])
    .index("by_projectId_and_updatedAt", ["projectId", "updatedAt"])
    .index("by_repoUrl_and_number", ["repoUrl", "number"]),
  /**
   * Two-way issue sync (convex/githubIssueSync.ts): per Origin issue, fingerprints of the title, body and labels that
   * Origin and GitHub last agreed on, plus an outbox entry while Origin has changes GitHub has not seen yet. A deleted
   * issue keeps its row (with `deleted`) until the worker closed its GitHub issue.
   */
  githubIssueMirrors: defineTable({
    projectId: v.id("projects"), taskId: v.id("tasks"),
    titleHash: v.optional(v.string()), bodyHash: v.optional(v.string()), labelsHash: v.optional(v.string()),
    pending: v.boolean(), revision: v.number(), attempts: v.number(), nextAt: v.number(),
    leaseUntil: v.optional(v.number()), error: v.optional(v.string()),
    deleted: v.optional(v.object({ repoUrl: v.string(), number: v.number() })),
    updatedAt: v.number(),
  }).index("by_taskId", ["taskId"]).index("by_pending_and_nextAt", ["pending", "nextAt"]),
};

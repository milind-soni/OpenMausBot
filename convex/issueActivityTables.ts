import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * What an issue's Activity shows (convex/issueActivity.ts). Agents are connector grants (personal access tokens and
 * OAuth connections) their owner marked as taking delegated issues; an agent acts with its owner's access, and every
 * MCP write it makes is recorded here under its own name. `actorName` and `agentName` are copied at write time so the
 * log reads the same after a token is renamed or revoked.
 */
export const issueActivityKind = v.union(
  v.literal("delegated"), v.literal("undelegated"),
  v.literal("acknowledged"), v.literal("progress"), v.literal("question"), v.literal("blocked"), v.literal("done"),
  v.literal("commented"), v.literal("status"), v.literal("updated"), v.literal("created"), v.literal("criteria"),
);

export const issueActivityTables = {
  issueActivity: defineTable({
    teamId: v.id("teams"),
    projectId: v.id("projects"),
    taskId: v.id("tasks"),
    kind: issueActivityKind,
    /** The person who acted, or the agent's owner when an agent acted. */
    actorUserId: v.optional(v.id("users")),
    actorName: v.string(),
    /** Set when an agent acted over MCP. */
    agentGrantId: v.optional(v.id("connectorGrants")),
    agentName: v.optional(v.string()),
    /** For delegation: the agent before and after. For status: the column before and after. */
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    body: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_taskId_and_createdAt", ["taskId", "createdAt"]),
};

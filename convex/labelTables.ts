import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The workspace label registry. Issues keep their labels as names on `tasks.labels`; these rows add color, description
 * and grouping, and are matched to those names case-insensitively through `key` (the lowercased name).
 */
export const labelTables = {
  issueLabels: defineTable({
    teamId: v.id("teams"),
    name: v.string(),
    key: v.string(),
    color: v.string(),
    description: v.optional(v.string()),
    groupId: v.optional(v.id("issueLabelGroups")),
    archived: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_teamId_and_key", ["teamId", "key"]),
  issueLabelGroups: defineTable({
    teamId: v.id("teams"),
    name: v.string(),
    key: v.string(),
    archived: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_teamId_and_key", ["teamId", "key"]),
};

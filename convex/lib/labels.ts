import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export const MAX_LABELS = 20;
export const MAX_LABEL_LENGTH = 32;

/**
 * Trims and de-duplicates labels case-insensitively, reusing the spelling a project already uses ("bug" becomes
 * "Bug" when the project has "Bug"), so people and agents do not create near-duplicates.
 */
export function cleanLabels(values: readonly string[], known: readonly string[] = []) {
  const canonical = new Map(known.map(label => [label.toLowerCase(), label]));
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const raw of values) {
    const label = raw.trim().replace(/\s+/g, " ");
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(canonical.get(key) ?? label);
  }
  if (labels.length > MAX_LABELS || labels.some(label => label.length > MAX_LABEL_LENGTH)) throw new ConvexError(`Use up to ${MAX_LABELS} labels of ${MAX_LABEL_LENGTH} characters each`);
  return labels;
}

/** Labels in use in a project, most used first. */
export async function projectLabels(ctx: QueryCtx, projectId: Id<"projects">, limit = 100) {
  const counts = new Map<string, number>();
  for (const task of await ctx.db.query("tasks").withIndex("by_project", q => q.eq("projectId", projectId)).take(3000)) {
    for (const label of task.labels ?? []) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([label]) => label);
}

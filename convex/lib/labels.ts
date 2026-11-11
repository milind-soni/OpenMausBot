import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

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

/** Linear's starter labels; every workspace has them unless someone archived or renamed them. */
export const DEFAULT_LABELS = [
  { name: "Feature", color: "#bb87fc" },
  { name: "Bug", color: "#eb5757" },
  { name: "Improvement", color: "#4ea7fc" },
] as const;

export const LABEL_COLORS = ["#95a2b3", "#bb87fc", "#eb5757", "#4ea7fc", "#4cb782", "#f2c94c", "#f2994a", "#e879a6", "#26b5ce", "#8d8df0"] as const;
export const MAX_WORKSPACE_LABELS = 250;
export const MAX_LABEL_DESCRIPTION = 200;

export const labelKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** A single cleaned label name, or an error for an empty or long one. */
export function cleanLabelName(value: string) {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_LABEL_LENGTH) throw new ConvexError(`Label names are 1 to ${MAX_LABEL_LENGTH} characters`);
  return name;
}

export function cleanLabelColor(value: string) {
  const color = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new ConvexError("Choose a label color");
  return color;
}

/** The color a label gets when it is first used by name: the default label's own, else a stable pick from the palette. */
export function colorForLabel(name: string) {
  const key = labelKey(name);
  const preset = DEFAULT_LABELS.find(label => label.name.toLowerCase() === key);
  if (preset) return preset.color;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return LABEL_COLORS[1 + (hash % (LABEL_COLORS.length - 1))]!;
}

/** Default labels a registry does not have yet (matched case-insensitively, archived ones count as present). */
export function missingDefaultLabels(existingNames: readonly string[]) {
  const keys = new Set(existingNames.map(labelKey));
  return DEFAULT_LABELS.filter(label => !keys.has(labelKey(label.name)));
}

export async function workspaceLabelRows(ctx: QueryCtx, teamId: Id<"teams">) {
  return ctx.db.query("issueLabels").withIndex("by_teamId_and_key", q => q.eq("teamId", teamId)).take(MAX_WORKSPACE_LABELS + 50);
}

/** Inserts the default labels a workspace lacks. Safe to run any number of times. */
export async function ensureDefaultLabels(ctx: MutationCtx, teamId: Id<"teams">) {
  const missing = missingDefaultLabels((await workspaceLabelRows(ctx, teamId)).map(row => row.name));
  const now = Date.now();
  for (const label of missing) await ctx.db.insert("issueLabels", { teamId, name: label.name, key: labelKey(label.name), color: label.color, archived: false, createdAt: now, updatedAt: now });
  return missing.length;
}

/**
 * Adds names applied to an issue that the registry does not know yet, so labels typed into an issue show up in the
 * picker and settings with a color. An archived label applied again is restored.
 */
export async function registerLabels(ctx: MutationCtx, teamId: Id<"teams">, names: readonly string[]) {
  if (!names.length) return;
  const rows = new Map((await workspaceLabelRows(ctx, teamId)).map(row => [row.key, row]));
  const now = Date.now();
  for (const name of names) {
    const key = labelKey(name);
    const row = rows.get(key);
    if (row) { if (row.archived) await ctx.db.patch(row._id, { archived: false, updatedAt: now }); continue; }
    if (rows.size >= MAX_WORKSPACE_LABELS) return;
    const id = await ctx.db.insert("issueLabels", { teamId, name, key, color: colorForLabel(name), archived: false, createdAt: now, updatedAt: now });
    rows.set(key, { _id: id, _creationTime: now, teamId, name, key, color: colorForLabel(name), archived: false, createdAt: now, updatedAt: now });
  }
}

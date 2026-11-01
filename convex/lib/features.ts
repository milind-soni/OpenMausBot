import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { canEdit, requireTeamMember } from "./permissions";

export async function requireWorkspaceEditor(ctx: QueryCtx | MutationCtx, teamId: Id<"teams">, sessionToken: string) {
  const result = await requireTeamMember(ctx, teamId, sessionToken);
  if (!canEdit(result.member)) throw new ConvexError("You have view-only access");
  return result;
}

export function cleanText(value: string, maximum: number, label: string) {
  const text = value.trim();
  if (!text || text.length > maximum) throw new ConvexError(`${label} must be between 1 and ${maximum} characters`);
  return text;
}

export function validDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ConvexError("Choose a valid date");
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new ConvexError("Choose a valid date");
  return value;
}

export async function workspaceProject(ctx: QueryCtx | MutationCtx, teamId: Id<"teams">, projectId: Id<"projects">) {
  const project = await ctx.db.get(projectId);
  if (!project || project.teamId !== teamId) throw new ConvexError("Project not found");
  return project;
}

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { canEdit, projectMember, requireTeamMember } from "./permissions";

export function compareProjectOrder(a: Pick<Doc<"projects">, "_id" | "order" | "createdAt">, b: Pick<Doc<"projects">, "_id" | "order" | "createdAt">): number {
  return (a.order ?? a.createdAt) - (b.order ?? b.createdAt) || a.createdAt - b.createdAt || a._id.localeCompare(b._id);
}

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);
const validIds = (ids: readonly string[]) => ids.length <= 500 && new Set(ids).size === ids.length;

export async function reorderWorkspaceProjects(ctx: MutationCtx, args: {
  sessionToken: string;
  teamId: Id<"teams">;
  projectIds: Id<"projects">[];
  expectedProjectIds?: Id<"projects">[];
}): Promise<null> {
  const { member, user } = await requireTeamMember(ctx, args.teamId, args.sessionToken);
  if (!canEdit(member)) throw new ConvexError("You have view-only access");
  if (!validIds(args.projectIds) || (args.expectedProjectIds && !validIds(args.expectedProjectIds))) throw new ConvexError("Invalid project order");
  const rows = await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", args.teamId)).take(501);
  if (rows.length > 500) throw new ConvexError("This workspace exceeds the supported project ordering limit");
  rows.sort(compareProjectOrder);
  const visible = [];
  for (const row of rows) if (await projectMember(ctx, row, user)) visible.push(row._id);
  const allowed = new Set(visible);
  if (args.projectIds.some(id => !allowed.has(id))) throw new ConvexError("Project does not belong to this workspace");
  if (args.expectedProjectIds && (!sameOrder(args.expectedProjectIds, visible) || args.projectIds.length !== visible.length)) {
    throw new ConvexError("Project order changed. Refresh the list and try again.");
  }
  const selected = new Set(args.projectIds);
  const current = rows.filter(row => selected.has(row._id)).map(row => row._id);
  if (sameOrder(current, args.projectIds)) return null;
  let next = 0;
  const order = rows.map(row => selected.has(row._id) ? args.projectIds[next++] : row._id);
  const byId = new Map(rows.map(row => [row._id, row]));
  for (const [rank, id] of order.entries()) if (byId.get(id)!.order !== rank) await ctx.db.patch(id, { order: rank });
  return null;
}

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeEmail, requireUser } from "./auth";

type Ctx = QueryCtx | MutationCtx;
type RoleCarrier = { role: "owner" | "admin" | "member" | "viewer" };

export { normalizeEmail };

export async function getActiveMember(ctx: Ctx, projectId: Id<"projects">, email: string) {
  const member = await ctx.db
    .query("members")
    .withIndex("by_project_email", (q) =>
      q.eq("projectId", projectId).eq("email", normalizeEmail(email)),
    )
    .unique();
  return member?.status === "active" ? member : null;
}

export async function getActiveTeamMember(ctx: Ctx, teamId: Id<"teams">, email: string) {
  const member = await ctx.db
    .query("teamMembers")
    .withIndex("by_team_email", (q) => q.eq("teamId", teamId).eq("email", normalizeEmail(email)))
    .unique();
  if (member?.status !== "active") return null;
  return (await ctx.db.get(teamId))?.deletingAt === undefined ? member : null;
}

export async function requireTeamMember(ctx: Ctx, teamId: Id<"teams">, sessionToken: string) {
  const user = await requireUser(ctx, sessionToken);
  const member = await getActiveTeamMember(ctx, teamId, user.email);
  if (!member || (member.userId && member.userId !== user._id)) throw new ConvexError("You don't have access to this workspace");
  return { member, user };
}

export async function requireTeamAdmin(ctx: Ctx, teamId: Id<"teams">, sessionToken: string) {
  const { member, user } = await requireTeamMember(ctx, teamId, sessionToken);
  if (member.role !== "owner" && member.role !== "admin") throw new ConvexError("Only admins can do this");
  return { member, user };
}

export async function requireMember(ctx: Ctx, projectId: Id<"projects">, sessionToken: string) {
  const user = await requireUser(ctx, sessionToken);
  const project = await ctx.db.get(projectId);
  if (!project) throw new ConvexError("Project not found");
  const member = await projectMember(ctx, project, user);
  if (member) return { member, user, project };
  throw new ConvexError("You don't have access to this project");
}

// Workspace admins see every project; everyone else needs explicit membership.
// A project role can never bypass a read-only workspace role.
export async function projectMember(ctx: Ctx, project: Doc<"projects">, user: Pick<Doc<"users">, "_id" | "email">) {
  const team = project.teamId ? await getActiveTeamMember(ctx, project.teamId, user.email) : null;
  if (project.teamId && (!team || (team.userId && team.userId !== user._id))) return null;
  if (team && ["owner", "admin"].includes(team.role)) return team;
  const member = await getActiveMember(ctx, project._id, user.email);
  if (!member || (member.userId && member.userId !== user._id)) return null;
  return team?.role === "viewer" ? { ...member, role: "viewer" as const } : member;
}

export async function visibleProjectRows<T extends { projectId: Id<"projects"> }>(ctx: Ctx, rows: T[], user: Pick<Doc<"users">, "_id" | "email">, activeOnly = false) {
  const allowed = new Set<Id<"projects">>();
  for (const id of new Set(rows.map(row => row.projectId))) {
    const project = await ctx.db.get(id);
    if (project && (!activeOnly || project.status === "active") && await projectMember(ctx, project, user)) allowed.add(id);
  }
  return rows.filter(row => allowed.has(row.projectId));
}

export async function projectPeople(ctx: Ctx, project: Doc<"projects">) {
  const rows = project.teamId
    ? await ctx.db.query("teamMembers").withIndex("by_team", q => q.eq("teamId", project.teamId!)).take(500)
    : await ctx.db.query("members").withIndex("by_project", q => q.eq("projectId", project._id)).take(500);
  const people = [];
  for (const row of rows) {
    const user = row.userId ? await ctx.db.get(row.userId) : null;
    if (row.status !== "active" || user?.status !== "active") continue;
    const access = await projectMember(ctx, project, user);
    if (!access) continue;
    people.push({ _id: row._id, userId: user._id, email: user.email, role: access.role, status: "active" as const, name: user.name, username: user.username, avatarUrl: user.avatarStorageId ? await ctx.storage.getUrl(user.avatarStorageId) : null });
  }
  return people;
}

export async function requireAdmin(ctx: Ctx, projectId: Id<"projects">, sessionToken: string) {
  const { member, user, project } = await requireMember(ctx, projectId, sessionToken);
  if (member.role !== "owner" && member.role !== "admin") {
    throw new ConvexError("Only admins can do this");
  }
  return { member, user, project };
}

export async function touchProject(ctx: MutationCtx, projectId: Id<"projects">) {
  await ctx.db.patch(projectId, { updatedAt: Date.now() });
}

export async function changeOpenIssueCount(ctx: MutationCtx, projectId: Id<"projects">, delta: number) {
  const project = await ctx.db.get(projectId);
  if (!project) return;
  let count = project.openIssueCount;
  if (count === undefined) {
    count = 0;
    for await (const task of ctx.db.query("tasks").withIndex("by_project_and_done", q => q.eq("projectId", projectId).eq("done", false))) { if (task) count += 1; }
  } else count = Math.max(0, count + delta);
  await ctx.db.patch(projectId, { openIssueCount: count });
}

export function canEdit(member: RoleCarrier | Doc<"members"> | Doc<"teamMembers">) {
  return member.role === "owner" || member.role === "admin" || member.role === "member";
}

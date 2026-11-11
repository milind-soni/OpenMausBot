import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { canEdit, projectMember, requireMember, requireTeamMember } from "./lib/permissions";
import { issueDelegated } from "./lib/issueEvents";
import { issueActivityKind } from "./issueActivityTables";

// Delegation and the issue Activity log, after Linear's assign/delegate model: the assignee stays the human who owns
// the issue; an agent can be delegated to work it. An agent is a connector grant (a personal access token or an OAuth
// connection) whose owner listed it as taking delegated issues; it acts over MCP with its owner's access. Delegating
// records who did it, sends issue.delegated to the workspace's issue webhook, and starts nothing by itself: the agent
// decides what to do when it hears about it, and Origin's standing rule is to refine first and build only once the
// owner confirms (lib/mcp-tools.ts MCP_INSTRUCTIONS).

type Ctx = QueryCtx | MutationCtx;
export type ActivityKind = Doc<"issueActivity">["kind"];
export type Actor = { user: Doc<"users">; agent?: Doc<"connectorGrants"> };

const MAX_BODY = 2000;
const live = (grant: Doc<"connectorGrants">, now = Date.now()) => !grant.revoked && grant.expiresAt > now && !grant.hostId && !grant.runId;

/** Appends one entry to an issue's Activity. */
export async function recordActivity(ctx: MutationCtx, task: Doc<"tasks">, actor: Actor, kind: ActivityKind, detail: { from?: string; to?: string; body?: string } = {}) {
  const project = await ctx.db.get(task.projectId);
  const teamId = task.teamId ?? project?.teamId;
  if (!teamId) return;
  const body = detail.body?.trim().slice(0, MAX_BODY);
  await ctx.db.insert("issueActivity", {
    teamId, projectId: task.projectId, taskId: task._id, kind, actorUserId: actor.user._id, actorName: actor.user.name || actor.user.email,
    ...(actor.agent ? { agentGrantId: actor.agent._id, agentName: actor.agent.name } : {}),
    ...(detail.from ? { from: detail.from.slice(0, 200) } : {}), ...(detail.to ? { to: detail.to.slice(0, 200) } : {}), ...(body ? { body } : {}),
    createdAt: Date.now(),
  });
}

/** Agents that can be delegated issues in this project: listed by their owner, live, read & write, owner can edit the project. */
export async function projectAgents(ctx: Ctx, project: Doc<"projects">) {
  if (!project.teamId) return [];
  const now = Date.now();
  const grants = (await ctx.db.query("connectorGrants").withIndex("by_teamId", q => q.eq("teamId", project.teamId!)).take(1000)).filter(g => g.delegatable && g.write && live(g, now));
  const owners = new Map<Id<"users">, { user: Doc<"users">; allowed: boolean }>();
  const agents = [];
  for (const grant of grants) {
    if (!owners.has(grant.userId)) {
      const user = await ctx.db.get(grant.userId);
      const member = user?.status === "active" ? await projectMember(ctx, project, user) : null;
      owners.set(grant.userId, { user: user!, allowed: Boolean(member && canEdit(member)) });
    }
    const owner = owners.get(grant.userId)!;
    if (owner.allowed) agents.push({ grant, owner: owner.user });
  }
  return agents.sort((a, b) => a.grant.name.localeCompare(b.grant.name));
}

/**
 * Delegates the issue to an agent, or removes the agent with null. Records it in Activity and sends issue.delegated.
 * Unchanged delegation is a no-op.
 */
export async function setDelegate(ctx: MutationCtx, task: Doc<"tasks">, grantId: Id<"connectorGrants"> | null, actor: Actor) {
  if ((task.delegateGrantId ?? null) === grantId) return;
  const project = await ctx.db.get(task.projectId);
  if (!project) throw new ConvexError("Project not found");
  let agent: Doc<"connectorGrants"> | null = null;
  if (grantId) {
    agent = (await projectAgents(ctx, project)).find(a => a.grant._id === grantId)?.grant ?? null;
    if (!agent) throw new ConvexError("That agent can't take issues in this project. Its owner lists it under Settings > Agents and needs edit access here.");
  }
  await ctx.db.patch(task._id, { delegateGrantId: agent?._id, delegateName: agent?.name, updatedAt: Date.now() });
  await recordActivity(ctx, task, actor, agent ? "delegated" : "undelegated", { from: task.delegateName, to: agent?.name });
  await issueDelegated(ctx, task);
}

/** Clears delegation from every issue delegated to a grant that stopped being an agent. Bounded; returns how many. */
export async function releaseAgentIssues(ctx: MutationCtx, grant: Doc<"connectorGrants">, user: Doc<"users">) {
  const projects = await ctx.db.query("projects").withIndex("by_team", q => q.eq("teamId", grant.teamId)).take(500);
  let released = 0;
  for (const project of projects) {
    for (const task of await ctx.db.query("tasks").withIndex("by_project_and_done", q => q.eq("projectId", project._id).eq("done", false)).take(2000)) {
      if (task.delegateGrantId !== grant._id) continue;
      await ctx.db.patch(task._id, { delegateGrantId: undefined, delegateName: undefined });
      await recordActivity(ctx, task, { user }, "undelegated", { from: task.delegateName, body: "The agent was removed from Settings > Agents." });
      await issueDelegated(ctx, task);
      if (++released >= 200) return released;
    }
  }
  return released;
}

const activityEntry = v.object({
  id: v.id("issueActivity"), kind: issueActivityKind, actorName: v.string(), agentName: v.union(v.string(), v.null()),
  from: v.union(v.string(), v.null()), to: v.union(v.string(), v.null()), body: v.union(v.string(), v.null()), createdAt: v.number(),
});

export function activityRows(rows: Doc<"issueActivity">[]) {
  return rows.map(row => ({ id: row._id, kind: row.kind, actorName: row.actorName, agentName: row.agentName ?? null, from: row.from ?? null, to: row.to ?? null, body: row.body ?? null, createdAt: row.createdAt }));
}

async function requireTask(ctx: Ctx, projectId: Id<"projects">, taskId: Id<"tasks">, sessionToken: string) {
  const access = await requireMember(ctx, projectId, sessionToken);
  const task = await ctx.db.get(taskId);
  if (!task || task.projectId !== projectId) throw new ConvexError("Issue not found");
  return { ...access, task };
}

/** The issue's Activity, oldest first (the latest 100). */
export const list = query({
  args: { sessionToken: v.string(), projectId: v.id("projects"), taskId: v.id("tasks") },
  returns: v.array(activityEntry),
  handler: async (ctx, a) => {
    await requireTask(ctx, a.projectId, a.taskId, a.sessionToken);
    const rows = await ctx.db.query("issueActivity").withIndex("by_taskId_and_createdAt", q => q.eq("taskId", a.taskId)).order("desc").take(100);
    return activityRows(rows.reverse());
  },
});

/** Agents the delegate picker offers in a project. */
export const agents = query({
  args: { sessionToken: v.string(), projectId: v.id("projects") },
  returns: v.array(v.object({ id: v.id("connectorGrants"), name: v.string(), owner: v.string() })),
  handler: async (ctx, a) => {
    const { project } = await requireMember(ctx, a.projectId, a.sessionToken);
    return (await projectAgents(ctx, project)).map(({ grant, owner }) => ({ id: grant._id, name: grant.name, owner: owner.name || owner.email }));
  },
});

export const delegate = mutation({
  args: { sessionToken: v.string(), projectId: v.id("projects"), taskId: v.id("tasks"), grantId: v.union(v.id("connectorGrants"), v.null()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const { member, user, task } = await requireTask(ctx, a.projectId, a.taskId, a.sessionToken);
    if (!canEdit(member)) throw new ConvexError("You have view-only access");
    await setDelegate(ctx, task, a.grantId, { user });
    return null;
  },
});

/**
 * Lists or unlists one of your own connections as an agent. Only read & write connections qualify. Unlisting takes the
 * agent off the open issues it was delegated (each records it and sends issue.delegated).
 */
export const setDelegatable = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), grantId: v.id("connectorGrants"), delegatable: v.boolean() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const { user } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
    const grant = await ctx.db.get(a.grantId);
    if (!grant || grant.teamId !== a.teamId || grant.userId !== user._id || !live(grant)) throw new ConvexError("Connection not found");
    if (a.delegatable && !grant.write) throw new ConvexError("Only a read & write connection can take issues");
    if (Boolean(grant.delegatable) === a.delegatable) return null;
    await ctx.db.patch(grant._id, { delegatable: a.delegatable });
    if (!a.delegatable) await releaseAgentIssues(ctx, grant, user);
    return null;
  },
});

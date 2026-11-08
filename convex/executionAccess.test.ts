/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";
import type { ExecutionPrincipal } from "../lib/execution-store";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const now = Date.UTC(2026, 10, 8, 12);
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const t = convexTest(schema, modules);
  const people = await t.run(async ctx => {
    const users = [];
    for (const name of ["owner", "member", "viewer", "outsider"]) {
      const email = `${name}@execution-access.test`;
      const id = await ctx.db.insert("users", { name, email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: now, updatedAt: now });
      users.push({ id, email, token: await createSession(ctx, id) });
    }
    return { owner: users[0]!, member: users[1]!, viewer: users[2]!, outsider: users[3]! };
  });
  const sessionToken = people.owner.token;
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken, name: "Execution workspace" });
  for (const [person, role] of [[people.member, "member"], [people.viewer, "viewer"]] as const) {
    await t.run(ctx => ctx.db.insert("teamMembers", { teamId, userId: person.id, email: person.email, name: role, role, status: "active", createdAt: now, updatedAt: now }));
  }
  const sharedId = await t.mutation(api.projects.create, { sessionToken, teamId, name: "Shared execution", repoUrl: "https://github.com/fixture/shared" });
  const privateId = await t.mutation(api.projects.create, { sessionToken, teamId, name: "Private execution", repoUrl: "https://github.com/fixture/private" });
  for (const person of [people.member, people.viewer]) await t.mutation(api.members.addWorkspaceMember, { sessionToken, projectId: sharedId, email: person.email, role: "member" });
  const { teamId: otherTeamId } = await t.mutation(api.workspaces.create, { sessionToken: people.outsider.token, name: "Other workspace" });
  const foreignId = await t.mutation(api.projects.create, { sessionToken: people.outsider.token, teamId: otherTeamId, name: "Foreign project" });
  async function task(projectId: typeof sharedId) {
    const columnId = (await t.query(api.tasks.board, { sessionToken, projectId })).columns.find(column => !column.isDraft)!._id;
    return t.mutation(api.tasks.createTask, { sessionToken, projectId, columnId, title: "Authorized issue", priority: "low", assignedToEmail: people.owner.email, dueDate: "2026-12-31" });
  }
  const sharedTask = await task(sharedId), privateTask = await task(privateId);
  async function browser(person = people.member, projectId: typeof sharedId | undefined = sharedId, taskId: typeof sharedTask | undefined = sharedTask): Promise<ExecutionPrincipal> {
    return JSON.parse(await t.query(api.executionAccess.browserContext, { sessionToken: person.token, teamId, ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}) }));
  }
  async function grant(person = people.member, write = true) {
    return t.mutation(api.connectors.createGrant, { sessionToken: person.token, teamId, name: "Execution connector", write });
  }
  return { t, ...people, teamId, otherTeamId, sharedId, privateId, foreignId, sharedTask, privateTask, browser, grant };
}

test("execution context exposes only memberships, never private projects or identity secrets", async () => {
  const f = await fixture();
  const member = await f.browser();
  expect(member).toMatchObject({ userId: f.member.id, teamId: f.teamId, admin: false, projectAdmin: false, write: true, projectIds: [f.sharedId], project: { id: f.sharedId }, task: { id: f.sharedTask } });
  const owner = await f.browser(f.owner);
  expect(new Set(owner.projectIds)).toEqual(new Set([f.sharedId, f.privateId]));
  expect(owner).toMatchObject({ admin: true, projectAdmin: true, write: true });
  const encoded = JSON.stringify(member);
  for (const secret of [f.member.token, "passwordHash", "salt", "tokenHash", f.privateId, f.foreignId]) expect(encoded).not.toContain(secret);
});

test("workspace viewers remain read-only even if their project role is upgraded", async () => {
  const f = await fixture();
  await f.t.run(async ctx => {
    const membership = await ctx.db.query("members").withIndex("by_project_email", q => q.eq("projectId", f.sharedId).eq("email", f.viewer.email)).unique();
    await ctx.db.patch(membership!._id, { role: "admin" });
  });
  expect(await f.browser(f.viewer)).toMatchObject({ admin: false, projectAdmin: false, write: false });
  const grant = await f.grant(f.viewer, false);
  expect(JSON.parse(await f.t.query(api.executionAccess.mcpContext, { token: grant.token, projectId: f.sharedId }))).toMatchObject({ admin: false, projectAdmin: false, write: false });
  await expect(f.t.query(api.executionAccess.mcpContext, { token: grant.token, projectId: f.sharedId, write: true })).rejects.toThrow();
});

test("project/issue ID substitution never borrows authorization from a visible project", async () => {
  const f = await fixture();
  await expect(f.browser(f.member, f.sharedId, f.privateTask)).rejects.toThrow(/Issue not found/i);
  await expect(f.browser(f.member, f.privateId, f.privateTask)).rejects.toThrow(/Project not found/i);
  await expect(f.t.query(api.executionAccess.browserContext, { sessionToken: f.owner.token, teamId: f.teamId, projectId: f.foreignId })).rejects.toThrow(/Project not found/i);
  await expect(f.t.query(api.executionAccess.browserContext, { sessionToken: f.member.token, teamId: f.teamId, taskId: f.sharedTask })).rejects.toThrow(/Project required/i);
  await expect(f.browser(f.outsider)).rejects.toThrow();
  const grant = await f.grant();
  await expect(f.t.query(api.executionAccess.mcpContext, { token: grant.token, projectId: f.sharedId, taskId: f.privateTask, write: true })).rejects.toThrow(/Issue not found/i);
  await expect(f.t.query(api.executionAccess.mcpContext, { token: grant.token, projectId: f.privateId, write: true })).rejects.toThrow();
});

test("a read-only owner connector cannot inherit browser administrator spending authority", async () => {
  const f = await fixture(), grant = await f.grant(f.owner, false);
  const context: ExecutionPrincipal = JSON.parse(await f.t.query(api.executionAccess.mcpContext, { token: grant.token, projectId: f.sharedId, taskId: f.sharedTask }));
  expect(context).toMatchObject({ userId: f.owner.id, grantId: grant.grantId, write: false, admin: false, projectAdmin: false });
  await expect(f.t.query(internal.executionAccess.runContext, { userId: f.owner.id, teamId: f.teamId, projectId: f.sharedId, taskId: f.sharedTask, grantId: grant.grantId })).rejects.toThrow(/authorization revoked/i);
});

test.each(["revoked", "expired", "read-only"])("%s grants cannot authorize stored runs or new connector actions", async state => {
  const f = await fixture(), grant = await f.grant();
  const request = { userId: f.member.id, teamId: f.teamId, projectId: f.sharedId, taskId: f.sharedTask, grantId: grant.grantId };
  expect(JSON.parse(await f.t.query(internal.executionAccess.runContext, request)).write).toBe(true);
  if (state === "revoked") await f.t.mutation(api.connectors.revoke, { sessionToken: f.member.token, teamId: f.teamId, grantId: grant.grantId });
  if (state === "expired") await f.t.run(ctx => ctx.db.patch(grant.grantId, { expiresAt: now }));
  if (state === "read-only") await f.t.run(ctx => ctx.db.patch(grant.grantId, { write: false }));
  await expect(f.t.query(internal.executionAccess.runContext, request)).rejects.toThrow(/authorization revoked/i);
  await expect(f.t.query(api.executionAccess.mcpContext, { token: grant.token, projectId: f.sharedId, taskId: f.sharedTask, write: true })).rejects.toThrow();
});

test("stored run grants are bound to both the original user and workspace", async () => {
  const f = await fixture(), grant = await f.grant();
  await expect(f.t.query(internal.executionAccess.runContext, { userId: f.owner.id, teamId: f.teamId, projectId: f.sharedId, grantId: grant.grantId })).rejects.toThrow(/authorization revoked/i);
  await expect(f.t.query(internal.executionAccess.runContext, { userId: f.member.id, teamId: f.otherTeamId, projectId: f.foreignId, grantId: grant.grantId })).rejects.toThrow(/authorization revoked/i);
  await expect(f.t.mutation(api.connectors.revoke, { sessionToken: f.owner.token, teamId: f.teamId, grantId: grant.grantId })).rejects.toThrow();
  expect(JSON.parse(await f.t.query(internal.executionAccess.runContext, { userId: f.member.id, teamId: f.teamId, projectId: f.sharedId, grantId: grant.grantId })).write).toBe(true);
});

test.each(["project", "workspace", "account"])("revoking %s access invalidates both browser and stored automation authorization", async scope => {
  const f = await fixture(), grant = await f.grant();
  await f.t.run(async ctx => {
    if (scope === "project") {
      const member = await ctx.db.query("members").withIndex("by_project_email", q => q.eq("projectId", f.sharedId).eq("email", f.member.email)).unique();
      await ctx.db.delete(member!._id);
    } else if (scope === "workspace") {
      const member = await ctx.db.query("teamMembers").withIndex("by_team_email", q => q.eq("teamId", f.teamId).eq("email", f.member.email)).unique();
      await ctx.db.delete(member!._id);
    } else {
      await ctx.db.delete(f.member.id);
    }
  });
  await expect(f.browser()).rejects.toThrow();
  await expect(f.t.query(api.executionAccess.mcpContext, { token: grant.token, projectId: f.sharedId, taskId: f.sharedTask, write: true })).rejects.toThrow();
  await expect(f.t.query(internal.executionAccess.runContext, { userId: f.member.id, teamId: f.teamId, projectId: f.sharedId, taskId: f.sharedTask, grantId: grant.grantId })).rejects.toThrow();
});

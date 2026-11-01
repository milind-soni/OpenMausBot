/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";
import type { Id, TableNames } from "./_generated/dataModel";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const CHAT_MESSAGES = 700;

afterEach(() => { vi.useRealTimers(); });

async function seedWorkspace(t: ReturnType<typeof convexTest>, sessionToken: string, ownerId: Id<"users">, name: string) {
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken, name });
  const projectIds: Id<"projects">[] = [];
  for (const projectName of [`${name} app`, `${name} site`]) {
    const projectId = await t.mutation(api.projects.create, { sessionToken, teamId, name: projectName });
    const scope = { sessionToken, projectId };
    const columnId = (await t.query(api.tasks.board, scope)).columns[1]!._id;
    const taskId = await t.mutation(api.tasks.createTask, { ...scope, columnId, title: "Ship it", priority: "high", assignedToEmail: "owner@delete.test", dueDate: "2026-12-31" });
    const otherTaskId = await t.mutation(api.tasks.createTask, { ...scope, columnId, title: "Then this", priority: "low", assignedToEmail: "owner@delete.test", dueDate: "2026-12-31" });
    await t.mutation(api.tasks.addComment, { ...scope, taskId, body: "On it" });
    await t.mutation(api.credentials.create, { ...scope, title: "Vault entry", ciphertext: "c", iv: "i", salt: "s", iterations: 600000, kdf: "PBKDF2" });
    await t.mutation(api.wiki.create, { ...scope, title: "Notes", content: "Body", type: "wiki", tags: [] });
    await t.mutation(api.design.createToken, { ...scope, type: "color", name: "Accent", value: "#123456" });
    await t.mutation(api.feedback.configure, { ...scope, teamId, title: "Feedback", description: "", enabled: true });
    const portal = (await t.query(api.feedback.portals, { sessionToken, teamId })).find(item => item.projectId === projectId)!;
    await t.mutation(internal.feedback.submit, { slug: portal.slug, title: "Bug", body: "Report", kind: "bug" });
    await t.run(async ctx => {
      const now = Date.now();
      const storageId = await ctx.storage.store(new Blob(["asset"]));
      await ctx.db.insert("designAssets", { projectId, type: "image", name: "Logo", storageId, createdAt: now, updatedAt: now });
      await ctx.db.insert("storageAdmissions", { storageId, scopeKey: `project:${projectId}`, scope: { kind: "project", projectId }, createdAt: now });
      await ctx.db.insert("taskRelations", { teamId, fromTaskId: taskId, toTaskId: otherTaskId, kind: "blocks" });
      await ctx.db.insert("chatMessages", { projectId, authorUserId: ownerId, authorName: "Owner", authorEmail: "owner@delete.test", body: "Hi", createdAt: now });
      await ctx.db.insert("broadcastPosts", { projectId, variants: [], assetIds: [], status: "draft", authorUserId: ownerId, createdAt: now, updatedAt: now });
      await ctx.db.insert("pulseDays", { projectId, day: "2026-10-25", pageViews: 3 });
      const canvasId = await ctx.db.insert("canvases", { teamId, projectId, name: "Board", archived: false, createdAt: now, updatedAt: now });
      await ctx.db.insert("canvasComments", { teamId, canvasId, x: 0, y: 0, authorId: ownerId, authorName: "Owner", body: "Here", mentions: [], resolved: false, createdAt: now });
      const versionId = await ctx.db.insert("canvasVersions", { teamId, canvasId, name: "v1", nodeCount: 1, authorName: "Owner", createdAt: now });
      await ctx.db.insert("canvasVersionChunks", { versionId, order: 0, rows: ["{}"] });
      await ctx.db.insert("designLinks", { projectId, taskId, canvasId, frameId: "f", frameName: "Frame", status: "draft", createdAt: now, updatedAt: now });
      await ctx.db.insert("publishedPages", { teamId, projectId, canvasId, frameId: "f", site: `${teamId}`, slug: "home", title: "Home", description: "", body: "", background: "", fonts: [], leadForms: 0, views: 0, publishedBy: "Owner", publishedAt: now, updatedAt: now });
    });
    projectIds.push(projectId);
  }
  // Desktop-era agent rows still exist in production and must go with their workspace.
  const { agentId, threadId } = await t.run(async ctx => {
    const now = Date.now();
    const agentId = await ctx.db.insert("workspaceAgents", {
      teamId, projectId: projectIds[0]!, createdBy: ownerId, name: `${name} chief`, avatarSeed: "chief", avatarColor: "#888888", instructions: "", engine: "", model: "", effort: "",
      skills: [], approvalMode: "ask", destructiveMode: "ask", disabled: false, createdAt: now, updatedAt: now, kind: "chief", roleKey: "chief", title: "", description: "", soul: "", soulVersion: 1, color: "#888888", updatedBy: ownerId,
    });
    const threadId = await ctx.db.insert("agentThreads", { teamId, projectId: projectIds[0]!, agentId, title: "Plan", createdBy: ownerId, seq: 0, createdAt: now, updatedAt: now });
    return { agentId, threadId };
  });
  await t.run(async ctx => {
    const now = Date.now();
    for (let index = 0; index < CHAT_MESSAGES; index++) {
      await ctx.db.insert("teamChatMessages", { teamId, conversation: "workspace", messageId: `m${index}`, created: now + index, payload: "{}" });
    }
    await ctx.db.insert("agentThreadReads", { threadId, userId: ownerId, seq: 1, updatedAt: now });
    await ctx.db.insert("notifications", { teamId, userId: ownerId, actorId: ownerId, kind: "comment", eventId: `e-${teamId}`, read: false, createdAt: now });
    await ctx.db.insert("connectorGrants", { teamId, userId: ownerId, tokenHash: `hash-${teamId}`, name: "Laptop", write: true, expiresAt: now + 60_000, createdAt: now, revoked: false });
  });
  return { teamId, projectIds, agentId, threadId };
}

async function fixture() {
  const t = convexTest(schema, modules);
  const people = await t.run(async ctx => {
    const users = [];
    for (const name of ["owner", "admin", "member", "outsider"]) {
      const id = await ctx.db.insert("users", { name, email: `${name}@delete.test`, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
      users.push({ id, email: `${name}@delete.test`, token: await createSession(ctx, id) });
    }
    return { owner: users[0]!, admin: users[1]!, member: users[2]!, outsider: users[3]! };
  });
  const doomed = await seedWorkspace(t, people.owner.token, people.owner.id, "Doomed");
  const kept = await seedWorkspace(t, people.owner.token, people.owner.id, "Kept");
  for (const { teamId } of [doomed, kept]) {
    for (const [person, role] of [[people.admin, "admin"], [people.member, "member"]] as const) {
      await t.run(ctx => ctx.db.insert("teamMembers", { teamId, userId: person.id, email: person.email, name: role, role, status: "active", createdAt: 1, updatedAt: 1 }));
    }
  }
  return { t, ...people, doomed, kept };
}

/** Every row anywhere in the database whose fields name one of `ids`. */
async function rowsNaming(t: ReturnType<typeof convexTest>, ids: readonly string[]) {
  return t.run(async ctx => {
    const found: string[] = [];
    for (const table of Object.keys(schema.tables) as TableNames[]) {
      for (const row of await ctx.db.query(table).collect()) {
        const fields = JSON.stringify({ ...row, _id: undefined });
        if (ids.some(id => row._id === id || fields.includes(`"${id}"`))) found.push(`${table}:${row._id}`);
      }
    }
    return found;
  });
}

async function runScheduled(t: ReturnType<typeof convexTest>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("deleting a workspace", () => {
  test("only an owner or admin who repeats the name can delete it", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const teamId = f.doomed.teamId;
    await expect(f.t.mutation(api.workspaces.remove, { sessionToken: f.member.token, teamId, confirmName: "Doomed" })).rejects.toThrow("Only admins can do this");
    await expect(f.t.mutation(api.workspaces.remove, { sessionToken: f.outsider.token, teamId, confirmName: "Doomed" })).rejects.toThrow("You don't have access to this workspace");
    await expect(f.t.mutation(api.workspaces.remove, { sessionToken: f.admin.token, teamId, confirmName: "doomed" })).rejects.toThrow("Type the workspace name");
    await expect(f.t.query(api.workspaces.deletionSummary, { sessionToken: f.member.token, teamId })).rejects.toThrow("Only admins can do this");
    expect(await f.t.query(api.workspaces.deletionSummary, { sessionToken: f.admin.token, teamId })).toEqual({
      name: "Doomed", projects: ["Doomed app", "Doomed site"], projectCount: 2, agentCount: 1, memberCount: 3, openIssueCount: 4, countsCapped: false,
    });
    await f.t.mutation(api.workspaces.remove, { sessionToken: f.admin.token, teamId, confirmName: " Doomed " });
    await runScheduled(f.t);
    expect(await f.t.run(ctx => ctx.db.get(teamId))).toBeNull();
  });

  test("everything in the workspace goes, for every member, and nothing in another workspace does", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const doomedIds = [f.doomed.teamId, ...f.doomed.projectIds, f.doomed.agentId, f.doomed.threadId];
    const keptBefore = await rowsNaming(f.t, [f.kept.teamId, ...f.kept.projectIds]);
    const files = await f.t.run(async ctx => (await ctx.db.system.query("_storage").collect()).length);
    expect((await rowsNaming(f.t, doomedIds)).length).toBeGreaterThan(CHAT_MESSAGES + 40);

    await f.t.mutation(api.workspaces.remove, { sessionToken: f.owner.token, teamId: f.doomed.teamId, confirmName: "Doomed" });
    for (const person of [f.owner, f.admin, f.member]) {
      expect((await f.t.query(api.workspaces.list, { sessionToken: person.token })).map(row => row.name)).toEqual(["Kept"]);
      await expect(f.t.query(api.projects.get, { sessionToken: person.token, projectId: f.doomed.projectIds[0]! })).rejects.toThrow();
    }

    await runScheduled(f.t);
    const left = await rowsNaming(f.t, doomedIds);
    expect(left.map(row => row.split(":")[0])).toEqual(["deletedWorkspaces", "deletedWorkspaces", "deletedWorkspaces"]);
    expect(await rowsNaming(f.t, [f.kept.teamId, ...f.kept.projectIds])).toEqual(keptBefore);
    expect(await f.t.run(async ctx => (await ctx.db.system.query("_storage").collect()).length)).toBe(files - 2);
    expect((await f.t.query(api.tasks.board, { sessionToken: f.member.token, projectId: f.kept.projectIds[0]! }).catch(() => null))).toBeNull();
    expect((await f.t.query(api.tasks.board, { sessionToken: f.owner.token, projectId: f.kept.projectIds[0]! })).columns.length).toBeGreaterThan(0);
    expect((await f.t.query(api.teams.listWithProjects, { sessionToken: f.owner.token })).map(row => row.name)).toEqual(["Kept"]);
  });

  test("a file another scope still uses survives", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const storageId = await f.t.run(async ctx => {
      const asset = (await ctx.db.query("designAssets").withIndex("by_project", q => q.eq("projectId", f.doomed.projectIds[0]!)).first())!;
      await ctx.db.patch(f.owner.id, { avatarStorageId: asset.storageId });
      await ctx.db.insert("storageAdmissions", { storageId: asset.storageId!, scopeKey: `user:${f.owner.id}`, scope: { kind: "user", userId: f.owner.id }, createdAt: 1 });
      return asset.storageId!;
    });
    await f.t.mutation(api.workspaces.remove, { sessionToken: f.owner.token, teamId: f.doomed.teamId, confirmName: "Doomed" });
    await runScheduled(f.t);
    expect(await f.t.run(ctx => ctx.db.system.get(storageId))).not.toBeNull();
    expect((await f.t.run(ctx => ctx.db.query("storageAdmissions").withIndex("by_storageId_and_scopeKey", q => q.eq("storageId", storageId)).collect())).map(row => row.scopeKey)).toEqual([`user:${f.owner.id}`]);
  });

  test("an interrupted deletion resumes, and running it again is harmless", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const teamId = f.doomed.teamId;
    await f.t.run(async ctx => {
      await ctx.db.patch(teamId, { deletingAt: Date.now() - 60 * 60_000 });
      for (const member of await ctx.db.query("teamMembers").withIndex("by_team", q => q.eq("teamId", teamId)).collect()) await ctx.db.delete(member._id);
    });
    await f.t.mutation(internal.workspaceDeletion.purge, { teamId });
    expect(await f.t.run(ctx => ctx.db.get(teamId))).not.toBeNull();
    await f.t.mutation(internal.workspaceDeletion.resume, {});
    await runScheduled(f.t);
    expect(await rowsNaming(f.t, [teamId, ...f.doomed.projectIds])).toEqual([]);
    await f.t.mutation(internal.workspaceDeletion.purge, { teamId });
    await f.t.mutation(internal.workspaceDeletion.resume, {});
    expect(await rowsNaming(f.t, [f.kept.teamId]).then(rows => rows.length)).toBeGreaterThan(CHAT_MESSAGES);
  });

  test("each member who was in it, and nobody else, learns it was deleted and by whom", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const deleted = (person: { token: string }) => f.t.query(api.workspaces.deleted, { sessionToken: person.token });
    const pending = await f.t.run(async ctx => {
      const id = await ctx.db.insert("users", { name: "pending", email: "pending@delete.test", role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
      await ctx.db.insert("teamMembers", { teamId: f.doomed.teamId, email: "pending@delete.test", name: "pending", role: "member", status: "invited", createdAt: 1, updatedAt: 1 });
      return { token: await createSession(ctx, id) };
    });
    const memberOfKept = await f.t.run(ctx => ctx.db.query("teamMembers").withIndex("by_team", q => q.eq("teamId", f.kept.teamId)).collect())
      .then(rows => rows.find(row => row.email === f.member.email)!._id);
    await f.t.mutation(api.teams.removeMember, { sessionToken: f.owner.token, teamId: f.kept.teamId, memberId: memberOfKept });
    expect(await deleted(f.member)).toEqual([]);

    await f.t.mutation(api.workspaces.remove, { sessionToken: f.admin.token, teamId: f.doomed.teamId, confirmName: "Doomed" });
    for (const person of [f.owner, f.admin, f.member]) {
      expect(await deleted(person)).toEqual([{ teamId: f.doomed.teamId, name: "Doomed", deletedBy: "admin", byYou: person === f.admin, deletedAt: Date.now() }]);
    }
    expect(await deleted(f.outsider)).toEqual([]);
    expect(await deleted(pending)).toEqual([]);
    await expect(f.t.query(api.workspaces.deleted, { sessionToken: "not-a-session" })).rejects.toThrow("Your session has expired. Sign in again.");

    await runScheduled(f.t);
    expect((await deleted(f.member)).map(row => row.name)).toEqual(["Doomed"]);
    vi.setSystemTime(Date.now() + 181 * 24 * 60 * 60_000);
    await f.t.mutation(internal.workspaceDeletion.expireNotices, {});
    expect(await f.t.run(ctx => ctx.db.query("deletedWorkspaces").collect())).toEqual([]);
  });

  test("members the first step could not reach are told when the purge removes their membership", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const teamId = f.doomed.teamId;
    await f.t.run(ctx => ctx.db.patch(teamId, { deletingAt: Date.now(), deletedBy: { userId: f.owner.id, name: "owner" } }));
    await f.t.mutation(internal.workspaceDeletion.purge, { teamId });
    await runScheduled(f.t);
    for (const person of [f.owner, f.admin, f.member]) {
      expect((await f.t.query(api.workspaces.deleted, { sessionToken: person.token })).map(row => [row.name, row.byYou])).toEqual([["Doomed", person === f.owner]]);
    }
  });

  test("an invitation to a workspace being deleted no longer works", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const invite = await f.t.mutation(api.workspaces.createInvite, { sessionToken: f.owner.token, teamId: f.doomed.teamId, role: "member" });
    await f.t.mutation(api.workspaces.remove, { sessionToken: f.owner.token, teamId: f.doomed.teamId, confirmName: "Doomed" });
    expect(await f.t.query(api.workspaces.invitePreview, { token: invite.token })).toBeNull();
    await expect(f.t.mutation(api.workspaces.acceptInvite, { sessionToken: f.outsider.token, token: invite.token })).rejects.toThrow("no longer exists");
    await runScheduled(f.t);
  });
});

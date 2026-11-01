/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession, hashPassword } from "./lib/auth";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const password = "invite-password";

async function fixture() {
  const t = convexTest(schema, modules);
  const people = await t.run(async ctx => {
    const now = Date.now();
    const salt = "1234567890abcdef";
    const passwordHash = await hashPassword(password, salt, 1);
    const users = [];
    for (const name of ["Owner", "Guest"]) {
      const email = `${name.toLowerCase()}@example.test`;
      const id = await ctx.db.insert("users", { name, email, role: "user", status: "active", passwordHash, salt, iterations: 1, createdAt: now, updatedAt: now });
      users.push({ id, email, token: await createSession(ctx, id) });
    }
    return { owner: users[0]!, guest: users[1]! };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: people.owner.token, name: "Invitations" });
  const projectId = await t.mutation(api.projects.create, { sessionToken: people.owner.token, teamId, name: "Invited project" });
  const otherProjectId = await t.mutation(api.projects.create, { sessionToken: people.owner.token, teamId, name: "Private project" });
  const invite = await t.mutation(api.members.invite, { sessionToken: people.owner.token, projectId, email: people.guest.email, role: "admin" });
  const accept = () => t.mutation(internal.auth.acceptInviteAccount, { inviteToken: invite.inviteToken, name: "Guest", password });
  return { t, ...people, teamId, projectId, otherProjectId, invite, accept };
}

describe("project email invitation acceptance", () => {
  test("a project invite adds only the workspace access needed to open its project", async () => {
    const f = await fixture();
    const accepted = await f.accept();
    expect(accepted.teamId).toBe(f.teamId);
    expect((await f.t.query(api.workspaces.access, { sessionToken: accepted.sessionToken, teamId: f.teamId })).role).toBe("member");
    expect((await f.t.query(api.projects.get, { sessionToken: accepted.sessionToken, projectId: f.projectId })).memberRole).toBe("admin");
    await expect(f.t.query(api.projects.get, { sessionToken: accepted.sessionToken, projectId: f.otherProjectId })).rejects.toThrow("access to this project");
    await expect(f.t.mutation(api.workspaces.update, { sessionToken: accepted.sessionToken, teamId: f.teamId, name: "Hijacked" })).rejects.toThrow("Only admins");
  });

  test("acceptance preserves an existing read-only workspace role", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.insert("teamMembers", { teamId: f.teamId, userId: f.guest.id, email: f.guest.email, name: "Guest", role: "viewer", status: "active", createdAt: 1, updatedAt: 1 }));
    const accepted = await f.accept();
    expect((await f.t.query(api.projects.get, { sessionToken: accepted.sessionToken, projectId: f.projectId })).memberRole).toBe("viewer");
  });

  test("a removed project cannot consume an invitation or create a session", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.delete(f.projectId));
    await expect(f.accept()).rejects.toThrow("Project");
    expect(await f.t.query(api.members.getInvite, { token: f.invite.inviteToken })).toBeNull();
    const invite = await f.t.run(ctx => ctx.db.query("members").withIndex("by_token", q => q.eq("inviteToken", f.invite.inviteToken)).unique());
    expect(invite?.status).toBe("invited");
  });
});

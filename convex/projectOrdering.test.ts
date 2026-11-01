/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { createSession } from "./lib/auth";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function fixture() {
  const t = convexTest(schema, modules);
  const data = await t.run(async ctx => {
    const now = Date.now();
    const people = await Promise.all(["owner", "member", "viewer"].map(async role => {
      const email = `${role}@project-order.test`;
      const id = await ctx.db.insert("users", { email, name: role, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: now, updatedAt: now });
      return { id, email, token: await createSession(ctx, id) };
    }));
    const [owner, member, viewer] = people;
    const teamId = await ctx.db.insert("teams", { name: "Order fixture", ownerUserId: owner.id, createdAt: now, updatedAt: now });
    for (const [person, role] of [[owner, "owner"], [member, "member"], [viewer, "viewer"]] as const) {
      await ctx.db.insert("teamMembers", { teamId, userId: person.id, email: person.email, name: role, role, status: "active", createdAt: now, updatedAt: now });
    }
    const ids = [];
    for (const [order, name] of ["Alpha", "Hidden", "Beta", "Gamma"].entries()) {
      const id = await ctx.db.insert("projects", { teamId, name, order, status: "active", accent: "#123456", ownerEmail: owner.email, createdAt: now + order, updatedAt: now });
      ids.push(id);
      if (name === "Hidden") continue;
      for (const person of [member, viewer]) await ctx.db.insert("members", { projectId: id, userId: person.id, email: person.email, name: "Synthetic member", role: "member", status: "active", createdAt: now, updatedAt: now });
    }
    return { owner, member, viewer, teamId, ids };
  });
  const list = async (token: string) => (await t.query(api.projects.listForUser, { teamId: data.teamId, sessionToken: token })).map(row => row._id);
  return { t, ...data, list };
}

test("a member's visible reorder reaches both accounts and preserves inaccessible project slots", async () => {
  const f = await fixture(), [a, hidden, b, c] = f.ids;
  await f.t.mutation(api.projects.reorder, { sessionToken: f.member.token, teamId: f.teamId, expectedProjectIds: [a, b, c], projectIds: [c, a, b] });
  expect(await f.list(f.owner.token)).toEqual([c, hidden, a, b]);
  expect(await f.list(f.member.token)).toEqual([c, a, b]);
  expect(await f.list(f.viewer.token)).toEqual([c, a, b]);
});

test("a concurrent stale reorder cannot overwrite the winning workspace order", async () => {
  const f = await fixture(), [a, hidden, b, c] = f.ids;
  await f.t.mutation(api.projects.reorder, { sessionToken: f.owner.token, teamId: f.teamId, expectedProjectIds: f.ids, projectIds: [c, hidden, b, a] });
  await expect(f.t.mutation(api.projects.reorder, { sessionToken: f.member.token, teamId: f.teamId, expectedProjectIds: [a, b, c], projectIds: [b, a, c] })).rejects.toThrow("Project order changed");
  expect(await f.list(f.owner.token)).toEqual([c, hidden, b, a]);
});

test("a checked reorder must include the current visible set exactly once", async () => {
  const f = await fixture(), [a, hidden, b, c] = f.ids;
  for (const projectIds of [[b, a], [a, b, c, c], [a, hidden, b, c]]) {
    await expect(f.t.mutation(api.projects.reorder, { sessionToken: f.member.token, teamId: f.teamId, expectedProjectIds: [a, b, c], projectIds })).rejects.toThrow();
  }
  expect(await f.list(f.owner.token)).toEqual(f.ids);
});

test("viewers and revoked members cannot change the order", async () => {
  const f = await fixture(), [a, , b, c] = f.ids;
  await expect(f.t.mutation(api.projects.reorder, { sessionToken: f.viewer.token, teamId: f.teamId, projectIds: [c, b, a] })).rejects.toThrow("You have view-only access");
  await f.t.run(async ctx => {
    const member = await ctx.db.query("teamMembers").withIndex("by_team_email", q => q.eq("teamId", f.teamId).eq("email", f.member.email)).unique();
    await ctx.db.delete(member!._id);
  });
  await expect(f.t.mutation(api.projects.reorder, { sessionToken: f.member.token, teamId: f.teamId, projectIds: [c, b, a] })).rejects.toThrow("You don't have access to this workspace");
  expect(await f.list(f.owner.token)).toEqual(f.ids);
});

test("legacy subset reorders retain the positions of projects outside the submitted subset", async () => {
  const f = await fixture(), [a, hidden, b, c] = f.ids;
  await f.t.mutation(api.projects.reorder, { sessionToken: f.member.token, teamId: f.teamId, projectIds: [b, a] });
  expect(await f.list(f.owner.token)).toEqual([b, hidden, a, c]);
});

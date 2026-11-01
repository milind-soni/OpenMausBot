/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
afterEach(() => { vi.unstubAllEnvs(); });

const element = (id: string, version: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, version, versionNonce: version * 7, type: "rectangle", x: 1, y: 2, width: 30, height: 40, ...extra });

async function fixture() {
  vi.stubEnv("CONVEX_SITE_URL", "https://fixture.convex.site");
  const t = convexTest(schema, modules);
  const people = await t.run(async ctx => {
    const out: { id: Id<"users">; email: string; token: string }[] = [];
    for (const name of ["owner", "viewer", "outsider"]) {
      const email = `${name}@draw.test`;
      const id = await ctx.db.insert("users", { name, email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
      out.push({ id, email, token: await createSession(ctx, id) });
    }
    return { owner: out[0]!, viewer: out[1]!, outsider: out[2]! };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: people.owner.token, name: "Draw" });
  const projectId = await t.mutation(api.projects.create, { sessionToken: people.owner.token, teamId, name: "Sketches", githubRepo: "later" });
  const invite = await t.mutation(api.workspaces.createInvite, { sessionToken: people.owner.token, teamId, role: "viewer", email: people.viewer.email });
  await t.mutation(api.workspaces.acceptInvite, { sessionToken: people.viewer.token, token: invite.token });
  await new Promise(resolve => setTimeout(resolve, 0));
  await t.finishInProgressScheduledFunctions();
  return { t, ...people, teamId, projectId };
}

test("a workspace scene and project canvases keep their own elements, newest version wins", async () => {
  const f = await fixture();
  const workspace = { sessionToken: f.owner.token, teamId: f.teamId };
  await f.t.mutation(api.draw.updateElements, { ...workspace, elements: [element("a", 2)] });
  await f.t.mutation(api.draw.updateElements, { ...workspace, elements: [element("a", 1, { x: 99 })] });
  expect((await f.t.query(api.draw.scene, workspace)).map(row => JSON.parse(row).version)).toEqual([2]);

  const canvasId = await f.t.mutation(api.draw.createCanvas, { sessionToken: f.owner.token, projectId: f.projectId, name: " Flows " });
  await f.t.mutation(api.draw.renameCanvas, { ...workspace, canvasId, name: "User flows" });
  expect(await f.t.query(api.draw.canvases, { sessionToken: f.owner.token, projectId: f.projectId })).toEqual([{ _id: canvasId, name: "User flows" }]);
  await f.t.mutation(api.draw.updateElements, { ...workspace, canvasId, elements: [element("b", 1), element("c", 1)] });
  expect(await f.t.query(api.draw.scene, { ...workspace, canvasId })).toHaveLength(2);
  expect(await f.t.query(api.draw.scene, workspace)).toHaveLength(1);
  expect((await f.t.run(ctx => ctx.db.get(canvasId)))?.drawingElementCount).toBe(2);
  await expect(f.t.mutation(api.draw.updateElements, { ...workspace, elements: [JSON.stringify({ id: "x", version: 1, type: "script" })] })).rejects.toThrow(/Invalid drawing element/);
});

test("retired Studio canvases stay hidden and viewers or outsiders cannot draw", async () => {
  const f = await fixture();
  const studio = await f.t.run(ctx => ctx.db.insert("canvases", { teamId: f.teamId, projectId: f.projectId, name: "Design", kind: "design", archived: false, createdAt: 1, updatedAt: 1 }));
  expect(await f.t.query(api.draw.canvases, { sessionToken: f.owner.token, projectId: f.projectId })).toEqual([]);
  await expect(f.t.query(api.draw.scene, { sessionToken: f.owner.token, teamId: f.teamId, canvasId: studio })).rejects.toThrow(/Canvas not found/);
  expect(await f.t.query(api.draw.scene, { sessionToken: f.viewer.token, teamId: f.teamId })).toEqual([]);
  await expect(f.t.mutation(api.draw.updateElements, { sessionToken: f.viewer.token, teamId: f.teamId, elements: [element("a", 1)] })).rejects.toThrow(/You have view-only access/);
  await expect(f.t.query(api.draw.scene, { sessionToken: f.outsider.token, teamId: f.teamId })).rejects.toThrow();
});

test("images upload through the scoped upload route and presence tracks the pointer", async () => {
  const f = await fixture();
  const workspace = { sessionToken: f.owner.token, teamId: f.teamId };
  const url = new URL(await f.t.mutation(api.draw.uploadUrl, workspace));
  expect(url.origin + url.pathname).toBe("https://fixture.convex.site/uploads");
  const response = await f.t.fetch(url.pathname + url.search, { method: "POST", headers: { "Content-Type": "image/png" }, body: "png bytes" });
  expect(response.status).toBe(200);
  const { storageId } = await response.json() as { storageId: Id<"_storage"> };
  await f.t.mutation(api.draw.saveFile, { ...workspace, fileId: "img-1", storageId, mimeType: "image/png" });
  await f.t.mutation(api.draw.saveFile, { ...workspace, fileId: "img-1", storageId, mimeType: "image/png" });
  expect(await f.t.query(api.draw.files, workspace)).toMatchObject([{ fileId: "img-1", mimeType: "image/png" }]);
  await expect(f.t.mutation(api.draw.uploadUrl, { sessionToken: f.viewer.token, teamId: f.teamId })).rejects.toThrow(/You have view-only access/);

  await f.t.mutation(api.draw.setPresence, { ...workspace, x: 5, y: 6, button: "down" });
  expect(await f.t.query(api.draw.presence, { sessionToken: f.viewer.token, teamId: f.teamId })).toMatchObject([{ name: "owner", x: 5, y: 6, button: "down" }]);
  await f.t.mutation(api.draw.setPresence, { ...workspace, x: 0, y: 0, button: "up", leave: true });
  expect(await f.t.query(api.draw.presence, workspace)).toEqual([]);
});

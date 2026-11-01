/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function legacyImageMetadata(ctx: MutationCtx, id: Id<"_storage">) {
  // convex-test 0.0.60 omits Blob.type when emulating storage.store.
  const patchSystem = ctx.db.patch as unknown as (id: Id<"_storage">, fields: { contentType: string }) => Promise<void>;
  await patchSystem(id, { contentType: "image/png" });
}

async function fixture() {
  vi.stubEnv("CONVEX_SITE_URL", "https://fixture.convex.site");
  const t = convexTest(schema, modules);
  const people = await t.run(async ctx => {
    const users = [];
    for (const name of ["owner", "member"]) {
      const email = `${name}@storage.test`;
      const id = await ctx.db.insert("users", { name, email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
      users.push({ id, email, token: await createSession(ctx, id) });
    }
    return { owner: users[0]!, member: users[1]! };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: people.owner.token, name: "Private workspace" });
  const projectId = await t.mutation(api.projects.create, { sessionToken: people.owner.token, teamId, name: "Private project", githubRepo: "later" });
  const invite = await t.mutation(api.workspaces.createInvite, { sessionToken: people.owner.token, teamId, role: "member", email: people.member.email });
  await t.mutation(api.workspaces.acceptInvite, { sessionToken: people.member.token, token: invite.token });
  await t.mutation(api.members.addWorkspaceMember, { sessionToken: people.owner.token, projectId, email: people.member.email, role: "member" });
  const ownTeam = await t.mutation(api.workspaces.create, { sessionToken: people.member.token, name: "Own workspace" });
  const ownProjectId = await t.mutation(api.projects.create, { sessionToken: people.member.token, teamId: ownTeam.teamId, name: "Own project", githubRepo: "later" });
  const source = { projectId, sessionToken: people.owner.token };
  const own = { projectId: ownProjectId, sessionToken: people.member.token };
  const removeMember = async () => {
    const row = (await t.query(api.members.list, source)).find(member => member.email === people.member.email)!;
    await t.mutation(api.members.remove, { ...source, memberId: row._id });
  };
  const upload = async (url: string, type = "image/png") => {
    const response = await t.fetch(new URL(url).pathname + new URL(url).search, { method: "POST", headers: { "Content-Type": type }, body: "image bytes" });
    expect(response.status).toBe(200);
    return (await response.json() as { storageId: import("./_generated/dataModel").Id<"_storage"> }).storageId;
  };
  // Let background jobs scheduled by the setup (GitHub access review) finish: convex-test's storage
  // emulation races any transaction that is still open when an upload stores its blob.
  if (!vi.isFakeTimers()) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
  return { t, people, source, own, removeMember, upload };
}

test("a removed project member cannot rebind its remembered storage ID in their own workspace", async () => {
  const t = convexTest(schema, modules);
  const people = await t.run(async ctx => {
    const users = [];
    for (const name of ["owner", "member"]) {
      const email = `${name}@storage.test`;
      const id = await ctx.db.insert("users", { name, email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
      users.push({ id, email, token: await createSession(ctx, id) });
    }
    return { owner: users[0]!, member: users[1]! };
  });
  const sourceTeam = await t.mutation(api.workspaces.create, { sessionToken: people.owner.token, name: "Private workspace" });
  const sourceProjectId = await t.mutation(api.projects.create, { sessionToken: people.owner.token, teamId: sourceTeam.teamId, name: "Private project", githubRepo: "later" });
  const invite = await t.mutation(api.workspaces.createInvite, { sessionToken: people.owner.token, teamId: sourceTeam.teamId, role: "member", email: people.member.email });
  await t.mutation(api.workspaces.acceptInvite, { sessionToken: people.member.token, token: invite.token });
  await t.mutation(api.members.addWorkspaceMember, { sessionToken: people.owner.token, projectId: sourceProjectId, email: people.member.email, role: "member" });
  const storageId = await t.run(ctx => ctx.storage.store(new Blob(["private project bytes"], { type: "application/pdf" })));
  await t.run(ctx => ctx.db.insert("designAssets", { projectId: sourceProjectId, type: "document", name: "Private document", storageId, createdAt: 1, updatedAt: 1 }));
  const rememberedId = (await t.query(api.design.list, { sessionToken: people.member.token, projectId: sourceProjectId })).assets[0]!.storageId!;
  const membership = (await t.query(api.members.list, { sessionToken: people.owner.token, projectId: sourceProjectId })).find(row => row.email === people.member.email)!;
  await t.mutation(api.members.remove, { sessionToken: people.owner.token, projectId: sourceProjectId, memberId: membership._id });
  await expect(t.query(api.design.list, { sessionToken: people.member.token, projectId: sourceProjectId })).rejects.toThrow("access to this project");
  const destinationTeam = await t.mutation(api.workspaces.create, { sessionToken: people.member.token, name: "Own workspace" });
  const destinationProjectId = await t.mutation(api.projects.create, { sessionToken: people.member.token, teamId: destinationTeam.teamId, name: "Own project", githubRepo: "later" });
  const rebind = async () => {
    await t.mutation(api.design.createAsset, { sessionToken: people.member.token, projectId: destinationProjectId, type: "document", name: "Recovered private document", storageId: rememberedId });
    return (await t.query(api.design.list, { sessionToken: people.member.token, projectId: destinationProjectId })).assets[0];
  };
  await expect(rebind()).rejects.toThrow("access");
});

test("unreferenced IDs cannot be claimed by any of the storage reference writers", async () => {
  const f = await fixture();
  const storageId = await f.t.run(async ctx => {
    const id = await ctx.storage.store(new Blob(["unknown private bytes"], { type: "image/png" }));
    await legacyImageMetadata(ctx, id);
    return id;
  });
  const attempts = [
    () => f.t.mutation(api.auth.updateProfile, { sessionToken: f.own.sessionToken, avatarStorageId: storageId }),
    () => f.t.mutation(api.projects.update, { ...f.own, iconType: "image", iconStorageId: storageId }),
    () => f.t.mutation(api.design.createAsset, { ...f.own, storageId, type: "image", name: "Foreign" }),
  ];
  for (const attempt of attempts) await expect(attempt()).rejects.toThrow("access");
  expect((await f.t.query(api.design.list, f.own)).assets).toHaveLength(0);
});

test("every upload issuer register scoped server-stored bytes and preserve the transport contract", async () => {
  const f = await fixture();
  const avatar = await f.upload(await f.t.mutation(api.auth.generateAvatarUploadUrl, { sessionToken: f.own.sessionToken }));
  await f.t.mutation(api.auth.updateProfile, { sessionToken: f.own.sessionToken, avatarStorageId: avatar });
  expect((await f.t.query(api.auth.me, { sessionToken: f.own.sessionToken }))?.avatarUrl).toBeTruthy();
  const icon = await f.upload(await f.t.mutation(api.projects.generateIconUploadUrl, f.own));
  await f.t.mutation(api.projects.update, { ...f.own, iconType: "image", iconStorageId: icon });
  expect((await f.t.query(api.projects.get, f.own)).iconUrl).toBeTruthy();
  const asset = await f.upload(await f.t.mutation(api.design.generateUploadUrl, f.own), "application/pdf");
  await f.t.mutation(api.design.createAsset, { ...f.own, storageId: asset, type: "document", name: "Document" });
  expect((await f.t.query(api.design.list, f.own)).assets[0]?.fileUrl).toBeTruthy();
});

test("a valid unrelated upload intent cannot authorize an arbitrary ID or someone else's private profile upload", async () => {
  const f = await fixture();
  await f.t.mutation(api.design.generateUploadUrl, f.own);
  const privateAvatar = await f.upload(await f.t.mutation(api.auth.generateAvatarUploadUrl, { sessionToken: f.source.sessionToken }));
  await expect(f.t.mutation(api.design.createAsset, { ...f.own, storageId: privateAvatar, type: "image", name: "Stolen avatar" })).rejects.toThrow("access");
});

test("current source readers may reuse legacy files, and an authorized copy survives source removal", async () => {
  const f = await fixture();
  const storageId = await f.t.run(async ctx => {
    const id = await ctx.storage.store(new Blob(["legacy shared bytes"], { type: "image/png" }));
    await legacyImageMetadata(ctx, id);
    await ctx.db.insert("designAssets", { projectId: f.source.projectId, storageId: id, name: "Legacy", type: "image", createdAt: 1, updatedAt: 1 });
    return id;
  });
  await f.t.mutation(api.projects.update, { ...f.own, iconType: "image", iconStorageId: storageId });
  await f.removeMember();
  await f.t.mutation(api.auth.updateProfile, { sessionToken: f.own.sessionToken, avatarStorageId: storageId });
  expect((await f.t.query(api.projects.get, f.own)).iconUrl).toBeTruthy();
});

test("a revoked source cannot be rebound through profiles, icons or assets", async () => {
  const f = await fixture();
  const storageId = await f.upload(await f.t.mutation(api.design.generateUploadUrl, f.source));
  await f.t.mutation(api.design.createAsset, { ...f.source, storageId, type: "image", name: "Private" });
  await f.removeMember();
  const attempts = [
    () => f.t.mutation(api.auth.updateProfile, { sessionToken: f.own.sessionToken, avatarStorageId: storageId }),
    () => f.t.mutation(api.projects.update, { ...f.own, iconStorageId: storageId }),
    () => f.t.mutation(api.design.createAsset, { ...f.own, storageId, type: "image", name: "Stolen" }),
  ];
  for (const attempt of attempts) await expect(attempt()).rejects.toThrow("access");
});

test("upload URLs are one-use, expire, enforce MIME and bound incoming bytes", async () => {
  const f = await fixture();
  const url = await f.t.mutation(api.auth.generateAvatarUploadUrl, { sessionToken: f.own.sessionToken });
  await f.upload(url);
  expect((await f.t.fetch(new URL(url).pathname + new URL(url).search, { method: "POST", body: "replay", headers: { "Content-Type": "image/png" } })).status).toBe(400);
  const invalid = await f.t.mutation(api.auth.generateAvatarUploadUrl, { sessionToken: f.own.sessionToken });
  expect((await f.t.fetch(new URL(invalid).pathname + new URL(invalid).search, { method: "POST", body: "invalid", headers: { "Content-Type": "text/plain" } })).status).toBe(400);
  const large = await f.t.mutation(api.auth.generateAvatarUploadUrl, { sessionToken: f.own.sessionToken });
  expect((await f.t.fetch(new URL(large).pathname + new URL(large).search, { method: "POST", body: "oversize", headers: { "Content-Type": "image/png", "Content-Length": String(6 * 1024 * 1024) } })).status).toBe(413);
  const expired = await f.t.mutation(api.auth.generateAvatarUploadUrl, { sessionToken: f.own.sessionToken });
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60 * 1000);
  expect((await f.t.fetch(new URL(expired).pathname + new URL(expired).search, { method: "POST", body: "expired", headers: { "Content-Type": "image/png" } })).status).toBe(400);
});

test("an upload rechecks project access after receiving the body and deletes only its rejected new blob", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const original = await f.upload(await f.t.mutation(api.design.generateUploadUrl, f.source));
  const url = await f.t.mutation(api.design.generateUploadUrl, { ...f.source, sessionToken: f.own.sessionToken });
  let release!: () => void;
  let reading!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { reading = resolve; });
  const body = new ReadableStream({ async pull(controller) { reading(); await blocked; controller.enqueue(new TextEncoder().encode("revoked bytes")); controller.close(); } }, { highWaterMark: 0 });
  const response = f.t.fetch(new URL(url).pathname + new URL(url).search, { method: "POST", body, headers: { "Content-Type": "image/png" }, duplex: "half" } as RequestInit);
  await started;
  await f.removeMember();
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  release();
  expect((await response).status).toBe(400);
  expect(await f.t.run(ctx => ctx.db.system.get(original))).not.toBeNull();
  expect(await f.t.run(ctx => ctx.db.system.query("_storage").collect())).toHaveLength(1);
});

test("signing out invalidates an already issued upload capability", async () => {
  const f = await fixture();
  const url = await f.t.mutation(api.design.generateUploadUrl, f.own);
  await f.t.mutation(api.auth.logout, { sessionToken: f.own.sessionToken });
  expect((await f.t.fetch(new URL(url).pathname + new URL(url).search, { method: "POST", body: "signed-out bytes", headers: { "Content-Type": "image/png" } })).status).toBe(400);
});

test("legacy migration is paginated and idempotent and does not claim unreferenced blobs", async () => {
  const f = await fixture();
  const storageId = await f.t.run(async ctx => {
    const id = await ctx.storage.store(new Blob(["legacy bytes"], { type: "image/png" }));
    for (let index = 0; index < 125; index += 1) await ctx.db.insert("designAssets", { projectId: f.source.projectId, storageId: id, name: `Legacy ${index}`, type: "image", createdAt: 1, updatedAt: 1 });
    return id;
  });
  const first = await f.t.mutation(internal.storage.migrateReferences, { table: "designAssets", cursor: null });
  expect(first).toMatchObject({ done: false, admitted: 100 });
  expect(await f.t.mutation(internal.storage.migrateReferences, { table: "designAssets", cursor: first.cursor })).toMatchObject({ done: true, admitted: 25 });
  await f.t.mutation(internal.storage.migrateReferences, { table: "designAssets", cursor: null });
  expect(await f.t.run(ctx => ctx.db.query("storageAdmissions").collect())).toHaveLength(1);
  await f.removeMember();
  await expect(f.t.mutation(api.design.createAsset, { ...f.own, storageId, type: "image", name: "Revoked migrated" })).rejects.toThrow("access");
});

test("concurrent POSTs can consume an upload intent only once", async () => {
  const f = await fixture();
  const url = new URL(await f.t.mutation(api.design.generateUploadUrl, f.own));
  let reading!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const body = new ReadableStream({ async pull(controller) { reading(); await blocked; controller.enqueue(new TextEncoder().encode("concurrent image")); controller.close(); } }, { highWaterMark: 0 });
  const first = f.t.fetch(url.pathname + url.search, { method: "POST", body, headers: { "Content-Type": "image/png" }, duplex: "half" } as RequestInit);
  await started;
  const second = await f.t.fetch(url.pathname + url.search, { method: "POST", body: "concurrent image", headers: { "Content-Type": "image/png" } });
  release();
  expect([(await first).status, second.status]).toEqual([200, 400]);
  expect(await f.t.run(ctx => ctx.db.system.query("_storage").collect())).toHaveLength(1);
});

test("a chunked upload is bounded without trusting Content-Length", async () => {
  const f = await fixture();
  const url = new URL(await f.t.mutation(api.auth.generateAvatarUploadUrl, { sessionToken: f.own.sessionToken }));
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3 * 1024 * 1024)); controller.enqueue(new Uint8Array(3 * 1024 * 1024)); controller.close(); } });
  expect((await f.t.fetch(url.pathname + url.search, { method: "POST", body, headers: { "Content-Type": "image/png" }, duplex: "half" } as RequestInit)).status).toBe(413);
  expect(await f.t.run(ctx => ctx.db.system.query("_storage").collect())).toHaveLength(0);
});

test("session generation revocation during an upload prevents admission", async () => {
  const f = await fixture();
  const url = await f.t.mutation(api.design.generateUploadUrl, f.own);
  const token = new URL(url).searchParams.get("token")!;
  const started = await f.t.mutation(internal.storage.beginUpload, { token });
  await f.t.run(async ctx => { await ctx.db.patch(f.people.member.id, { sessionVersion: 1 }); });
  const storageId = await f.t.run(ctx => ctx.storage.store(new Blob(["revoked session bytes"], { type: "image/png" })));
  await expect(f.t.mutation(internal.storage.completeUpload, { intentId: started.intentId, storageId, contentType: "image/png" })).rejects.toThrow("access");
  expect(await f.t.run(ctx => ctx.db.query("storageAdmissions").collect())).toHaveLength(0);
});

test("migration covers every live reference scope without exposing unrelated unreferenced blobs", async () => {
  const f = await fixture();
  const storageId = await f.t.run(async ctx => {
    const id = await ctx.storage.store(new Blob(["shared legacy image"], { type: "image/png" }));
    await legacyImageMetadata(ctx, id);
    await ctx.storage.store(new Blob(["unreferenced private image"], { type: "image/png" }));
    await ctx.db.patch(f.people.owner.id, { avatarStorageId: id });
    await ctx.db.patch(f.source.projectId, { iconType: "image", iconStorageId: id });
    await ctx.db.insert("designAssets", { projectId: f.source.projectId, storageId: id, name: "Legacy", type: "image", createdAt: 1, updatedAt: 1 });
    return id;
  });
  for (const table of ["users", "projects", "workspaceAgents", "designAssets"] as const) {
    expect((await f.t.mutation(internal.storage.migrateReferences, { table, cursor: null })).done).toBe(true);
  }
  const admissions = await f.t.run(ctx => ctx.db.query("storageAdmissions").collect());
  expect(admissions).toHaveLength(2);
  expect(admissions.every(row => row.storageId === storageId)).toBe(true);
  expect((await f.t.query(api.projects.get, f.source)).iconUrl).toBeTruthy();
});

test("upload preflight permits binary transport without ambient credentials", async () => {
  const f = await fixture();
  const response = await f.t.fetch("/uploads", { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:5173", "Access-Control-Request-Headers": "content-type" } });
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
});

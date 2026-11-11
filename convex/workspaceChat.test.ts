/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createSession } from "./lib/auth";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function workspace() {
  const t = convexTest(schema, modules);
  const people = await t.run(async ctx => {
    const now = Date.now();
    const make = async (email: string) => {
      const id = await ctx.db.insert("users", { email, name: email.split("@")[0], role: "user", status: "active", passwordHash: "x", salt: "x", iterations: 1, createdAt: now, updatedAt: now });
      return { id, session: await createSession(ctx, id) };
    };
    return { ann: await make("ann@chat.test"), bob: await make("bob@chat.test"), eve: await make("eve@chat.test"), val: await make("val@chat.test") };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: people.ann.session, name: "Chat" });
  await t.run(async ctx => {
    const now = Date.now();
    await ctx.db.insert("teamMembers", { teamId, userId: people.bob.id, email: "bob@chat.test", name: "bob", role: "member", status: "active", createdAt: now, updatedAt: now });
    await ctx.db.insert("teamMembers", { teamId, userId: people.val.id, email: "val@chat.test", name: "val", role: "viewer", status: "active", createdAt: now, updatedAt: now });
  });
  const as = (who: keyof typeof people, conversation?: string) => ({ sessionToken: people[who].session, teamId, ...(conversation ? { conversation } : {}) });
  return { t, people, teamId, as };
}

test("workspace chat: send, list, edit, react, search and delete are stored in Convex and scoped to members", async () => {
  const { t, people, as } = await workspace();
  const first = JSON.parse(await t.mutation(api.workspaceChat.send, { ...as("ann"), body: "Hello team", mentionUserIds: [people.bob.id] }));
  expect(first).toMatchObject({ body: "Hello team", authorUserId: people.ann.id, mentions: [{ userId: people.bob.id, name: "bob" }] });
  await t.mutation(api.workspaceChat.send, { ...as("bob"), body: "Hi Ann", replyTo: first.id });
  expect((await t.query(api.workspaceChat.list, as("bob"))).map(row => JSON.parse(row).body)).toEqual(["Hello team", "Hi Ann"]);
  await expect(t.query(api.workspaceChat.list, as("eve"))).rejects.toThrow("access");
  await expect(t.mutation(api.workspaceChat.send, { ...as("val"), body: "read only" })).rejects.toThrow("View-only");
  await expect(t.mutation(api.workspaceChat.send, { ...as("ann"), body: "x", mentionUserIds: [people.eve.id] })).rejects.toThrow("Mention");
  await expect(t.mutation(api.workspaceChat.edit, { ...as("bob"), id: first.id, body: "hijack" })).rejects.toThrow("Only the author");
  expect(JSON.parse((await t.mutation(api.workspaceChat.edit, { ...as("bob"), id: first.id, reaction: "heart" }))!).reactions).toEqual({ heart: [people.bob.id] });
  expect(JSON.parse((await t.mutation(api.workspaceChat.edit, { ...as("ann"), id: first.id, body: "Hello everyone" }))!)).toMatchObject({ body: "Hello everyone", editedAt: expect.any(Number) });
  expect((await t.mutation(api.workspaceChat.search, { ...as("bob"), search: "EVERYONE" })).map(row => JSON.parse(row).id)).toEqual([first.id]);
  expect(await t.mutation(api.workspaceChat.edit, { ...as("ann"), id: first.id, delete: true })).toBeNull();
  expect((await t.query(api.workspaceChat.list, as("ann"))).map(row => JSON.parse(row).body)).toEqual(["Hi Ann"]);
});

test("workspace chat: a mention schedules its notification in the same transaction", async () => {
  vi.useFakeTimers();
  const { t, people, as } = await workspace();
  await t.mutation(api.workspaceChat.send, { ...as("ann"), body: "@bob look", mentionUserIds: [people.bob.id] });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const notes = await t.run(ctx => ctx.db.query("notifications").take(10));
  expect(notes).toEqual([expect.objectContaining({ userId: people.bob.id, kind: "mention" })]);
});

test("direct conversations: only their two people can read them; unread counts and read markers", async () => {
  const { t, people, as } = await workspace();
  const conversation = await t.mutation(api.workspaceChat.openDirect, { ...as("ann"), recipientId: people.bob.id });
  expect(conversation).toBe(`dm:${[people.ann.id, people.bob.id].sort().join(":")}`);
  expect(await t.mutation(api.workspaceChat.openDirect, { ...as("bob"), recipientId: people.ann.id })).toBe(conversation);
  await expect(t.mutation(api.workspaceChat.openDirect, { ...as("ann"), recipientId: people.eve.id })).rejects.toThrow("member");
  const message = JSON.parse(await t.mutation(api.workspaceChat.send, { ...as("ann", conversation), body: "private" }));
  await expect(t.query(api.workspaceChat.list, as("val", conversation))).rejects.toThrow("Conversation not found");
  expect(await t.query(api.workspaceChat.directs, as("bob"))).toEqual([{ id: conversation, otherUserId: people.ann.id, lastMessage: expect.stringContaining("private"), unread: 1 }]);
  await t.mutation(api.workspaceChat.markRead, { ...as("bob", conversation), messageId: message.id });
  expect((await t.query(api.workspaceChat.directs, as("bob")))[0].unread).toBe(0);
  // Direct messages are kept apart from the workspace channel.
  expect(await t.query(api.workspaceChat.list, as("bob"))).toEqual([]);
});

test("chat rate limits are shared state, not per-process", async () => {
  const { t, as } = await workspace();
  for (let i = 0; i < 40; i++) await t.mutation(api.workspaceChat.send, { ...as("ann"), body: `m${i}` });
  await expect(t.mutation(api.workspaceChat.send, { ...as("ann"), body: "one too many" })).rejects.toThrow("Too many requests");
  expect(await t.run(ctx => ctx.db.query("requestLimits").take(5))).toEqual([expect.objectContaining({ count: 40 })]);
});

test("attachments upload straight to Convex storage and are recorded only for the uploader's conversation", async () => {
  vi.stubEnv("CONVEX_SITE_URL", "https://fixture.convex.site");
  const { t, as, teamId } = await workspace();
  const started = await t.mutation(api.workspaceChat.beginUpload, { ...as("bob"), name: "notes.txt", size: 5, contentType: "text/plain" });
  expect(started.uploadUrl).toMatch(/^https:\/\/fixture\.convex\.site\/uploads\?token=[a-f0-9]{64}$/);
  await expect(t.mutation(api.workspaceChat.beginUpload, { ...as("val"), name: "x", size: 5, contentType: "text/plain" })).rejects.toThrow("View-only");
  await expect(t.mutation(api.workspaceChat.beginUpload, { ...as("bob"), name: "big", size: 16 * 1024 * 1024, contentType: "text/plain" })).rejects.toThrow("15 MB");
  const response = await t.fetch(`/uploads?${new URL(started.uploadUrl).searchParams}`, { method: "POST", body: "hello", headers: { "Content-Type": "text/plain" } });
  expect(response.status).toBe(200);
  const file = await t.query(api.workspaceChat.file, { ...as("ann"), fileId: started.file.id });
  expect(file).toMatchObject({ name: "notes.txt", contentType: "text/plain", url: expect.any(String) });
  const sent = JSON.parse(await t.mutation(api.workspaceChat.send, { ...as("bob"), body: "", attachmentIds: [started.file.id] }));
  expect(sent.attachments).toEqual([expect.objectContaining({ id: started.file.id, size: 5 })]);
  // Another member cannot attach Bob's upload as their own.
  await expect(t.mutation(api.workspaceChat.send, { ...as("ann"), body: "", attachmentIds: [started.file.id] })).rejects.toThrow("Attachment not found");
  expect(await t.run(ctx => ctx.db.query("teamChatFiles").withIndex("by_team_conversation_file", q => q.eq("teamId", teamId as Id<"teams">)).take(5))).toHaveLength(1);
});

test("calls: presence, room size, signaling handshake, acknowledgement and expiry", async () => {
  const { t, people, as } = await workspace();
  const ann = await t.mutation(api.workspaceCalls.join, { ...as("ann"), audioEnabled: true, videoEnabled: false, screenSharing: false, heartbeat: false });
  const bob = await t.mutation(api.workspaceCalls.join, { ...as("bob"), audioEnabled: true, videoEnabled: true, screenSharing: false, heartbeat: false });
  await expect(t.mutation(api.workspaceCalls.join, { ...as("val"), audioEnabled: true, videoEnabled: false, screenSharing: false, heartbeat: false })).rejects.toThrow("View-only");
  expect((await t.query(api.workspaceCalls.participants, as("bob"))).map(row => JSON.parse(row).userId)).toEqual([people.ann.id, people.bob.id]);
  const heartbeat = await t.mutation(api.workspaceCalls.join, { ...as("ann"), audioEnabled: false, videoEnabled: false, screenSharing: true, heartbeat: true });
  expect(heartbeat.joinedAt).toBe(ann.joinedAt);
  const offer = JSON.parse((await t.mutation(api.workspaceCalls.signal, { ...as("ann"), toUserId: people.bob.id, kind: "offer", payload: "sdp", fromJoinedAt: ann.joinedAt, toJoinedAt: bob.joinedAt }))!);
  expect(await t.mutation(api.workspaceCalls.signal, { ...as("ann"), toUserId: people.bob.id, kind: "offer", payload: "sdp", toJoinedAt: bob.joinedAt - 1 })).toBeNull();
  await expect(t.mutation(api.workspaceCalls.signal, { ...as("ann"), toUserId: people.bob.id, kind: "bogus", payload: "x" })).rejects.toThrow("Invalid call signal");
  expect((await t.query(api.workspaceCalls.signals, as("bob"))).map(row => JSON.parse(row).id)).toEqual([offer.id]);
  expect(await t.query(api.workspaceCalls.signals, as("ann"))).toEqual([]);
  await t.mutation(api.workspaceCalls.ack, { ...as("bob"), signalIds: [offer.id] });
  expect(await t.query(api.workspaceCalls.signals, as("bob"))).toEqual([]);
  await t.mutation(api.workspaceCalls.leave, as("bob"));
  expect((await t.query(api.workspaceCalls.participants, as("ann"))).map(row => JSON.parse(row).userId)).toEqual([people.ann.id]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 31000);
  expect(await t.query(api.workspaceCalls.participants, as("ann"))).toEqual([]);
  await t.mutation(internal.workspaceCalls.prune, {});
  expect(await t.run(ctx => ctx.db.query("teamCallParticipants").take(5))).toEqual([]);
});

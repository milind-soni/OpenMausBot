/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { createSession } from "./lib/auth";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

test("desktop chat exports workspace and direct conversations, never project conversations", async () => {
  const t = convexTest(schema, modules);
  const session = await t.run(async ctx => {
    const id = await ctx.db.insert("users", { name: "Owner", username: "owner", email: "owner@chat.test", role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    return createSession(ctx, id);
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: session, name: "Chat" });
  const other = await t.mutation(api.workspaces.create, { sessionToken: session, name: "Other" });
  await t.run(async ctx => {
    const message = (id: string, conversation: string, created: number) => ctx.db.insert("teamChatMessages", { teamId, conversation, messageId: id, created, payload: JSON.stringify({ id, body: id, createdAt: created }) });
    await message("general", "", 1);
    await message("direct", "dm:a:b", 2);
    await message("project", "project:abcdefghij", 3);
    for (let i = 0; i < 230; i++) await message(`bulk-${i}`, "", 10 + i);
    await ctx.db.insert("teamChatMessages", { teamId: other.teamId, conversation: "", messageId: "elsewhere", created: 4, payload: "{}" });
    const storageId = await ctx.storage.store(new Blob(["hello"]));
    await ctx.db.insert("teamChatFiles", { teamId, conversation: "", fileId: "f1", author: "a", storageId, payload: JSON.stringify({ id: "f1", name: "a.txt", size: 5, contentType: "text/plain" }) });
    await ctx.db.insert("teamChatFiles", { teamId, conversation: "project:abcdefghij", fileId: "f2", author: "a", storageId, payload: "{}" });
    await ctx.db.insert("teamDirectConversations", { teamId, conversation: "dm:a:b", userA: "a", userB: "b" });
    await ctx.db.insert("teamChatReads", { teamId, conversation: "dm:a:b", userId: "a", seen: 2 });
    await ctx.db.insert("teamChatReads", { teamId, conversation: "project:abcdefghij", userId: "a", seen: 3 });
  });
  const all = async (table: "messages" | "files" | "directs" | "reads") => {
    const rows: Record<string, unknown>[] = [];
    for (let cursor: string | null = null; ;) {
      const page: { rows: Record<string, unknown>[]; isDone: boolean; continueCursor: string } = await t.query(internal.legacyChat.exportPage, { teamId, table, cursor });
      rows.push(...page.rows);
      if (page.isDone) return rows;
      cursor = page.continueCursor;
    }
  };
  const messages = await all("messages");
  expect(messages).toHaveLength(232);
  expect(messages.map(row => row.id)).not.toContain("project");
  expect(messages.map(row => row.id)).not.toContain("elsewhere");
  expect(messages.find(row => row.id === "direct")).toMatchObject({ conversation: "dm:a:b", created: 2 });
  const files = await all("files");
  expect(files).toEqual([expect.objectContaining({ id: "f1", conversation: "", author: "a", url: expect.any(String) })]);
  expect(await all("directs")).toEqual([{ id: "dm:a:b", userA: "a", userB: "b" }]);
  expect(await all("reads")).toEqual([{ conversation: "dm:a:b", userId: "a", seen: 2 }]);
});

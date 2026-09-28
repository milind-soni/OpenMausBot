import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("thread archive through an isolated HTTP fixture", () => {
  let fixture: VerificationServer;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const getBot = async (botId: string) => (await api("GET", "/api/bots?messages=1")).body.bots.find((bot: any) => bot.id === botId);
  const persistedTask = (botId: string, threadId: string) => JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8"))
    .find((bot: any) => bot.id === botId).tasks.find((task: any) => task.threadId === threadId);

  beforeAll(async () => {
    fixture = await launchVerificationServer();
  });
  afterAll(async () => {
    if (!fixture) return;
    await fixture.close();
  });

  it("archives and unarchives a thread over HTTP, and the flag persists to bots.json", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Archive fixture" })).body.bot;
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Old research" })).body.task;
    const at = 1700000000000;
    const archived = await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { archivedAt: at });
    expect(archived.status).toBe(200);
    expect(archived.body.task.archivedAt).toBe(at);
    expect((await getBot(bot.id)).tasks.find((entry: any) => entry.threadId === task.threadId).archivedAt).toBe(at);
    expect(persistedTask(bot.id, task.threadId).archivedAt).toBe(at);
    const restored = await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { archivedAt: null });
    expect(restored.status).toBe(200);
    expect(restored.body.task.archivedAt).toBeUndefined();
    expect((await getBot(bot.id)).tasks.find((entry: any) => entry.threadId === task.threadId).archivedAt).toBeUndefined();
    expect("archivedAt" in persistedTask(bot.id, task.threadId)).toBe(false);
  });

  it("rejects values that are not timestamps so the flag cannot drift into junk", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Archive validation" })).body.bot;
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Validated" })).body.task;
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { archivedAt: "soon" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { archivedAt: -1 })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { archivedAt: { ts: 5 } })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { archivedAt: Date.now() })).status).toBe(200);
  });

  it("pins and unpins a thread, and refuses a client-supplied updatedAt", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Pin fixture" })).body.bot;
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Keep this" })).body.task;
    expect(task.updatedAt).toBe(task.createdAt);
    const pinned = await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { pinned: true });
    expect(pinned.status).toBe(200);
    expect(pinned.body.task.pinned).toBe(true);
    expect(persistedTask(bot.id, task.threadId).pinned).toBe(true);
    const cleared = await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { pinned: false });
    expect(cleared.status).toBe(200);
    expect(cleared.body.task.pinned).toBeUndefined();
    expect("pinned" in persistedTask(bot.id, task.threadId)).toBe(false);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { pinned: "yes" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { updatedAt: Date.now() })).status).toBe(400);
  });

  it("still rejects thread settings outside the allowlist", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Archive allowlist" })).body.bot;
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Allowlist" })).body.task;
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { archived: true })).status).toBe(400);
  });
});

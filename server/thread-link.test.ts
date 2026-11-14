import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";

describe("thread link through an isolated HTTP fixture", () => {
  let fixture: VerificationServer;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const persistedTask = (botId: string, threadId: string) => JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8"))
    .find((bot: any) => bot.id === botId).tasks.find((task: any) => task.threadId === threadId);

  beforeAll(async () => {
    fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify(["Opened https://github.com/o/r/pull/12 for review."]) });
  });
  afterAll(async () => {
    if (!fixture) return;
    await fixture.close();
  });

  it("assigns, persists and removes a link, and rejects anything but http(s)", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Link fixture" })).body.bot;
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Review" })).body.task;
    const path = `/api/bots/${bot.id}/tasks/${task.threadId}`;
    const assigned = await api("PATCH", path, { link: " https://github.com/o/r/pull/7 " });
    expect(assigned.status).toBe(200);
    expect(assigned.body.task.link).toBe("https://github.com/o/r/pull/7");
    expect(persistedTask(bot.id, task.threadId).link).toBe("https://github.com/o/r/pull/7");
    for (const link of ["javascript:alert(1)", "not a url", 7, `https://x.dev/${"a".repeat(2_048)}`]) {
      expect((await api("PATCH", path, { link })).status).toBe(400);
    }
    expect(persistedTask(bot.id, task.threadId).link).toBe("https://github.com/o/r/pull/7");
    const removed = await api("PATCH", path, { link: null });
    expect(removed.status).toBe(200);
    expect(removed.body.task.link).toBeUndefined();
    expect("link" in persistedTask(bot.id, task.threadId)).toBe(false);
    expect(persistedTask(bot.id, task.threadId).linkAuto).toBe(false);
  });

  it("suggests the pull request a reply links once the turn completes", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Link suggestion" })).body.bot;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "open the PR", threadId: bot.threadId })).status).toBe(202);
    const deadline = Date.now() + 20_000;
    while (!persistedTask(bot.id, bot.threadId)?.link && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(persistedTask(bot.id, bot.threadId)).toMatchObject({ link: "https://github.com/o/r/pull/12", linkAuto: true });
  });
});

describe("suggested thread links in the store", () => {
  const selection = (): ModelSelection => ({ instanceId: "claude", model: "default" });
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("follows the newest change request until a person assigns a link", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const task = store.createTask(bot.id, "Ship it", false)!;
    expect(store.suggestTaskLink(bot.id, task.threadId, "see https://example.com/docs")).toBeNull();
    store.suggestTaskLink(bot.id, task.threadId, "opened https://github.com/o/r/pull/1 then https://github.com/o/r/pull/2.");
    expect(store.taskByThread(bot.id, task.threadId)).toMatchObject({ link: "https://github.com/o/r/pull/2", linkAuto: true });
    store.suggestTaskLink(bot.id, task.threadId, "moved to https://gitlab.com/g/p/-/merge_requests/3");
    expect(store.taskByThread(bot.id, task.threadId)?.link).toBe("https://gitlab.com/g/p/-/merge_requests/3");
    store.patchTask(bot.id, task.threadId, { link: "https://docs.example.com/plan", linkAuto: undefined });
    expect(store.suggestTaskLink(bot.id, task.threadId, "https://github.com/o/r/pull/9")).toBeNull();
    expect(new Store(selection).taskByThread(bot.id, task.threadId)?.link).toBe("https://docs.example.com/plan");
  });

  it("stops suggesting once a person removes the link", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const task = store.createTask(bot.id, "Removed", false)!;
    store.suggestTaskLink(bot.id, task.threadId, "https://github.com/o/r/pull/1");
    store.patchTask(bot.id, task.threadId, { link: undefined, linkAuto: false });
    expect(store.suggestTaskLink(bot.id, task.threadId, "pushed to https://github.com/o/r/pull/1")).toBeNull();
    expect(store.taskByThread(bot.id, task.threadId)?.link).toBeUndefined();
  });
});

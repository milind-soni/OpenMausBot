import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";

describe("thread snooze through an isolated HTTP fixture", () => {
  let fixture: VerificationServer;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const taskOf = async (botId: string, threadId: string) => (await api("GET", "/api/bots?messages=1")).body.bots
    .find((bot: any) => bot.id === botId).tasks.find((task: any) => task.threadId === threadId);
  const persistedTask = (botId: string, threadId: string) => JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8"))
    .find((bot: any) => bot.id === botId).tasks.find((task: any) => task.threadId === threadId);

  beforeAll(async () => {
    fixture = await launchVerificationServer();
  });
  afterAll(async () => {
    if (!fixture) return;
    await fixture.close();
  });

  it("snoozes until activity or a time over HTTP, wakes on null, and persists to bots.json", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Snooze fixture" })).body.bot;
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Noisy build watch" })).body.task;
    const untilActivity = await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { snoozedUntil: 0 });
    expect(untilActivity.status).toBe(200);
    expect(untilActivity.body.task.snoozedUntil).toBe(0);
    expect((await taskOf(bot.id, task.threadId)).snoozedUntil).toBe(0);
    expect(persistedTask(bot.id, task.threadId).snoozedUntil).toBe(0);
    const until = Date.now() + 3_600_000;
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { snoozedUntil: until })).body.task.snoozedUntil).toBe(until);
    const woken = await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { snoozedUntil: null });
    expect(woken.status).toBe(200);
    expect(woken.body.task.snoozedUntil).toBeUndefined();
    expect("snoozedUntil" in persistedTask(bot.id, task.threadId)).toBe(false);
  });

  it("rejects values that are not timestamps or the sentinel", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Snooze validation" })).body.bot;
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Validated" })).body.task;
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { snoozedUntil: "later" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { snoozedUntil: -1 })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { snoozedUntil: { until: 5 } })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { snoozedUntil: 0 })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { snoozedUntil: Date.now() })).status).toBe(200);
  });

  it("heals expired time-based snoozes on read while the until-activity sentinel survives", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Snooze clock" })).body.bot;
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Timed" })).body.task;
    const past = 1_700_000_000_000;
    const patched = await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { snoozedUntil: past });
    expect(patched.status).toBe(200);
    expect(patched.body.task.snoozedUntil).toBeUndefined();
    expect((await taskOf(bot.id, task.threadId)).snoozedUntil).toBeUndefined();
    // the heal is on read, not a rewrite: the stale value sits until the next save
    expect(persistedTask(bot.id, task.threadId).snoozedUntil).toBe(past);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { snoozedUntil: 0 });
    expect((await taskOf(bot.id, task.threadId)).snoozedUntil).toBe(0);
  });
});

describe("thread snooze wake events in the store", () => {
  const selection = (): ModelSelection => ({ instanceId: "claude", model: "default" });
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
  const snoozedUntilActivity = () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const task = store.createTask(bot.id, "Snoozed thread", false)!;
    store.patchTask(bot.id, task.threadId, { snoozedUntil: 0 });
    return { store, bot, task };
  };

  it("clears the until-activity sentinel when a new message marks the thread unread", () => {
    const { store, bot, task } = snoozedUntilActivity();
    store.patchTask(bot.id, task.threadId, { unread: true });
    expect(store.taskByThread(bot.id, task.threadId)?.snoozedUntil).toBeUndefined();
    expect(new Store(selection).taskByThread(bot.id, task.threadId)?.snoozedUntil).toBeUndefined();
  });

  it("clears the until-activity sentinel on any activity change, including settling back to idle", () => {
    const { store, bot, task } = snoozedUntilActivity();
    store.setTaskActivity(bot.id, task.threadId, "working");
    expect(store.taskByThread(bot.id, task.threadId)?.snoozedUntil).toBeUndefined();
    store.patchTask(bot.id, task.threadId, { snoozedUntil: 0 });
    store.setTaskActivity(bot.id, task.threadId, "idle");
    expect(new Store(selection).taskByThread(bot.id, task.threadId)?.snoozedUntil).toBeUndefined();
  });

  it("leaves a time-based snooze to its clock: wake events override it on screen without clearing it", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const task = store.createTask(bot.id, "Timed thread", false)!;
    const until = Date.now() + 60_000;
    store.patchTask(bot.id, task.threadId, { snoozedUntil: until });
    store.patchTask(bot.id, task.threadId, { unread: true });
    store.setTaskActivity(bot.id, task.threadId, "working");
    expect(store.taskByThread(bot.id, task.threadId)?.snoozedUntil).toBe(until);
  });
});

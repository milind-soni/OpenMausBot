import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { createBotTasksHost } from "./wiring.ts";

let dir: string;
let clock: number;
let botTasks: Record<string, unknown>;
const frames: Array<Record<string, unknown>> = [];

const host = () => createBotTasksHost({
  dataDir: dir, vaultToken: () => null, config: () => ({ botTasks }) as unknown as AppConfig, botName: () => "Lin", bots: () => [{ id: "lin", name: "Lin" }],
  person: () => "Sam", broadcast: (payload) => frames.push(payload), now: () => clock, tickMs: 1_000_000,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-bot-tasks-wiring-"));
  clock = 1_700_000_000_000;
  botTasks = { enabled: true, githubSync: true, pollMinutes: 5 };
  frames.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the bot task poller", () => {
  it("syncs only once the interval has passed", async () => {
    const wired = host();
    const sync = vi.spyOn(wired.tasks, "syncAll").mockResolvedValue({ checked: 0, added: 0 } as never);
    await wired.tick();
    expect(sync).not.toHaveBeenCalled();
    clock += 5 * 60_000;
    await wired.tick();
    expect(sync).toHaveBeenCalledTimes(1);
    clock += 60_000;
    await wired.tick();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it.each([[{ enabled: false }], [{ githubSync: false }]])("never syncs while %j", async (off) => {
    botTasks = { ...botTasks, ...off };
    const wired = host();
    const sync = vi.spyOn(wired.tasks, "syncAll").mockResolvedValue({ checked: 0, added: 0 } as never);
    clock += 60 * 60_000;
    await wired.tick();
    expect(sync).not.toHaveBeenCalled();
    wired.start();
    expect(wired.nextDueAt()).toBeNull();
    wired.stop();
  });

  it("reports when the next poll is due, follows Settings, and survives a failing sync", async () => {
    const wired = host();
    expect(wired.nextDueAt()).toBeNull();
    wired.start();
    expect(wired.nextDueAt()).toBe(clock + 5 * 60_000);
    botTasks = { ...botTasks, pollMinutes: 10 };
    expect(wired.nextDueAt()).toBe(clock + 10 * 60_000);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(wired.tasks, "syncAll").mockRejectedValue(new Error("rate limited"));
    clock += 10 * 60_000;
    await wired.tick();
    expect(error).toHaveBeenCalledWith("bot-tasks: poll failed: rate limited");
    expect(wired.isTicking).toBe(false);
    expect(wired.nextDueAt()).toBe(clock + 10 * 60_000);
    wired.stop();
    expect(wired.nextDueAt()).toBeNull();
    error.mockRestore();
  });

  it("tells the app about every change", () => {
    const wired = host();
    const { task } = wired.tasks.create({ title: "x", ownerBotId: "lin", by: { kind: "bot", id: "lin", name: "Lin" } });
    expect(frames).toEqual([{ kind: "bot-task", taskId: task.id }]);
  });
});

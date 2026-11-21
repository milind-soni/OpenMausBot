import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { approvalModeFor, type ApprovalMode } from "../shared/approval-mode.ts";
import type { TaskOpenedBy } from "../shared/wire.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const OCT_1 = Date.UTC(2026, 9, 1);
const OCT_20 = Date.UTC(2026, 9, 20);
const MARKER = join(DATA_DIR, "legacy-work-threads-follow-bot");
/** The next start runs this build for the first time: an older one left no marker. */
const upgraded = () => { rmSync(MARKER, { force: true }); return new Store(selection); };
const levelOf = (store: Store, botId: string, threadId: string) => approvalModeFor(store.projectBotForTask(botId, threadId)!);

/** A thread as an older build saved it: made at `createdAt`, saved at `mode`. */
function saved(store: Store, botId: string, title: string, createdAt: number, mode: ApprovalMode, openedBy?: Omit<TaskOpenedBy, "at">): string {
  const task = store.createTask(botId, title, false, undefined, openedBy && { ...openedBy, at: createdAt })!;
  Object.assign(store.taskByThread(botId, task.threadId)!, { createdAt, approvalMode: mode, autoApprove: false, alwaysAllow: [] });
  store.patchTask(botId, task.threadId, { title });
  return task.threadId;
}

describe("work threads saved at Ask before Full access was the default", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("follow their bot once, and only the hand-off's standing work thread does", () => {
    const first = new Store(selection);
    const sender = first.createBot();
    const bot = first.createBot(); // nobody set its level: it reads the default, Full access
    const work = { botId: sender.id, name: "Sender", threadId: sender.threadId, kind: "work" as const };
    const legacy = saved(first, bot.id, "@Sender · work", OCT_1, "ask", work);
    const personal = saved(first, bot.id, "My own chat", OCT_1, "ask");
    const handedNew = saved(first, bot.id, "A new thread handed on", OCT_1, "ask", { botId: sender.id, name: "Sender", threadId: sender.threadId });
    const roomJob = saved(first, bot.id, "Room · job", OCT_1, "ask", { ...work, roomLane: true });
    const later = saved(first, bot.id, "@Other · work", OCT_20, "ask", { ...work, threadId: "another-chat" });
    const edits = saved(first, bot.id, "@Third · work", OCT_1, "edits", { ...work, threadId: "third-chat" });
    expect(levelOf(first, bot.id, legacy)).toBe("ask");

    const loaded = upgraded();

    expect(loaded.taskByThread(bot.id, legacy)).not.toHaveProperty("approvalMode");
    expect(loaded.taskByThread(bot.id, legacy)).not.toHaveProperty("autoApprove");
    expect(levelOf(loaded, bot.id, legacy)).toBe("full");
    for (const kept of [personal, handedNew, roomJob, later]) expect(levelOf(loaded, bot.id, kept)).toBe("ask");
    expect(levelOf(loaded, bot.id, edits)).toBe("edits");
    expect(existsSync(MARKER)).toBe(true);

    // Done once: the person later picks Ask on that thread, and it stays Ask through every later load.
    loaded.patchTask(bot.id, legacy, { approvalMode: "ask", autoApprove: false });
    expect(levelOf(new Store(selection), bot.id, legacy)).toBe("ask");
  });

  it("follows a bot saved at Ask to Ask, and later to whatever its bot is set to", () => {
    const first = new Store(selection);
    const sender = first.createBot();
    const bot = first.createBot();
    first.patchBot(bot.id, { approvalMode: "ask", autoApprove: false });
    const legacy = saved(first, bot.id, "@Sender · work", OCT_1, "ask", { botId: sender.id, name: "Sender", threadId: sender.threadId, kind: "work" });

    const loaded = upgraded();
    expect(levelOf(loaded, bot.id, legacy)).toBe("ask");
    loaded.patchBot(bot.id, { approvalMode: "auto", autoApprove: true });
    expect(levelOf(loaded, bot.id, legacy)).toBe("auto");
  });

  it("leaves a bot whose level change was pending at shutdown to the grant's own recovery", () => {
    const first = new Store(selection);
    const sender = first.createBot();
    const bot = first.createBot();
    const legacy = saved(first, bot.id, "@Sender · work", OCT_1, "ask", { botId: sender.id, name: "Sender", threadId: sender.threadId, kind: "work" });
    first.patchBot(bot.id, { approvalMode: "full", approvalGrant: { requestId: "123e4567-e89b-42d3-a456-426614174000", mode: "full", phase: "prepared" } });

    const loaded = upgraded();
    expect(loaded.bot(bot.id)?.approvalMode).toBe("ask");
    expect(loaded.taskByThread(bot.id, legacy)?.approvalMode).toBe("ask");
  });
});

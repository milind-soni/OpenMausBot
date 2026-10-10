import { rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";

// Company instance ids became stable across re-enrolment. Saved references
// to the old device-scoped id move over once and survive a restart.
beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });
const legacy = "company.aaaaaaaaaaaaaaaaaaaaaaaa.anthropic", stable = "company.bbbbbbbbbbbbbbbbbbbbbbbb.anthropic";

it("moves model choices, native resume cursors and handed-message records to the stable id", () => {
  const store = new Store(() => ({ instanceId: "personal", model: "claude-sonnet-5" }));
  const bot = store.createBot({ modelSelection: { instanceId: legacy, model: "claude-company" } }, { seedMessages: false });
  const other = store.createBot({}, { seedMessages: false });
  const second = store.createTask(bot.id, "Second")!;
  store.patchTask(bot.id, second.threadId, { modelSelection: { instanceId: legacy, model: "claude-company" } });
  store.setResumeCursor(bot.id, legacy, "native-session-1", bot.threadId);
  store.markTaskDispatched(bot.id, bot.threadId, legacy);
  store.setHandedMessages(bot.id, bot.threadId, legacy, { session: "native-session-1", through: "m1" } as never);
  expect(store.renameInstances(new Map([[legacy, stable]]))).toBe(1);
  const reloaded = new Store(() => ({ instanceId: "personal", model: "claude-sonnet-5" }));
  const moved = reloaded.bot(bot.id)!, task = reloaded.taskByThread(bot.id, bot.threadId)!;
  expect(moved.modelSelection).toEqual({ instanceId: stable, model: "claude-company" });
  expect(reloaded.taskByThread(bot.id, second.threadId)?.modelSelection).toEqual({ instanceId: stable, model: "claude-company" });
  expect(task.resumeCursors).toEqual({ [stable]: "native-session-1" });
  expect(task.lastInstanceId).toBe(stable);
  expect(task.handedMessages).toEqual({ [stable]: { session: "native-session-1", through: "m1" } });
  expect(reloaded.bot(other.id)?.modelSelection.instanceId).toBe("personal");
  // Idempotent: nothing left to move.
  expect(reloaded.renameInstances(new Map([[legacy, stable]]))).toBe(0);
});

it("keeps an entry that already exists under the stable id", () => {
  const store = new Store(() => ({ instanceId: "personal", model: "claude-sonnet-5" }));
  const bot = store.createBot({}, { seedMessages: false });
  store.setResumeCursor(bot.id, stable, "newer", bot.threadId);
  store.setResumeCursor(bot.id, legacy, "older", bot.threadId);
  store.renameInstances(new Map([[legacy, stable]]));
  expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({ [stable]: "newer" });
});

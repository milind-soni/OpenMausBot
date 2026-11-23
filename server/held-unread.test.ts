import { rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";

beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });

it("keeps a conversation's mark the person made with it open until its unread mark changes another way", () => {
  const store = new Store(() => ({ instanceId: "personal", model: "claude-sonnet-5" }));
  const bot = store.createBot({}, { seedMessages: false });
  const held = () => store.taskByThread(bot.id, bot.threadId)?.heldUnread;
  store.patchTask(bot.id, bot.threadId, { unread: true, heldUnread: "m1" });
  store.patchTask(bot.id, bot.threadId, { title: "Renamed" });
  expect(held(), "a change that leaves its unread mark alone").toBe("m1");
  expect(new Store(() => ({ instanceId: "personal", model: "claude-sonnet-5" })).taskByThread(bot.id, bot.threadId)?.heldUnread,
    "a restarted server").toBe("m1");
  store.patchTask(bot.id, bot.threadId, { unread: true });
  expect(held(), "a new reply's unread mark").toBeUndefined();
  store.patchTask(bot.id, bot.threadId, { unread: true, heldUnread: "m2" });
  store.patchTask(bot.id, bot.threadId, { unread: false });
  expect(held(), "a person's turn or an explicit read").toBeUndefined();
});

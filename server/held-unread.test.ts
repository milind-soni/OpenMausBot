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

it("ends the mark with anything new a bot says in it, whoever wrote it, and an emitted change, but not with its working trail", () => {
  const store = new Store(() => ({ instanceId: "personal", model: "claude-sonnet-5" }));
  const bot = store.createBot({}, { seedMessages: false });
  const held = () => store.taskByThread(bot.id, bot.threadId)?.heldUnread;
  const changes: unknown[] = [];
  store.onChange((change) => { if (change.type === "bot") changes.push(change); });
  const first = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Done." });
  store.patchTask(bot.id, bot.threadId, { unread: true, heldUnread: first.id });
  for (const kind of ["activity", "screen", "digest", "compaction"] as const) store.appendMessage(bot.threadId, { role: "bot", kind });
  expect(held(), "a bot's working trail").toBe(first.id);
  for (const said of [
    { role: "bot", kind: "text", text: "Report from another bot." },
    { role: "bot", kind: "options", card: { requestType: "question", question: "Which?", options: [] } },
  ] as const) {
    store.patchTask(bot.id, bot.threadId, { unread: true, heldUnread: store.activePath(bot.threadId).at(-1)!.id });
    changes.length = 0;
    store.appendMessage(bot.threadId, said as never);
    expect(held(), said.kind).toBeUndefined();
    expect(store.taskByThread(bot.id, bot.threadId)?.unread, "the chat stays unread").toBe(true);
    expect(changes, "every window is told").toContainEqual({ type: "bot", botId: bot.id, threadId: bot.threadId });
  }
  store.patchTask(bot.id, bot.threadId, { unread: true, heldUnread: store.activePath(bot.threadId).at(-1)!.id });
  store.insertMessageAfter(bot.threadId, first.id, { role: "bot", kind: "text", text: "A late answer under an earlier line." });
  expect(held(), "a line written under an earlier one").toBeUndefined();
  expect(new Store(() => ({ instanceId: "personal", model: "claude-sonnet-5" })).taskByThread(bot.id, bot.threadId)?.heldUnread,
    "a restarted server").toBeUndefined();
});

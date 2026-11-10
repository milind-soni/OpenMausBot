import { describe, expect, it } from "vitest";

import { isFreshStart, sinceFreshStart, startFresh } from "./fresh-start.ts";
import { Store, type Message } from "./store.ts";

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);
const row = (id: string, extra: Partial<Message> = {}): Message => ({ id, at: 1, parentId: null, role: "user", kind: "text", text: id, ...extra });
const divider = (id: string) => row(id, { role: "bot", kind: "compaction", compaction: { summary: "", firstKeptId: "", foldedThroughId: "x", tokensBefore: 0, by: "person", fresh: true } });
const summary = (id: string) => row(id, { role: "bot", kind: "compaction", compaction: { summary: "s", firstKeptId: "", foldedThroughId: "x", tokensBefore: 0, by: "harness" } });

describe("the divider's slice of a conversation", () => {
  it("is the whole path with no divider, and only what follows the newest one otherwise", () => {
    expect(ids(sinceFreshStart([row("a"), row("b")]))).toEqual(["a", "b"]);
    expect(ids(sinceFreshStart([row("a"), divider("d1"), row("b"), divider("d2"), row("c")]))).toEqual(["c"]);
    expect(ids(sinceFreshStart([row("a"), divider("d")]))).toEqual([]);
  });
  it("tells a divider from a context summary", () => {
    expect(isFreshStart(divider("d"))).toBe(true);
    expect(isFreshStart(summary("s"))).toBe(false);
    expect(ids(sinceFreshStart([row("a"), summary("s"), row("b")]))).toEqual(["a", "s", "b"]);
  });
});

describe("starting fresh", () => {
  const setup = () => {
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture-model" }));
    const bot = store.createBot({ name: "Ava", description: "Kind words" }, { seedMessages: false });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "first", at: 1 });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "second", at: 2 });
    return { store, bot };
  };

  it("clears what the next turn would resume, and leaves the bot's own setup alone", () => {
    const { store, bot } = setup();
    store.patchTask(bot.id, bot.threadId, { resumeCursors: { claude: "old-session" }, appliedCompactionId: "c", contextFloor: 9, lastContextModel: "claude:m",
      usage: { input: 5, output: 7, costUsd: 0.1, turns: 2, context: { tokens: 90_000, window: 100_000 } } });
    const setupBefore = JSON.stringify({ ...store.bot(bot.id)!, tasks: undefined, messages: undefined, threadId: undefined, activeLeafId: undefined, rewound: undefined, resumeCursors: undefined, unread: undefined, updatedAt: undefined, usage: undefined });

    const written = startFresh(store, bot.id, bot.threadId)!;
    expect(written).toMatchObject({ role: "bot", kind: "compaction", compaction: { summary: "", by: "person", fresh: true } });

    const task = store.taskByThread(bot.id, bot.threadId)!;
    expect(task).toMatchObject({ rewound: true, resumeCursors: {}, appliedCompactionId: undefined, contextFloor: undefined, lastContextModel: undefined });
    expect(task.usage).toMatchObject({ input: 5, output: 7, turns: 2 });
    expect(task.usage?.context).toBeUndefined();
    expect(sinceFreshStart(store.activePath(bot.threadId))).toEqual([]);
    expect(store.messagesFor(bot.threadId).map((m) => m.text ?? "")).toEqual(["first", "second", ""]);
    expect(JSON.stringify({ ...store.bot(bot.id)!, tasks: undefined, messages: undefined, threadId: undefined, activeLeafId: undefined, rewound: undefined, resumeCursors: undefined, unread: undefined, updatedAt: undefined, usage: undefined })).toBe(setupBefore);
  });

  it("adds one divider however many times it is pressed, and still clears the cursor", () => {
    const { store, bot } = setup();
    startFresh(store, bot.id, bot.threadId);
    store.patchTask(bot.id, bot.threadId, { resumeCursors: { claude: "stale" } });
    expect(startFresh(store, bot.id, bot.threadId)).toBeNull();
    expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({});
    expect(store.activePath(bot.threadId).filter(isFreshStart)).toHaveLength(1);
  });

  it("survives a restart", () => {
    const { store, bot } = setup();
    startFresh(store, bot.id, bot.threadId);
    const later = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "third", at: 3 });
    const reopened = new Store(() => ({ instanceId: "fixture", model: "fixture-model" }));
    expect(ids(sinceFreshStart(reopened.activePath(bot.threadId)))).toEqual([later.id]);
    expect(reopened.taskByThread(bot.id, bot.threadId)?.rewound).toBe(true);
  });
});

// Where a message lands in the branch, and what survives a restart.
//
// The compaction divider needs to be inserted at a chosen point rather than
// appended, so these are the persistence primitives it will stand on. The
// active leaf is the load-bearing part: activePath() walks root → leaf, so a
// leaf pointing at the wrong row silently truncates the visible conversation.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { Store } from "../store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

/** A second Store over the same DATA_DIR — what the next launch sees. */
const afterRestart = () => new Store(selection);

describe("insertMessageAfter", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("threads the artifact between the anchor and what followed it", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const anchor = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "done" });
    const followUp = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "and next?" });

    const shot = store.insertMessageAfter(bot.threadId, anchor.id, { role: "bot", kind: "text", text: "[screen]" });

    const path = store.activePath(bot.threadId).map((m) => m.text);
    expect(path.slice(-3)).toEqual(["done", "[screen]", "and next?"]);
    expect(store.messagesFor(bot.threadId).find((m) => m.id === followUp.id)?.parentId).toBe(shot.id);
  });

  it("keeps the branch head on the real leaf, across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const anchor = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "done" });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "and next?" });
    const leafBefore = store.activeLeaf(bot.threadId);

    store.insertMessageAfter(bot.threadId, anchor.id, { role: "bot", kind: "text", text: "[screen]" });

    // in memory the leaf never moved — the insert went behind the follow-up
    expect(store.activeLeaf(bot.threadId)).toBe(leafBefore);

    // and the durable record must agree, or the next launch walks a path
    // that stops at the inserted artifact and drops everything after it
    const reopened = afterRestart();
    expect(reopened.activeLeaf(bot.threadId)).toBe(leafBefore);
    expect(reopened.activePath(bot.threadId).map((m) => m.text).slice(-3))
      .toEqual(["done", "[screen]", "and next?"]);
  });

  it("still appends, and moves the leaf, when the anchor IS the leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const anchor = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "done" });

    const added = store.insertMessageAfter(bot.threadId, anchor.id, { role: "bot", kind: "text", text: "[screen]" });

    expect(store.activeLeaf(bot.threadId)).toBe(added.id);
    expect(afterRestart().activeLeaf(bot.threadId)).toBe(added.id);
  });
});

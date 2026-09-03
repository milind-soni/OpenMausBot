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

describe("insertMessageBefore", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("threads the divider in ahead of its target", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "one" });
    const second = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "two" });

    const divider = store.insertMessageBefore(bot.threadId, second.id, { role: "bot", kind: "text", text: "[divider]" });

    expect(divider).not.toBeNull();
    expect(divider!.parentId).toBe(first.id);
    expect(store.activePath(bot.threadId).map((m) => m.text).slice(-3))
      .toEqual(["one", "[divider]", "two"]);
  });

  it("moves ONLY the target — a sibling branch keeps its original parent", () => {
    // This is the whole point: insertMessageAfter sweeps up every child, so
    // using it here would drag abandoned forks onto the divider and make one
    // branch's compaction visible from another.
    const store = new Store(selection);
    const bot = store.createBot();
    const shared = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "shared" });
    const kept = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "kept" });
    // an edit of `kept` forks a sibling off the same parent
    const sibling = store.branchMessage(bot.threadId, kept.id, "edited");
    expect(sibling?.parentId).toBe(shared.id);

    const divider = store.insertMessageBefore(bot.threadId, kept.id, { role: "bot", kind: "text", text: "[divider]" });

    const byId = new Map(store.messagesFor(bot.threadId).map((m) => [m.id, m]));
    expect(byId.get(kept.id)?.parentId).toBe(divider!.id);
    expect(byId.get(sibling!.id)?.parentId).toBe(shared.id);
  });

  it("leaves the branch head alone, across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "one" });
    const second = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "two" });
    const leafBefore = store.activeLeaf(bot.threadId);

    store.insertMessageBefore(bot.threadId, second.id, { role: "bot", kind: "text", text: "[divider]" });

    expect(store.activeLeaf(bot.threadId)).toBe(leafBefore);
    const reopened = afterRestart();
    expect(reopened.activeLeaf(bot.threadId)).toBe(leafBefore);
    expect(reopened.activePath(bot.threadId).map((m) => m.text).slice(-3))
      .toEqual(["one", "[divider]", "two"]);
  });

  it("can take the root position", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const root = store.activePath(bot.threadId)[0];
    expect(root.parentId ?? null).toBeNull();

    const divider = store.insertMessageBefore(bot.threadId, root.id, { role: "bot", kind: "text", text: "[divider]" });

    expect(divider!.parentId ?? null).toBeNull();
    expect(store.activePath(bot.threadId)[0].text).toBe("[divider]");
  });

  it("reports an unknown target rather than guessing a position", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.insertMessageBefore(bot.threadId, "no-such-id", { role: "bot", kind: "text", text: "x" })).toBeNull();
  });
});

// Writing a compaction divider into a real branch, and refusing to when it
// no longer applies.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { Store, type CompactionRecord } from "../store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const reopen = () => new Store(selection);

const record = (over: Partial<CompactionRecord>): CompactionRecord => ({
  schemaVersion: 1,
  summary: "Earlier: they chose Postgres over SQLite and deployed to stage.",
  firstKeptId: "unset",
  throughId: "unset",
  sourceDigest: "unset",
  estimatedTokensBefore: 12_000,
  targetContextWindow: 8_000,
  createdByInstanceId: "claude",
  ...over,
});

/** A thread with `count` user/bot pairs, newest last. */
const seed = (store: Store, count: number) => {
  const bot = store.createBot();
  for (let i = 0; i < count; i += 1) {
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `ask ${i}` });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `answer ${i}` });
  }
  return bot;
};

describe("Store.insertCompaction", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("writes a divider ahead of the first kept message", () => {
    const store = new Store(selection);
    const bot = seed(store, 5);
    const context = store.modelContext(bot.threadId);
    const firstKept = context.activeMessages.at(-4)!;

    const divider = store.insertCompaction(
      bot.threadId,
      record({ firstKeptId: firstKept.id, throughId: context.activeMessages.at(-5)!.id, sourceDigest: context.digest }),
    );

    expect(divider).not.toBeNull();
    const path = store.activePath(bot.threadId);
    expect(path[path.indexOf(divider!) + 1].id).toBe(firstKept.id);
  });

  it("leaves the ENTIRE visible history above it in place", () => {
    // compaction changes what the model sees, never what the user sees
    const store = new Store(selection);
    const bot = seed(store, 5);
    const before = store.activePath(bot.threadId).map((m) => m.text);
    const context = store.modelContext(bot.threadId);

    store.insertCompaction(
      bot.threadId,
      record({ firstKeptId: context.activeMessages.at(-4)!.id, throughId: context.activeMessages.at(-5)!.id, sourceDigest: context.digest }),
    );

    const after = store.activePath(bot.threadId).filter((m) => m.kind !== "compaction").map((m) => m.text);
    expect(after).toEqual(before);
  });

  it("survives a restart", () => {
    const store = new Store(selection);
    const bot = seed(store, 5);
    const context = store.modelContext(bot.threadId);
    store.insertCompaction(
      bot.threadId,
      record({ firstKeptId: context.activeMessages.at(-4)!.id, throughId: context.activeMessages.at(-5)!.id, sourceDigest: context.digest }),
    );
    const leafBefore = store.activeLeaf(bot.threadId);

    const reopened = reopen();
    const path = reopened.activePath(bot.threadId);
    expect(path.filter((m) => m.kind === "compaction")).toHaveLength(1);
    expect(path.find((m) => m.kind === "compaction")?.compaction?.summary).toContain("Postgres");
    // a divider is never the branch head
    expect(reopened.activeLeaf(bot.threadId)).toBe(leafBefore);
  });

  it("refuses a record whose branch moved while the summary was being written", () => {
    // the realistic race: compaction is a model call, and a delegated result
    // or another turn lands during it
    const store = new Store(selection);
    const bot = seed(store, 5);
    const context = store.modelContext(bot.threadId);
    const stale = record({
      firstKeptId: context.activeMessages.at(-4)!.id,
      throughId: context.activeMessages.at(-5)!.id,
      sourceDigest: context.digest,
    });

    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "one more thing" });

    expect(store.insertCompaction(bot.threadId, stale)).toBeNull();
    expect(store.activePath(bot.threadId).some((m) => m.kind === "compaction")).toBe(false);
  });

  it("refuses a boundary that is not on this branch", () => {
    const store = new Store(selection);
    const bot = seed(store, 5);
    const context = store.modelContext(bot.threadId);
    expect(store.insertCompaction(bot.threadId, record({ firstKeptId: "no-such-id", throughId: "x", sourceDigest: context.digest })))
      .toBeNull();
  });

  it("refuses an empty summary rather than folding history behind nothing", () => {
    const store = new Store(selection);
    const bot = seed(store, 5);
    const context = store.modelContext(bot.threadId);
    expect(store.insertCompaction(bot.threadId, record({
      summary: "   ",
      firstKeptId: context.activeMessages.at(-4)!.id,
      throughId: context.activeMessages.at(-5)!.id,
      sourceDigest: context.digest,
    }))).toBeNull();
  });

  it("stacks repeated compactions on one branch", () => {
    const store = new Store(selection);
    const bot = seed(store, 8);
    for (const summary of ["first fold", "second fold"]) {
      const context = store.modelContext(bot.threadId);
      store.insertCompaction(bot.threadId, record({
        summary,
        firstKeptId: context.activeMessages.at(-4)!.id,
        throughId: context.activeMessages.at(-5)!.id,
        sourceDigest: context.digest,
      }));
    }
    const summaries = reopen().activePath(bot.threadId)
      .filter((m) => m.kind === "compaction")
      .map((m) => m.compaction?.summary);
    expect(summaries).toEqual(["first fold", "second fold"]);
  });

  it("stays on its own branch — a sibling fork never sees it", () => {
    const store = new Store(selection);
    const bot = seed(store, 5);
    const path = store.activePath(bot.threadId);
    const forkPoint = path.at(-2)!;
    const sibling = store.branchMessage(bot.threadId, forkPoint.id, "a different question");
    // branching moves the active leaf onto the sibling; go back to the
    // original branch before compacting it
    store.setActiveLeaf(bot.threadId, path.at(-1)!.id);

    const context = store.modelContext(bot.threadId);
    store.insertCompaction(bot.threadId, record({
      firstKeptId: context.activeMessages.at(-2)!.id,
      throughId: context.activeMessages.at(-3)!.id,
      sourceDigest: context.digest,
    }));

    store.setActiveLeaf(bot.threadId, sibling!.id);
    expect(store.activePath(bot.threadId).some((m) => m.kind === "compaction")).toBe(false);
  });

  it("a rewind to before the divider leaves it behind", () => {
    // A rewind is an EDIT, which forks a sibling off the edited message —
    // not setActiveLeaf, which selects a branch and descends to its newest
    // tip. Editing a turn that sits above the divider starts a branch the
    // divider was never on, so the summary does not follow the user there.
    const store = new Store(selection);
    const bot = seed(store, 6);
    const context = store.modelContext(bot.threadId);
    const early = context.activeMessages.find((m) => m.text === "ask 1")!;
    store.insertCompaction(bot.threadId, record({
      firstKeptId: context.activeMessages.at(-4)!.id,
      throughId: context.activeMessages.at(-5)!.id,
      sourceDigest: context.digest,
    }));
    expect(store.activePath(bot.threadId).some((m) => m.kind === "compaction")).toBe(true);

    const edited = store.branchMessage(bot.threadId, early.id, "ask 1, but differently");

    const path = store.activePath(bot.threadId);
    expect(path.at(-1)?.id).toBe(edited!.id);
    expect(path.some((m) => m.kind === "compaction")).toBe(false);
    // and the original branch still has it
    store.setActiveLeaf(bot.threadId, context.activeMessages.at(-1)!.id);
    expect(store.activePath(bot.threadId).some((m) => m.kind === "compaction")).toBe(true);
  });
});

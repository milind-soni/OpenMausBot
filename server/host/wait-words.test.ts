import { describe, expect, it } from "vitest";

import type { HandoffView } from "../coordinator.ts";
import { addServerLinePacks } from "../server-lines.ts";
import { createQueuedNotes, createWaitWords, QUEUED_NOTE_AFTER_MS, type QueuedNotesDeps } from "./wait-words.ts";

const words = (starter: boolean, language?: string) => {
  const held: [string, string][] = [];
  return { held, waits: createWaitWords({ language: () => language, starter: () => starter, held: (threadId, why) => held.push([threadId, why]), changed: () => {} }) };
};

describe("how a wait for memory reads", () => {
  it("names what runs and what is ahead, and that it starts by itself", () => {
    expect(words(false).waits.text("t", { first: true, running: 1, ahead: 2 }))
      .toBe("Waiting for memory on this Cloud. Running now: 1. Ahead of this one: 2. It starts by itself when there's room.");
    expect(words(false).waits.text("t", { first: false, running: 1, ahead: 0 })).toBe("Still waiting for memory. Running now: 1. Ahead of this one: 0.");
  });

  it("says a bigger plan runs more on Starter only, once, in the person's language", () => {
    expect(words(true).waits.text("t", { first: true, running: 1, ahead: 0 })).toContain("Starter has room for about one task at a time. A bigger plan runs more at once.");
    expect(words(false).waits.text("t", { first: true, running: 1, ahead: 0 })).not.toContain("Starter");
    expect(words(true).waits.text("t", { first: false, running: 1, ahead: 0 })).not.toContain("Starter");
    addServerLinePacks({ xx: { "server.memory.wait": "Warten {running}/{ahead}.", "server.memory.starter": "Größerer Plan." } });
    expect(words(true, "xx").waits.text("t", { first: true, running: 1, ahead: 0 })).toBe("Warten 1/0. Größerer Plan.");
  });

  it("records the limit and what is ahead", () => {
    const { waits, held } = words(true);
    waits.began("t", { running: 1, ahead: 3 });
    waits.began("u", { running: 2, ahead: 1, limit: 2 });
    expect(held).toEqual([["t", "memory: 1 running, 3 ahead, on Starter"], ["u", "plan: 2 at once, 1 ahead"]]);
  });

  it("names the plan's limit, not memory, when that is what the turn waits for", () => {
    expect(words(true).waits.text("t", { first: true, running: 2, ahead: 1, limit: 2 }))
      .toBe("Waiting for a turn: Starter runs 2 tasks at once on this Cloud. Ahead of this one: 1. It starts by itself when one finishes, and a bigger plan runs more at once.");
    expect(words(true).waits.text("t", { first: false, running: 2, ahead: 0, limit: 2 })).toBe("Still waiting: Starter runs 2 tasks at once. Ahead of this one: 0.");
  });
});

describe("how a held send reads", () => {
  it("says why, and offers a bigger plan only where the plan is what holds it", () => {
    expect(words(true).waits.queued("t", "capacity")).toContain("A bigger plan runs more");
    expect(words(false).waits.queued("t", "capacity")).toBe("Queued. Starts when this bot has a free thread slot.");
    expect(words(true).waits.queued("t", "group-turn")).toContain("room turn");
    expect(words(true).waits.queued("t", undefined)).toBeUndefined();
  });
});

describe("a hand-off held a while", () => {
  const node = { id: "h", threadId: "t", botId: "b", lastProgressAt: 0, status: "queued" } as HandoffView;
  const notes = (over: Partial<QueuedNotesDeps> = {}, now = QUEUED_NOTE_AFTER_MS) => {
    const posted: string[] = [];
    const note = createQueuedNotes({ now: () => now, language: () => undefined, botName: () => "Ops", parent: () => ({ threadId: "p" }) as HandoffView, post: (_p, _n, line) => posted.push(line), node: () => node,
      threadBusy: () => false, slots: () => ({ busy: [], limit: 16 }), groupTurn: () => false, waitsForComputer: () => false, behindPerson: () => undefined, ...over });
    return { note, posted };
  };

  it("says which limit, once", () => {
    const { note, posted } = notes({ slots: () => ({ busy: [{ threadId: "a", title: "A" }, { threadId: "c", title: "C" }], limit: 2 }) });
    note(node);
    note(node);
    expect(posted).toEqual(["Ops hasn't started this yet: it's already running 2 of 2 threads at once."]);
  });

  it("names an earlier turn in its thread, and a room turn", () => {
    const thread = notes({ threadBusy: () => true });
    thread.note(node);
    expect(thread.posted).toEqual(["Ops hasn't started this yet: an earlier turn in that thread is still running."]);
    const room = notes({ groupTurn: () => true });
    room.note(node);
    expect(room.posted).toEqual(["Ops hasn't started this yet: it's finishing a turn in a room."]);
  });

  it("says it once for each of several hand-offs held behind the same turn, however often the queue is checked", () => {
    const held = ["r1", "r2", "q"].map((id) => ({ ...node, id, status: id === "q" ? "queued" : "resume" }) as HandoffView);
    const posted: string[] = [];
    const { note } = notes({ threadBusy: () => true, node: (id) => held.find((n) => n.id === id), post: (_p, n) => posted.push(n.id) });
    for (let tick = 0; tick < 4; tick++) for (const n of held) note(n);
    expect(posted).toEqual(["r1", "r2", "q"]);
  });

  it("forgets a hand-off once it has started, so finished ones are not kept", () => {
    const held = new Map(["a", "b", "c"].map((id) => [id, { ...node, id, status: "resume" } as HandoffView]));
    const looked: string[] = [];
    const { note } = notes({ threadBusy: () => true, node: (id) => (looked.push(id), held.get(id)) });
    note(held.get("a")!);
    held.set("a", { ...held.get("a")!, status: "done" });
    looked.length = 0;
    note(held.get("b")!);
    expect(looked).toEqual(["a"]);
    looked.length = 0;
    note(held.get("c")!);
    expect(looked).toEqual(["b"]);
  });

  it("stays quiet for a short hold, a room's own hand-off, a computer's wait and a person's open card, which say so themselves", () => {
    const busy = { threadBusy: () => true };
    for (const { over, at, row } of [
      { over: busy, at: QUEUED_NOTE_AFTER_MS - 1, row: node },
      { over: busy, at: QUEUED_NOTE_AFTER_MS, row: { ...node, groupId: "g" } as HandoffView },
      { over: { ...busy, waitsForComputer: () => true }, at: QUEUED_NOTE_AFTER_MS, row: node },
      { over: { ...busy, behindPerson: () => ({ kind: "question" as const, title: "Pick" }) }, at: QUEUED_NOTE_AFTER_MS, row: node },
    ]) {
      const { note, posted } = notes(over, at);
      note(row);
      expect(posted).toEqual([]);
    }
  });
});

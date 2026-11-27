import { describe, expect, it } from "vitest";

import { BOARD_LIMITS, type BoardItem, type BoardItemState } from "../../shared/board.ts";
import {
  applyMove, boardLabels, boardNeeds, boardResult, boardTitle, BoardError, closesCycle, promote, startState, withoutItems,
  type BoardActor, type BoardMove,
} from "./state.ts";

const T = 1_700_000_000_000;
const PERSON: BoardActor = { kind: "person", person: "p_mira" };
const DISPATCHER: BoardActor = { kind: "dispatcher" };
const HOLDER: BoardActor = { kind: "bot", botId: "scout" };
const OTHER_BOT: BoardActor = { kind: "bot", botId: "payroll" };
const STATES: BoardItemState[] = ["waiting", "ready", "working", "needs_person", "done", "failed", "cancelled"];

function item(over: Partial<BoardItem> = {}): BoardItem {
  return {
    threadId: "t1", groupId: "g1", title: "Write the brief", state: "ready", needs: [], labels: {}, attempts: 0,
    createdBy: { kind: "person", id: "p_mira", name: "Mira" }, createdAt: T, updatedAt: T, ...over,
  };
}
const inState = (state: BoardItemState): BoardItem => item({
  state, ...(state === "working" || state === "needs_person" ? { holder: { botId: "scout", since: T } } : {}),
  ...(state === "needs_person" ? { question: { text: "Which client?", askedAt: T } } : {}),
});

const MOVES: Record<BoardMove["move"], BoardMove> = {
  take: { move: "take", botId: "scout" }, done: { move: "done", result: "Shipped" }, failed: { move: "failed", result: "No access" },
  ask: { move: "ask", question: "Which client?" }, resume: { move: "resume" }, release: { move: "release" },
  cancel: { move: "cancel" }, reopen: { move: "reopen" }, later: { move: "later", at: T + 60_000, note: "See CI" }, wake: { move: "wake" },
};

/** Every move each actor may make, by state: anything not listed is refused. */
const ALLOWED: Record<string, Array<[BoardItemState, BoardMove["move"], BoardActor]>> = {
  dispatcher: [
    ["ready", "take", DISPATCHER], ["working", "done", DISPATCHER], ["working", "failed", DISPATCHER], ["working", "release", DISPATCHER],
    ["needs_person", "resume", DISPATCHER], ["needs_person", "release", DISPATCHER],
  ],
  holder: [["working", "done", HOLDER], ["working", "failed", HOLDER], ["working", "ask", HOLDER], ["working", "release", HOLDER], ["working", "later", HOLDER]],
  person: [
    ["waiting", "done", PERSON], ["ready", "done", PERSON], ["working", "done", PERSON], ["needs_person", "done", PERSON],
    ["needs_person", "release", PERSON],
    ["waiting", "cancel", PERSON], ["ready", "cancel", PERSON], ["working", "cancel", PERSON], ["needs_person", "cancel", PERSON],
    ["done", "reopen", PERSON], ["failed", "reopen", PERSON], ["cancelled", "reopen", PERSON],
  ],
};

describe("moves", () => {
  const actors: Array<[string, BoardActor]> = [["dispatcher", DISPATCHER], ["holder", HOLDER], ["person", PERSON], ["other bot", OTHER_BOT]];
  for (const [name, actor] of actors) {
    for (const state of STATES) {
      for (const move of Object.keys(MOVES) as Array<BoardMove["move"]>) {
        const ok = (ALLOWED[name] ?? []).some(([s, m]) => s === state && m === move);
        it(`${name} ${ok ? "may" : "may not"} ${move} a ${state} item`, () => {
          const run = () => applyMove(inState(state), MOVES[move], actor, [], T + 1);
          if (ok) expect(run().updatedAt).toBe(T + 1);
          else expect(run).toThrow(expect.objectContaining({ status: 409, code: "board_bad_move" }));
        });
      }
    }
  }

  it("a bot cancels only an open item it made", () => {
    const made = item({ createdBy: { kind: "bot", id: "payroll", name: "Payroll" } });
    expect(applyMove(made, { move: "cancel", result: "Not needed" }, OTHER_BOT, [], T + 1)).toMatchObject({ state: "cancelled", result: "Not needed" });
    expect(() => applyMove(made, { move: "cancel" }, HOLDER, [], T + 1)).toThrow(BoardError);
    expect(() => applyMove({ ...made, state: "done" }, { move: "cancel" }, OTHER_BOT, [], T + 1)).toThrow(BoardError);
  });

  it("take sets the holder and counts the attempt; done clears the holder and keeps the result", () => {
    const taken = applyMove(item({ attempts: 1 }), { move: "take", botId: "scout" }, DISPATCHER, [], T + 5);
    expect(taken).toMatchObject({ state: "working", holder: { botId: "scout", since: T + 5 }, attempts: 2 });
    const done = applyMove(taken, { move: "done", result: "Shipped" }, HOLDER, [], T + 9);
    expect(done).toMatchObject({ state: "done", result: "Shipped", attempts: 2 });
    expect(done.holder).toBeUndefined();
  });

  it("ask keeps the holder and the question; resume goes back to the same bot", () => {
    const working = inState("working");
    const asked = applyMove(working, { move: "ask", question: "  Which client?  ", person: "p_mira" }, HOLDER, [], T + 3);
    expect(asked).toMatchObject({ state: "needs_person", holder: { botId: "scout" }, question: { text: "Which client?", askedAt: T + 3, person: "p_mira" } });
    const resumed = applyMove(asked, { move: "resume" }, DISPATCHER, [], T + 7);
    expect(resumed).toMatchObject({ state: "working", holder: { botId: "scout", since: T + 7 } });
    expect(resumed.question).toBeUndefined();
    expect(() => applyMove(working, { move: "ask", question: " " }, HOLDER, [], T)).toThrow(expect.objectContaining({ code: "board_bad_input" }));
    expect(() => applyMove(working, { move: "ask", question: "x".repeat(BOARD_LIMITS.questionMax + 1) }, HOLDER, [], T)).toThrow(BoardError);
  });

  it("release frees the item for any bot", () => {
    const released = applyMove(inState("needs_person"), { move: "release" }, PERSON, [], T + 1);
    expect(released.state).toBe("ready");
    expect(released.holder).toBeUndefined();
    expect(released.question).toBeUndefined();
  });

  it("reopen resets the tries and the result, and waits again when a need is not done", () => {
    const failed = item({ state: "failed", attempts: 3, result: "Stopped after 3 tries" });
    const reopened = applyMove(failed, { move: "reopen" }, PERSON, [failed], T + 1);
    expect(reopened).toMatchObject({ state: "ready", attempts: 0 });
    expect(reopened.result).toBeUndefined();
    const need = item({ threadId: "t0", state: "working" });
    const dependent = item({ state: "cancelled", needs: ["t0"] });
    expect(applyMove(dependent, { move: "reopen" }, PERSON, [need, dependent], T + 1).state).toBe("waiting");
  });

  it("refuses a result over the limit", () => {
    expect(() => applyMove(inState("working"), { move: "done", result: "x".repeat(BOARD_LIMITS.resultMax + 1) }, HOLDER, [], T)).toThrow(expect.objectContaining({ code: "board_bad_input" }));
  });
});

describe("needs", () => {
  const board = (states: Record<string, BoardItemState>, needs: Record<string, string[]> = {}) =>
    Object.entries(states).map(([threadId, state]) => item({ threadId, state, needs: needs[threadId] ?? [] }));

  it("a new item waits while any need is not done", () => {
    const items = board({ a: "done", b: "working" });
    expect(startState({ needs: ["a"] }, items)).toBe("ready");
    expect(startState({ needs: ["a", "b"] }, items)).toBe("waiting");
    expect(startState({ needs: [] }, items)).toBe("ready");
  });

  it("a waiting item is ready only when every need is done", () => {
    const items = board({ a: "done", b: "working", c: "waiting" }, { c: ["a", "b"] });
    expect(promote(items, T + 1).find((one) => one.threadId === "c")!.state).toBe("waiting");
    const both = board({ a: "done", b: "done", c: "waiting" }, { c: ["a", "b"] });
    const promoted = promote(both, T + 1).find((one) => one.threadId === "c")!;
    expect(promoted).toMatchObject({ state: "ready", updatedAt: T + 1 });
  });

  it("a failed or cancelled need readies nothing", () => {
    for (const state of ["failed", "cancelled"] as const) {
      const items = board({ a: state, c: "waiting" }, { c: ["a"] });
      expect(promote(items, T + 1).find((one) => one.threadId === "c")!.state).toBe("waiting");
    }
  });

  it("promote leaves every other item as it was", () => {
    const items = board({ a: "done", b: "ready", c: "waiting" }, { c: ["a"] });
    const after = promote(items, T + 1);
    expect(after[0]).toBe(items[0]);
    expect(after[1]).toBe(items[1]);
  });

  it("refuses a cycle, a need on itself, one in another room, an unknown one, and more than ten", () => {
    const items = board({ a: "ready", b: "waiting", c: "waiting" }, { b: ["a"], c: ["b"] });
    expect(closesCycle(items, "a", ["c"])).toBe(true);
    expect(() => boardNeeds(["c"], items, { threadId: "a", groupId: "g1" })).toThrow(expect.objectContaining({ status: 409, code: "board_cycle" }));
    expect(() => boardNeeds(["a"], items, { threadId: "a", groupId: "g1" })).toThrow(expect.objectContaining({ code: "board_bad_input" }));
    expect(() => boardNeeds(["zz"], items, { threadId: "n", groupId: "g1" })).toThrow(expect.objectContaining({ code: "board_bad_input" }));
    expect(() => boardNeeds(["a"], [...items, item({ threadId: "x", groupId: "g2" })], { threadId: "x2", groupId: "g2" })).toThrow(BoardError);
    expect(() => boardNeeds([{}], items, { threadId: "n", groupId: "g1" })).toThrow(BoardError);
    const many = Array.from({ length: BOARD_LIMITS.needsMax + 1 }, (_, i) => item({ threadId: `m${i}` }));
    expect(() => boardNeeds(many.map((one) => one.threadId), many, { threadId: "n", groupId: "g1" })).toThrow(BoardError);
    expect(boardNeeds(many.slice(0, BOARD_LIMITS.needsMax).map((one) => one.threadId), many, { threadId: "n", groupId: "g1" })).toHaveLength(BOARD_LIMITS.needsMax);
    expect(boardNeeds(["a", "a", "b"], items, { threadId: "n", groupId: "g1" })).toEqual(["a", "b"]);
  });

  it("an item that leaves the board stops being needed, and what that readies is ready", () => {
    const items = board({ a: "working", b: "done", c: "waiting" }, { c: ["a", "b"] });
    const after = withoutItems(items, new Set(["a"]), T + 2);
    expect(after.map((one) => one.threadId)).toEqual(["b", "c"]);
    expect(after.find((one) => one.threadId === "c")).toMatchObject({ needs: ["b"], state: "ready" });
  });
});

describe("fields", () => {
  it("titles: one line, at most 120 characters, not empty", () => {
    expect(boardTitle("  Write\nthe   brief ")).toBe("Write the brief");
    expect(boardTitle("x".repeat(BOARD_LIMITS.titleMax))).toHaveLength(BOARD_LIMITS.titleMax);
    for (const bad of ["", "   ", 3, undefined, "x".repeat(BOARD_LIMITS.titleMax + 1)]) {
      expect(() => boardTitle(bad), String(bad)).toThrow(expect.objectContaining({ status: 400, code: "board_bad_input" }));
    }
  });

  it("labels: at most 12, keys of lowercase letters, digits, _ and -, values of at most 80 characters", () => {
    expect(boardLabels({ area: " billing ", "due-by_2": "Friday" })).toEqual({ area: "billing", "due-by_2": "Friday" });
    expect(boardLabels(undefined)).toEqual({});
    const twelve = Object.fromEntries(Array.from({ length: BOARD_LIMITS.labelsMax }, (_, i) => [`k${i}`, "v"]));
    expect(Object.keys(boardLabels(twelve))).toHaveLength(BOARD_LIMITS.labelsMax);
    for (const bad of [
      { ...twelve, k99: "v" }, { Area: "x" }, { "a b": "x" }, { ["k".repeat(BOARD_LIMITS.labelKeyMax + 1)]: "x" }, { "": "x" },
      { area: "x".repeat(BOARD_LIMITS.labelValueMax + 1) }, { area: 3 }, ["area"], "area", null,
    ]) {
      expect(() => boardLabels(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: "board_bad_input" }));
    }
    expect(boardLabels({ ["k".repeat(BOARD_LIMITS.labelKeyMax)]: "x".repeat(BOARD_LIMITS.labelValueMax) })).toBeTruthy();
  });

  it("results: text of at most 2,000 characters; blank is none", () => {
    expect(boardResult(undefined)).toBeUndefined();
    expect(boardResult("  ")).toBeUndefined();
    expect(boardResult("x".repeat(BOARD_LIMITS.resultMax))).toHaveLength(BOARD_LIMITS.resultMax);
    expect(() => boardResult(5)).toThrow(BoardError);
  });
});

describe("later", () => {
  const working = inState("working");
  it("keeps the item working with its holder, notes when and why, and counts it", () => {
    const set = applyMove(working, { move: "later", at: T + 300_000, note: " See CI " }, HOLDER, [], T + 1);
    expect(set).toMatchObject({ state: "working", holder: { botId: "scout", since: T }, later: { at: T + 300_000, note: "See CI" }, laterCount: 1, attempts: 0 });
  });
  it("needs a note and a time ahead", () => {
    expect(() => applyMove(working, { move: "later", at: T + 60_000, note: " " }, HOLDER, [], T + 1)).toThrow(expect.objectContaining({ code: "board_bad_input" }));
    expect(() => applyMove(working, { move: "later", at: T, note: "See CI" }, HOLDER, [], T + 1)).toThrow(expect.objectContaining({ code: "board_bad_input" }));
  });
  it(`is refused after ${BOARD_LIMITS.latersMax} times`, () => {
    const many = item({ state: "working", holder: { botId: "scout", since: T }, laterCount: BOARD_LIMITS.latersMax });
    expect(() => applyMove(many, { move: "later", at: T + 60_000, note: "Again" }, HOLDER, [], T + 1)).toThrow(expect.objectContaining({ code: "board_bad_move" }));
  });
  it("wakes only by the dispatcher, back to the same holder, counting no attempt", () => {
    const set = applyMove(working, { move: "later", at: T + 60_000, note: "See CI" }, HOLDER, [], T + 1);
    expect(() => applyMove(set, { move: "wake" }, HOLDER, [], T + 2)).toThrow(expect.objectContaining({ code: "board_bad_move" }));
    const woken = applyMove(set, { move: "wake" }, DISPATCHER, [], T + 60_000);
    expect(woken).toMatchObject({ state: "working", holder: { botId: "scout", since: T + 60_000 }, attempts: 0, laterCount: 1 });
    expect(woken.later).toBeUndefined();
  });
  it("is cleared by every move that settles, releases or asks, and its count by a reopen", () => {
    const set = applyMove(working, { move: "later", at: T + 60_000, note: "See CI" }, HOLDER, [], T + 1);
    for (const move of [MOVES.done, MOVES.failed, MOVES.release, MOVES.ask]) expect(applyMove(set, move, HOLDER, [], T + 2).later).toBeUndefined();
    const done = applyMove(set, MOVES.done, HOLDER, [], T + 2);
    expect(applyMove(done, MOVES.reopen, PERSON, [], T + 3).laterCount).toBeUndefined();
  });
  it("resumes a waiting item with a later the dispatcher starts", () => {
    const asked = inState("needs_person");
    const resumed = applyMove(asked, { move: "resume", later: { at: T + 5, note: "Mira answered" } }, DISPATCHER, [], T + 5);
    expect(resumed).toMatchObject({ state: "working", holder: { botId: "scout", since: T + 5 }, later: { at: T + 5, note: "Mira answered" } });
    expect(resumed.question).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { BOARD_COLUMNS, cardTone, dropTargets, groupByStatus, raiseStep, spendLabel, type BoardTaskView } from "./task-board-view";

const task = (over: Partial<BoardTaskView>): BoardTaskView => ({
  id: "t", title: "x", body: "", status: "todo", assigneeBotId: null, createdByBotId: null, priority: 0, threadId: null,
  result: null, blockedReason: null, attempts: 0, createdAt: 1, updatedAt: 1, startedAt: null, heartbeatAt: null, finishedAt: null,
  owner: null, dueAt: null, budgetUsd: null, spentUsd: 0, unpricedTurns: 0, gates: null, gatesAt: null, hold: null, ...over,
});

describe("the board view", () => {
  it("shows six columns in the board's own order and hides archived work", () => {
    expect(BOARD_COLUMNS).toEqual(["todo", "ready", "running", "blocked", "review", "done"]);
    const grouped = groupByStatus([task({ id: "a", status: "done" }), task({ id: "b", status: "todo" }), task({ id: "c", status: "archived" }), task({ id: "d", status: "todo", updatedAt: 9 })]);
    expect(grouped.todo.map((t) => t.id)).toEqual(["d", "b"]); // newest first
    expect(grouped.done.map((t) => t.id)).toEqual(["a"]);
    expect("archived" in grouped).toBe(false);
  });
  it("raises a cap by the cap itself, never under a dollar — the pause card's rule", () => {
    expect(raiseStep(0.02)).toBe(1);
    expect(raiseStep(3)).toBe(3);
    expect(raiseStep(null)).toBe(1);
  });
  it("labels spend against the cap, or alone, or not at all", () => {
    expect(spendLabel(task({ spentUsd: 0.111, budgetUsd: 0.08 }))).toBe("$0.11 of $0.08");
    expect(spendLabel(task({ spentUsd: 0.05 }))).toBe("$0.05");
    expect(spendLabel(task({}))).toBe("");
  });
  it("tones a card by what needs a person: paused or blocked is danger, waiting is warning, review is accent", () => {
    expect(cardTone(task({ status: "blocked", blockedReason: "paused, needs a budget increase" }))).toBe("danger");
    expect(cardTone(task({ status: "ready", hold: "Momo is on ask" }))).toBe("warning");
    expect(cardTone(task({ status: "review" }))).toBe("accent");
    expect(cardTone(task({ status: "review", gates: { results: [{ name: "test", status: "fail", seconds: 1, tail: "" }], scope: "Gates: test fail (1 s)." } }))).toBe("danger");
    expect(cardTone(task({ status: "todo" }))).toBe("none");
  });
  it("lets a card be dragged only onto columns the board would accept, the person's moves only", () => {
    expect(dropTargets("todo")).toEqual(["ready"]);
    expect(dropTargets("ready")).toEqual([]); // the dispatcher owns what happens next
    expect(dropTargets("running")).toEqual([]);
    expect(dropTargets("blocked")).toEqual(["ready"]);
    expect(dropTargets("review")).toEqual(["done", "ready"]);
    expect(dropTargets("done")).toEqual([]);
  });
});

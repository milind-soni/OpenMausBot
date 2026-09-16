// The pause card (Phase 2, budget defaults): raised once per paused task in
// its run thread, three fixed answers, each a one-tap outcome on the board.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DATA = mkdtempSync(join(tmpdir(), "omb-budget-card-"));
vi.mock("./config.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("./config.ts")>()), DATA_DIR: DATA }));

const board = await import("./task-board.ts");
const { allowMoreLabel, BUDGET_CARD_NO_CAP, BUDGET_CARD_STOP, forgetBudgetCards, raiseBudgetCard, resolveBudgetCard } = await import("./budget-card.ts");
const { closeMessageDb } = await import("./message-db.ts");
const { Store } = await import("./store.ts");

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

function pausedTask(store: InstanceType<typeof Store>, budget = 0.5) {
  const bot = store.createBot();
  const run = store.createTask(bot.id, "run", false)!;
  const task = board.createTask({ title: "Invoice Acme", assigneeBotId: bot.id, budgetUsd: budget });
  board.setStatus(task.id, "ready");
  board.claimTask(task.id);
  board.attachThread(task.id, run.threadId);
  board.bookSpend(task.id, budget + 0.1);
  return { bot, threadId: run.threadId, task: board.getTask(task.id)! };
}

describe("the pause card", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA, { recursive: true, force: true });
    board.openBoard(join(DATA, "board.db"));
    forgetBudgetCards();
  });

  it("is raised once in the run thread with the three answers", () => {
    const store = new Store(selection);
    const { threadId, task } = pausedTask(store);
    expect(task.status).toBe("blocked");
    const card = raiseBudgetCard(store, task)!;
    expect(card.kind).toBe("options");
    expect(card.card).toMatchObject({ fixedOptions: true, options: [allowMoreLabel(1), BUDGET_CARD_NO_CAP, BUDGET_CARD_STOP] });
    expect(card.card!.title).toContain("Paused at $0.60");
    expect(raiseBudgetCard(store, task)).toBeNull();
    expect(store.messagesFor(threadId).filter((m) => m.kind === "options")).toHaveLength(1);
  });

  it("allow-more raises the cap by the step and the task runs again; the card is marked answered", () => {
    const store = new Store(selection);
    const { threadId, task } = pausedTask(store);
    const card = raiseBudgetCard(store, task)!;
    expect(resolveBudgetCard(store, card.card!.requestId!, allowMoreLabel(1))).toBe(true);
    expect(board.getTask(task.id)).toMatchObject({ status: "ready", budgetUsd: 1.6, blockedReason: null });
    expect(store.messagesFor(threadId).find((m) => m.id === card.id)?.card?.answered).toBe("answer");
    expect(store.messagesFor(threadId).at(-1)?.tool?.name).toContain("budget raised to $1.60");
    expect(resolveBudgetCard(store, card.card!.requestId!, allowMoreLabel(1))).toBe(false);
  });

  it("no-cap removes the cap and stop archives the task; an unknown request is not ours", () => {
    const store = new Store(selection);
    const a = pausedTask(store);
    resolveBudgetCard(store, raiseBudgetCard(store, a.task)!.card!.requestId!, BUDGET_CARD_NO_CAP);
    expect(board.getTask(a.task.id)).toMatchObject({ status: "ready", budgetUsd: null });
    const b = pausedTask(store);
    resolveBudgetCard(store, raiseBudgetCard(store, b.task)!.card!.requestId!, BUDGET_CARD_STOP);
    expect(board.getTask(b.task.id)?.status).toBe("archived");
    expect(resolveBudgetCard(store, "not-a-card", "x")).toBe(false);
  });
});

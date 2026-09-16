import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DATA = mkdtempSync(join(tmpdir(), "omb-board-"));
vi.mock("./config.ts", () => ({ DATA_DIR: DATA }));

const board = await import("./task-board.ts");

describe("the board", () => {
  beforeEach(() => board.openBoard(join(DATA, `board-${Math.random()}.db`)));

  it("creates a task in todo and writes 0600", () => {
    const task = board.createTask({ title: "Write the changelog" });
    expect(task.status).toBe("todo");
    expect(task.attempts).toBe(0);
    expect(statSync(board.boardFile()).mode & 0o777).toBe(0o600);
  });

  it("keeps a gate run on the task, and it survives a reopen (Phase 3 part 1)", () => {
    const file = join(DATA, "gates.db");
    board.openBoard(file);
    const created = board.createTask({ title: "Ship it" });
    expect(created.gates).toBeNull();
    const results = [{ name: "typecheck", status: "pass" as const, seconds: 3, tail: "" }, { name: "test", status: "fail" as const, seconds: 9, tail: "2 failed" }];
    const stamped = board.setGates(created.id, results, "Gates: typecheck pass (3 s), test fail (9 s).");
    expect(stamped.gates).toEqual({ results, scope: "Gates: typecheck pass (3 s), test fail (9 s)." });
    expect(stamped.gatesAt).toBeGreaterThan(0);
    board.openBoard(file);
    expect(board.getTask(created.id)?.gates?.results[1].tail).toBe("2 failed");
  });
  it("survives a reopen", () => {
    const file = join(DATA, "persist.db");
    board.openBoard(file);
    const created = board.createTask({ title: "Outlive the process" });
    board.openBoard(file);
    expect(board.getTask(created.id)?.title).toBe("Outlive the process");
  });

  it("lists newest-first within a priority", () => {
    board.createTask({ title: "low" });
    board.createTask({ title: "high", priority: 5 });
    expect(board.listTasks().map((t) => t.title)).toEqual(["high", "low"]);
  });
});

describe("transitions", () => {
  beforeEach(() => board.openBoard(join(DATA, `t-${Math.random()}.db`)));

  it("walks the happy path and stamps the clocks", () => {
    const task = board.createTask({ title: "ship it" });
    expect(board.setStatus(task.id, "ready").status).toBe("ready");
    const running = board.setStatus(task.id, "running", { threadId: "thread-9" });
    expect(running.startedAt).toBeGreaterThan(0);
    expect(running.threadId).toBe("thread-9");
    expect(running.attempts).toBe(1);
    const reviewed = board.setStatus(task.id, "review", { result: "shipped" });
    expect(reviewed.finishedAt).toBeGreaterThan(0);
    expect(board.setStatus(task.id, "done").status).toBe("done");
  });

  it("refuses an illegal move", () => {
    const task = board.createTask({ title: "no shortcuts" });
    expect(() => board.setStatus(task.id, "running")).toThrow(/todo → running/);
    expect(() => board.setStatus(task.id, "done")).toThrow(/todo → done/);
  });

  it("counts an attempt per claim, so a reclaimed task cannot loop forever", () => {
    const task = board.createTask({ title: "flaky" });
    board.setStatus(task.id, "ready");
    board.setStatus(task.id, "running");
    board.setStatus(task.id, "ready"); // reclaimed
    expect(board.setStatus(task.id, "running").attempts).toBe(2);
  });

  it("records a block reason and clears it on the way out", () => {
    const task = board.createTask({ title: "needs a key" });
    board.setStatus(task.id, "ready");
    board.setStatus(task.id, "running");
    expect(board.setStatus(task.id, "blocked", { blockedReason: "no GitHub token" }).blockedReason)
      .toBe("no GitHub token");
    expect(board.setStatus(task.id, "ready").blockedReason).toBeNull();
  });
});

describe("links", () => {
  beforeEach(() => board.openBoard(join(DATA, `l-${Math.random()}.db`)));

  it("reports a child as not promotable until every parent is done", () => {
    const a = board.createTask({ title: "design" });
    const b = board.createTask({ title: "build" });
    const child = board.createTask({ title: "ship", parentIds: [a.id, b.id] });
    expect(board.parentsOf(child.id).map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(board.promotable().map((t) => t.id)).not.toContain(child.id);

    for (const parent of [a, b]) {
      board.setStatus(parent.id, "ready");
      board.setStatus(parent.id, "running");
      board.setStatus(parent.id, "review");
      board.setStatus(parent.id, "done");
    }
    expect(board.promotable().map((t) => t.id)).toContain(child.id);
  });

  it("treats an archived parent as satisfied, so an abandoned branch cannot wedge the board", () => {
    const parent = board.createTask({ title: "abandoned" });
    const child = board.createTask({ title: "downstream", parentIds: [parent.id] });
    board.setStatus(parent.id, "archived");
    expect(board.promotable().map((t) => t.id)).toContain(child.id);
  });
});

describe("comments", () => {
  beforeEach(() => board.openBoard(join(DATA, `c-${Math.random()}.db`)));

  it("keeps comments oldest-first and attributes the author", () => {
    const task = board.createTask({ title: "discuss" });
    board.addComment(task.id, "bot-1", "starting on this");
    board.addComment(task.id, null, "hold off until Friday");
    expect(board.commentsOf(task.id).map((c) => c.botId)).toEqual(["bot-1", null]);
  });
});

describe("heartbeat and staleness", () => {
  beforeEach(() => board.openBoard(join(DATA, `h-${Math.random()}.db`)));

  it("bumps heartbeatAt for a running task", () => {
    const task = board.createTask({ title: "long haul" });
    board.setStatus(task.id, "ready");
    const running = board.setStatus(task.id, "running");
    const bumped = board.heartbeat(task.id);
    expect(bumped.status).toBe("running");
    expect(bumped.heartbeatAt).toBeGreaterThanOrEqual(running.heartbeatAt ?? 0);
  });

  it("refuses to heartbeat a task that isn't running", () => {
    const task = board.createTask({ title: "not started yet" });
    expect(() => board.heartbeat(task.id)).toThrow(/running/);
  });

  it("finds a running task whose heartbeat is older than the cutoff", () => {
    const task = board.createTask({ title: "flatlined" });
    board.setStatus(task.id, "ready");
    board.setStatus(task.id, "running");
    expect(board.staleRunning(Date.now() + 1000).map((t) => t.id)).toContain(task.id);
    expect(board.staleRunning(Date.now() - 1000).map((t) => t.id)).not.toContain(task.id);
  });

  it("excludes tasks that are not running from staleness", () => {
    const task = board.createTask({ title: "idle" });
    expect(board.staleRunning(Date.now() + 1000).map((t) => t.id)).not.toContain(task.id);
  });
});

describe("attachThread", () => {
  beforeEach(() => board.openBoard(join(DATA, `a-${Math.random()}.db`)));

  it("records the thread a running task executed in without changing its status", () => {
    const task = board.createTask({ title: "long haul" });
    board.setStatus(task.id, "ready");
    board.setStatus(task.id, "running");
    const withThread = board.attachThread(task.id, "thread-42");
    expect(withThread.status).toBe("running");
    expect(withThread.threadId).toBe("thread-42");
  });

  it("throws for a task that does not exist", () => {
    expect(() => board.attachThread("no-such-id", "thread-1")).toThrow(/no such task/);
  });
});

describe("patchTask", () => {
  beforeEach(() => board.openBoard(join(DATA, `p-${Math.random()}.db`)));

  it("updates only the fields given, leaving the rest untouched", () => {
    const task = board.createTask({ title: "draft", body: "first pass", priority: 0 });
    const patched = board.patchTask(task.id, { title: "final", priority: 3 });
    expect(patched.title).toBe("final");
    expect(patched.priority).toBe(3);
    expect(patched.body).toBe("first pass");
    expect(patched.status).toBe("todo");
  });

  it("assigns and then unassigns a bot, distinguishing omitted from null", () => {
    const task = board.createTask({ title: "needs an owner" });
    expect(board.patchTask(task.id, { assigneeBotId: "bot-1" }).assigneeBotId).toBe("bot-1");
    // Omitted entirely: assigneeBotId must survive untouched.
    expect(board.patchTask(task.id, { priority: 1 }).assigneeBotId).toBe("bot-1");
    // Explicit null: clears it.
    expect(board.patchTask(task.id, { assigneeBotId: null }).assigneeBotId).toBeNull();
  });

  it("throws for a task that does not exist", () => {
    expect(() => board.patchTask("no-such-id", { title: "x" })).toThrow(/no such task/);
  });
});

describe("claimTask and releaseClaim", () => {
  beforeEach(() => board.openBoard(join(DATA, `c-${Math.random()}.db`)));

  it("claims a ready task once, charging exactly one attempt", () => {
    const task = board.createTask({ title: "one winner", assigneeBotId: "bot-1" });
    board.setStatus(task.id, "ready");
    const claimed = board.claimTask(task.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.heartbeatAt).toBeGreaterThan(0);
    // A second caller — another tick, or a second process over the same
    // ~/.openmausbot — finds the row already out of "ready" and loses.
    expect(board.claimTask(task.id)).toBeNull();
    expect(board.getTask(task.id)?.attempts).toBe(1);
  });

  it("refuses to claim anything that is not ready", () => {
    const task = board.createTask({ title: "still todo" });
    expect(board.claimTask(task.id)).toBeNull();
    expect(board.claimTask("no-such-task")).toBeNull();
    expect(board.getTask(task.id)?.status).toBe("todo");
  });

  it("refunds the attempt of a claim whose turn never started", () => {
    const task = board.createTask({ title: "never started", assigneeBotId: "bot-1" });
    board.setStatus(task.id, "ready");
    board.claimTask(task.id);
    const released = board.releaseClaim(task.id);
    expect(released.status).toBe("ready");
    expect(released.attempts).toBe(0);
    expect(released.heartbeatAt).toBeNull();
  });

  it("leaves a task that is no longer running exactly as it found it", () => {
    const task = board.createTask({ title: "settled elsewhere", assigneeBotId: "bot-1" });
    board.setStatus(task.id, "ready");
    board.claimTask(task.id);
    board.setStatus(task.id, "review");
    const released = board.releaseClaim(task.id);
    expect(released.status).toBe("review");
    expect(released.attempts).toBe(1);
    expect(() => board.releaseClaim("no-such-task")).toThrow(/no such task/);
  });
});

describe("input caps", () => {
  beforeEach(() => board.openBoard(join(DATA, `l-${Math.random()}.db`)));

  it("clamps a title, a body and a comment to their caps rather than storing them whole", () => {
    const task = board.createTask({ title: "t".repeat(500), body: "b".repeat(20_000) });
    expect(task.title).toHaveLength(board.TASK_TITLE_MAX);
    expect(task.body).toHaveLength(board.TASK_BODY_MAX);
    const patched = board.patchTask(task.id, { title: "n".repeat(500) });
    expect(patched.title).toHaveLength(board.TASK_TITLE_MAX);
    const comment = board.addComment(task.id, null, "c".repeat(20_000));
    expect(comment.text).toHaveLength(board.TASK_COMMENT_MAX);
    expect(board.commentsOf(task.id)[0].text).toHaveLength(board.TASK_COMMENT_MAX);
  });

  it("returns the most recent page of comments, oldest-first, never the whole history", () => {
    const task = board.createTask({ title: "chatty" });
    for (let i = 0; i < 10; i++) board.addComment(task.id, null, `comment ${i}`);
    const page = board.commentsOf(task.id, 3);
    expect(page.map((comment) => comment.text)).toEqual(["comment 7", "comment 8", "comment 9"]);
    expect(board.commentsOf(task.id)).toHaveLength(10);
  });
});

describe("visibleTo", () => {
  beforeEach(() => board.openBoard(join(DATA, `v-${Math.random()}.db`)));

  it("hides another section's work while keeping a reader's own and the unowned", () => {
    const mine = board.createTask({ title: "mine", assigneeBotId: "me" });
    const filedForMe = board.createTask({ title: "filed for me", createdByBotId: "peer", assigneeBotId: "me" });
    const peers = board.createTask({ title: "a peer's", assigneeBotId: "peer" });
    const strangers = board.createTask({ title: "another section's", assigneeBotId: "stranger" });
    const strangerFiled = board.createTask({ title: "filed by a stranger", createdByBotId: "stranger" });
    const unowned = board.createTask({ title: "a human filed this" });

    const reachable = new Set(["me", "peer"]);
    const seen = board.visibleTo(board.listTasks(), (botId) => reachable.has(botId)).map((task) => task.id);

    expect(seen).toContain(mine.id);
    expect(seen).toContain(filedForMe.id);
    expect(seen).toContain(peers.id);
    expect(seen).toContain(unowned.id);
    expect(seen).not.toContain(strangers.id);
    expect(seen).not.toContain(strangerFiled.id);
  });
});

describe("owner, due date, budget and result (Phase 2 part 1)", () => {
  beforeEach(() => board.openBoard(join(DATA, `b-${Math.random()}.db`)));

  it("round-trips owner, dueAt and budgetUsd, and patches them", () => {
    const task = board.createTask({ title: "Invoice Acme", owner: "person", dueAt: 1_800_000_000_000, budgetUsd: 2 });
    expect(task).toMatchObject({ owner: "person", dueAt: 1_800_000_000_000, budgetUsd: 2, spentUsd: 0, unpricedTurns: 0 });
    const patched = board.patchTask(task.id, { owner: "bot-1", dueAt: null, budgetUsd: 3 });
    expect(patched).toMatchObject({ owner: "bot-1", dueAt: null, budgetUsd: 3 });
    expect(board.createTask({ title: "no cap" })).toMatchObject({ owner: null, dueAt: null, budgetUsd: null });
  });

  it("adds the columns to a board file written before this part", () => {
    const file = join(DATA, `old-${Math.random()}.db`);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, assignee_bot_id TEXT, created_by_bot_id TEXT, priority INTEGER NOT NULL DEFAULT 0, thread_id TEXT, result TEXT, blocked_reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, heartbeat_at INTEGER, finished_at INTEGER);
      INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES ('t-old', 'old row', 'todo', 1, 1);`);
    old.close();
    board.openBoard(file);
    expect(board.getTask("t-old")).toMatchObject({ title: "old row", owner: null, dueAt: null, budgetUsd: null, spentUsd: 0 });
    board.openBoard(file); // idempotent
    expect(board.getTask("t-old")?.title).toBe("old row");
  });

  it("books spend, warns once at 70%, and pauses at the cap with the stated reason", () => {
    const task = board.createTask({ title: "capped", assigneeBotId: "bot-1", budgetUsd: 0.014 });
    board.setStatus(task.id, "ready");
    board.claimTask(task.id);
    const first = board.bookSpend(task.id, 0.01);
    expect(first).toMatchObject({ warned: true, paused: false });
    expect(board.getTask(task.id)).toMatchObject({ spentUsd: 0.01, status: "running" });
    expect(board.commentsOf(task.id).map((c) => c.text)).toEqual(["70% of this task's budget is spent ($0.010 of $0.014)."]);
    // a second booking past the cap pauses, and the warning is not repeated
    const second = board.bookSpend(task.id, 0.01);
    expect(second).toMatchObject({ warned: false, paused: true });
    expect(board.getTask(task.id)).toMatchObject({ status: "blocked", blockedReason: "paused, needs a budget increase", spentUsd: 0.02 });
    expect(board.commentsOf(task.id)).toHaveLength(2);
    expect(board.commentsOf(task.id)[1]!.text).toContain("paused, needs a budget increase");
    // a turn with no reported cost books nothing but is counted, and a
    // task already paused is not commented on again
    expect(board.bookSpend(task.id, null)).toMatchObject({ warned: false, paused: false });
    expect(board.getTask(task.id)?.unpricedTurns).toBe(1);
    expect(board.commentsOf(task.id)).toHaveLength(2);
  });

  it("never dispatches a task at its cap, and a raised cap resumes a task paused for budget", () => {
    const task = board.createTask({ title: "capped", assigneeBotId: "bot-1", budgetUsd: 0.01 });
    board.setStatus(task.id, "ready");
    board.claimTask(task.id);
    board.bookSpend(task.id, 0.01);
    expect(board.getTask(task.id)?.status).toBe("blocked");
    expect(board.exhausted(board.getTask(task.id)!)).toBe(true);
    expect(() => board.patchTask(task.id, { budgetUsd: 0.005 })).toThrow(/below what is already spent/);
    const resumed = board.patchTask(task.id, { budgetUsd: 0.05 });
    expect(resumed).toMatchObject({ status: "ready", blockedReason: null, budgetUsd: 0.05 });
    expect(board.exhausted(resumed)).toBe(false);
  });

  it("finds a task by its thread and stores the digest as its result", () => {
    const task = board.createTask({ title: "digested", assigneeBotId: "bot-1" });
    board.setStatus(task.id, "ready");
    board.claimTask(task.id);
    board.attachThread(task.id, "thread-9");
    expect(board.taskByThread("thread-9")?.id).toBe(task.id);
    expect(board.taskByThread("thread-none")).toBeNull();
    board.setStatus(task.id, "review", { result: "the reply" });
    expect(board.setResult(task.id, "[digest] · tools: Bash ×1 · reply: the reply").result).toBe("[digest] · tools: Bash ×1 · reply: the reply");
  });
});

describe("a cap nobody has to guess (Phase 2, budget defaults)", () => {
  beforeEach(() => board.openBoard(join(DATA, `auto-${Math.random()}.db`)));

  it("is the floor without history, and three times the median of finished tasks with it", () => {
    expect(board.suggestedBudgetUsd("bot-1")).toBe(board.AUTO_BUDGET_FLOOR_USD);
    expect(board.suggestedBudgetUsd(null)).toBe(board.AUTO_BUDGET_FLOOR_USD);
    for (const spent of [0.4, 0.5, 0.6, 9]) {
      const task = board.createTask({ title: `t${spent}`, assigneeBotId: "bot-1" });
      board.setStatus(task.id, "ready");
      board.claimTask(task.id);
      board.bookSpend(task.id, spent);
      board.setStatus(task.id, "review");
    }
    // median of 0.4, 0.5, 0.6, 9 is 0.55; three times is 1.65 — the outlier does not drag it
    expect(board.suggestedBudgetUsd("bot-1")).toBeCloseTo(1.65, 2);
    // another bot's history is not this bot's; a running task is not history
    expect(board.suggestedBudgetUsd("bot-2")).toBe(board.AUTO_BUDGET_FLOOR_USD);
    const small = board.createTask({ title: "small", assigneeBotId: "bot-3" });
    board.setStatus(small.id, "ready"); board.claimTask(small.id); board.bookSpend(small.id, 0.05); board.setStatus(small.id, "review");
    expect(board.suggestedBudgetUsd("bot-3")).toBe(board.AUTO_BUDGET_FLOOR_USD);
  });
});

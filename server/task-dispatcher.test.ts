import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DATA = mkdtempSync(join(tmpdir(), "omb-tick-"));
vi.mock("./config.ts", () => ({ DATA_DIR: DATA }));

const board = await import("./task-board.ts");
const { createDispatcher } = await import("./task-dispatcher.ts");

describe("the dispatcher tick", () => {
  beforeEach(() => board.openBoard(join(DATA, `d-${Math.random()}.db`)));

  it("promotes, claims, and records the thread it ran in", async () => {
    const task = board.createTask({ title: "do the thing", assigneeBotId: "bot-1" });
    const dispatch = vi.fn(async () => ({ threadId: "thread-7" }));
    await createDispatcher({ dispatch }).tick();

    const after = board.getTask(task.id);
    expect(after?.status).toBe("running");
    expect(after?.threadId).toBe("thread-7");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("honours the concurrency cap", async () => {
    for (let i = 0; i < 5; i++) board.createTask({ title: `t${i}`, assigneeBotId: "bot-1" });
    const dispatch = vi.fn(async () => ({ threadId: "t" }));
    await createDispatcher({ dispatch, maxRunning: 2 }).tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not claim a task whose parents are unfinished", async () => {
    const parent = board.createTask({ title: "first" });
    board.createTask({ title: "second", parentIds: [parent.id] });
    const dispatch = vi.fn(async () => ({ threadId: "t" }));
    await createDispatcher({ dispatch, maxRunning: 10 }).tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("reclaims a running task whose heartbeat went cold", async () => {
    const task = board.createTask({ title: "crashed", assigneeBotId: "bot-1" });
    board.setStatus(task.id, "ready");
    board.setStatus(task.id, "running");
    const clock = Date.now() + 10 * 60_000;
    const dispatch = vi.fn(async () => ({ threadId: "t2" }));
    await createDispatcher({ dispatch, now: () => clock, staleAfterMs: 60_000 }).tick();
    expect(board.getTask(task.id)?.attempts).toBe(2);
  });

  it("blocks a task that has burned through its attempts instead of looping", async () => {
    const task = board.createTask({ title: "cursed", assigneeBotId: "bot-1" });
    for (let i = 0; i < 3; i++) {
      board.setStatus(task.id, "ready");
      board.setStatus(task.id, "running");
    }
    // Reclaimed after its 3rd failed attempt — back in "ready" with
    // attempts already at the cap, which is where give-up must catch it:
    // before a 4th claim, not while it is mid-flight (see the next test).
    board.setStatus(task.id, "ready");
    const dispatch = vi.fn(async () => ({ threadId: "t" }));
    await createDispatcher({ dispatch, maxAttempts: 3 }).tick();
    expect(board.getTask(task.id)?.status).toBe("blocked");
    expect(board.getTask(task.id)?.blockedReason).toMatch(/3 attempts/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not force-block a running task whose attempt count already sits at the cap, as long as it is still heartbeating", async () => {
    // A task on its 3rd (final) attempt is legitimately running right now —
    // it has not failed yet, it might still succeed. Give-up must judge a
    // task by whether it is back in the pool asking for another attempt,
    // not by a historical attempt count that a healthy in-flight task also
    // happens to carry.
    const task = board.createTask({ title: "still going", assigneeBotId: "bot-1" });
    for (let i = 0; i < 3; i++) {
      board.setStatus(task.id, "ready");
      board.setStatus(task.id, "running");
    }
    board.heartbeat(task.id);
    const dispatch = vi.fn(async () => ({ threadId: "t" }));
    await createDispatcher({ dispatch, maxAttempts: 3 }).tick();
    const after = board.getTask(task.id);
    expect(after?.status).toBe("running");
    expect(after?.blockedReason).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns a task to ready when dispatch declines it", async () => {
    const task = board.createTask({ title: "busy bot", assigneeBotId: "bot-1" });
    await createDispatcher({ dispatch: async () => null }).tick();
    expect(board.getTask(task.id)?.status).toBe("ready");
  });

  it("never lets a second tick double-claim while the first is still dispatching", async () => {
    board.createTask({ title: "slow one", assigneeBotId: "bot-1" });
    const box: { resolve: (() => void) | null } = { resolve: null };
    const dispatch = vi.fn(
      () =>
        new Promise<{ threadId: string } | null>((resolve) => {
          box.resolve = () => resolve({ threadId: "t" });
        }),
    );
    const dispatcher = createDispatcher({ dispatch, maxRunning: 10 });
    const first = dispatcher.tick();
    const second = dispatcher.tick();
    box.resolve?.();
    await Promise.all([first, second]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("what the tick must never do", () => {
  beforeEach(() => board.openBoard(join(DATA, `d-${Math.random()}.db`)));

  it("burns no attempt on a task the wiring cannot dispatch, however many ticks pass", async () => {
    // The default path, not an edge case: task_create tells the model it is
    // fine to leave a task unassigned for a human. The wiring declines every
    // one of those, and before this fix each decline still cost an attempt —
    // four ticks took the task from ready to blocked with "gave up after 3
    // attempts — no progress" without a single turn ever starting.
    const task = board.createTask({ title: "left for a human" });
    // Exactly what the wiring does with an undispatchable task today: it
    // declines. The tick had already claimed (and charged) it by then.
    const dispatch = vi.fn(async () => null);
    const dispatcher = createDispatcher({ dispatch, canDispatch: () => false, maxAttempts: 3 });
    for (let i = 0; i < 4; i++) await dispatcher.tick();

    const after = board.getTask(task.id);
    expect(after?.status).toBe("ready");
    expect(after?.attempts).toBe(0);
    expect(after?.blockedReason).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("hands a task back with its attempt refunded when a dispatch declines after the claim", async () => {
    const task = board.createTask({ title: "busy bot", assigneeBotId: "bot-1" });
    await createDispatcher({ dispatch: async () => null }).tick();
    const after = board.getTask(task.id);
    expect(after?.status).toBe("ready");
    expect(after?.attempts).toBe(0);
  });

  it("mutates nothing at all while the board flag is off", async () => {
    // Turning a feature flag off must never mutate the data behind it: no
    // promote, no claim, no reclaim, no give-up, not even a bumped
    // updated_at.
    const task = board.createTask({ title: "filed while the flag was on", assigneeBotId: "bot-1" });
    const dispatch = vi.fn(async () => ({ threadId: "t" }));
    const dispatcher = createDispatcher({ dispatch, enabled: () => false });
    for (let i = 0; i < 4; i++) await dispatcher.tick();

    const after = board.getTask(task.id);
    expect(after?.status).toBe("todo");
    expect(after?.attempts).toBe(0);
    expect(after?.updatedAt).toBe(task.updatedAt);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("claims a ready task exactly once even when two dispatchers race over one database", async () => {
    // The in-process re-entrancy guard covers one server; the documented
    // OMB2 side-by-side setup shares ~/.openmausbot, so the claim itself has
    // to be the conditional write that decides.
    const task = board.createTask({ title: "contended", assigneeBotId: "bot-1" });
    board.setStatus(task.id, "ready");
    expect(board.claimTask(task.id)?.status).toBe("running");
    expect(board.claimTask(task.id)).toBeNull();
    expect(board.getTask(task.id)?.attempts).toBe(1);
  });
});

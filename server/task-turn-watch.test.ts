import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DATA = mkdtempSync(join(tmpdir(), "omb-turn-watch-"));
vi.mock("./config.ts", () => ({ DATA_DIR: DATA }));

const board = await import("./task-board.ts");
const { createTaskTurnWatch } = await import("./task-turn-watch.ts");
const { createDispatcher } = await import("./task-dispatcher.ts");

describe("task turn watch", () => {
  beforeEach(() => {
    board.openBoard(join(DATA, `w-${Math.random()}.db`));
    vi.useRealTimers();
  });

  function claim(title = "do the thing") {
    const task = board.createTask({ title, assigneeBotId: "bot-1" });
    board.setStatus(task.id, "ready");
    return board.setStatus(task.id, "running");
  }

  it("keeps a running task alive across the stale threshold as long as its turn keeps emitting activity", async () => {
    vi.useFakeTimers();
    try {
      const claimed = claim();
      const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
      watch.watch(claimed.id, "thread-1");

      // Simulate the turn producing real activity every 60s (well under the
      // dispatcher's 180s staleAfterMs) for a total of 10 minutes — far past
      // the stale threshold in aggregate, but no single gap crosses it.
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(60_000);
        watch.handle({ type: "item.completed", threadId: "thread-1" });
      }

      const dispatch = vi.fn(async () => ({ threadId: "unused" }));
      const dispatcher = createDispatcher({ dispatch, now: () => Date.now(), staleAfterMs: 180_000 });
      await dispatcher.tick();

      expect(board.getTask(claimed.id)?.status).toBe("running");
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a quiet-but-alive turn from going stale via the keepalive alone, and still settles it when it later completes", async () => {
    vi.useFakeTimers();
    try {
      const claimed = claim();
      const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
      watch.watch(claimed.id, "thread-8");
      // No handle() calls at all — the turn's event stream is completely
      // silent (one long tool call, say) — but the turn is still actually
      // in flight in this process, so the keepalive alone must carry it.
      vi.advanceTimersByTime(400_000); // well past the 180s default stale threshold

      const dispatch = vi.fn(async () => ({ threadId: "unused" }));
      const dispatcher = createDispatcher({ dispatch, now: () => Date.now(), staleAfterMs: 180_000 });
      await dispatcher.tick();
      expect(dispatch).not.toHaveBeenCalled();
      expect(board.getTask(claimed.id)?.status).toBe("running");

      // And it still settles correctly once the (still silent, still
      // in-flight) turn eventually finishes.
      watch.handle({ type: "turn.completed", threadId: "thread-8", ok: true });
      expect(board.getTask(claimed.id)?.status).toBe("review");
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves a task to review when its watched turn completes successfully", () => {
    const claimed = claim();
    const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
    watch.watch(claimed.id, "thread-2");

    watch.handle({ type: "item.completed", threadId: "thread-2" });
    watch.handle({ type: "turn.completed", threadId: "thread-2", ok: true });

    const after = board.getTask(claimed.id);
    expect(after?.status).toBe("review");
    expect(after?.finishedAt).toBeGreaterThan(0);
  });

  it("moves a task to blocked with the reason when its watched turn fails", () => {
    const claimed = claim();
    const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
    watch.watch(claimed.id, "thread-3");

    watch.handle({ type: "turn.completed", threadId: "thread-3", ok: false, stopReason: "provider quota exhausted" });

    const after = board.getTask(claimed.id);
    expect(after?.status).toBe("blocked");
    expect(after?.blockedReason).toBe("provider quota exhausted");
  });

  it("treats a session exit with no turn.completed as a failure too", () => {
    const claimed = claim();
    const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
    watch.watch(claimed.id, "thread-4");

    watch.handle({ type: "session.exited", threadId: "thread-4" });

    expect(board.getTask(claimed.id)?.status).toBe("blocked");
  });

  it("a crashed turn — the process dies mid-turn, taking its keepalive down with it — is still reclaimed by the dispatcher tick", async () => {
    vi.useFakeTimers();
    try {
      const claimed = claim();
      const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
      watch.watch(claimed.id, "thread-5");
      // One burst of real activity, then the process dies: nothing in this
      // module survives that (no more handle() calls, and the keepalive
      // timer itself is gone) — simulated here with stopAll(), the closest
      // a single process can come to modeling its own crash.
      watch.handle({ type: "item.started", threadId: "thread-5" });
      watch.stopAll();

      vi.advanceTimersByTime(181_000); // just past the default 180s stale window

      const dispatch = vi.fn(async () => ({ threadId: "thread-5-retry" }));
      const dispatcher = createDispatcher({ dispatch, now: () => Date.now(), staleAfterMs: 180_000 });
      await dispatcher.tick();

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(board.getTask(claimed.id)?.attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the keepalive timer itself the moment the turn settles — no leaked timer", () => {
    vi.useFakeTimers();
    try {
      const claimed = claim();
      const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
      watch.watch(claimed.id, "thread-10");
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      watch.handle({ type: "turn.completed", threadId: "thread-10", ok: true });
      expect(vi.getTimerCount()).toBe(0);

      // And advancing the clock afterwards produces no further heartbeats —
      // a settled task is never heartbeated again, keepalive or otherwise.
      const settledHeartbeatAt = board.getTask(claimed.id)?.heartbeatAt;
      vi.advanceTimersByTime(600_000);
      expect(board.getTask(claimed.id)?.heartbeatAt).toBe(settledHeartbeatAt);
      expect(board.getTask(claimed.id)?.status).toBe("review");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reacting to a threadId once its turn has settled — no leaked listener", () => {
    const claimed = claim();
    const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
    watch.watch(claimed.id, "thread-6");
    watch.handle({ type: "turn.completed", threadId: "thread-6", ok: true });
    expect(board.getTask(claimed.id)?.status).toBe("review");

    // A late duplicate event for the same (settled) thread must not throw
    // and must not move the task again.
    expect(() => watch.handle({ type: "item.completed", threadId: "thread-6" })).not.toThrow();
    expect(() => watch.handle({ type: "turn.completed", threadId: "thread-6", ok: false })).not.toThrow();
    expect(board.getTask(claimed.id)?.status).toBe("review");
  });

  it("stops beating once the keepalive's silence budget runs out, so a wedged turn is reclaimable", async () => {
    // The keepalive must be genuinely bounded: a turn that never emits a
    // single event and never completes (a dispatch that failed inside the
    // un-awaited setup IIFE, say) otherwise keeps a timer heartbeating the
    // task for the life of the process, and staleRunning can never reclaim
    // it — the task holds a concurrency slot in "running" forever.
    vi.useFakeTimers();
    try {
      const claimed = claim();
      const watch = createTaskTurnWatch({ staleAfterMs: 180_000, maxSilentMs: 600_000 });
      watch.watch(claimed.id, "thread-wedged");

      vi.advanceTimersByTime(600_000 + 180_000 + 1_000); // budget spent, then a full stale window of silence

      const dispatch = vi.fn(async () => ({ threadId: "thread-wedged-retry" }));
      await createDispatcher({ dispatch, now: () => Date.now(), staleAfterMs: 180_000 }).tick();

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(board.getTask(claimed.id)?.attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("beats only while the harness agrees the thread is still working", async () => {
    // Honest evidence, not a blind timer: the moment the harness says that
    // thread is not busy any more, the keepalive stops asserting liveness
    // and the stale sweep is allowed to do its job.
    vi.useFakeTimers();
    try {
      const claimed = claim();
      let working = true;
      const watch = createTaskTurnWatch({
        staleAfterMs: 180_000,
        isThreadAlive: () => working,
      });
      watch.watch(claimed.id, "thread-quiet", { botId: "bot-1" });
      vi.advanceTimersByTime(120_000);
      working = false;
      vi.advanceTimersByTime(181_000);

      const dispatch = vi.fn(async () => ({ threadId: "thread-quiet-retry" }));
      await createDispatcher({ dispatch, now: () => Date.now(), staleAfterMs: 180_000 }).tick();
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a task to blocked when the dispatch itself fails without ever emitting a completion", async () => {
    const claimed = claim();
    const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
    watch.watch(claimed.id, "thread-failed");

    watch.fail("thread-failed", "the bot's provider account is being updated");

    const after = board.getTask(claimed.id);
    expect(after?.status).toBe("blocked");
    expect(after?.blockedReason).toBe("the bot's provider account is being updated");
  });

  it("redacts a provider's own words before they are stored as a blocked reason", () => {
    const claimed = claim();
    const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
    watch.watch(claimed.id, "thread-secret");

    watch.handle({
      type: "turn.completed",
      threadId: "thread-secret",
      ok: false,
      stopReason: "401 from https://api.example.com with api_key=sk-liveSECRETvalue123",
    });

    const reason = board.getTask(claimed.id)?.blockedReason ?? "";
    expect(reason).not.toContain("sk-liveSECRETvalue123");
    expect(reason).toContain("401 from");
  });

  it("ignores a superseded attempt's terminal signal instead of settling the attempt that replaced it", () => {
    // A reclaim (or a human moving a task back to ready) re-dispatches the
    // task under a NEW thread. When the OLD turn finally completes, its
    // settle would be a perfectly legal running -> review move on the task —
    // marking the NEW attempt finished while its turn is still running.
    const claimed = claim("re-dispatched");
    const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
    watch.watch(claimed.id, "thread-old");

    board.setStatus(claimed.id, "ready");
    const again = board.setStatus(claimed.id, "running");
    watch.watch(again.id, "thread-new");

    watch.handle({ type: "turn.completed", threadId: "thread-old", ok: true });
    expect(board.getTask(claimed.id)?.status).toBe("running");

    watch.handle({ type: "turn.completed", threadId: "thread-new", ok: true });
    expect(board.getTask(claimed.id)?.status).toBe("review");
  });

  it("tears down a task's previous watch when the same task is watched again", () => {
    vi.useFakeTimers();
    try {
      const claimed = claim();
      const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
      watch.watch(claimed.id, "thread-a");
      watch.watch(claimed.id, "thread-b");
      expect(vi.getTimerCount()).toBe(1);
      watch.handle({ type: "turn.completed", threadId: "thread-b", ok: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a watch that was armed for a turn that never started", () => {
    vi.useFakeTimers();
    try {
      const claimed = claim();
      const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
      watch.watch(claimed.id, "thread-stillborn");
      watch.unwatch(claimed.id);
      expect(vi.getTimerCount()).toBe(0);
      watch.handle({ type: "turn.completed", threadId: "thread-stillborn", ok: true });
      expect(board.getTask(claimed.id)?.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores events for threads nobody is watching", () => {
    const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
    expect(() => watch.handle({ type: "turn.completed", threadId: "stranger", ok: true })).not.toThrow();
  });

  it("stopAll forgets every watched task without settling it, and clears its keepalive timer", () => {
    vi.useFakeTimers();
    try {
      const claimed = claim();
      const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
      watch.watch(claimed.id, "thread-7");
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      watch.stopAll();
      expect(vi.getTimerCount()).toBe(0);
      watch.handle({ type: "turn.completed", threadId: "thread-7", ok: true });
      expect(board.getTask(claimed.id)?.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });
});

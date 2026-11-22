import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadUntilReplayQuiet } from "./load-replay.ts";

const QUIET_MS = 2_000;

function scripted(quietMs: number | undefined) {
  const link: { onUpdate: ((params: any) => void) | null } = { onUpdate: null };
  const received: unknown[] = [];
  let answer!: (result: unknown) => void;
  let fail!: (error: Error) => void;
  let deliver!: (result: unknown) => void;
  const done = loadUntilReplayQuiet({
    link, sessionId: "s1", quietMs,
    send: (receive) => new Promise((resolve, reject) => {
      deliver = receive;
      answer = (result) => { receive(result); resolve(result); };
      fail = reject;
    }),
    receive: (result) => received.push(result),
    replayed: () => ({ kept: true }),
  });
  let state = "pending";
  done.then(() => { state = "loaded"; }, (error: Error) => { state = `failed: ${error.message}`; });
  const replay = (sessionId = "s1") => link.onUpdate?.({ sessionId, update: { sessionUpdate: "agent_message_chunk" } });
  return { link, received, done, state: () => state, answer: (result: unknown) => answer(result), fail: (error: Error) => fail(error), late: (result: unknown) => deliver(result), replay };
}

describe("a session/load that can go unanswered after its replay", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("counts as loaded once the replay has been quiet for the window, and drops a late answer", async () => {
    const load = scripted(QUIET_MS);
    load.replay();
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
    load.replay();
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
    expect(load.state()).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(load.state()).toBe("loaded");
    expect(load.received).toEqual([{ kept: true }]);
    expect(load.link.onUpdate).toBeNull();
    load.late({ models: { currentModelId: "stale" } });
    load.fail(new Error("session/load timed out"));
    await vi.advanceTimersByTimeAsync(0);
    expect(load.received).toEqual([{ kept: true }]);
    expect(load.state()).toBe("loaded");
  });

  it("takes the answer when it comes first", async () => {
    const load = scripted(QUIET_MS);
    load.replay();
    load.answer({ models: { currentModelId: "grok-4.5" } });
    await vi.advanceTimersByTimeAsync(QUIET_MS * 2);
    expect(load.state()).toBe("loaded");
    expect(load.received).toEqual([{ models: { currentModelId: "grok-4.5" } }]);
  });

  it("waits for the answer, or its timeout, when nothing of the session is replayed", async () => {
    const load = scripted(QUIET_MS);
    load.replay("another-session");
    await vi.advanceTimersByTimeAsync(QUIET_MS * 10);
    expect(load.state()).toBe("pending");
    load.fail(new Error("session/load timed out"));
    await vi.advanceTimersByTimeAsync(0);
    expect(load.state()).toBe("failed: session/load timed out");
    expect(load.received).toEqual([]);
  });

  it("only waits for the answer without a quiet window", async () => {
    const load = scripted(undefined);
    expect(load.link.onUpdate).toBeNull();
    await vi.advanceTimersByTimeAsync(QUIET_MS * 10);
    expect(load.state()).toBe("pending");
    load.answer(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(load.state()).toBe("loaded");
    expect(load.received).toEqual([null]);
  });
});

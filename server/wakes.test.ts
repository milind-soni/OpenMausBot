// The wake queue's dispatch policy.
//
// Every rule here was already law in the connector-resume path this replaces;
// the tests exist so the generalisation cannot quietly change one of them. The
// two that matter most: a busy bot's wake is HELD, never raced against the
// turn it is already running, and a wake whose bot/thread pairing is gone is
// dropped rather than retried forever.
import { describe, expect, it, vi } from "vitest";

import { WakeQueue, type Wake, type WakeOwner, type WakeRuntime } from "./wakes.ts";

const wake = (over: Partial<Wake> = {}): Wake => ({
  key: "k1",
  source: "connector",
  botId: "bot-1",
  threadId: "t1",
  prompt: "carry on",
  ...over,
});

function harness(owner: WakeOwner | null, soloResult?: Promise<void>) {
  const runGroupTurn = vi.fn();
  const runSoloTurn = vi.fn(() => soloResult ?? Promise.resolve());
  const runtime: WakeRuntime = { owner: () => owner, runGroupTurn, runSoloTurn };
  return { queue: new WakeQueue(runtime), runGroupTurn, runSoloTurn };
}

describe("WakeQueue.dispatch", () => {
  it("runs a solo wake when the bot is idle", () => {
    const { queue, runSoloTurn } = harness({ busy: false });
    queue.dispatch(wake());
    expect(runSoloTurn).toHaveBeenCalledOnce();
    expect(queue.size).toBe(0);
  });

  it("holds a wake for a busy bot instead of dropping or racing it", () => {
    const { queue, runSoloTurn } = harness({ busy: true });
    queue.dispatch(wake());
    expect(runSoloTurn).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);
  });

  it("drops a wake whose bot/thread pairing is gone", () => {
    const { queue, runSoloTurn } = harness(null);
    queue.dispatch(wake());
    expect(runSoloTurn).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });

  it("routes a group member's wake through the group queue", () => {
    const { queue, runGroupTurn, runSoloTurn } = harness({ busy: false, groupId: "g1" });
    queue.dispatch(wake());
    expect(runGroupTurn).toHaveBeenCalledOnce();
    expect(runGroupTurn.mock.calls[0]![0]).toBe("g1");
    expect(runSoloTurn).not.toHaveBeenCalled();
  });

  it("dedupes by key — a second wake for the same pause replaces the first", () => {
    const { queue } = harness({ busy: true });
    queue.dispatch(wake({ prompt: "first" }));
    queue.dispatch(wake({ prompt: "second" }));
    expect(queue.size).toBe(1);
  });
});

describe("WakeQueue solo failures", () => {
  it("re-queues when the turn says the bot is already working", async () => {
    const rejection = Promise.reject(new Error("the bot is already working — interrupt it first"));
    const { queue } = harness({ busy: false }, rejection);
    queue.dispatch(wake());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.size).toBe(1);
  });

  it("reports a real failure instead of silently re-queueing forever", async () => {
    const onFailure = vi.fn();
    const { queue } = harness({ busy: false }, Promise.reject(new Error("no such bot")));
    queue.dispatch(wake({ onFailure }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onFailure).toHaveBeenCalledWith("no such bot");
    expect(queue.size).toBe(0);
  });
});

describe("WakeQueue.drain", () => {
  it("dispatches held wakes once their bot is idle, and leaves the rest", () => {
    const busy = new Set(["bot-1", "bot-2"]);
    const runSoloTurn = vi.fn(() => Promise.resolve());
    const queue = new WakeQueue({
      owner: (botId: string) => ({ busy: busy.has(botId) }),
      runGroupTurn: vi.fn(),
      runSoloTurn,
    });
    queue.dispatch(wake({ key: "a", botId: "bot-1" }));
    queue.dispatch(wake({ key: "b", botId: "bot-2" }));
    expect(queue.size).toBe(2);

    busy.delete("bot-1");
    queue.drain();
    expect(runSoloTurn).toHaveBeenCalledOnce();
    expect(queue.size).toBe(1);
  });

  it("is safe to drain when nothing is held", () => {
    const { queue } = harness({ busy: false });
    expect(() => queue.drain()).not.toThrow();
  });
});

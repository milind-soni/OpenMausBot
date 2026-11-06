import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { createPersonFirst, PERSON_FIRST_MS, ranFor, stoppedLine, stoppedNote, type PersonWait } from "./person-first.ts";

const T = "thread-1";
const MIN = 60_000;

function harness(options: { waiting?: () => boolean } = {}) {
  let clock = 1_000_000;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  const stops: string[] = [];
  const requeued: string[] = [];
  const first = createPersonFirst({
    waiting: () => options.waiting?.() ?? false,
    stop: async (_threadId, line) => { stops.push(line); },
    now: () => clock,
    schedule: (run, ms) => {
      const timer = { at: clock + ms, run, live: true };
      timers.push(timer);
      return () => { timer.live = false; };
    },
  });
  const base = { eventId: "e", provider: "claudeAgent" as const, threadId: T, createdAt: "", turnId: "turn-1" };
  const emit = (event: RuntimeEvent) => first.onEvent(event);
  return {
    first,
    stops,
    requeued,
    /** Moves the clock, running the timers that come due on the way. */
    async advance(ms: number) {
      const end = clock + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        clock = due.at;
        due.run();
      }
      clock = end;
      await Promise.resolve();
      await Promise.resolve();
    },
    turnStarted: () => emit({ ...base, type: "turn.started" }),
    toolStarted: (itemId: string, summary = "gh run view 42; sleep 30") => emit({ ...base, type: "item.started", itemType: "tool", itemId, title: "Bash", summary }),
    toolDone: (itemId: string) => emit({ ...base, type: "item.completed", itemType: "tool", itemId, ok: true }),
    said: (delta: string) => emit({ ...base, type: "content.delta", streamKind: "assistant_text", delta }),
    turnCompleted: () => emit({ ...base, type: "turn.completed", ok: true, stopReason: "end_turn", cost: null }),
    steered: (): PersonWait => ({ requeue: (note) => requeued.push(note ?? "") }),
  };
}

describe("the person's message goes first", () => {
  it("stops a tool call that has already held them a minute, and runs their message next with what was stopped", async () => {
    const h = harness();
    h.turnStarted();
    h.toolStarted("poll");
    await h.advance(9 * MIN);
    h.first.wait(T, h.steered());
    await h.advance(0);
    expect(h.stops).toEqual(["Stopped a step that had run for 9 min, to answer you first"]);
    expect(h.requeued).toEqual([stoppedNote("Bash: gh run view 42; sleep 30", 9 * MIN)]);
    expect(h.requeued[0]).toContain("do not wait inside a command again: check it once, then use wait_until or a one-time trigger");
  });

  it("gives a young tool call the rest of its minute, and leaves the turn alone when it returns and the bot answers", async () => {
    const h = harness();
    h.turnStarted();
    h.toolStarted("build");
    await h.advance(10_000);
    h.first.wait(T, h.steered());
    await h.advance(20_000);
    h.toolDone("build");
    h.said("The PR is #42; I'll tell you when CI is done.");
    h.toolStarted("next", "npm test");
    await h.advance(10 * MIN);
    expect(h.stops).toEqual([]);
    expect(h.requeued).toEqual([]);
  });

  it("stops the call when it reaches its minute with the message still unread", async () => {
    const h = harness();
    h.turnStarted();
    h.toolStarted("poll");
    await h.advance(10_000);
    h.first.wait(T, h.steered());
    await h.advance(PERSON_FIRST_MS - 10_000 - 1);
    expect(h.stops).toEqual([]);
    await h.advance(1);
    expect(h.stops).toEqual([stoppedLine(PERSON_FIRST_MS)]);
    expect(h.requeued).toHaveLength(1);
  });

  it("does not count words the engine was already writing when the message came", async () => {
    const h = harness();
    h.turnStarted();
    h.first.wait(T, h.steered());
    h.said("Checking CI again…");
    h.toolStarted("poll");
    await h.advance(PERSON_FIRST_MS);
    expect(h.stops).toHaveLength(1);
  });

  it("stops a bot that read the message and went on into another long call without a word", async () => {
    const h = harness();
    h.turnStarted();
    h.toolStarted("first");
    h.first.wait(T, h.steered());
    await h.advance(5_000);
    h.toolDone("first");
    h.toolStarted("second");
    await h.advance(PERSON_FIRST_MS);
    expect(h.stops).toHaveLength(1);
  });

  it("never stops a turn waiting on the person or a computer, and looks again once it is not", async () => {
    let waiting = true;
    const h = harness({ waiting: () => waiting });
    h.turnStarted();
    h.toolStarted("ask");
    h.first.wait(T, h.steered());
    await h.advance(5 * MIN);
    expect(h.stops).toEqual([]);
    waiting = false;
    await h.advance(10_000);
    expect(h.stops).toHaveLength(1);
  });

  it("only stops for a message already in the queue: the queue runs it next", async () => {
    const h = harness();
    h.turnStarted();
    h.toolStarted("poll");
    await h.advance(2 * MIN);
    h.first.wait(T, {});
    await h.advance(0);
    expect(h.stops).toHaveLength(1);
    expect(h.requeued).toEqual([]);
  });

  it("stops once, queues every waiting message, and forgets a turn that ended", async () => {
    const h = harness();
    h.turnStarted();
    h.toolStarted("poll");
    h.first.wait(T, h.steered());
    h.first.wait(T, h.steered());
    await h.advance(2 * MIN);
    expect(h.stops).toHaveLength(1);
    expect(h.requeued).toEqual(["", stoppedNote("Bash: gh run view 42; sleep 30", PERSON_FIRST_MS)]);
    h.first.wait(T, h.steered());
    await h.advance(2 * MIN);
    expect(h.stops).toHaveLength(1);

    h.turnCompleted();
    h.turnStarted();
    h.toolStarted("other");
    h.first.wait(T, h.steered());
    h.turnCompleted();
    await h.advance(5 * MIN);
    expect(h.stops).toHaveLength(1);
  });

  it("says how long the step ran in plain words", () => {
    expect(ranFor(45_000)).toBe("45 s");
    expect(ranFor(89_000)).toBe("89 s");
    expect(ranFor(9 * MIN + 20_000)).toBe("9 min");
  });
});

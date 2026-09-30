import { describe, expect, it, vi } from "vitest";

import type { Decider } from "./index.ts";
import { STEER_SPLIT } from "./jobs.ts";
import { RELAY_MAX_STATE_BYTES, relayAccepts } from "./relay.ts";
import { STEER_SPLIT_MIN_PROBABILITY, SteerSplitLane, decideSteerSplit, steerSplitRequest, type SteerSplitInput } from "./steer-split.ts";
import type { ChoiceAnswer, DeciderResult } from "./types.ts";

const INPUT: SteerSplitInput = {
  title: "Fix the signup page",
  request: "The signup button overlaps the footer on Safari mobile. Please fix it.",
  message: "also book me a cab to the airport for 6pm",
};

type Choose = Decider["choose"];

function answering(result: DeciderResult<ChoiceAnswer>) {
  const choose = vi.fn(async () => result) as unknown as Choose & ReturnType<typeof vi.fn>;
  return { choose };
}

const picked = (choice: string, pTop: number): DeciderResult<ChoiceAnswer> =>
  ({ ok: true, provider: "jev", latencyMs: 280, answers: { type: "choice", choice, pTop, margin: pTop - 0.1, probabilities: { [choice]: pTop } } });

const asked = (request: ReturnType<typeof steerSplitRequest>) => ({ answer: { type: "choice" as const, ...request.question } });

describe("steer split request", () => {
  it("sends the contract's question verbatim with only its state keys", () => {
    const request = steerSplitRequest(INPUT);
    expect(request.question).toEqual({ instructions: STEER_SPLIT.instructions, options: STEER_SPLIT.options });
    expect(request.state).toEqual({
      running_task: "Fix the signup page: The signup button overlaps the footer on Safari mobile. Please fix it.",
      new_message: "also book me a cab to the airport for 6pm",
    });
    expect(relayAccepts("steerSplit", request.state, asked(request))).toBe(true);
  });

  it("clips both sides, and stays inside the relay's caps in wide characters", () => {
    const request = steerSplitRequest({ title: "t".repeat(500), request: "请".repeat(9_000), message: "😀".repeat(40_000) });
    expect(request.state.running_task.length).toBeLessThanOrEqual(1_500);
    expect(request.state.new_message.length).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(JSON.stringify(request.state))).toBeLessThanOrEqual(RELAY_MAX_STATE_BYTES);
    expect(relayAccepts("steerSplit", request.state, asked(request))).toBe(true);
  });

  it("describes the running task by whichever half it has", () => {
    expect(steerSplitRequest({ message: "hi", request: "Draft the brief" }).state.running_task).toBe("Draft the brief");
    expect(steerSplitRequest({ message: "hi", title: "Weekly brief" }).state.running_task).toBe("Weekly brief");
  });
});

describe("decideSteerSplit", () => {
  it("a clear separate answer splits, within the 800 ms budget", async () => {
    const decider = answering(picked("separate", 0.93));
    await expect(decideSteerSplit(decider, INPUT)).resolves.toEqual({ kind: "separate", probability: 0.93 });
    expect(decider.choose).toHaveBeenCalledWith("steerSplit", expect.any(Object), expect.any(Object), expect.objectContaining({ timeoutMs: 800 }));
  });

  it("exactly the threshold splits; below it steers as today", async () => {
    await expect(decideSteerSplit(answering(picked("separate", STEER_SPLIT_MIN_PROBABILITY)), INPUT)).resolves.toMatchObject({ kind: "separate" });
    await expect(decideSteerSplit(answering(picked("separate", 0.79)), INPUT)).resolves.toEqual({ kind: "fallback", reason: "low_confidence" });
  });

  it("same, any failure, an unknown choice or a throw steers as today", async () => {
    await expect(decideSteerSplit(answering(picked("same", 0.99)), INPUT)).resolves.toEqual({ kind: "fallback", reason: "same" });
    for (const reason of ["timeout", "rate_limited", "disabled", "job_off"] as const) {
      await expect(decideSteerSplit(answering({ ok: false, reason }), INPUT)).resolves.toEqual({ kind: "fallback", reason });
    }
    await expect(decideSteerSplit(answering(picked("other", 0.99)), INPUT)).resolves.toEqual({ kind: "fallback", reason: "malformed" });
    const choose = vi.fn(async () => { throw new Error("boom"); }) as unknown as Choose;
    await expect(decideSteerSplit({ choose }, INPUT)).resolves.toEqual({ kind: "fallback", reason: "malformed" });
  });

  it("does not ask without a running task to compare against", async () => {
    const decider = answering(picked("separate", 0.99));
    await expect(decideSteerSplit(decider, { message: "book a cab" })).resolves.toEqual({ kind: "fallback", reason: "no_task" });
    expect(decider.choose).not.toHaveBeenCalled();
  });
});

describe("SteerSplitLane", () => {
  it("runs one thread's sends in arrival order, even when the first waits longest", async () => {
    const lane = new SteerSplitLane();
    const order: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const first = lane.run("thread-a", async () => { await slow; order.push("first"); return 1; });
    expect(lane.pending("thread-a")).toBe(true);
    const second = lane.run("thread-a", async () => { order.push("second"); return 2; });
    const other = lane.run("thread-b", async () => { order.push("other thread"); return 3; });
    await other;
    expect(order).toEqual(["other thread"]);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["other thread", "first", "second"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(lane.pending("thread-a")).toBe(false);
  });

  it("a send that fails does not stall the ones behind it", async () => {
    const lane = new SteerSplitLane();
    const failed = lane.run("thread", async () => { throw new Error("409"); });
    const next = lane.run("thread", async () => "sent");
    await expect(failed).rejects.toThrow("409");
    await expect(next).resolves.toBe("sent");
  });
});

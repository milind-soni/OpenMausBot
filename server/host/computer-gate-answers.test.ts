import { describe, expect, it, vi } from "vitest";
import { CONTROL_HANDED_BACK, CONTROL_WAITED, CONTROL_WAITED_HELD } from "../control-client.ts";
import { TurnResources, type TurnOwner } from "../turn-resources.ts";
import { createComputerGateAnswers, PERSON_HOLDS } from "./computer-gate-answers.ts";

const holder = { threadId: "holder", generation: "1" };
const waiter = { threadId: "waiter", generation: "2" };
const third = { threadId: "third", generation: "3" };
const SHARED = "computer:vm:shared";

const nobody = { held: () => false, lastTake: () => 0 };

function setup(personOn: string[] = [], seatTakes = new Map<string, number>()) {
  const resources = new TurnResources();
  const bound = new Map<string, { owner: TurnOwner; resource: string }>();
  const answers = createComputerGateAnswers({ resources, bound: (threadId) => bound.get(threadId), personHolds: (resource) => personOn.includes(resource),
    personLastTake: (resource) => seatTakes.get(resource) ?? 0, pollMs: 10 });
  return { resources, bound, answers };
}

describe("what a screen call that was not performed tells the model", () => {
  it("says another thread has it, with the queue place, while one holds the seat", () => {
    const { resources, answers } = setup();
    resources.claim(SHARED, holder);
    resources.startWaiting(SHARED, waiter);
    expect(answers.contention(waiter)).toMatch(/^Another thread is using this computer\. .* This turn is 1st in line \(the other thread has had it /);
  });

  it("gives a queue place without claiming a holder between turns", () => {
    const { resources, answers } = setup();
    resources.claim(SHARED, holder);
    resources.startWaiting(SHARED, waiter);
    resources.release(holder);
    resources.startWaiting(SHARED, third);
    expect(answers.contention(third)).toMatch(/^This computer is not ready for this turn yet, .* This turn is 2nd in line/);
  });

  it("answers with the person's hold on the seat the turn queues for, though its own computer key names another", () => {
    const { resources, answers } = setup([SHARED]);
    resources.claim(SHARED, holder);
    resources.startWaiting(SHARED, waiter);
    expect(answers.contention(waiter)).toBe(PERSON_HOLDS);
    expect(answers.held(PERSON_HOLDS, true)).toEqual({ held: true, helpOpen: true, reason: "person" });
  });

  it("has nothing to say once the turn holds its seat and only waits for readiness", () => {
    const { resources, bound, answers } = setup();
    resources.claim(SHARED, waiter);
    bound.set(waiter.threadId, { owner: waiter, resource: SHARED });
    expect(answers.contention(waiter)).toBeUndefined();
    expect(answers.contention(third)).toBeUndefined();
  });

  it("remembers a person who took the queued seat and handed it back while the claim was pending", async () => {
    vi.useFakeTimers();
    try {
      const personOn: string[] = [];
      const { resources, answers } = setup(personOn);
      resources.claim(SHARED, holder);
      resources.startWaiting(SHARED, waiter);
      let grant!: () => void;
      const begin = new Promise<void>((resolve) => { grant = resolve; });
      const waited = answers.waitForClaim(begin, Date.now() + 5_000, waiter, nobody, 0);
      await vi.advanceTimersByTimeAsync(10);
      personOn.push(SHARED);
      await vi.advanceTimersByTimeAsync(10);
      personOn.length = 0;
      grant();
      expect(await waited).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("remembers a take and hand-back of a seat the turn queues for only after its first look", async () => {
    const seatTakes = new Map([[SHARED, 3]]);
    const sequence = { now: 3 };
    const { resources, answers } = setup([], seatTakes);
    resources.claim(SHARED, holder);
    let grant!: () => void;
    const begin = new Promise<void>((resolve) => { grant = resolve; });
    const waited = answers.waitForClaim(begin, Date.now() + 5_000, waiter, nobody, sequence.now);
    resources.startWaiting(SHARED, waiter);
    sequence.now = 4;
    seatTakes.set(SHARED, 4);
    grant();
    expect(await waited).toBe(true);
  });

  it("does not count a hold that started before the call, on a key the turn reads only later", async () => {
    const sequence = { now: 7 };
    const { resources, answers } = setup([], new Map());
    resources.startWaiting(SHARED, waiter);
    let lastTake = 0;
    let grant!: () => void;
    const begin = new Promise<void>((resolve) => { grant = resolve; });
    const waited = answers.waitForClaim(begin, Date.now() + 5_000, waiter, { held: () => false, lastTake: () => lastTake }, sequence.now);
    lastTake = 7;
    grant();
    expect(await waited).toBe(false);
  });

  it("sees a take and hand-back of the seat a turn already holds, from the sequence its call started at", () => {
    const seatTakes = new Map([[SHARED, 5]]);
    const { resources, bound, answers } = setup([], seatTakes);
    resources.claim(SHARED, waiter);
    bound.set(waiter.threadId, { owner: waiter, resource: SHARED });
    expect(answers.personCame(waiter, nobody, 5)).toBe(false);
    expect(answers.personCame(waiter, nobody, 4)).toBe(true);
    expect(answers.personCame(waiter, { held: () => false, lastTake: () => 6 }, 5)).toBe(true);
    expect(answers.personCame({ ...waiter, generation: "older" }, nobody, 4)).toBe(false);
  });

  it("asks a claim to be retried with a fresh screenshot after a hand-back, but not while the person still holds the seat", () => {
    const personOn: string[] = [];
    const { resources, answers } = setup(personOn);
    resources.claim(SHARED, holder);
    resources.startWaiting(SHARED, waiter);
    expect(answers.retry(waiter, false, "retry")).toBe("retry");
    expect(answers.retry(waiter, true, "retry")).toBe(CONTROL_HANDED_BACK);
    personOn.push(SHARED);
    expect(answers.retry(waiter, true, "retry")).toBe("retry");
  });

  it("sees no person when nobody took the seat, stops at its deadline, and listens to the claim once", async () => {
    vi.useFakeTimers();
    try {
      const { resources, answers } = setup();
      resources.startWaiting(SHARED, waiter);
      const begin = new Promise<void>(() => {});
      const then = vi.spyOn(begin, "then");
      const waited = answers.waitForClaim(begin, Date.now() + 1_000, waiter, nobody, 0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await waited).toBe(false);
      expect(then).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the turn now has the computer only for a seat it holds in this generation", () => {
    const { resources, bound, answers } = setup();
    expect(answers.waited(waiter)).toBe(CONTROL_WAITED);
    bound.set(waiter.threadId, { owner: waiter, resource: SHARED });
    expect(answers.waited(waiter)).toBe(CONTROL_WAITED);
    resources.claim(SHARED, waiter);
    expect(answers.waited(waiter)).toBe(CONTROL_WAITED_HELD);
    expect(answers.waited({ ...waiter, generation: "older" })).toBe(CONTROL_WAITED);
  });
});

import { describe, expect, it } from "vitest";
import { createComputerFrames, createFrameBudget, mapComputerState, type ComputerFramesOptions, type FrameMachine } from "./computer-frames.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(machines: FrameMachine[], overrides: Partial<ComputerFramesOptions> = {}) {
  let clock = 1_000_000;
  const captured: string[] = [];
  const turn = new Map<string, { data: string; mime: string; at: number }>();
  const working = new Set<string>();
  const held = new Set<string>();
  let listed = machines;
  let lists = 0;
  const frames = createComputerFrames({
    listMachines: async () => { lists += 1; return listed; },
    capture: async (boxId) => { captured.push(boxId); return { data: `frame-of-${boxId}`, mime: "image/jpeg" }; },
    turnFrame: (boxId) => turn.get(boxId),
    working: (owner) => working.has(owner),
    held: (owner) => held.has(owner),
    now: () => clock,
    tickMs: 1e9,
    ...overrides,
  });
  return {
    frames, captured, turn, working, held,
    lists: () => lists,
    setMachines: (next: FrameMachine[]) => { listed = next; },
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    /** Ticks every 250 ms of fake time, letting captures settle in between. */
    async run(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 250) {
        clock += 250;
        frames.tick();
        await flush();
      }
    },
  };
}

const running = (count: number, state = "running"): FrameMachine[] =>
  Array.from({ length: count }, (_, index) => ({ owner: `bot-${index}`, boxId: `bx_${index}`, state }));

describe("frame budget", () => {
  it("allows at most one second's worth at once and refills at the given rate", () => {
    let clock = 0;
    const budget = createFrameBudget(4, () => clock);
    expect([1, 2, 3, 4, 5].map(() => budget.take())).toEqual([true, true, true, true, false]);
    clock += 250;
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
  });
});

describe("Team map frames", () => {
  it("keeps every machine together under the global frame budget", async () => {
    const test = harness(running(20), { framesPerSecond: 4, concurrency: 20, workingIntervalMs: 1_000, idleIntervalMs: 1_000 });
    for (let index = 0; index < 20; index++) test.working.add(`bot-${index}`);
    await test.frames.watch();
    for (let second = 0; second < 10; second++) {
      await test.frames.watch();
      await test.run(1_000);
    }
    // 4 a second for 10 seconds, plus the first second's burst.
    expect(test.captured.length).toBeGreaterThanOrEqual(36);
    expect(test.captured.length).toBeLessThanOrEqual(44);
  });

  it("never captures a machine that is asleep, starting, gone or under a person's control", async () => {
    const machines: FrameMachine[] = [
      { owner: "asleep", boxId: "bx_a", state: "archived" },
      { owner: "starting", boxId: "bx_s", state: "provisioning" },
      { owner: "failed", boxId: "bx_f", state: "error" },
      { owner: "held", boxId: "bx_h", state: "running" },
      { owner: "on", boxId: "bx_o", state: "idle" },
    ];
    const test = harness(machines);
    test.held.add("held");
    await test.frames.watch();
    await test.run(60_000);
    expect(new Set(test.captured)).toEqual(new Set(["bx_o"]));
  });

  it("reuses a fresh turn frame and captures only once the turn stops feeding the screen", async () => {
    const test = harness(running(1), { turnStaleMs: 10_000, turnFeedMs: 20_000, workingIntervalMs: 4_000 });
    test.working.add("bot-0");
    test.turn.set("bx_0", { data: "turn", mime: "image/jpeg", at: test.now() });
    for (let second = 0; second < 9; second += 3) {
      await test.frames.watch();
      await test.run(3_000);
    }
    expect(test.captured).toEqual([]);
    expect(test.frames.frame("bot-0")).toMatchObject({ source: "turn", data: "turn" });
    await test.frames.watch();
    await test.run(2_000);
    expect(test.captured).toEqual(["bx_0"]);
    expect(test.frames.frame("bot-0")).toMatchObject({ source: "map", data: "frame-of-bx_0" });
  });

  it("refreshes a working machine every few seconds and an idle one slowly", async () => {
    const test = harness(running(2), { workingIntervalMs: 4_000, idleIntervalMs: 30_000 });
    test.working.add("bot-0");
    for (let second = 0; second < 60; second += 5) {
      await test.frames.watch();
      await test.run(5_000);
    }
    const count = (boxId: string) => test.captured.filter((id) => id === boxId).length;
    expect(count("bx_0")).toBeGreaterThanOrEqual(12);
    expect(count("bx_1")).toBeGreaterThanOrEqual(2);
    expect(count("bx_1")).toBeLessThanOrEqual(3);
  });

  it("stops asking for frames soon after the last map request", async () => {
    const test = harness(running(1), { idleIntervalMs: 1_000 });
    await test.frames.watch();
    await test.run(6_000);
    const watched = test.captured.length;
    expect(watched).toBeGreaterThan(3);
    await test.run(60_000);
    expect(test.captured.length).toBeLessThanOrEqual(watched + 1);
    expect(test.frames.watching()).toBe(false);
  });

  it("backs off a machine whose captures fail", async () => {
    let attempts = 0;
    const test = harness(running(1), {
      idleIntervalMs: 1_000,
      capture: async () => { attempts += 1; throw new Error("busy"); },
    });
    for (let second = 0; second < 60; second += 5) {
      await test.frames.watch();
      await test.run(5_000);
    }
    // 5 s, 10 s, 20 s, 40 s apart: never a capture every tick.
    expect(attempts).toBeLessThanOrEqual(5);
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it("never has more captures in flight than its concurrency", async () => {
    const pending: Array<() => void> = [];
    let peak = 0;
    let open = 0;
    const test = harness(running(10), {
      concurrency: 3, framesPerSecond: 100,
      capture: () => new Promise((resolve) => {
        open += 1; peak = Math.max(peak, open);
        pending.push(() => { open -= 1; resolve({ data: "x", mime: "image/jpeg" }); });
      }),
    });
    await test.frames.watch();
    await test.run(2_000);
    expect(peak).toBe(3);
    pending.splice(0).forEach((done) => done());
  });

  it("makes no provider call while provider settings change", async () => {
    const test = harness(running(3), { paused: () => true });
    await test.frames.watch();
    await test.run(30_000);
    expect(test.lists()).toBe(0);
    expect(test.captured).toEqual([]);
  });

  it("forgets frames of machines that left the account", async () => {
    const test = harness(running(2));
    await test.frames.watch();
    await test.run(1_000);
    expect(test.frames.frame("bot-1")).toBeDefined();
    test.setMachines(running(1));
    await test.frames.refresh();
    expect(test.frames.frame("bot-1")).toBeUndefined();
  });
});

describe("map computer state", () => {
  it("names the machine's state in the words the map shows", () => {
    const machine = (state: string) => ({ owner: "bot", boxId: "bx_1", state });
    expect(mapComputerState(undefined, false)).toBe("off");
    expect(mapComputerState(machine("running"), true)).toBe("working");
    expect(mapComputerState(machine("idle"), false)).toBe("idle");
    expect(mapComputerState(machine("provisioning"), false)).toBe("starting");
    expect(mapComputerState(machine("archived"), true)).toBe("asleep");
    expect(mapComputerState(machine("error"), false)).toBe("problem");
    expect(mapComputerState(machine("removing"), false)).toBe("off");
  });
});

import { describe, expect, it } from "vitest";

import { createJobSlots, slotLimit } from "./job-slots.ts";

const later = () => {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  return { done, finish };
};

describe("a few background jobs at once", () => {
  it("runs at most the limit, the rest in arrival order", async () => {
    const slots = createJobSlots(2);
    const started: number[] = [];
    const gates = [later(), later(), later(), later()];
    const runs = gates.map((gate, i) => slots.run(async () => { started.push(i); await gate.done; return i; }));
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(slots.waiting).toBe(2);
    gates[1]!.finish();
    await runs[1];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.finish(); gates[2]!.finish(); gates[3]!.finish();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(slots.running).toBe(0);
  });

  it("never starts a job whose signal aborts while it waits, and frees its place", async () => {
    const slots = createJobSlots(1);
    const gate = later();
    const first = slots.run(() => gate.done);
    const abort = new AbortController();
    let ran = false;
    const second = slots.run(async () => { ran = true; }, { signal: abort.signal });
    abort.abort();
    await expect(second).rejects.toThrow();
    expect(slots.waiting).toBe(0);
    gate.finish();
    await first;
    expect(ran).toBe(false);
    expect(slots.running).toBe(0);
  });

  it("starts a job at once, over the limit, once someone waits on it", async () => {
    const slots = createJobSlots(1);
    const gate = later();
    const first = slots.run(() => gate.done);
    let awaited = false, ran = false;
    const second = slots.run(async () => { ran = true; }, { urgent: () => awaited });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ran).toBe(false);
    awaited = true;
    await second;
    expect(ran).toBe(true);
    gate.finish();
    await first;
    expect(slots.running).toBe(0);
  });

  it("lets what a person sees soon wait ahead of what nobody sees, each in arrival order, and says when a job waits", async () => {
    const slots = createJobSlots(1);
    const gate = later();
    const order: string[] = [];
    const waited: string[] = [];
    const first = slots.run(() => gate.done);
    const runs = [["review", false], ["upkeep", false], ["title", true], ["suggestions", true]].map(([name, interactive]) =>
      slots.run(async () => { order.push(name as string); }, { interactive: interactive as boolean, onWait: () => waited.push(name as string) }));
    expect(waited).toEqual(["review", "upkeep", "title", "suggestions"]);
    gate.finish();
    await Promise.all([first, ...runs]);
    expect(order).toEqual(["title", "suggestions", "review", "upkeep"]);
    let told = false;
    await slots.run(async () => undefined, { onWait: () => { told = true; } });
    expect(told).toBe(false);
  });

  it("reads its limit from the environment only when it is a whole number from 1 to 64", () => {
    expect(slotLimit("5", 3)).toBe(5);
    for (const raw of [undefined, "", "0", "65", "2.5", "many"]) expect(slotLimit(raw, 3)).toBe(3);
  });
});

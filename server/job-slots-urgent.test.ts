import { describe, expect, it } from "vitest";

import { createJobSlots } from "./job-slots.ts";

function gate() {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  return { done, finish };
}

describe("background capacity after urgent work", () => {
  it.each([0, 1])("keeps ordinary jobs queued when running work still fills the limit after job %i ends", async (firstToFinish) => {
    const slots = createJobSlots(1);
    const gates = [gate(), gate(), gate()];
    const started: number[] = [];
    const runs = gates.map((hold, index) => slots.run(async () => {
      started.push(index);
      await hold.done;
    }, index === 1 ? { urgent: () => true } : {}));
    try {
      await Promise.resolve();
      expect(started).toEqual([0, 1]);
      expect(slots.running).toBe(2);
      gates[firstToFinish]!.finish();
      await runs[firstToFinish];
      expect(started).toEqual([0, 1]);
      expect(slots.running).toBe(1);
      expect(slots.waiting).toBe(1);
      gates[1 - firstToFinish]!.finish();
      await runs[1 - firstToFinish];
      expect(started).toEqual([0, 1, 2]);
      expect(slots.running).toBe(1);
    } finally {
      for (const hold of gates) hold.finish();
      await Promise.all(runs);
    }
    expect(slots.running).toBe(0);
    expect(slots.waiting).toBe(0);
  });

  it("drains several urgent jobs before handing a slot back to ordinary work", async () => {
    const slots = createJobSlots(1);
    const gates = [gate(), gate(), gate(), gate()];
    const started: number[] = [];
    const runs = gates.map((hold, index) => slots.run(async () => {
      started.push(index);
      await hold.done;
    }, index === 1 || index === 2 ? { urgent: () => true } : {}));
    try {
      await Promise.resolve();
      expect(started).toEqual([0, 1, 2]);
      for (const index of [1, 2]) {
        gates[index]!.finish();
        await runs[index];
        expect(started).toEqual([0, 1, 2]);
        expect(slots.waiting).toBe(1);
      }
      gates[0]!.finish();
      await runs[0];
      expect(started).toEqual([0, 1, 2, 3]);
      expect(slots.running).toBe(1);
    } finally {
      for (const hold of gates) hold.finish();
      await Promise.all(runs);
    }
    expect(slots.running).toBe(0);
  });
});

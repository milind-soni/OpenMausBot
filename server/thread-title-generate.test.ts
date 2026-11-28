import { describe, expect, it, vi } from "vitest";

import { createJobSlots } from "./job-slots.ts";
import { generateThreadTitle } from "./thread-title-generate.ts";

const titleWarnings = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("title generation:"));

describe("generateThreadTitle deadlines", () => {
  it("times out while waiting for a slot and never calls the provider after expiry", async () => {
    vi.useFakeTimers();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const slots = createJobSlots(1);
      let free!: () => void;
      const busy = slots.run(() => new Promise<void>((resolve) => { free = resolve; }));
      await vi.advanceTimersByTimeAsync(0);
      const provider = { generateText: vi.fn(async () => "Title") };
      const result = generateThreadTitle(provider, "request", "first-message", slots);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toBeNull();
      expect(slots.waiting).toBe(0);
      free();
      await busy;
      expect(provider.generateText).not.toHaveBeenCalled();
    } finally {
      warnings.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps the current title on a KEEP reply", async () => {
    expect(await generateThreadTitle({ generateText: async () => "KEEP" }, "request", "follow-up", createJobSlots(1))).toBeNull();
  });
  it("keeps an explicit regeneration alive at 10000 ms and returns a title that arrives at 12000 ms", async () => {
    vi.useFakeTimers();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const slots = createJobSlots(1);
      let signal: AbortSignal | undefined;
      const provider = { generateText: (_prompt: string, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise<string>((resolve) => { setTimeout(() => resolve("Trip plan"), 12_000); });
      } };
      const title = generateThreadTitle(provider, "plan the trip", "conversation", slots);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await title).toBe("Trip plan");
      expect(titleWarnings(warnings)).toEqual([]);
    } finally {
      warnings.mockRestore();
      vi.useRealTimers();
    }
  });

  it("aborts an explicit regeneration at 30000 ms, warns once, and releases the slot when the engine call ends", async () => {
    vi.useFakeTimers();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const slots = createJobSlots(1);
      let signal: AbortSignal | undefined;
      let rejectCall!: (error: Error) => void;
      const provider = { generateText: (_prompt: string, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise<string>((_resolve, reject) => { rejectCall = reject; });
      } };
      let settled = false;
      const title = generateThreadTitle(provider, "plan the trip", "conversation", slots).then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(signal?.aborted).toBe(false);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect(await title).toBeNull();
      expect(titleWarnings(warnings)).toEqual(["title generation: timeout budgetMs=30000"]);
      expect(slots.running).toBe(1);
      rejectCall(new Error("late"));
      await vi.advanceTimersByTimeAsync(0);
      expect(slots.running).toBe(0);
      expect(titleWarnings(warnings)).toEqual(["title generation: timeout budgetMs=30000"]);
    } finally {
      warnings.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([["first-message", 30_000], ["call", 10_000]] as const)("bounds %s at %i ms and holds the slot until the call ends", async (source, timeoutMs) => {
    vi.useFakeTimers();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const slots = createJobSlots(1);
      let end!: (text: string) => void;
      let aborted = false;
      const provider = { generateText: (_prompt: string, options?: { signal?: AbortSignal }) => {
        options?.signal?.addEventListener("abort", () => { aborted = true; });
        return new Promise<string>((resolve) => { end = resolve; });
      } };
      const title = generateThreadTitle(provider, "plan the trip", source, slots);
      await vi.advanceTimersByTimeAsync(timeoutMs);
      expect(await title).toBeNull();
      expect(aborted).toBe(true);
      expect(slots.running).toBe(1);
      expect(titleWarnings(warnings)).toEqual(source === "call" ? [] : ["title generation: timeout budgetMs=30000"]);
      end("Trip plan");
      await vi.advanceTimersByTimeAsync(0);
      expect(slots.running).toBe(0);
      expect(titleWarnings(warnings)).toEqual(source === "call" ? [] : ["title generation: timeout budgetMs=30000"]);
    } finally {
      warnings.mockRestore();
      vi.useRealTimers();
    }
  });
});

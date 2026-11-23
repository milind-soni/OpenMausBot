import { describe, expect, it } from "vitest";

import { memoryStopText } from "./engine-memory.ts";
import { browsedSince, FREEZE_LOOKBACK_MS, frozeForMemory, FROZE_BROWSING, restartCutStop } from "./memory-freeze-restart.ts";
import type { StallRecord } from "./perf/stall-sample.ts";

const START = 1_800_000_000_000;

function stall(at: number, machine: Partial<StallRecord["machine"]>, why?: StallRecord["why"]): StallRecord {
  return { at, blockedSinceMs: 71_000, kind: "not-profiled", ...(why ? { why } : {}), top: [], stack: [], thread: { state: "D", wchan: "folio_wait_bit_common" },
    machine: { availableMB: null, memoryFull10: null, cpuSome10: null, stealPct: null, ...machine }, memory: [{ bucket: "browser", rssMB: 1406, procs: 22 }] };
}

describe("the restart after a memory freeze", () => {
  it("knows a freeze for want of memory from the stall watch's records before this start", () => {
    const frozen = stall(START - 26 * 60_000, { availableMB: 17, memoryFull10: 51 }, "memory");
    expect(frozeForMemory([frozen], START)).toBe(true);
    // Memory available alone, or the stall alone, is enough.
    expect(frozeForMemory([stall(START - 60_000, { availableMB: 120, memoryFull10: 2 })], START)).toBe(true);
    expect(frozeForMemory([stall(START - 60_000, { availableMB: 900, memoryFull10: 45 })], START)).toBe(true);
    // A record that read neither counts by the reason it took no profile.
    expect(frozeForMemory([stall(START - 60_000, {}, "memory")], START)).toBe(true);
    expect(frozeForMemory([stall(START - 60_000, {}, "hourly-cap")], START)).toBe(false);
  });

  it("does not take a busy main thread with memory to spare, an old stall, or one from after this start for one", () => {
    expect(frozeForMemory([stall(START - 60_000, { availableMB: 900, memoryFull10: 6 }, "memory")], START)).toBe(false);
    expect(frozeForMemory([stall(START - FREEZE_LOOKBACK_MS - 1, { availableMB: 17, memoryFull10: 51 })], START)).toBe(false);
    expect(frozeForMemory([stall(START + 1, { availableMB: 17, memoryFull10: 51 })], START)).toBe(false);
    expect(frozeForMemory([], START)).toBe(false);
  });

  it("knows a turn browsed from its browser calls since it started, in any of the names they arrive in", () => {
    const at = START - 120_000;
    expect(browsedSince([{ at, tool: { name: "agent_browser_open" } }], at)).toBe(true);
    expect(browsedSince([{ at, tool: { name: "mcp__browser__browser_navigate" } }], at)).toBe(true);
    expect(browsedSince([{ at, tool: { name: "mcp__computer__click" } }, { at, tool: { name: "Bash" } }, { at }], at)).toBe(false);
    // A call of an earlier turn in the same conversation is not this one's.
    expect(browsedSince([{ at: at - 1, tool: { name: "agent_browser_open" } }], at)).toBe(false);
  });

  it("ends a browsing turn with the line of a browser closed for memory, read from the records once", () => {
    expect(FROZE_BROWSING).toBe(memoryStopText(true));
    expect(FROZE_BROWSING).toBe("Ran out of room, so I closed the browser to keep everything else running.");
    let reads = 0;
    const lines: Record<string, Array<{ at: number; tool?: { name: string } }>> = {
      browsed: [{ at: START - 100_000, tool: { name: "agent_browser_open" } }],
      wrote: [{ at: START - 100_000, tool: { name: "Write" } }],
    };
    const cut = restartCutStop({ dataDir: "/data", startedAt: START, lines: (threadId) => lines[threadId] ?? [],
      read: (file) => { reads += 1; expect(file.replaceAll("\\", "/")).toBe("/data/perf-stalls.json"); return [stall(START - 26 * 60_000, { availableMB: 17, memoryFull10: 51 }, "memory")]; } });
    expect(cut("browsed", START - 120_000)).toBe(FROZE_BROWSING);
    expect(cut("wrote", START - 120_000)).toBeNull();
    expect(reads).toBe(1);
    const healthy = restartCutStop({ dataDir: "/data", startedAt: START, lines: (threadId) => lines[threadId] ?? [], read: () => [] });
    expect(healthy("browsed", START - 120_000)).toBeNull();
  });
});

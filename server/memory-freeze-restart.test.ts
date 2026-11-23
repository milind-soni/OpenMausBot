import { describe, expect, it } from "vitest";

import { memoryStopText } from "./engine-memory.ts";
import { browsedSince, frozeForMemory, FROZE_BROWSING, restartCutStop } from "./memory-freeze-restart.ts";
import type { StallRecord } from "./perf/stall-sample.ts";

const START = 1_800_000_000_000, MINUTE = 60_000;

function stall(at: number, machine: Partial<StallRecord["machine"]>, why?: StallRecord["why"]): StallRecord {
  return { at, blockedSinceMs: 71_000, kind: "not-profiled", ...(why ? { why } : {}), top: [], stack: [], thread: { state: "D", wchan: "folio_wait_bit_common" },
    machine: { availableMB: null, memoryFull10: null, cpuSome10: null, stealPct: null, ...machine }, memory: [{ bucket: "browser", rssMB: 1406, procs: 22 }] };
}

describe("the restart after a memory freeze", () => {
  const turnStart = START - 30 * MINUTE;

  it("knows a freeze for want of memory that a turn ran through from the stall watch's records", () => {
    const frozen = stall(START - 26 * MINUTE, { availableMB: 17, memoryFull10: 51 }, "memory");
    expect(frozeForMemory([frozen], turnStart, START)).toBe(true);
    // Memory available alone, or the stall alone, is enough.
    expect(frozeForMemory([stall(START - MINUTE, { availableMB: 120, memoryFull10: 2 })], turnStart, START)).toBe(true);
    expect(frozeForMemory([stall(START - MINUTE, { availableMB: 900, memoryFull10: 45 })], turnStart, START)).toBe(true);
    // A record that read neither counts by the reason it took no profile.
    expect(frozeForMemory([stall(START - MINUTE, {}, "memory")], turnStart, START)).toBe(true);
    expect(frozeForMemory([stall(START - MINUTE, {}, "hourly-cap")], turnStart, START)).toBe(false);
  });

  it("does not take a busy main thread with memory to spare, a stall before the turn started, or one after this start", () => {
    expect(frozeForMemory([stall(START - MINUTE, { availableMB: 900, memoryFull10: 6 }, "memory")], turnStart, START)).toBe(false);
    expect(frozeForMemory([stall(turnStart - 1, { availableMB: 17, memoryFull10: 51 })], turnStart, START)).toBe(false);
    expect(frozeForMemory([stall(START + 1, { availableMB: 17, memoryFull10: 51 })], turnStart, START)).toBe(false);
    expect(frozeForMemory([], turnStart, START)).toBe(false);
  });

  it("knows a turn browsed from its browser calls since it started, in any of the names they arrive in", () => {
    const at = START - 2 * MINUTE;
    expect(browsedSince([{ at, tool: { name: "agent_browser_open" } }], at)).toBe(true);
    expect(browsedSince([{ at, tool: { name: "mcp__browser__browser_navigate" } }], at)).toBe(true);
    expect(browsedSince([{ at, tool: { name: "mcp__computer__click" } }, { at, tool: { name: "Bash" } }, { at }], at)).toBe(false);
    // A call of an earlier turn in the same conversation is not this one's.
    expect(browsedSince([{ at: at - 1, tool: { name: "agent_browser_open" } }], at)).toBe(false);
  });

  it("ends a browsing turn that ran through the freeze with the line of a browser closed for memory", () => {
    expect(FROZE_BROWSING).toBe(memoryStopText(true));
    expect(FROZE_BROWSING).toBe("Ran out of room, so I closed the browser to keep everything else running.");
    let reads = 0;
    const lines: Record<string, Array<{ at: number; tool?: { name: string } }>> = {
      browsed: [{ at: turnStart + MINUTE, tool: { name: "agent_browser_open" } }],
      wrote: [{ at: turnStart + MINUTE, tool: { name: "Write" } }],
    };
    const cut = restartCutStop({ dataDir: "/data", startedAt: START, lines: (threadId) => lines[threadId] ?? [],
      read: (file) => { reads += 1; expect(file.replaceAll("\\", "/")).toBe("/data/perf-stalls.json"); return [stall(START - 26 * MINUTE, { availableMB: 17, memoryFull10: 51 }, "memory")]; } });
    expect(cut("browsed", turnStart)).toBe(FROZE_BROWSING);
    expect(cut("wrote", turnStart)).toBeNull();
    // A turn whose start is unknown is started again: any browser call ever made in its conversation would count otherwise.
    expect(cut("browsed", undefined)).toBeNull();
    expect(reads).toBe(1);
    const healthy = restartCutStop({ dataDir: "/data", startedAt: START, lines: (threadId) => lines[threadId] ?? [], read: () => [] });
    expect(healthy("browsed", turnStart)).toBeNull();
  });

  it("starts again a browsing turn that began after a freeze the server came back from, when an update restart cuts it", () => {
    // A freeze 50 minutes ago, then a turn that started 5 minutes ago and browsed, cut by an ordinary update restart.
    const started = START - 5 * MINUTE;
    const cut = restartCutStop({ dataDir: "/data", startedAt: START, lines: () => [{ at: started + 30_000, tool: { name: "agent_browser_open" } }],
      read: () => [stall(START - 50 * MINUTE, { availableMB: 17, memoryFull10: 51 }, "memory")] });
    expect(cut("browsed", started)).toBeNull();
  });
});

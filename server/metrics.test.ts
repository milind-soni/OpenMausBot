// Measurement (Phase 0, item 0.6): tokens per task, cache-hit share, prompt
// shape per turn, and stable-prefix changes — computed from rows the ledger
// already writes, for every engine.
import { describe, expect, it } from "vitest";

import { cacheHitShare, promptShape, stableSectionChanges, summarizeMetrics } from "./metrics.ts";
import type { UsageRow } from "./usage-ledger.ts";

const row = (over: Partial<UsageRow> & { botId: string }): UsageRow => ({
  at: "2026-09-15T10:00:00.000Z",
  botName: over.botId,
  threadId: "t1",
  instanceId: "claude",
  driverKind: "claudeAgent",
  model: "m",
  input: 1_000,
  output: 100,
  costUsd: null,
  trigger: { kind: "owner" },
  ...over,
});

describe("promptShape", () => {
  it("sums stable and volatile bytes from the prompt sections and records a replay", () => {
    const shape = promptShape(
      [
        { id: "persona", bytes: 100 },
        { id: "memory", bytes: 400 },
        { id: "skills", bytes: 50 },
        { id: "mentions", bytes: 10 },
      ],
      { replayed: true, replayBytes: 8_000 },
    );
    expect(shape).toEqual({
      sections: [{ id: "persona", bytes: 100 }, { id: "memory", bytes: 400 }, { id: "skills", bytes: 50 }, { id: "mentions", bytes: 10 }],
      stableBytes: 150,
      volatileBytes: 410,
      totalBytes: 560,
      replayed: true,
      replayBytes: 8_000,
    });
  });
});

describe("stableSectionChanges", () => {
  it("names the stable sections whose size changed since the previous turn, ignoring volatile ones", () => {
    const prev = [{ id: "persona", bytes: 100 }, { id: "skill-instructions", bytes: 0 }, { id: "memory", bytes: 400 }];
    const next = [{ id: "persona", bytes: 100 }, { id: "skill-instructions", bytes: 3_000 }, { id: "memory", bytes: 900 }];
    expect(stableSectionChanges(prev, next)).toEqual(["skill-instructions"]);
    expect(stableSectionChanges(next, next)).toEqual([]);
    expect(stableSectionChanges(undefined, next)).toEqual([]);
  });
});

describe("cacheHitShare", () => {
  it("is the cached share of input over the rows that report it, and null when none do", () => {
    expect(cacheHitShare([row({ botId: "a", input: 1_000, cachedInput: 900 }), row({ botId: "a", input: 1_000, cachedInput: 500 })])).toEqual({ share: 0.7, reported: 2, turns: 2 });
    expect(cacheHitShare([row({ botId: "a" })])).toEqual({ share: null, reported: 0, turns: 1 });
    expect(cacheHitShare([])).toEqual({ share: null, reported: 0, turns: 0 });
  });
});

describe("summarizeMetrics", () => {
  const rows = [
    row({ botId: "dev", threadId: "t1", input: 2_000, output: 200, cachedInput: 1_800, hookCoverage: "full", promptShape: { stableBytes: 5_000, volatileBytes: 1_000, totalBytes: 6_000, replayed: false, replayBytes: 0, stableChanged: [] } }),
    row({ botId: "dev", threadId: "t1", input: 3_000, output: 300, cachedInput: 600, hookCoverage: "preview", promptShape: { stableBytes: 5_500, volatileBytes: 1_000, totalBytes: 6_500, replayed: true, replayBytes: 4_000, stableChanged: ["skill-instructions"] } }),
    row({ botId: "dev", threadId: "t2", input: 1_000, output: 100, hookCoverage: "preview" }),
    row({ botId: "scout", driverKind: "openai-compat", threadId: "t3", input: 500, output: 50, hookCoverage: "none", trigger: { kind: "routine" } }),
  ];

  it("reports per bot: turns, tasks, tokens per turn and per task, cache share, prefix changes, replays, evidence coverage", () => {
    const summary = summarizeMetrics(rows);
    const dev = summary.bots.find((b) => b.botId === "dev")!;
    expect(dev).toMatchObject({
      botId: "dev",
      turns: 3,
      tasks: 2,
      input: 6_000,
      output: 600,
      tokensPerTurn: 2_200,
      tokensPerTask: 3_300,
      cacheHitShare: { share: 0.48, reported: 2, turns: 3 },
      stablePrefixChanges: 1,
      replays: 1,
      coverage: { full: 1, preview: 2, none: 0 },
      promptBytes: { stable: 5_250, volatile: 1_000, turns: 2 },
    });
    const scout = summary.bots.find((b) => b.botId === "scout")!;
    expect(scout.cacheHitShare).toEqual({ share: null, reported: 0, turns: 1 });
    expect(scout.coverage).toEqual({ full: 0, preview: 0, none: 1 });
  });

  it("reports the same per engine and per trigger, so a regression on one engine shows", () => {
    const summary = summarizeMetrics(rows);
    expect(summary.engines.map((e) => [e.driverKind, e.turns])).toEqual([["claudeAgent", 3], ["openai-compat", 1]]);
    expect(summary.triggers.map((t) => [t.kind, t.turns])).toEqual([["owner", 3], ["routine", 1]]);
    expect(summary.total).toMatchObject({ turns: 4, tasks: 3, input: 6_500, output: 650 });
  });
});

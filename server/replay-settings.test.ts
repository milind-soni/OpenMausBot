import { describe, expect, it } from "vitest";
import { z } from "zod";

import { selectReplay } from "./context-rebuild.ts";
import { replaySettings, replayToolHistoryEnabled } from "./replay-settings.ts";

describe("replaySettings", () => {
  // as server/config.ts takes them: added to the `context` group
  const context = z.object({ compactAt: z.number().optional() }).extend(replaySettings);

  it("is the replay's two settings, each optional, beside whatever else the group holds", () => {
    expect(Object.keys(replaySettings).sort()).toEqual(["rebuildBytes", "replayToolHistory"]);
    expect(context.parse({})).toEqual({});
    expect(context.parse({ compactAt: 0.7, rebuildBytes: 32_000, replayToolHistory: true }))
      .toEqual({ compactAt: 0.7, rebuildBytes: 32_000, replayToolHistory: true });
  });

  it("bounds rebuildBytes, with the floor selectReplay itself refuses to go under", () => {
    for (const value of [1_024, 24_000, 1_000_000]) expect(context.parse({ rebuildBytes: value })).toEqual({ rebuildBytes: value });
    for (const value of [512, 1_023, 1_024.1, 1_000_001, "24000", null]) expect(() => context.parse({ rebuildBytes: value })).toThrow();
    // a budget this lets through never makes the replay throw, and the first one it refuses would
    expect(() => selectReplay([], { budgetBytes: 1_024 })).not.toThrow();
    expect(() => selectReplay([], { budgetBytes: 1_023 })).toThrow("invalid context");
  });

  it("takes replayToolHistory as a boolean only", () => {
    for (const value of [true, false]) expect(context.parse({ replayToolHistory: value })).toEqual({ replayToolHistory: value });
    for (const value of ["1", 1, "true", null]) expect(() => context.parse({ replayToolHistory: value })).toThrow();
  });
});

describe("replayToolHistoryEnabled", () => {
  const ON = { replayToolHistory: true };
  const NO_ENV: NodeJS.ProcessEnv = {};

  it("is off unless the setting is switched on", () => {
    expect(replayToolHistoryEnabled(undefined, NO_ENV)).toBe(false);
    expect(replayToolHistoryEnabled({}, NO_ENV)).toBe(false);
    expect(replayToolHistoryEnabled({ replayToolHistory: false }, NO_ENV)).toBe(false);
    expect(replayToolHistoryEnabled(ON, NO_ENV)).toBe(true);
  });

  it("lets OMB_REPLAY_TOOL_HISTORY win over the file, both ways", () => {
    expect(replayToolHistoryEnabled(undefined, { OMB_REPLAY_TOOL_HISTORY: "1" })).toBe(true);
    expect(replayToolHistoryEnabled({ replayToolHistory: false }, { OMB_REPLAY_TOOL_HISTORY: "1" })).toBe(true);
    expect(replayToolHistoryEnabled(ON, { OMB_REPLAY_TOOL_HISTORY: "0" })).toBe(false);
    // anything else is not an answer: the file decides
    for (const value of ["", "true", "yes", "2"]) {
      expect(replayToolHistoryEnabled(ON, { OMB_REPLAY_TOOL_HISTORY: value })).toBe(true);
      expect(replayToolHistoryEnabled(undefined, { OMB_REPLAY_TOOL_HISTORY: value })).toBe(false);
    }
  });
});

import { describe, expect, it, vi } from "vitest";

import { MAX_ALWAYS_ALLOW, recoveredGrants, withAlwaysAllowKey } from "./always-allow.ts";

const full = Array.from({ length: MAX_ALWAYS_ALLOW }, (_, i) => `provider-tool:claude:linear:tool_${i}:0123456789abcdef`);

describe("adding an Always allow grant", () => {
  it("adds a new key once and keeps the ones already there", () => {
    expect(withAlwaysAllowKey(undefined, "Read")).toEqual(["Read"]);
    expect(withAlwaysAllowKey(["Read"], "Grep")).toEqual(["Read", "Grep"]);
    expect(withAlwaysAllowKey(["Read", "Grep"], "Read")).toEqual(["Read", "Grep"]);
  });

  it("refuses a new key when the list is full instead of dropping it", () => {
    expect(withAlwaysAllowKey(full.slice(1), full[0])).toHaveLength(MAX_ALWAYS_ALLOW);
    expect(withAlwaysAllowKey(full, "provider-tool:claude:linear:one_more:0123456789abcdef")).toBeNull();
  });

  it("still accepts a key that is already on a full list", () => {
    expect(withAlwaysAllowKey(full, full[7])).toEqual(full);
  });
});

describe("recovering a bot's grants from its threads at start", () => {
  const recovered = Array.from({ length: 30 }, (_, i) => `provider-tool:claude:notes:read_${i}:0123456789abcdef`);

  it("adds them to the bot's own, each once, and says nothing while there is room", () => {
    const log = vi.fn();
    expect(recoveredGrants(["Read", recovered[0]!], recovered.slice(0, 3), "bot-1", log)).toEqual(["Read", ...recovered.slice(0, 3)]);
    expect(recoveredGrants(undefined, recovered, "bot-1", log)).toEqual(recovered);
    expect(recoveredGrants(full.slice(30), recovered, "bot-1", log)).toHaveLength(MAX_ALWAYS_ALLOW);
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps every grant the bot already has when its threads hold more than fit, and says how many were kept", () => {
    const log = vi.fn();
    const own = full.slice(10);
    expect(recoveredGrants(own, recovered, "bot-1", log)).toEqual([...own, ...recovered.slice(0, 10)]);
    expect(log).toHaveBeenCalledExactlyOnceWith("[always-allow] bot bot-1: kept 200 of 220 always-allowed tools (the limit is 200); the other 20 ask again.");
  });

  it("keeps the newest of a list that was already past the limit", () => {
    const log = vi.fn();
    const own = [...recovered.slice(0, 5), ...full];
    expect(recoveredGrants(own, recovered.slice(0, 6), "bot-1", log)).toEqual(full);
    expect(log).toHaveBeenCalledExactlyOnceWith("[always-allow] bot bot-1: kept 200 of 206 always-allowed tools (the limit is 200); the other 6 ask again.");
  });
});

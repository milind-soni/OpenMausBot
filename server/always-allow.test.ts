import { describe, expect, it } from "vitest";

import { MAX_ALWAYS_ALLOW, withAlwaysAllowKey } from "./always-allow.ts";

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

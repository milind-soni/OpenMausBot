import { describe, expect, it } from "vitest";

import { restoredProfileSource, withDepartmentRenamed, type ProfilesState } from "./state.ts";

describe("profiles state", () => {
  it("moves the areas on a department the app renamed, and no others", () => {
    const state: ProfilesState = { version: 1, areas: { bi: { section: "BI", hashes: { name: "a" } }, sales: { section: "Sales", hashes: {} } }, mcpServers: {} };
    expect(withDepartmentRenamed(state, "bi", "Analytics").areas).toEqual({ bi: { section: "Analytics", hashes: { name: "a" } }, sales: { section: "Sales", hashes: {} } });
  });

  it("keeps a restored stamp apply could have written and drops any other", () => {
    const stamp = { area: "bi", key: "analyst", file: "areas/bi/bots/analyst.md", commit: "a".repeat(40), appliedAt: 1, hashes: { soul: "0123456789abcdef" } };
    expect(restoredProfileSource(stamp)).toEqual(stamp);
    for (const forged of [
      { ...stamp, file: "areas/bi/bots/other.md" },
      { ...stamp, file: "../../outside.md" },
      { ...stamp, area: "../bi" },
      { ...stamp, hashes: { soul: "not a hash" } },
      { ...stamp, commit: "HEAD" },
      { ...stamp, folder: "/home/someone/profiles" },
      "bi/analyst",
      null,
    ]) expect(restoredProfileSource(forged)).toBeUndefined();
  });
});

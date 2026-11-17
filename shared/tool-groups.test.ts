import { describe, expect, it } from "vitest";

import { parseToolsOff, TOOL_GROUPS, toolsOffFromEnv } from "./tool-groups.ts";

describe("tool groups", () => {
  it("saves a list of known groups once each, in one order, and refuses anything else", () => {
    expect(parseToolsOff(["pages", "meetings", "pages"])).toEqual(["meetings", "pages"]);
    expect(parseToolsOff([])).toEqual([]);
    for (const bad of [["browser"], "meetings", null, [1], { meetings: true }]) expect(parseToolsOff(bad)).toBeNull();
  });

  it("reads the proxy's variable, ignoring a name it does not know", () => {
    expect(toolsOffFromEnv("email,future,meetings")).toEqual(["meetings", "email"]);
    expect(toolsOffFromEnv(undefined)).toEqual([]);
    expect(toolsOffFromEnv("")).toEqual([]);
    expect(toolsOffFromEnv(TOOL_GROUPS.join(","))).toEqual([...TOOL_GROUPS]);
  });
});

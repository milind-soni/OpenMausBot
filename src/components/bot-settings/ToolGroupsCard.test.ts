import { describe, expect, it } from "vitest";

import { shownToolGroups } from "./ToolGroupsCard";

describe("the Tools card", () => {
  it("shows the groups this workspace has, and a group a bot has off even where the workspace lost it", () => {
    expect(shownToolGroups(["pages", "data"], [])).toEqual(["data", "pages"]);
    expect(shownToolGroups(["pages"], ["meetings"])).toEqual(["meetings", "pages"]);
    expect(shownToolGroups(undefined, undefined)).toEqual([]);
  });
});

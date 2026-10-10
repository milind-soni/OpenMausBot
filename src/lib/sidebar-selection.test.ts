import { describe, expect, it } from "vitest";

import { botListItemPointerIntent } from "./sidebar-selection";

describe("botListItemPointerIntent", () => {
  it.each(["avatar", "body", "right edge"])("selects the bot from its %s", () => {
    expect(botListItemPointerIntent("click", false)).toBe("select");
  });

  it("leaves clicks inside the rename input with the editor", () => {
    expect(botListItemPointerIntent("click", true)).toBe("ignore");
  });

  it("ignores unrelated pointer events", () => {
    expect(botListItemPointerIntent("contextmenu", false)).toBe("ignore");
  });
});

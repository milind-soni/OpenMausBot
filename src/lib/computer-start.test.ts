// The one progress line a chat shows while a bot's computer starts.
import { describe, expect, it } from "vitest";

import { computerStartLine } from "./computer-start";

describe("computerStartLine", () => {
  it("names the bot's cloud computer while it is created or woken", () => {
    expect(computerStartLine({ state: "provisioning", place: "cloud" }, "Scout"))
      .toBe("Starting Scout's cloud computer. The first start takes about a minute.");
    expect(computerStartLine({ state: "waking", place: "cloud" }, "Scout")).toBe("Waking Scout's cloud computer…");
  });

  it("keeps the Local VM's line, and shows nothing when nothing is starting", () => {
    expect(computerStartLine({ state: "provisioning" }, "Scout")).toBe("Setting up this bot's computer…");
    expect(computerStartLine(undefined, "Scout")).toBeNull();
  });
});

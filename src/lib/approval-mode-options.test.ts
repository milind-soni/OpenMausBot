import { describe, expect, it } from "vitest";

import { approvalModeOptionsFor, simpleApprovalName } from "./approval-mode-options";

describe("simpleApprovalName", () => {
  it.each(["codex", "claudeAgent", "antigravityAgent"])("names every level as Advanced mode's selector does for %s", (driverKind) => {
    for (const option of approvalModeOptionsFor(driverKind)) {
      if (option.mode === "custom") continue;
      expect(simpleApprovalName(option.mode, driverKind)).toBe(option.label);
    }
  });

  it("keeps Custom short, without the config file Advanced mode names", () => {
    expect(simpleApprovalName("custom", "codex")).toBe("Custom");
  });
});

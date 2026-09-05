import { describe, expect, it } from "vitest";

import {
  APPROVAL_MODE_OPTIONS,
  approvalModeOptionsFor,
  approvalModeSelectionRequiresLocalDesktop,
} from "./ApprovalModeSelector";

describe("approval mode selector", () => {
  it("matches the four Codex approval levels and their plain-language copy", () => {
    expect(APPROVAL_MODE_OPTIONS.map(({ mode, label, description }) => ({ mode, label, description }))).toEqual([
      {
        mode: "ask",
        label: "Ask for approval",
        description: "Always ask to edit external files and use the internet",
      },
      {
        mode: "auto",
        label: "Approve for me",
        description: "Only ask for actions detected as potentially unsafe",
      },
      {
        mode: "full",
        label: "Full access",
        description: "Full computer access (elevated risk)",
      },
      {
        mode: "custom",
        label: "Custom (config.toml)",
        description: "Uses permissions defined in config.toml",
      },
    ]);
  });

  it("offers Full access and config.toml only when the bot uses Codex", () => {
    expect(approvalModeOptionsFor("codex").map((option) => option.mode)).toEqual([
      "ask",
      "auto",
      "full",
      "custom",
    ]);
    expect(approvalModeOptionsFor("claudeAgent").map((option) => option.mode)).toEqual([
      "ask",
      "auto",
    ]);
  });

  it("hides trusted modes when the packaged desktop bridge is unavailable", () => {
    expect(approvalModeOptionsFor("codex", false).map((option) => option.mode)).toEqual([
      "ask",
      "auto",
    ]);
  });

  it("locks an existing Custom bot to the local packaged desktop", () => {
    expect(approvalModeSelectionRequiresLocalDesktop("custom", false)).toBe(true);
    expect(approvalModeSelectionRequiresLocalDesktop("ask", false)).toBe(false);
    expect(approvalModeSelectionRequiresLocalDesktop("custom", true)).toBe(false);
  });
});

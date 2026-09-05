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
        description: "The provider reviews routine actions and asks about others; unattended turns always ask",
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

  it("offers provider-supported Full access but keeps config.toml Codex-only", () => {
    expect(approvalModeOptionsFor("codex").map((option) => option.mode)).toEqual([
      "ask",
      "auto",
      "full",
      "custom",
    ]);
    expect(approvalModeOptionsFor("claudeAgent").map((option) => option.mode)).toEqual([
      "ask",
      "auto",
      "full",
    ]);
  });

  it.each(["antigravityAgent", "cursorAgent", "grokAgent", "opencodeGo"])("offers Full access for %s", (kind) => {
    expect(approvalModeOptionsFor(kind).map((option) => option.mode)).toEqual(["ask", "auto", "full"]);
    expect(approvalModeOptionsFor(kind, false).map((option) => option.mode)).toEqual(["ask", "auto"]);
  });

  it("explains Auto fallbacks and does not elevate unknown providers", () => {
    expect(approvalModeOptionsFor("antigravityAgent").find((option) => option.mode === "auto")?.description).toContain("behaves like Ask");
    expect(approvalModeOptionsFor("customAgent").map((option) => option.mode)).toEqual(["ask", "auto"]);
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

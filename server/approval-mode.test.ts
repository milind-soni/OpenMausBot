import { describe, expect, it } from "vitest";

import {
  APPROVAL_MODES,
  approvalModeFor,
  supportsApprovalMode,
  hasNativeAutoReview,
  requiresNativeApproval,
  isEmergencyApprovalDowngrade,
  isApprovalMode,
} from "../shared/approval-mode.ts";

describe("approval modes", () => {
  it("only exposes implemented provider capabilities", () => {
    for (const driver of ["codex", "claudeAgent", "antigravityAgent", "cursorAgent", "grokAgent", "opencodeGo"]) {
      expect(supportsApprovalMode(driver, "full")).toBe(true);
      expect(supportsApprovalMode(driver, "custom")).toBe(driver === "codex");
      expect(hasNativeAutoReview(driver)).toBe(["codex", "claudeAgent", "cursorAgent"].includes(driver));
      expect(requiresNativeApproval(driver, "auto")).toBe(true);
    }
    for (const driver of [undefined, "customAgent", "pi"]) expect(supportsApprovalMode(driver, "full")).toBe(false);
    expect(requiresNativeApproval("antigravityAgent", "full")).toBe(true);
    expect(requiresNativeApproval("opencodeGo", "full")).toBe(false);
  });
  it("recognizes only the four durable values", () => {
    expect(APPROVAL_MODES).toEqual(["ask", "auto", "full", "custom"]);
    for (const mode of APPROVAL_MODES) expect(isApprovalMode(mode)).toBe(true);
    for (const value of [undefined, null, true, "automatic", "bypass"]) {
      expect(isApprovalMode(value)).toBe(false);
    }
  });

  it("migrates the legacy Auto bit to safe Auto, never Full access", () => {
    expect(approvalModeFor({ autoApprove: true })).toBe("auto");
    expect(approvalModeFor({ autoApprove: false })).toBe("ask");
    expect(approvalModeFor({})).toBe("ask");
  });

  it("prefers a valid explicit mode and fails closed around corrupt values", () => {
    expect(approvalModeFor({ approvalMode: "full", autoApprove: false })).toBe("full");
    expect(approvalModeFor({ approvalMode: "custom", autoApprove: true })).toBe("custom");
    expect(approvalModeFor({ approvalMode: "unknown", autoApprove: true })).toBe("auto");
    expect(approvalModeFor({ approvalMode: "unknown", autoApprove: false })).toBe("ask");
  });

  it("keeps an unconfirmed elevated grant in Ask", () => {
    expect(approvalModeFor({
      approvalMode: "full",
      approvalGrant: { requestId: "pending", mode: "full", phase: "prepared" },
    })).toBe("ask");
    expect(approvalModeFor({
      approvalMode: "custom",
      approvalGrant: { requestId: "pending", mode: "custom", phase: "confirmed" },
    })).toBe("ask");
  });

  it("permits only fail-closed recovery from an elevated mode", () => {
    expect(isEmergencyApprovalDowngrade("full", "ask")).toBe(true);
    expect(isEmergencyApprovalDowngrade("custom", "ask")).toBe(true);
    expect(isEmergencyApprovalDowngrade("full", "auto")).toBe(false);
    expect(isEmergencyApprovalDowngrade("ask", "auto")).toBe(false);
    expect(isEmergencyApprovalDowngrade("auto", "ask")).toBe(false);
  });
});

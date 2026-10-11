import { describe, expect, it } from "vitest";

import {
  APPROVAL_MODES,
  approvalModeFor,
  supportsApprovalMode,
  modelSwitchNeedsAsk,
  hasNativeAutoReview,
  isEmergencyApprovalDowngrade,
  isApprovalMode,
} from "../shared/approval-mode.ts";
import { createApprovalModeSupport } from "./harness-capabilities.ts";

describe("approval modes", () => {
  it("resets only grants that cannot safely carry to the selected provider", () => {
    for (const driver of ["codex", "claudeAgent", "grokAgent", "antigravityAgent", "piAgent", "customAcp"]) {
      expect(modelSwitchNeedsAsk("ask", "codex", driver)).toBe(false);
      expect(modelSwitchNeedsAsk("auto", "codex", driver)).toBe(false);
      expect(modelSwitchNeedsAsk("full", "codex", driver)).toBe(driver !== "codex");
      expect(modelSwitchNeedsAsk("custom", "codex", driver)).toBe(driver !== "codex");
    }
    expect(modelSwitchNeedsAsk("edits", "claudeAgent", "codex")).toBe(true);
    expect(modelSwitchNeedsAsk("edits", "claudeAgent", "grokAgent")).toBe(false);
    expect(modelSwitchNeedsAsk("full", "claudeAgent", "claudeAgent")).toBe(false);
    expect(modelSwitchNeedsAsk("full", "codex", undefined)).toBe(true);
  });
  it("only exposes implemented provider capabilities", () => {
    for (const driver of ["codex", "claudeAgent", "antigravityAgent", "cursorAgent", "grokAgent", "opencodeGo", "qwenAgent", "geminiAgent"]) {
      expect(supportsApprovalMode(driver, "full")).toBe(true);
      expect(supportsApprovalMode(driver, "custom")).toBe(driver === "codex");
      // Qwen's `--approval-mode auto` is an LLM classifier; Gemini has no reviewer
      expect(hasNativeAutoReview(driver)).toBe(["codex", "claudeAgent", "cursorAgent", "grokAgent", "qwenAgent"].includes(driver));
      // auto-accept edits exists only where the engine has such a mode
      expect(supportsApprovalMode(driver, "edits")).toBe(["claudeAgent", "grokAgent", "antigravityAgent", "qwenAgent", "geminiAgent"].includes(driver));
    }
    expect(supportsApprovalMode(undefined, "full")).toBe(false);
    expect(supportsApprovalMode(undefined, "edits")).toBe(false);
  });

  it.each([
    "kimiAgent", "droidAgent", "hermesAgent", "customAcp",
    "piAgent", "unknown",
  ])("keeps %s on supported approval levels without claiming native Auto", (driver) => {
    expect(supportsApprovalMode(driver, "ask")).toBe(true);
    expect(supportsApprovalMode(driver, "auto")).toBe(true);
    expect(supportsApprovalMode(driver, "edits")).toBe(false);
    expect(supportsApprovalMode(driver, "full")).toBe(false);
    expect(supportsApprovalMode(driver, "custom")).toBe(false);
    expect(hasNativeAutoReview(driver)).toBe(false);
  });

  // The chat-completions family has no provider reviewer, so Auto still
  // behaves like Ask — but Full is implemented in the harness itself
  // (createOpenAIChatRuntime answers its own gate), so it IS offered. Without
  // it these engines had no level that ever stops asking, and a Chief's
  // delegated Full access could not reach them either.
  it.each(["grok", "openai-compat", "minimax", "groq"])("offers harness-implemented Full on %s, but never native Auto", (driver) => {
    expect(supportsApprovalMode(driver, "ask")).toBe(true);
    expect(supportsApprovalMode(driver, "auto")).toBe(true);
    expect(supportsApprovalMode(driver, "full")).toBe(true);
    expect(supportsApprovalMode(driver, "edits")).toBe(false);
    expect(supportsApprovalMode(driver, "custom")).toBe(false);
    expect(hasNativeAutoReview(driver)).toBe(false);
  });
  it("recognizes only the five durable values", () => {
    expect(APPROVAL_MODES).toEqual(["ask", "edits", "auto", "full", "custom"]);
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

  it("holds only the explicitly targeted thread during a composer grant", () => {
    const approvalGrant = { requestId: "pending", mode: "full", phase: "prepared", threadOnly: true, threadId: "target" };
    expect(approvalModeFor({ approvalMode: "full", approvalGrant, threadId: "target" })).toBe("ask");
    expect(approvalModeFor({ approvalMode: "full", approvalGrant, threadId: "other" })).toBe("full");
    expect(approvalModeFor({ approvalMode: "full", approvalGrant })).toBe("ask");
  });
});

describe("approval support bound to a registry", () => {
  const registry = {
    cliTarget: (instanceId: string) =>
      instanceId === "codex-fixture" ? { driverKind: "codex" }
        : instanceId === "pi-fixture" ? { driverKind: "piAgent" }
        : null,
  };
  const supports = createApprovalModeSupport(registry);

  it("resolves model selections through the registry", () => {
    const codex = { instanceId: "codex-fixture", model: "fixture" };
    const pi = { instanceId: "pi-fixture", model: "fixture" };
    expect(supports(codex, "full")).toBe(true);
    expect(supports(codex, "custom")).toBe(true);
    expect(supports(pi, "ask")).toBe(true);
    expect(supports(pi, "auto")).toBe(true);
    expect(supports(pi, "full")).toBe(false);
    expect(supports(pi, "custom")).toBe(false);
  });

  it("answers an unknown instance like an unknown driver", () => {
    const ghost = { instanceId: "ghost", model: "fixture" };
    expect(supports(ghost, "ask")).toBe(true);
    expect(supports(ghost, "edits")).toBe(false);
    expect(supports(ghost, "full")).toBe(false);
    expect(supports(undefined, "ask")).toBe(true);
    expect(supports(undefined, "full")).toBe(false);
  });

  it("passes already-resolved driver views to the table unchanged", () => {
    expect(supports({ driverKind: "codex" }, "custom")).toBe(true);
    expect(supports({ driverKind: "piAgent" }, "full")).toBe(false);
    expect(supports({ driverKind: undefined }, "ask")).toBe(true);
    expect(supports({ driverKind: undefined }, "full")).toBe(false);
  });

  it("agrees with the pure table across every mode", () => {
    for (const driverKind of ["codex", "claudeAgent", "piAgent", undefined] as const) {
      for (const mode of APPROVAL_MODES) {
        expect(supports({ driverKind }, mode)).toBe(supportsApprovalMode(driverKind, mode));
      }
    }
  });
});

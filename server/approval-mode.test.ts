import { describe, expect, it } from "vitest";

import {
  APPROVAL_MODES,
  runningApprovalMode,
  supportsLiveApprovalMode,
  DEFAULT_APPROVAL_MODE,
  approvalModeFor,
  setDefaultApprovalMode,
  supportsApprovalMode,
  modelSwitchNeedsAsk,
  hasNativeAutoReview,
  isEmergencyApprovalDowngrade,
  isApprovalMode,
} from "../shared/approval-mode.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { createApprovalModeSupport } from "./harness-capabilities.ts";

describe("approval modes", () => {
  it("carries Full silently to any engine that runs it; Custom never crosses engines", () => {
    for (const driver of ["codex", "claudeAgent", "grokAgent", "antigravityAgent", "piAgent", "customAcp"]) {
      expect(modelSwitchNeedsAsk("ask", "codex", driver)).toBe(false);
      expect(modelSwitchNeedsAsk("auto", "codex", driver)).toBe(false);
      expect(modelSwitchNeedsAsk("full", "codex", driver)).toBe(false);
      expect(modelSwitchNeedsAsk("custom", "codex", driver)).toBe(driver !== "codex");
    }
    expect(modelSwitchNeedsAsk("full", "codex", "claudeAgent")).toBe(false);
    expect(modelSwitchNeedsAsk("full", "claudeAgent", "openai-compat")).toBe(false);
    expect(modelSwitchNeedsAsk("edits", "claudeAgent", "codex")).toBe(true);
    expect(modelSwitchNeedsAsk("edits", "claudeAgent", "grokAgent")).toBe(false);
    expect(modelSwitchNeedsAsk("full", "claudeAgent", "claudeAgent")).toBe(false);
    expect(modelSwitchNeedsAsk("full", "codex", undefined)).toBe(false);
  });
  it("only exposes implemented provider capabilities", () => {
    for (const driver of ["codex", "claudeAgent", "antigravityAgent", "cursorAgent", "grokAgent", "opencodeGo", "qwenAgent", "geminiAgent"]) {
      expect(supportsApprovalMode(driver, "full")).toBe(true);
      expect(supportsApprovalMode(driver, "custom")).toBe(driver === "codex");
      // Qwen's `--approval-mode auto` is an LLM classifier; Gemini has no reviewer
      expect(hasNativeAutoReview(driver)).toBe(["codex", "claudeAgent", "cursorAgent", "grokAgent", "qwenAgent"].includes(driver));
      expect(supportsApprovalMode(driver, "edits")).toBe(["claudeAgent", "grokAgent", "antigravityAgent", "qwenAgent", "geminiAgent"].includes(driver));
    }
    expect(supportsApprovalMode(undefined, "full")).toBe(true);
    expect(supportsApprovalMode(undefined, "edits")).toBe(false);
  });

  it("runs Full access, the default level, on every engine", () => {
    for (const { driverKind } of BUILT_IN_DRIVERS) expect(supportsApprovalMode(driverKind, "full"), driverKind).toBe(true);
  });

  // No permissive mode of their own: the harness answers the permission
  // requests they leave, so Full runs there too.
  it.each([
    "kimiAgent", "droidAgent", "hermesAgent", "customAcp",
    "piAgent", "unknown",
  ])("runs Full on %s without claiming native Auto or Edits", (driver) => {
    expect(supportsApprovalMode(driver, "ask")).toBe(true);
    expect(supportsApprovalMode(driver, "auto")).toBe(true);
    expect(supportsApprovalMode(driver, "edits")).toBe(false);
    expect(supportsApprovalMode(driver, "full")).toBe(true);
    expect(supportsApprovalMode(driver, "custom")).toBe(false);
    expect(hasNativeAutoReview(driver)).toBe(false);
  });

  it.each(["grok", "openai-compat", "minimax", "groq", "meta"])("offers harness-implemented Full on %s, but never native Auto", (driver) => {
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
  });

  it("starts a bot or conversation nobody has set a level on at Full access", () => {
    expect(DEFAULT_APPROVAL_MODE).toBe("full");
    expect(approvalModeFor({})).toBe("full");
    // Every bot made over HTTP stores the legacy bit off beside no level.
    expect(approvalModeFor({ autoApprove: false })).toBe("full");
    expect(approvalModeFor({ approvalMode: "ask", autoApprove: false })).toBe("ask");
  });

  it("keeps Ask as the default where the server says so (a shared company workspace)", () => {
    setDefaultApprovalMode("ask");
    try {
      expect(approvalModeFor({})).toBe("ask");
      expect(approvalModeFor({ autoApprove: false })).toBe("ask");
      expect(approvalModeFor({ approvalMode: "full" })).toBe("full");
    } finally {
      setDefaultApprovalMode(DEFAULT_APPROVAL_MODE);
    }
    expect(approvalModeFor({})).toBe("full");
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
    expect(supports(pi, "full")).toBe(true);
    expect(supports(pi, "custom")).toBe(false);
  });

  it("answers an unknown instance like an unknown driver", () => {
    const ghost = { instanceId: "ghost", model: "fixture" };
    expect(supports(ghost, "ask")).toBe(true);
    expect(supports(ghost, "edits")).toBe(false);
    expect(supports(ghost, "full")).toBe(true);
    expect(supports(undefined, "ask")).toBe(true);
    expect(supports(undefined, "full")).toBe(true);
  });

  it("passes already-resolved driver views to the table unchanged", () => {
    expect(supports({ driverKind: "codex" }, "custom")).toBe(true);
    expect(supports({ driverKind: "piAgent" }, "full")).toBe(true);
    expect(supports({ driverKind: undefined }, "ask")).toBe(true);
    expect(supports({ driverKind: undefined }, "full")).toBe(true);
  });

  it("agrees with the pure table across every mode", () => {
    for (const driverKind of ["codex", "claudeAgent", "piAgent", undefined] as const) {
      for (const mode of APPROVAL_MODES) {
        expect(supports({ driverKind }, mode)).toBe(supportsApprovalMode(driverKind, mode));
      }
    }
  });
});

describe("mode selection during work", () => {
  it("allows both directions at app-owned gates and delays native elevation while honoring revocation", () => {
    expect(runningApprovalMode("ask", "full", true)).toBe("full");
    expect(runningApprovalMode("full", "ask", true)).toBe("ask");
    expect(runningApprovalMode("ask", "full", false)).toBe("ask");
    expect(runningApprovalMode("auto", "full", false)).toBe("auto");
    expect(runningApprovalMode("full", "ask", false)).toBe("ask");
    expect(runningApprovalMode("full", "auto", false)).toBe("auto");
    expect(supportsLiveApprovalMode("openai-compat")).toBe(true);
    expect(supportsLiveApprovalMode("meta")).toBe(true);
    expect(supportsLiveApprovalMode("museCode")).toBe(false);
    expect(supportsLiveApprovalMode("codex")).toBe(false);
    expect(supportsLiveApprovalMode(undefined)).toBe(false);
  });
});

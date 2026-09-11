import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FullAccessWarning } from "./FullAccessWarning";

import {
  ApprovalModeSelector,
  approvalModeOptions,
  approvalModeOptionsFor,
  approvalModeSelectionRequiresLocalDesktop,
} from "./ApprovalModeSelector";

describe("approval mode selector", () => {
  it("discloses delegated work in the Full access confirmation", () => {
    const html = renderToStaticMarkup(createElement(FullAccessWarning, {
      open: true, onCancel: () => {}, onConfirm: () => {},
    }));
    expect(html).toContain("tasks delegated by your Chief or other bots");
    expect(html).toContain("does not enable Full access on other bots");
    expect(html).not.toContain("Requests that come from another bot still get the usual checks");
  });
  it("lists the approval levels with their plain-language copy", () => {
    expect(approvalModeOptions().map(({ mode, label, description }) => ({ mode, label, description }))).toEqual([
      {
        mode: "ask",
        label: "Ask for approval",
        description: "Requests approval for commands and file changes",
      },
      {
        mode: "edits",
        label: "Auto-accept edits",
        description: "Approves file edits automatically; other actions can still require approval",
      },
      {
        mode: "auto",
        label: "Approve for me",
        description: "Uses the provider's automatic review to approve routine actions and ask about others",
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
      "edits",
      "auto",
      "full",
    ]);
  });

  it.each(["cursorAgent", "opencodeGo"])("offers Full access for %s, and no Edits level it cannot map", (kind) => {
    expect(approvalModeOptionsFor(kind).map((option) => option.mode)).toEqual(["ask", "auto", "full"]);
    expect(approvalModeOptionsFor(kind, false).map((option) => option.mode)).toEqual(["ask", "auto"]);
  });

  it("offers Grok its native acceptEdits as Auto-accept edits", () => {
    expect(approvalModeOptionsFor("grokAgent").map((option) => option.mode)).toEqual(["ask", "edits", "auto", "full"]);
    expect(approvalModeOptionsFor("grokAgent", false).map((option) => option.mode)).toEqual(["ask", "edits", "auto"]);
  });

  it("offers Antigravity Auto as the explicit full-access grant, not native review", () => {
    const options = approvalModeOptionsFor("antigravityAgent");
    expect(options.map(({ mode, label }) => ({ mode, label }))).toEqual([
      { mode: "ask", label: "Ask for approval" },
      { mode: "edits", label: "Auto-accept edits" },
      { mode: "full", label: "Auto (full access)" },
    ]);
    expect(options[2].chip).toBe("Auto");
    expect(options[2].description).toContain("Automatically approve tool requests");
    expect(approvalModeOptionsFor("antigravityAgent", false).map((option) => option.mode)).toEqual(["ask", "edits"]);
  });

  it("shows the effective Antigravity mode without upgrading saved Auto settings", () => {
    const render = (mode: "ask" | "auto" | "full" | undefined, autoApprove = false, trustedModesAvailable = true) => renderToStaticMarkup(createElement(ApprovalModeSelector, {
      approvalMode: mode, autoApprove, trustedModesAvailable,
      providerName: "Antigravity", driverKind: "antigravityAgent", onSelect: () => {},
    }));
    for (const html of [render("ask"), render("auto"), render(undefined, true)]) {
      expect(html).toContain('aria-label="Ask for approval for Antigravity"');
      expect(html).not.toContain('aria-label="Auto (full access)');
    }
    expect(render("full")).toContain('aria-label="Auto (full access) for Antigravity"');
    expect(render("full", false, false)).toContain('aria-label="Auto (full access) for Antigravity"');
  });

  it("explains Auto fallbacks and does not elevate unknown providers", () => {
    expect(approvalModeOptionsFor("grokAgent").find((option) => option.mode === "auto")?.description).toContain("automatic review to approve routine actions");
    expect(approvalModeOptionsFor("customAgent").find((option) => option.mode === "auto")?.description).toContain("behaves like Ask");
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
    const html = renderToStaticMarkup(createElement(ApprovalModeSelector, {
      approvalMode: "custom", trustedModesAvailable: false,
      providerName: "Missing provider", driverKind: "", onSelect: () => {},
    }));
    expect(html).toContain('aria-label="Custom (config.toml) for Missing provider"');
  });
});

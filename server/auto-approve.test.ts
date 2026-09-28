// The harness's part in a provider's permission request: pass it through.
// These pin that nothing here judges an action, that Full access is the one
// synthesized answer, and that every note a card can show has a catalog key.
import { describe, expect, it, vi } from "vitest";

import englishCatalog from "../src/locales/en.json" with { type: "json" };

import {
  HELD_NOTE,
  approvalHeldNote,
  approvalHeldReason,
  approvalModeForOrigin,
  autoVerdict,
  deliverFullAccessApproval,
  delegationInheritsFullAccess,
} from "./auto-approve.ts";

describe("Full access delivery", () => {
  it.each(["allowed-once", "rejected", "unavailable"] as const)("preserves %s without interrupting or inventing an approval", async outcome => {
    const adapter = { respondToRequest: vi.fn().mockResolvedValue(outcome), interruptTurn: vi.fn() };
    expect(await deliverFullAccessApproval(adapter, "thread", "request", "turn")).toBe(outcome);
    expect(adapter.respondToRequest).toHaveBeenCalledWith("thread", "request", { behavior: "allow" });
    expect(adapter.interruptTurn).not.toHaveBeenCalled();
  });
  it("reports transport failure and interrupts only the failed turn", async () => {
    const adapter = { respondToRequest: vi.fn().mockRejectedValue(new Error("connection lost")), interruptTurn: vi.fn().mockResolvedValue(undefined) };
    expect(await deliverFullAccessApproval(adapter, "thread", "request", "original-turn", () => true)).toBe("failed");
    expect(adapter.interruptTurn).toHaveBeenCalledWith("thread", "original-turn");
    adapter.interruptTurn.mockClear();
    expect(await deliverFullAccessApproval(adapter, "thread", "request")).toBe("failed");
    expect(adapter.interruptTurn).not.toHaveBeenCalled();
    expect(await deliverFullAccessApproval(adapter, "thread", "request", "old-turn", () => false)).toBe("failed");
    expect(adapter.interruptTurn).not.toHaveBeenCalled();
    expect(await deliverFullAccessApproval(undefined, "thread", "request")).toBe("failed");
  });
});

describe("autoVerdict", () => {
  it("applies an explicit exact command grant without changing Full or answering questions/elevations", () => {
    for (const mode of ["ask", "edits", "auto", "custom"] as const) {
      expect(autoVerdict(mode, "Bash", { commandAllowed: true }).source).toBe("command-allowlist");
      expect(autoVerdict(mode, "Bash", { commandAllowed: true }).approve).toBeTruthy();
      expect(autoVerdict(mode, "Bash", { commandAllowed: true, requiresExplicitApproval: true }).approve).toBeNull();
      expect(autoVerdict(mode, "AskUserQuestion", { commandAllowed: true }).approve).toBeNull();
    }
    expect(autoVerdict("full", "Bash", { commandAllowed: true, requiresExplicitApproval: true }).source).toBe("full-access");
  });
  it("answers only for Full access, and then answers everything", () => {
    expect(autoVerdict("full", "Bash")).toEqual({ approve: "approved Bash (full access)", source: "full-access" });
    expect(autoVerdict("full", "Bash", { requiresExplicitApproval: true })).toEqual({
      approve: "approved Bash (full access)",
      source: "full-access",
    });
  });

  it("leaves an Auto or Custom request with the person as the provider's own reviewer did", () => {
    expect(autoVerdict("auto", "Bash")).toEqual({ approve: null, source: "native-approval" });
    expect(autoVerdict("custom", "Bash")).toEqual({ approve: null, source: "native-approval" });
  });

  it("never judges the action itself: Ask and Edits card everything the provider asks about", () => {
    for (const summary of ["wc -l notes.md", "rm -rf build", "cat ~/.ssh/id_rsa"]) {
      expect(autoVerdict("ask", summary)).toEqual({ approve: null, source: "no-grant" });
      expect(autoVerdict("edits", summary)).toEqual({ approve: null, source: "no-grant" });
    }
  });

  it("holds a sandbox widening for the person in every mode but Full", () => {
    for (const mode of ["ask", "edits", "auto", "custom"] as const) {
      expect(autoVerdict(mode, "shell", { requiresExplicitApproval: true }))
        .toEqual({ approve: null, source: "explicit-approval-block" });
    }
  });
});

describe("approvalModeForOrigin", () => {
  it("runs peer-started Custom turns as Auto and leaves every other mode alone", () => {
    expect(approvalModeForOrigin("custom", { peerInitiated: true })).toBe("auto");
    expect(approvalModeForOrigin("custom", { peerInitiated: false })).toBe("custom");
    for (const mode of ["ask", "edits", "auto", "full"] as const) {
      expect(approvalModeForOrigin(mode, { peerInitiated: true })).toBe(mode);
    }
  });
});

describe("held notes", () => {
  it("explains a provider's own request and a sandbox change, and nothing else", () => {
    expect(approvalHeldNote({ source: "native-approval", permission: true })).toBe("approval.held.native");
    expect(approvalHeldNote({ source: "explicit-approval-block", permission: true })).toBe("approval.held.sandbox");
    expect(approvalHeldNote({ source: "no-grant", permission: true })).toBeUndefined();
    expect(approvalHeldNote({ source: undefined, permission: true })).toBeUndefined();
    // questions are never held for a mode reason
    expect(approvalHeldNote({ source: "native-approval", permission: false })).toBeUndefined();
    expect(approvalHeldReason({ source: "native-approval", permission: true }))
      .toBe("The provider requires your approval for this action.");
  });

  it("has a catalog entry for every note, so the client can translate by key", () => {
    for (const [key, text] of Object.entries(HELD_NOTE)) {
      expect(englishCatalog[key as keyof typeof englishCatalog], key).toBe(text);
    }
  });
});

describe("tools that ask a person", () => {
  // A question normally arrives typed as a question and never reaches a
  // verdict. This is the backstop for the path where one arrives typed as a
  // permission: no mode may answer it, because approving does not answer
  // anything — the CLI runs the tool with no answers and the model is told
  // "The user did not answer the questions."
  const modes = ["ask", "edits", "auto", "custom", "full"] as const;

  it("never answers AskUserQuestion for the person, even under Full access", () => {
    for (const mode of modes) {
      expect(autoVerdict(mode, "AskUserQuestion"), mode).toEqual({ approve: null, source: "no-grant" });
    }
  });

  it("never answers ask_user, bare or MCP-prefixed", () => {
    for (const mode of modes) {
      expect(autoVerdict(mode, "ask_user").approve, mode).toBeNull();
      expect(autoVerdict(mode, "mcp__ogb__ask_user").approve, mode).toBeNull();
      expect(autoVerdict(mode, "omb-ask").approve, mode).toBeNull();
    }
  });

  it("still answers an ordinary tool under Full access", () => {
    expect(autoVerdict("full", "Read").approve).toBeTruthy();
  });
});

describe("delegationInheritsFullAccess", () => {
  const base = { senderIsChief: true, senderHasFullAccess: true, sameBot: false, recipientDriverKind: "claudeAgent" };
  it("passes a Full-access Chief's access to the teammate it delegates to", () => {
    expect(delegationInheritsFullAccess(base)).toBe(true);
    for (const recipientDriverKind of ["codex", "claudeAgent", "antigravityAgent", "cursorAgent", "grokAgent", "opencodeGo"]) {
      expect(delegationInheritsFullAccess({ ...base, recipientDriverKind })).toBe(true);
    }
  });
  it("passes nothing on from an ordinary bot, a Chief without Full access, or a bot to itself", () => {
    expect(delegationInheritsFullAccess({ ...base, senderIsChief: false })).toBe(false);
    expect(delegationInheritsFullAccess({ ...base, senderHasFullAccess: false })).toBe(false);
    expect(delegationInheritsFullAccess({ ...base, sameBot: true })).toBe(false);
  });
  it("leaves a teammate whose engine has no Full mode on its own level", () => {
    expect(delegationInheritsFullAccess({ ...base, recipientDriverKind: "hermes" })).toBe(false);
    expect(delegationInheritsFullAccess({ ...base, recipientDriverKind: undefined })).toBe(false);
  });
});

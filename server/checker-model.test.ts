import { describe, expect, it } from "vitest";

import { otherProviderSelection } from "./checker-model.ts";
import type { SelectableInstance } from "./default-model-selection.ts";

const ai = (instanceId: string, driverKind: string, model: string, extra: Partial<SelectableInstance> = {}): SelectableInstance => ({
  instanceId, driverKind, snapshot: { state: "available", authenticated: true }, models: { default: model, options: [{ id: model, label: model }] }, ...extra,
});
const claude = ai("claude", "claudeAgent", "claude-default");
const work = ai("claude-work", "claudeAgent", "claude-work-default");
const codex = ai("codex", "codex", "codex-default");

describe("otherProviderSelection", () => {
  it("picks another provider's model, never a second account of the same provider", () => {
    expect(otherProviderSelection([claude, work, codex], { instanceId: "claude", model: "claude-default" })).toEqual({ instanceId: "codex", model: "codex-default" });
    expect(otherProviderSelection([codex, claude], { instanceId: "codex", model: "codex-default" })).toEqual({ instanceId: "claude", model: "claude-default" });
  });

  it("is null with only one provider ready: signed out, turned off, refused or OpenCode's free backup do not count", () => {
    const signedOut = { ...codex, snapshot: { state: "available" as const, authenticated: false } };
    const off = { ...codex, enabled: false };
    const free = ai("opencodeGo", "opencodeGo", "free-model", { snapshot: { state: "available", authenticated: true, freeFallback: true } });
    expect(otherProviderSelection([claude, work], { instanceId: "claude", model: "claude-default" })).toBeNull();
    for (const other of [signedOut, off, free]) expect(otherProviderSelection([claude, other], { instanceId: "claude", model: "claude-default" })).toBeNull();
    expect(otherProviderSelection([claude, codex], { instanceId: "claude", model: "claude-default" }, { refusal: (instance) => instance.instanceId === "codex" ? "blocked" : undefined })).toBeNull();
  });
});

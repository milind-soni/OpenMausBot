import { describe, expect, it } from "vitest";
import { recoveryCapabilityError, refusalsAllow, startupBackups, untriedBackups } from "./automatic-recovery.ts";

describe("automatic recovery capabilities", () => {
  const engine = { driverKind: "qwenAgent", capabilities: {
    sessionModelSwitch: "unsupported" as const, agentsMcp: true, browserMcp: true,
    customMcp: true, dataMcp: true, emailMcp: true, images: true,
  } };
  it("keeps a compatible local workspace and rejects losing a tool or attachment", () => {
    expect(recoveryCapabilityError(engine, { ...engine, driverKind: "claudeAgent" })).toBeUndefined();
    for (const key of ["agentsMcp", "browserMcp", "customMcp", "dataMcp", "emailMcp", "images"] as const) {
      expect(recoveryCapabilityError(engine, { ...engine, capabilities: { ...engine.capabilities, [key]: false } })).toMatch(/tools and attachments/);
    }
  });
  it("lets a limited Claude bot carry on with an engine that has every tool but a USB phone", () => {
    const claude = { driverKind: "claudeAgent", capabilities: { sessionModelSwitch: "in-session" as const, agentsMcp: true, customMcp: true,
      computerMcp: true, composioMcp: true, phoneMcp: true, browserMcp: true, dataMcp: true, emailMcp: true, deviceMcp: true, images: true } };
    const { phoneMcp: _phone, ...rest } = claude.capabilities;
    const opencode = { driverKind: "opencodeAgent", capabilities: { ...rest, sessionModelSwitch: "unsupported" as const, localComputerMcp: true } };
    expect(recoveryCapabilityError(claude, opencode)).toBeUndefined();
    expect(recoveryCapabilityError(claude, { ...opencode, capabilities: { ...opencode.capabilities, browserMcp: false } })).toMatch(/tools and attachments/);
  });
  it("does not silently move work to a file-less engine", () => {
    expect(recoveryCapabilityError(engine, { ...engine, driverKind: "openai-compat" })).toMatch(/same workspace/);
  });
});

describe("startup backups", () => {
  const own = [{ instanceId: "codex", model: "gpt-5.5" }, { instanceId: "gemini", model: "gemini-3-pro" }];
  const app = { instanceId: "qwen", model: "qwen3-coder" };
  it("tries a bot's own backups in order whether or not Automatic recovery is on", () => {
    expect(startupBackups({ fallback: own }, { enabled: false })).toEqual(own);
    expect(startupBackups({ fallback: own }, { enabled: false, backup: app })).toEqual(own);
    expect(startupBackups({ fallback: own }, { enabled: true, backup: app })).toEqual(own);
    expect(startupBackups({ fallback: own })).toEqual(own);
  });
  it("uses the installation's backup only while Automatic recovery is on, for a bot with none of its own", () => {
    expect(startupBackups({ fallback: [] }, { enabled: true, backup: app })).toEqual([app]);
    expect(startupBackups({}, { enabled: true, backup: app })).toEqual([app]);
    expect(startupBackups({}, { enabled: false, backup: app })).toEqual([]);
    expect(startupBackups({}, { enabled: false })).toEqual([]);
    expect(startupBackups({})).toEqual([]);
  });
});

describe("untried backups", () => {
  const primary = { instanceId: "claude", model: "claude-sonnet-5" };
  const second = { instanceId: "claude2", model: "claude-sonnet-5" };
  const codex = { instanceId: "codex", model: "gpt-5.5" };
  it("keeps every backup but the refusing AI on the first refusal", () => {
    expect(untriedBackups([primary, second, codex], primary)).toEqual([second, codex]);
  });
  it("still offers a later backup when the list is rebuilt from a backup that also refused", () => {
    expect(untriedBackups([second, codex], second, [primary])).toEqual([codex]);
    expect(untriedBackups([primary, codex], second, [primary])).toEqual([codex]);
    expect(untriedBackups([second, codex], codex, [primary, second])).toEqual([]);
  });
  it("tells another model of a tried AI apart from the one tried", () => {
    const other = { ...primary, model: "claude-opus-5" };
    expect(untriedBackups([other, codex], second, [primary])).toEqual([other, codex]);
  });
});

describe("refusals met on the way", () => {
  const claude = { instanceId: "claude", driverKind: "claudeAgent" };
  const claudeApi = { instanceId: "claudeApi", driverKind: "claudeAgent" };
  const claudeWork = { instanceId: "claudeWork", driverKind: "claudeAgent" };
  const codex = { instanceId: "codex", driverKind: "codex" };
  const limited = { ...claude, model: "claude-sonnet-5", why: "engine" as const };
  const signedOut = { ...claudeApi, model: "claude-sonnet-5", why: "signed-out" as const };
  it("keeps ruling out another sign-in of a limited plan after a later backup signed out, even once that account is gone", () => {
    expect(refusalsAllow([limited, signedOut], claudeWork)).toBe(false);
    expect(refusalsAllow([signedOut], claudeWork)).toBe(true);
  });
  it("offers none of a signed-out AI's models again", () => {
    expect(refusalsAllow([{ ...signedOut, instanceId: "claude" }, signedOut], claude)).toBe(false);
    expect(refusalsAllow([{ ...claude, model: "claude-sonnet-5" }], claude)).toBe(true);
  });
  it("still allows another AI, a pay-per-use key, and the same AI's other model after a model's own limit", () => {
    expect(refusalsAllow([limited, signedOut], codex)).toBe(true);
    expect(refusalsAllow([limited], claudeApi, { environment: { ANTHROPIC_API_KEY: "sk-test" } })).toBe(true);
    expect(refusalsAllow([{ ...limited, why: "model" }], claude)).toBe(true);
    expect(refusalsAllow([limited], claude)).toBe(false);
  });
});

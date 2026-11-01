import { describe, expect, it } from "vitest";
import { recoveryCapabilityError, startupBackups } from "./automatic-recovery.ts";

describe("automatic recovery capabilities", () => {
  const engine = { driverKind: "qwenAgent", capabilities: {
    sessionModelSwitch: "unsupported" as const, agentsMcp: true, browserMcp: true,
    customMcp: true, dataMcp: true, highlevelMcp: true, images: true,
  } };
  it("keeps a compatible local workspace and rejects losing a tool or attachment", () => {
    expect(recoveryCapabilityError(engine, { ...engine, driverKind: "claudeAgent" })).toBeUndefined();
    for (const key of ["agentsMcp", "browserMcp", "customMcp", "dataMcp", "highlevelMcp", "images"] as const) {
      expect(recoveryCapabilityError(engine, { ...engine, capabilities: { ...engine.capabilities, [key]: false } })).toMatch(/tools and attachments/);
    }
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

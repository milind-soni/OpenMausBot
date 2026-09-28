import { describe, expect, it } from "vitest";
import { newBotDefaultsSchema } from "./new-bot-defaults.ts";
import { parseConfigPatch } from "./config.ts";

describe("new-bot templates", () => {
  it("stores Full as a preference without accepting reusable consent or identity", () => {
    expect(newBotDefaultsSchema.parse({ profile: { name: "", approvalMode: "full" } }).profile)
      .toEqual({ name: "", approvalMode: "full" });
    for (const field of ["id", "threadId", "approvalGrant", "confirmFullAccess", "acknowledgeLocalAuto", "acknowledgePeerScope", "busy"]) {
      expect(newBotDefaultsSchema.safeParse({ profile: { [field]: true } }).success, field).toBe(false);
    }
  });

  it("accepts bounded settings and rejects coercion and invalid model combinations", () => {
    expect(parseConfigPatch({ newBotDefaults: { profile: { notifications: false, computer: "off", mcpServers: [] } } })
      .newBotDefaults?.profile).toEqual({ notifications: false, computer: "off", mcpServers: [] });
    for (const profile of [
      { notifications: "false" }, { name: "one\ntwo" }, { cloudBackend: "made-up" },
      { modelSelection: { instanceId: "codex", model: "model", effort: "low", variant: "fast" } },
      { soul: "\u00e9".repeat(12_001) }, { avatarUrl: "https://external.test/avatar.png" },
    ]) expect(newBotDefaultsSchema.safeParse({ profile }).success).toBe(false);
  });

  it("never permits memory paths to escape the new bot's memory folder", () => {
    const accepted = { "MEMORY.md": "Index", "memory/preferences.md": "Keep replies short" };
    expect(newBotDefaultsSchema.parse({ memory: accepted }).memory).toEqual(accepted);
    for (const path of ["../config.json", "memory/../../config.json", "C:\\secret.md", "memory/x/y.md", "SOUL.md"]) {
      expect(newBotDefaultsSchema.safeParse({ memory: { [path]: "text" } }).success, path).toBe(false);
    }
  });

  it("rejects malformed routines before saving a reusable template", () => {
    const routine = { name: "Check", prompt: "Review status", schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3] }, enabled: false };
    expect(newBotDefaultsSchema.parse({ routines: [routine] }).routines).toEqual([routine]);
    for (const change of [
      { botId: "some-existing-bot" }, { prompt: "" }, { schedule: { type: "daily", time: "25:99", weekdays: [1] } },
      { schedule: { type: "cron", expression: "not cron", timeZone: "UTC" } },
      { schedule: { type: "interval", everyMinutes: 30, anchorAt: 1, window: { start: "09:00", end: "09:10" } } },
    ]) expect(newBotDefaultsSchema.safeParse({ routines: [{ ...routine, ...change }] }).success).toBe(false);
  });

  it("bounds the complete template, including multiple individually valid files", () => {
    const memory = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`memory/file${index}.md`, "x".repeat(262_144)]));
    expect(newBotDefaultsSchema.safeParse({ memory }).success).toBe(false);
  });
});

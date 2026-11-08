import { describe, expect, it } from "vitest";
import { botSkillTemplateSchema, newBotDefaultsSchema, resolveBotCreationDefaults } from "./new-bot-defaults.ts";
import { parseConfigPatch } from "./config.ts";

describe("new-bot templates", () => {
  it("requires bundle instructions to round-trip through UTF-8 without changing old text-only templates", () => {
    const skill = { name: "runbook", description: "A guide", source: "fixture", text: "Guide \ud800", enabled: false };
    expect(botSkillTemplateSchema.safeParse({ ...skill, files: [{ path: "guide.md", content: "Guide" }] }).success).toBe(false);
    expect(botSkillTemplateSchema.safeParse(skill).success).toBe(true);
    expect(botSkillTemplateSchema.safeParse({ ...skill, text: "Guide 😀", files: [{ path: "guide.md", content: "Guide" }] }).success).toBe(true);
  });
  it("preserves restricted and empty tool defaults while allowing an explicit owner reset", () => {
    const defaults = newBotDefaultsSchema.parse({ profile: { toolScope: { allow: ["native:read", "native:read"] } } });
    expect(defaults.profile).toEqual({ toolScope: { allow: ["native:read"] } });
    expect(resolveBotCreationDefaults(defaults, {}).profile).toEqual({ toolScope: { allow: ["native:read"] } });
    expect(resolveBotCreationDefaults(defaults, { settings: { toolScope: { allow: [] } } }).profile).toEqual({ toolScope: { allow: [] } });
    expect(resolveBotCreationDefaults(defaults, { settings: { toolScope: null } }).profile).toEqual({ toolScope: null });
    expect(newBotDefaultsSchema.safeParse({ profile: { toolScope: { deny: ["mcp:*:read"] } } }).success).toBe(false);
  });
  it("stores Full as a plain preference, with no consent field, and creates new bots with it", () => {
    const defaults = newBotDefaultsSchema.parse({ profile: { name: "", approvalMode: "full" } });
    expect(defaults.profile).toEqual({ name: "", approvalMode: "full" });
    expect(resolveBotCreationDefaults(defaults, { name: "Ada" }).profile).toEqual({ name: "Ada", approvalMode: "full" });
    expect(resolveBotCreationDefaults(defaults, { settings: { approvalMode: "ask" } }).profile).toEqual({ approvalMode: "ask" });
    for (const field of ["id", "threadId", "approvalGrant", "acknowledgeLocalAuto", "acknowledgePeerScope", "busy"]) {
      expect(newBotDefaultsSchema.safeParse({ profile: { [field]: true } }).success, field).toBe(false);
    }
  });

  it("takes the helper-model switch in the request that creates a bot, as a boolean and nothing else", () => {
    expect(resolveBotCreationDefaults(undefined, { settings: { helperModel: false } }).profile).toEqual({ helperModel: false });
    // beside a tool selection, as the sidebar's Duplicate sends them
    expect(resolveBotCreationDefaults(undefined, { settings: { toolScope: { allow: [] }, helperModel: false } }).profile).toEqual({ toolScope: { allow: [] }, helperModel: false });
    for (const wrong of ["false", 0, null]) {
      expect(() => resolveBotCreationDefaults(undefined, { settings: { helperModel: wrong } }), JSON.stringify(wrong)).toThrow();
    }
  });

  it("saves the voice-note switches as defaults and gives them to new bots", () => {
    const profile = { voiceNotes: false, voiceNoteEveryReply: true };
    expect(parseConfigPatch({ newBotDefaults: { profile } }).newBotDefaults?.profile).toEqual(profile);
    expect(resolveBotCreationDefaults(newBotDefaultsSchema.parse({ profile }), { name: "Ada" }).profile).toEqual({ name: "Ada", ...profile });
    expect(newBotDefaultsSchema.parse({ profile: { voiceNoteEveryReply: null } }).profile).toEqual({ voiceNoteEveryReply: null });
    for (const wrong of [{ voiceNotes: "false" }, { voiceNotes: null }, { voiceNoteEveryReply: 1 }]) {
      expect(newBotDefaultsSchema.safeParse({ profile: wrong }).success, JSON.stringify(wrong)).toBe(false);
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

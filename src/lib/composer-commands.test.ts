import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeLocale, loadLocale, setLocale, t } from "./i18n";
import {
  composerSlashTrigger,
  goalTextFromComposer,
  replaceComposerSlashTrigger,
  skillSlashCommands,
  slashCommandMatches,
  type ComposerSlashCommandId,
} from "./composer-commands";
import { enabledSlashSkills } from "./use-slash-skills";

describe("composer slash commands", () => {
  it("opens command search for the unfinished slash token at the caret", () => {
    expect(composerSlashTrigger("/", 1)).toEqual({ query: "", start: 0, end: 1 });
    expect(composerSlashTrigger("/go", 3)).toEqual({ query: "go", start: 0, end: 3 });
    expect(composerSlashTrigger("/goal write", 11)).toBeNull();
  });

  it("opens command search for a slash token later in the message", () => {
    expect(composerSlashTrigger("hello /go", 9)).toEqual({ query: "go", start: 6, end: 9 });
    expect(composerSlashTrigger("first line\n/", 12)).toEqual({ query: "", start: 11, end: 12 });
    expect(composerSlashTrigger("use /stand later", 10)).toEqual({ query: "stand", start: 4, end: 10 });
    expect(composerSlashTrigger("a/b", 3)).toBeNull();
    expect(composerSlashTrigger("see http://x/", 13)).toBeNull();
    expect(
      replaceComposerSlashTrigger("use /stand later", { query: "stand", start: 4, end: 10 }, "/standup "),
    ).toEqual({ text: "use /standup  later", caret: 13 });
  });

  it("does not open inside code, and opens again after it", () => {
    expect(composerSlashTrigger("```\n/st", 7)).toBeNull();
    expect(composerSlashTrigger("`a /st` b", 6)).toBeNull();
    expect(composerSlashTrigger("```\nx\n```\n/st", 13)).toEqual({ query: "st", start: 10, end: 13 });
  });

  describe("localized search", () => {
    let previousLocale: string;
    beforeEach(() => { previousLocale = activeLocale(); });
    afterEach(() => { setLocale(previousLocale); });

    it.each([["zh", "让这"], ["zh-tw", "讓這"]])("finds the translated goal description for %s without translating the command", async (locale, query) => {
      expect(await loadLocale(locale)).toBe(locale);
      const text = `/${query}`;
      const trigger = composerSlashTrigger(text, text.length);
      expect(trigger).toEqual({ query, start: 0, end: text.length });
      expect(slashCommandMatches({ kind: "command", id: "goal", label: "/goal", description: t("composer.command.goalBotDesc") }, trigger!.query)).toBe(true);
      expect(goalTextFromComposer(text)).toBeNull();
      expect(skillSlashCommands([{ name: query, description: "Not an executable skill name" }])).toEqual([]);
    });

    it("keeps localized queries out of URLs and code", () => {
      expect(composerSlashTrigger("https://host/让这", 15)).toBeNull();
      expect(composerSlashTrigger("```\n/讓這", 7)).toBeNull();
      expect(composerSlashTrigger("`a /让这`", 6)).toBeNull();
    });
  });

  it("replaces the active token without losing text after the caret", () => {
    expect(
      replaceComposerSlashTrigger("/go later", { query: "go", start: 0, end: 3 }, ""),
    ).toEqual({ text: " later", caret: 0 });
    expect(
      replaceComposerSlashTrigger("/le", { query: "le", start: 0, end: 3 }, "/learn "),
    ).toEqual({ text: "/learn ", caret: 7 });
  });

  it("turns a manually typed goal command into a goal request", () => {
    expect(goalTextFromComposer("/goal ship the release")).toBe("ship the release");
    expect(goalTextFromComposer("/GOAL\n  investigate the failure")).toBe(
      "investigate the failure",
    );
    expect(goalTextFromComposer("/goalie says hello")).toBeNull();
    expect(goalTextFromComposer("discuss /goal later")).toBeNull();
  });

  it("offers setup as a slash command id and keeps the typed token", () => {
    const id: ComposerSlashCommandId = "setup";
    expect(id).toBe("setup");
    expect(
      replaceComposerSlashTrigger("/se", { query: "se", start: 0, end: 3 }, "/setup "),
    ).toEqual({ text: "/setup ", caret: 7 });
  });

  it("opens on a skill name with digits", () => {
    expect(composerSlashTrigger("/weekly-2", 9)).toEqual({ query: "weekly-2", start: 0, end: 9 });
  });

  it("lists enabled skills as rows after the built-ins, never shadowing one", () => {
    const rows = skillSlashCommands([
      { name: "standup", description: "Writes the weekly standup note." },
      { name: "goal", description: "A skill that happens to be called goal." },
      { name: "release-notes", description: "Drafts release notes." },
    ]);
    expect(rows).toEqual([
      { kind: "skill", id: "release-notes", label: "/release-notes", description: "Drafts release notes." },
      { kind: "skill", id: "standup", label: "/standup", description: "Writes the weekly standup note." },
    ]);
    expect(slashCommandMatches(rows[1]!, "sta")).toBe(true);
    expect(slashCommandMatches(rows[1]!, "WEEKLY")).toBe(true);
    expect(slashCommandMatches(rows[1]!, "release")).toBe(false);
    expect(
      replaceComposerSlashTrigger("/sta", { query: "sta", start: 0, end: 4 }, `${rows[1]!.label} `),
    ).toEqual({ text: "/standup ", caret: 9 });
  });

  it("reads only enabled, named skills from the skills listing", () => {
    expect(enabledSlashSkills({ skills: [
      { name: "standup", description: "Writes the note.", enabled: true },
      { name: "draft", description: "Off for now.", enabled: false },
      { name: 7, description: "broken", enabled: true },
      { name: "bare", enabled: true },
    ] })).toEqual([
      { name: "standup", description: "Writes the note." },
      { name: "bare", description: "" },
    ]);
    expect(enabledSlashSkills(null)).toEqual([]);
  });
});

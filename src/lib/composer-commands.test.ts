import { describe, expect, it } from "vitest";
import {
  composerSlashTrigger,
  goalTextFromComposer,
  replaceComposerSlashTrigger,
  skillSlashCommands,
  slashCommandMatches,
  type ComposerSlashCommandId,
} from "./composer-commands";
import { findSkillCommands } from "../../shared/skill-command";
import { enabledSlashSkills } from "./use-slash-skills";

describe("composer slash commands", () => {
  it("opens command search for the unfinished token at the start", () => {
    expect(composerSlashTrigger("/", 1)).toEqual({ query: "", start: 0, end: 1, atStart: true });
    expect(composerSlashTrigger("/go", 3)).toEqual({ query: "go", start: 0, end: 3, atStart: true });
    expect(composerSlashTrigger("  /go", 5)).toEqual({ query: "go", start: 2, end: 5, atStart: true });
    expect(composerSlashTrigger("/goal write", 11)).toBeNull();
  });

  it("opens skill search for a token later in the message, after a space or a line break", () => {
    expect(composerSlashTrigger("hello /go", 9)).toEqual({ query: "go", start: 6, end: 9, atStart: false });
    expect(composerSlashTrigger("/standup billing\n/rev", 21)).toEqual({ query: "rev", start: 17, end: 21, atStart: false });
    expect(composerSlashTrigger("hello /go there", 9)).toEqual({ query: "go", start: 6, end: 9, atStart: false });
  });

  it("does not open inside a path, a link or a finished word", () => {
    expect(composerSlashTrigger("src/standup", 11)).toBeNull();
    expect(composerSlashTrigger("see https://example.com/a", 25)).toBeNull();
    expect(composerSlashTrigger("hello /go ", 10)).toBeNull();
  });

  it("does not open inside code, and opens again after it", () => {
    expect(composerSlashTrigger("```\n/st", 7)).toBeNull();
    expect(composerSlashTrigger("`a /st` b", 6)).toBeNull();
    expect(composerSlashTrigger("```\nx\n```\n/st", 13)).toEqual({ query: "st", start: 10, end: 13, atStart: false });
  });

  it("moves a skill picked later in a line onto a line of its own, where the server reads it", () => {
    const pick = (text: string, start: number, end: number) => replaceComposerSlashTrigger(text, { query: "", start, end }, "/standup ");
    expect(pick("hello /go", 6, 9)).toEqual({ text: "hello\n/standup ", caret: 15 });
    expect(pick("hello /go there", 6, 9)).toEqual({ text: "hello\n/standup  there", caret: 15 });
    expect(findSkillCommands(pick("hello /go there", 6, 9).text, ["standup"])).toEqual(["standup"]);
    expect(pick("hello\n/go", 6, 9)).toEqual({ text: "hello\n/standup ", caret: 15 });
    expect(pick("  /go", 2, 5)).toEqual({ text: "  /standup ", caret: 11 });
    expect(pick("     /go", 5, 8)).toEqual({ text: "/standup ", caret: 9 });
    expect(replaceComposerSlashTrigger("hello /go", { query: "go", start: 6, end: 9 }, "")).toEqual({ text: "hello ", caret: 6 });
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
    expect(composerSlashTrigger("/weekly-2", 9)).toEqual({ query: "weekly-2", start: 0, end: 9, atStart: true });
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

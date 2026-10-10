import { describe, expect, it } from "vitest";
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
  it("opens command search only for the first unfinished token", () => {
    expect(composerSlashTrigger("/", 1)).toEqual({ query: "", start: 0, end: 1 });
    expect(composerSlashTrigger("/go", 3)).toEqual({ query: "go", start: 0, end: 3 });
    expect(composerSlashTrigger("hello /go", 9)).toBeNull();
    expect(composerSlashTrigger("/goal write", 11)).toBeNull();
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

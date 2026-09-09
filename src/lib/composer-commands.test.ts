import { describe, expect, it } from "vitest";
import {
  composerSlashTrigger,
  goalTextFromComposer,
  replaceComposerSlashTrigger,
  type ComposerSlashCommandId,
} from "./composer-commands";

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
});

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { skillSwitchCardCopy, skillSwitchStillMatches, skillSwitchTarget, type SwitchableSkill } from "./skill-switch.ts";

const text = "---\nname: notes\ndescription: Keeps notes\n---\n# Notes\n";
const own = (enabled: boolean): SwitchableSkill => ({ kind: "own", enabled, text, description: "Keeps  notes" });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("skillSwitchTarget", () => {
  it("shows the current SKILL.md and binds the card to its hash", () => {
    expect(skillSwitchTarget("notes", "disable", own(true))).toEqual({ preview: text, sha256: hash(text), gist: "Keeps notes" });
    expect(skillSwitchTarget("notes", "enable", own(false))).toMatchObject({ sha256: hash(text) });
    expect(skillSwitchTarget("notes", "delete", own(false))).toMatchObject({ sha256: hash(text) });
  });

  it("refuses what the bot can't change on its own", () => {
    expect(skillSwitchTarget("ghost", "enable", undefined)).toEqual({ error: expect.stringContaining("no skill named \"ghost\"") });
    expect(skillSwitchTarget("lib", "disable", { kind: "fixed", enabled: true, text: null })).toEqual({ error: expect.stringContaining("only the person can change it") });
    expect(skillSwitchTarget("imp", "delete", { kind: "imported", enabled: true, text })).toEqual({ error: expect.stringContaining("turn it off instead") });
    expect(skillSwitchTarget("imp", "disable", { kind: "imported", enabled: true, text })).toMatchObject({ sha256: hash(text) });
    expect(skillSwitchTarget("imp", "enable", { kind: "imported", enabled: false, text })).toEqual({ error: expect.stringContaining("only the person can turn it on") });
  });

  it("refuses a switch that would change nothing", () => {
    expect(skillSwitchTarget("notes", "enable", own(true))).toEqual({ error: "skill \"notes\" is already on" });
    expect(skillSwitchTarget("notes", "disable", own(false))).toEqual({ error: "skill \"notes\" is already off" });
  });

  it("refuses a skill that can't be shown", () => {
    expect(skillSwitchTarget("notes", "delete", { ...own(true), text: null })).toEqual({ error: expect.stringContaining("can't be shown for review") });
  });
});

describe("skillSwitchStillMatches", () => {
  it("passes only for the same skill in the same state", () => {
    expect(skillSwitchStillMatches("notes", "disable", own(true), hash(text))).toEqual({ ok: true });
    expect(skillSwitchStillMatches("notes", "disable", { ...own(true), text: `${text}more\n` }, hash(text))).toEqual({ error: expect.stringContaining("changed after this card was shown") });
    expect(skillSwitchStillMatches("notes", "disable", own(false), hash(text))).toEqual({ error: "skill \"notes\" is already off" });
    expect(skillSwitchStillMatches("notes", "delete", undefined, hash(text))).toHaveProperty("error");
  });
});

describe("skillSwitchCardCopy", () => {
  it("names the action on the card and its button", () => {
    expect(skillSwitchCardCopy("enable", "notes", "")).toMatchObject({ title: "Turn on skill \"notes\"?", option: "Turn on", done: "Skill \"notes\" turned on" });
    expect(skillSwitchCardCopy("disable", "notes", "Keeps notes")).toMatchObject({ option: "Turn off", subtitle: expect.stringMatching(/^Keeps notes\n\n.*Nothing is deleted\.$/) });
    expect(skillSwitchCardCopy("delete", "notes", "")).toMatchObject({ title: "Delete skill \"notes\"?", option: "Delete", done: "Skill \"notes\" deleted" });
  });
});

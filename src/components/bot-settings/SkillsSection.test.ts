import { afterAll, describe, expect, it, vi } from "vitest";

import type { ManagedSkill } from "./SkillsSection";

// The settings components read `window` when they load; the src suite runs without one.
vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterAll(() => vi.unstubAllGlobals());

const { skillSwitchOn } = await import("./SkillsSection");

const imported = (fields: Partial<ManagedSkill>): ManagedSkill => ({
  name: "cli-jira",
  description: "Jira from the command line",
  enabled: true,
  source: "imported",
  warnings: [],
  origin: "imported",
  ...fields,
});

describe("an imported skill's switch", () => {
  it("is on for a skill that is on and in the bot's list", () => {
    expect(skillSwitchOn(imported({ listed: true }))).toBe(true);
  });

  it("is on for a skill that is on but found only when a task needs it, so one click turns it off", () => {
    expect(skillSwitchOn(imported({ listed: false }))).toBe(true);
  });

  it("is off for a skill that is off", () => {
    expect(skillSwitchOn(imported({ enabled: false, listed: false }))).toBe(false);
  });
});

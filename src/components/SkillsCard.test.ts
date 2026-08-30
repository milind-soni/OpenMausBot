import { describe, expect, it } from "vitest";

import {
  mergeInstalled,
  provenanceLine,
  removeSkillConfirmation,
  warningBadgeLabel,
  type BotSkill,
} from "./SkillsCard";

const skill = (name: string, overrides: Partial<BotSkill> = {}): BotSkill => ({
  name,
  description: `${name} description`,
  enabled: false,
  source: `github.com/example/${name}`,
  sha256: "0123456789abcdef".repeat(4),
  importedAt: "2026-08-24T00:00:00.000Z",
  warnings: [],
  skippedFiles: [],
  ...overrides,
});

describe("imported-skill list helpers", () => {
  it("shows the source with only the first 8 characters of the hash", () => {
    expect(provenanceLine(skill("pdf-tools"))).toBe("github.com/example/pdf-tools · 01234567");
  });

  it("folds fresh imports in sorted by name, replacing a re-import's stale row", () => {
    const existing = [skill("alpha"), skill("delta", { warnings: ["old warning"] })];
    const merged = mergeInstalled(existing, [skill("charlie"), skill("delta")]);

    expect(merged.map((entry) => entry.name)).toEqual(["alpha", "charlie", "delta"]);
    // the re-imported row carries the NEW scan result, not the remembered one
    expect(merged[2]?.warnings).toEqual([]);
  });

  it("keeps a merge with no fresh imports identical to the existing list", () => {
    const existing = [skill("alpha"), skill("bravo")];
    expect(mergeInstalled(existing, [])).toEqual(existing);
  });

  it("pluralizes the warning badge", () => {
    expect(warningBadgeLabel(1)).toBe("1 warning");
    expect(warningBadgeLabel(3)).toBe("3 warnings");
  });

  it("names the exact skill in the remove confirmation", () => {
    expect(removeSkillConfirmation("pdf-tools")).toBe(
      "Remove the imported skill “pdf-tools”? Its files are deleted from this bot's workspace.",
    );
  });
});

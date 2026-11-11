import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { claudeDisabledNativeSkillRules } from "./drivers/claude-unusable-tools.ts";
import { codexDisabledNativeSkillArgs, codexTurnConfigArgs, GUEST_CONFINED_CODEX_ARGS } from "./drivers/codex-guest.ts";
import { setImportedSkillEnabled, storeImportedSkills } from "./imported-skills.ts";
import { deniedNativeSkills, isNativeSkillEnabled, NativeSkillChoicesUnreadable, setNativeSkillEnabled } from "./native-skill-choices.ts";

// HOME and the data folder are this test file's own temporary ones (server/testing/setup.ts).
const HOME = join(DATA_DIR, "..");
const CODEX_HOME = join(HOME, "codex-home");
const env = { HOME, CODEX_HOME };
const choicesFile = (botId: string) => join(DATA_DIR, "skill-state", botId, "native-skills.json");

afterEach(() => {
  if (!DATA_DIR.startsWith(join(tmpdir(), "omb-test-home-"))) throw new Error(`refusing to clean ${DATA_DIR}: not this test's home`);
  for (const dir of [join(DATA_DIR, "skill-state"), join(DATA_DIR, "imported-skills"), join(HOME, ".agents"), CODEX_HOME, join(HOME, "repo"), join(HOME, "brought"), process.env.OMB_CODEX_ADMIN_SKILLS_DIR!]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const skillMd = (name: string) => `---\nname: ${name}\ndescription: Works with ${name}.\n---\n\nSteps.\n`;
function plant(root: string, name: string): string {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), skillMd(name));
  return join(root, name, "SKILL.md");
}
const paths = (args: string[]) => (args[1] ?? "").replace(/^skills\.config=\[|\]$/g, "").split("},{")
  .map((table) => /path=("(?:[^"\\]|\\.)*")/.exec(table)?.[1]).filter((path): path is string => path !== undefined)
  .map((path) => JSON.parse(path) as string).sort();
function damage(botId: string) {
  mkdirSync(join(DATA_DIR, "skill-state", botId), { recursive: true });
  writeFileSync(choicesFile(botId), "{\"off\": [");
}

describe("per-bot native skill switches", () => {
  it("defaults every native skill to on", () => {
    expect(isNativeSkillEnabled("bot-a", "pdf")).toBe(true);
    expect(deniedNativeSkills("bot-a")).toEqual({ names: [], origins: [] });
  });

  it("persists off across reads and leaves other bots alone", () => {
    expect(setNativeSkillEnabled("bot-a", "pdf", false)).toEqual({ off: ["pdf"] });
    expect(setNativeSkillEnabled("bot-a", "hatch-pet", false)).toEqual({ off: ["hatch-pet", "pdf"] });
    expect(isNativeSkillEnabled("bot-a", "pdf")).toBe(false);
    expect(isNativeSkillEnabled("bot-b", "pdf")).toBe(true);
    expect(setNativeSkillEnabled("bot-a", "pdf", true)).toEqual({ off: ["hatch-pet"] });
    expect(isNativeSkillEnabled("bot-a", "pdf")).toBe(true);
  });

  it("refuses to guess when the bot's saved switches can't be read, and never writes over them", () => {
    damage("bot-a");
    expect(isNativeSkillEnabled("bot-a", "pdf")).toBe(false);
    expect(() => deniedNativeSkills("bot-a")).toThrow(NativeSkillChoicesUnreadable);
    expect(setNativeSkillEnabled("bot-a", "pdf", true)).toEqual({ error: expect.stringContaining("Fix or delete that file") });
    expect(readFileSync(choicesFile("bot-a"), "utf8")).toBe("{\"off\": [");
    expect(() => claudeDisabledNativeSkillRules("bot-a")).toThrow(NativeSkillChoicesUnreadable);
    expect(() => codexTurnConfigArgs({ botId: "bot-a" }, env)).toThrow(NativeSkillChoicesUnreadable);
    rmSync(choicesFile("bot-a"));
    expect(isNativeSkillEnabled("bot-a", "pdf")).toBe(true);
  });
});

describe("Codex skills.config overrides for a bot's switched-off skills", () => {
  it("selects each switched-off user skill by its SKILL.md path, leaving same-named repository skills alone", () => {
    const agents = plant(join(HOME, ".agents", "skills"), "pdf");
    const legacy = plant(join(CODEX_HOME, "skills"), "pdf");
    const admin = plant(process.env.OMB_CODEX_ADMIN_SKILLS_DIR!, "pdf");
    plant(join(HOME, "repo", ".agents", "skills"), "pdf");
    plant(join(HOME, ".agents", "skills"), "rex");
    setNativeSkillEnabled("bot-a", "pdf", false);

    const args = codexDisabledNativeSkillArgs("bot-a", env);
    expect(args[0]).toBe("-c");
    expect(paths(args)).toEqual([agents, legacy, admin].sort());
    expect(args[1]).not.toContain("name=");
    expect(codexDisabledNativeSkillArgs("bot-b", env)).toEqual([]);
    expect(codexTurnConfigArgs({ botId: "bot-a", guestConfined: true }, env)).toEqual([...GUEST_CONFINED_CODEX_ARGS, ...args]);
    expect(codexTurnConfigArgs({ botId: "bot-a" }, env)).toEqual(args);
  });

  it("keeps a skill from this computer that the bot switched off out of Codex, from the folder it was brought in from", () => {
    const origin = plant(join(HOME, "brought"), "renamed-folder");
    const stored = storeImportedSkills([{
      name: "rex",
      entry: {
        description: "Works with rex.", source: "codex", root: join(HOME, "brought"), origin: join(HOME, "brought", "renamed-folder"),
        label: "rex", sha256: createHash("sha256").update(skillMd("rex")).digest("hex"), warnings: [],
      },
      skillMd: skillMd("rex"),
      files: [],
    }]);
    expect(stored.map((entry) => entry.name)).toEqual(["rex"]);
    expect(setImportedSkillEnabled("bot-a", "rex", false)).not.toHaveProperty("error");
    expect(isNativeSkillEnabled("bot-a", "rex")).toBe(false);
    expect(paths(codexDisabledNativeSkillArgs("bot-a", env))).toEqual([origin]);

    setNativeSkillEnabled("bot-a", "rex", true);
    expect(isNativeSkillEnabled("bot-a", "rex")).toBe(true);
    expect(paths(codexDisabledNativeSkillArgs("bot-a", env))).toEqual([]);
  });
});

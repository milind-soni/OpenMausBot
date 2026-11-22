import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.ts";
import { claudeUserSkillsDir, settingsTurnFields } from "./turn-settings.ts";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-turn-settings-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the person's own Claude Code skills", () => {
  it("links the whole folder, so a skill's scripts and later edits come along", () => {
    const home = temp(), data = temp();
    mkdirSync(join(home, ".claude", "skills", "deploy", "scripts"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "deploy", "SKILL.md"), "v1");
    const root = claudeUserSkillsDir(data, home)!;
    expect(root).toBe(join(data, "claude-user-skills"));

    writeFileSync(join(home, ".claude", "skills", "deploy", "SKILL.md"), "v2");
    writeFileSync(join(home, ".claude", "skills", "deploy", "scripts", "run.sh"), "echo");
    expect(readFileSync(join(root, ".claude", "skills", "deploy", "SKILL.md"), "utf8")).toBe("v2");
    expect(existsSync(join(root, ".claude", "skills", "deploy", "scripts", "run.sh"))).toBe(true);
    expect(claudeUserSkillsDir(data, home)).toBe(root);
  });

  it("leaves out the personal skills a bot's project ships itself, so the project's version wins", () => {
    const home = temp(), data = temp(), cwd = temp();
    for (const name of ["deploy", "crm"]) {
      mkdirSync(join(home, ".claude", "skills", name), { recursive: true });
      writeFileSync(join(home, ".claude", "skills", name, "SKILL.md"), `personal ${name}`);
    }
    mkdirSync(join(cwd, ".claude", "skills", "deploy"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "skills", "deploy", "SKILL.md"), "project deploy");
    const root = claudeUserSkillsDir(data, home, cwd)!;
    expect(root).not.toBe(join(data, "claude-user-skills"));
    expect(existsSync(join(root, ".claude", "skills", "deploy"))).toBe(false);
    expect(readFileSync(join(root, ".claude", "skills", "crm", "SKILL.md"), "utf8")).toBe("personal crm");
    // The project drops its copy: the personal one comes back on the next turn.
    rmSync(join(cwd, ".claude", "skills", "deploy"), { recursive: true });
    expect(claudeUserSkillsDir(data, home, cwd)).toBe(join(data, "claude-user-skills"));
    expect(claudeUserSkillsDir(data, home, temp())).toBe(join(data, "claude-user-skills"));
  });

  it("has nothing to add without a skills folder", () => {
    expect(claudeUserSkillsDir(temp(), temp())).toBeNull();
  });

  it("follows the skills folder when it is somewhere else now", () => {
    const data = temp(), first = temp(), second = temp();
    for (const home of [first, second]) mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    claudeUserSkillsDir(data, first);
    const root = claudeUserSkillsDir(data, second)!;
    expect(resolve(readlinkSync(join(root, ".claude", "skills")))).toBe(resolve(join(second, ".claude", "skills")));
  });
});

describe("turn fields from Settings", () => {
  it("adds the skills folder only when its switch is on", () => {
    const data = temp(), home = temp();
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    expect(settingsTurnFields({} as AppConfig, data, false, home)).not.toHaveProperty("userSkillsDir");
    expect(settingsTurnFields({ features: { claudeUserSkills: true } } as AppConfig, data, false, home).userSkillsDir).toBe(join(data, "claude-user-skills"));
  });

  it("takes the link away once the switch is off, never what it points to", () => {
    const data = temp(), home = temp();
    mkdirSync(join(home, ".claude", "skills", "deploy"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "deploy", "SKILL.md"), "mine");
    settingsTurnFields({ features: { claudeUserSkills: true } } as AppConfig, data, false, home);
    expect(existsSync(join(data, "claude-user-skills", ".claude", "skills"))).toBe(true);
    settingsTurnFields({} as AppConfig, data, false, home);
    expect(existsSync(join(data, "claude-user-skills"))).toBe(false);
    expect(readFileSync(join(home, ".claude", "skills", "deploy", "SKILL.md"), "utf8")).toBe("mine");
  });

  it("takes a project's own links away too once the switch is off, never what they point to", () => {
    const data = temp(), home = temp(), cwd = temp();
    for (const name of ["deploy", "crm"]) {
      mkdirSync(join(home, ".claude", "skills", name), { recursive: true });
      writeFileSync(join(home, ".claude", "skills", name, "SKILL.md"), `personal ${name}`);
    }
    mkdirSync(join(cwd, ".claude", "skills", "deploy"), { recursive: true });
    const on = settingsTurnFields({ features: { claudeUserSkills: true } } as AppConfig, data, false, home, cwd);
    expect(on.userSkillsDir).toContain(join(data, "claude-user-skills", "for"));
    settingsTurnFields({} as AppConfig, data, false, home, cwd);
    expect(existsSync(join(data, "claude-user-skills"))).toBe(false);
    expect(readFileSync(join(home, ".claude", "skills", "crm", "SKILL.md"), "utf8")).toBe("personal crm");
  });

  it("keeps the MCP switch its own, and an organization's MCP limit wins", () => {
    const on = { features: { claudeUserMcp: true } } as AppConfig;
    expect(settingsTurnFields(on, temp(), false, temp()).mcpFromUserConfig).toBe(true);
    expect(settingsTurnFields(on, temp(), true, temp()).mcpFromUserConfig).toBe(false);
    expect(settingsTurnFields(on, temp(), false, temp())).not.toHaveProperty("userSkillsDir");
  });
});

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR, type AppConfig } from "./config.ts";
import { createSkillsLibraryHost } from "./host/skills-library.ts";
import { skillExport } from "./skill-export.ts";
import { installSkill, setSkillEnabled } from "./skills.ts";
import type { BotRecord, Store } from "./store.ts";
import { TASK_WORKSPACES_DIR } from "./workspace.ts";

// HOME and the data folder are this test file's own temporary ones (server/testing/setup.ts).
const HOME = join(DATA_DIR, "..");
const USER_SKILLS = join(HOME, ".claude", "skills");
const SHARED = join(TASK_WORKSPACES_DIR, ".claude", "skills");
const PROJECTS = join(HOME, "projects");
afterEach(() => {
  for (const dir of [TASK_WORKSPACES_DIR, USER_SKILLS, PROJECTS]) rmSync(dir, { recursive: true, force: true });
});

const skillMd = (name: string) => `---\nname: ${name}\ndescription: Works with ${name}.\n---\n\nFollow the steps.\n`;
function plant(root: string, name: string): string {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), skillMd(name));
  return join(root, name, "SKILL.md");
}

function hostFor(driverKind: string, options: { cfg?: AppConfig; cwd?: string; threadCwd?: string | null } = {}) {
  const id = `bot-${randomUUID().slice(0, 8)}`;
  const bot = { id, threadId: "main", modelSelection: { instanceId: "engine", model: "m" }, ...(options.cwd ? { cwd: options.cwd } : {}) } as BotRecord;
  const host = createSkillsLibraryHost({
    store: {
      bot: () => undefined,
      messagesFor: () => [],
      taskByThread: (_botId: string, threadId: string) => (threadId === "pinned" ? { cwd: options.threadCwd } : undefined),
    } as unknown as Store,
    cfg: options.cfg ?? ({} as AppConfig),
    appendSkillRequestCard: () => ({ requestId: "", summary: "" }),
    instanceOf: (instanceId) => ({ instanceId, driverKind }),
  });
  return { host, bot };
}

const listed = (skills: Array<{ name: string; origin?: string }>) => skills.map((skill) => `${skill.name}:${skill.origin ?? "own"}`);

describe("skills the engine loads by itself", () => {
  it("reach a Claude bot's / menu, its Skills page and /name from the folders above its task folder", () => {
    const { host, bot } = hostFor("claudeAgent");
    const shared = plant(SHARED, "growth-data-expert");
    const own = plant(join(TASK_WORKSPACES_DIR, bot.id, ".claude", "skills"), "bot-notes");
    plant(SHARED, "bot-notes");
    plant(SHARED, "mine");
    installSkill(bot.id, "local", [{ path: "SKILL.md", content: skillMd("mine") }]);
    setSkillEnabled(bot.id, "mine", true);
    mkdirSync(join(SHARED, "no-frontmatter"), { recursive: true });
    writeFileSync(join(SHARED, "no-frontmatter", "SKILL.md"), "Just do\nthe thing.\n\nMore steps.\n");
    for (const [name, value] of [["model-only", "false"], ["model-only-no", "No"], ["model-only-off", "off"], ["model-only-zero", "0"]] as const) {
      mkdirSync(join(SHARED, name), { recursive: true });
      writeFileSync(join(SHARED, name, "SKILL.md"), `---\ndescription: Only for the model.\nuser-invocable: ${value}\n---\n\nSteps.\n`);
    }

    expect(listed(host.listBotSkills(bot))).toEqual(["mine:own", "bot-notes:native", "growth-data-expert:native", "no-frontmatter:native"]);
    expect(host.listBotSkills(bot).find((skill) => skill.name === "no-frontmatter")?.description).toBe("Just do the thing.");
    expect(host.listBotSkills(bot).find((skill) => skill.name === "bot-notes")).toMatchObject({ enabled: true, editable: false });
    expect(host.readBotSkillFile(bot, "growth-data-expert")).toBe(skillMd("growth-data-expert"));
    expect(host.expandSkillCommand(bot, "main", "/growth-data-expert find churn")).toContain(`Read ${JSON.stringify(shared)}`);
    expect(host.expandSkillCommand(bot, "main", "/bot-notes")).toContain(`Read ${JSON.stringify(own)}`);
    expect(host.expandSkillCommand(bot, "main", "/mine go")).toContain(JSON.stringify(join("workspaces", bot.id, "skills", "mine")).slice(1, -1));
  });

  it("stay out of a bot or team package, which carries only the bot's own, library and imported skills", () => {
    const { host, bot } = hostFor("claudeAgent", { cfg: { features: { claudeUserSkills: true } } as AppConfig });
    plant(USER_SKILLS, "personal-notes");
    plant(SHARED, "growth-data-expert");
    installSkill(bot.id, "local", [{ path: "SKILL.md", content: skillMd("mine") }]);
    setSkillEnabled(bot.id, "mine", true);
    expect(listed(host.listBotSkills(bot))).toEqual(["mine:own", "personal-notes:native", "growth-data-expert:native"]);
    const team = skillExport(host).collectTeamSkills([bot], "all");
    expect(team.ok && [...team.skillsByBot.values()].flat().map((skill) => skill.name)).toEqual(["mine"]);
    expect(skillExport(host).checkedExportSkillNames(["personal-notes"], [bot])).toMatchObject({ ok: false });
  });

  it("never run one under the name of the bot's own skill that is switched off", () => {
    const { host, bot } = hostFor("claudeAgent");
    plant(SHARED, "mine");
    installSkill(bot.id, "local", [{ path: "SKILL.md", content: skillMd("mine") }]);
    expect(listed(host.listBotSkills(bot))).toEqual(["mine:own"]);
    expect(host.expandSkillCommand(bot, "main", "/mine go")).toBe("/mine go");
  });

  it("come from the folder a thread really works in, up to its git root", () => {
    const repo = join(PROJECTS, "repo");
    plant(join(PROJECTS, ".claude", "skills"), "above-the-repo");
    plant(join(repo, ".claude", "skills"), "repo-skill");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "app"), { recursive: true });
    plant(SHARED, "task-folder-skill");

    const project = hostFor("claudeAgent", { cwd: join(repo, "app") });
    expect(listed(project.host.listBotSkills(project.bot))).toEqual(["repo-skill:native"]);
    const pinned = hostFor("claudeAgent", { threadCwd: repo });
    expect(pinned.host.expandSkillCommand(pinned.bot, "pinned", "/repo-skill")).toContain("repo-skill");
    expect(listed(pinned.host.listBotSkills(pinned.bot, "pinned"))).toEqual(["repo-skill:native"]);
    expect(listed(pinned.host.listBotSkills(pinned.bot))).toEqual(["task-folder-skill:native"]);
    expect(pinned.host.expandSkillCommand(pinned.bot, "main", "/repo-skill")).toBe("/repo-skill");
    const none = hostFor("claudeAgent", { threadCwd: null });
    expect(none.host.expandSkillCommand(none.bot, "pinned", "/task-folder-skill")).toBe("/task-folder-skill");
  });

  it.skipIf(process.platform === "win32")("never read a SKILL.md that is itself a link", () => {
    const { host, bot } = hostFor("claudeAgent");
    mkdirSync(join(SHARED, "linked"), { recursive: true });
    symlinkSync(plant(join(DATA_DIR, "elsewhere"), "secret"), join(SHARED, "linked", "SKILL.md"));
    expect(host.listBotSkills(bot)).toEqual([]);
    expect(host.readBotSkillFile(bot, "linked")).toBeNull();
    expect(host.expandSkillCommand(bot, "main", "/linked go")).toBe("/linked go");
  });

  it("include ~/.claude/skills only with \"Also use my Claude Code skills\", and no task folders for other engines", () => {
    plant(SHARED, "shared-one");
    plant(USER_SKILLS, "personal-one");
    plant(SHARED, "both");
    const personal = plant(USER_SKILLS, "both");
    const off = hostFor("claudeAgent");
    expect(listed(off.host.listBotSkills(off.bot))).toEqual(["both:native", "shared-one:native"]);
    const on = hostFor("claudeAgent", { cfg: { features: { claudeUserSkills: true } } as AppConfig });
    expect(listed(on.host.listBotSkills(on.bot))).toEqual(["both:native", "personal-one:native", "shared-one:native"]);
    expect(on.host.expandSkillCommand(on.bot, "main", "/both")).toContain(`Read ${JSON.stringify(personal)}`);
    const other = hostFor("geminiAgent", { cfg: { features: { claudeUserSkills: true } } as AppConfig });
    expect(listed(other.host.listBotSkills(other.bot))).toEqual([]);
    expect(other.host.expandSkillCommand(other.bot, "main", "/shared-one")).toBe("/shared-one");
  });
});

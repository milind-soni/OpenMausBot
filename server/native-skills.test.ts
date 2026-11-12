import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR, type AppConfig } from "./config.ts";
import { createSkillsLibraryHost } from "./host/skills-library.ts";
import { setNativeSkillEnabled } from "./native-skill-choices.ts";
import { skillExport } from "./skill-export.ts";
import { installSkill, setSkillEnabled } from "./skills.ts";
import type { BotRecord, Store } from "./store.ts";
import { noteTypedSend } from "./typed-sends.ts";
import { TASK_WORKSPACES_DIR } from "./workspace.ts";

// HOME and the data folder are this test file's own temporary ones (server/testing/setup.ts).
const HOME = join(DATA_DIR, "..");
const USER_SKILLS = join(HOME, ".claude", "skills");
const CODEX_SKILLS = join(HOME, ".codex", "skills");
const AGENTS_SKILLS = join(HOME, ".agents", "skills");
const SHARED = join(TASK_WORKSPACES_DIR, ".claude", "skills");
const PROJECTS = join(HOME, "projects");
afterEach(() => {
  if (!DATA_DIR.startsWith(join(tmpdir(), "omb-test-home-"))) throw new Error(`refusing to clean ${DATA_DIR}: not this test's home`);
  for (const dir of [TASK_WORKSPACES_DIR, USER_SKILLS, CODEX_SKILLS, AGENTS_SKILLS, PROJECTS, join(DATA_DIR, "skill-state")]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const skillMd = (name: string) => `---\nname: ${name}\ndescription: Works with ${name}.\n---\n\nFollow the steps.\n`;
function plant(root: string, name: string): string {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), skillMd(name));
  return join(root, name, "SKILL.md");
}

function hostFor(driverKind: string, options: { cfg?: AppConfig; cwd?: string; threadCwd?: string | null; resumed?: boolean } = {}) {
  const id = `bot-${randomUUID().slice(0, 8)}`;
  const bot = { id, threadId: "main", modelSelection: { instanceId: "engine", model: "m" }, ...(options.cwd ? { cwd: options.cwd } : {}) } as BotRecord;
  const host = createSkillsLibraryHost({
    store: {
      bot: () => undefined,
      messagesFor: () => [],
      taskByThread: (_botId: string, threadId: string) => (threadId === "pinned" ? { cwd: options.threadCwd, resumeCursors: options.resumed ? { engine: "s1" } : {} } : undefined),
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
    expect(host.expandSkillCommand(bot, "main", "/growth-data-expert find churn", undefined, [], true)).toContain(`Read ${JSON.stringify(shared)}`);
    expect(host.expandSkillCommand(bot, "main", "/bot-notes", undefined, [], true)).toContain(`Read ${JSON.stringify(own)}`);
    expect(host.expandSkillCommand(bot, "main", "/mine go", undefined, [], true)).toContain(JSON.stringify(join("workspaces", bot.id, "skills", "mine")).slice(1, -1));
  });

  it("run mid-message from what a person typed, alongside the bot's own, and stay off when switched off", () => {
    const { host, bot } = hostFor("claudeAgent");
    const shared = plant(SHARED, "growth-data-expert");
    plant(SHARED, "mine-off");
    installSkill(bot.id, "local", [{ path: "SKILL.md", content: skillMd("mine") }]);
    setSkillEnabled(bot.id, "mine", true);
    installSkill(bot.id, "local", [{ path: "SKILL.md", content: skillMd("mine-off") }]);
    const typed = (text: string) => {
      const sendId = randomUUID();
      noteTypedSend("main", sendId, text);
      return host.expandSkillCommand(bot, "main", text, undefined, [{ sendId, text }]);
    };
    const both = typed("find churn with /growth-data-expert, then /mine");
    expect(both).toContain("ran 2 of your skills with /growth-data-expert, /mine");
    expect(both).toContain(`${JSON.stringify(shared)} for /growth-data-expert`);
    expect(both).toMatch(new RegExp(`workspaces[\\\\/]+${bot.id}[\\\\/]+skills[\\\\/]+mine[\\\\/]+SKILL\\.md" for /mine`));
    expect(both).toContain("Request: find churn with /growth-data-expert, then /mine");
    expect(typed("Skip it, /mine-off")).toBe("Skip it, /mine-off");
    expect(host.expandSkillCommand(bot, "main", "find churn with /growth-data-expert")).toBe("find churn with /growth-data-expert");
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
    expect(host.expandSkillCommand(bot, "main", "/mine go", undefined, [], true)).toBe("/mine go");
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
    expect(pinned.host.expandSkillCommand(pinned.bot, "pinned", "/repo-skill", undefined, [], true)).toContain("repo-skill");
    expect(listed(pinned.host.listBotSkills(pinned.bot, "pinned"))).toEqual(["repo-skill:native"]);
    expect(listed(pinned.host.listBotSkills(pinned.bot))).toEqual(["task-folder-skill:native"]);
    expect(pinned.host.expandSkillCommand(pinned.bot, "main", "/repo-skill", undefined, [], true)).toBe("/repo-skill");
    const none = hostFor("claudeAgent", { threadCwd: null });
    expect(none.host.expandSkillCommand(none.bot, "pinned", "/task-folder-skill", undefined, [], true)).toBe("/task-folder-skill");
  });

  it.skipIf(process.platform === "win32")("never read a SKILL.md that is itself a link", () => {
    const { host, bot } = hostFor("claudeAgent");
    mkdirSync(join(SHARED, "linked"), { recursive: true });
    symlinkSync(plant(join(DATA_DIR, "elsewhere"), "secret"), join(SHARED, "linked", "SKILL.md"));
    expect(host.listBotSkills(bot)).toEqual([]);
    expect(host.readBotSkillFile(bot, "linked")).toBeNull();
    expect(host.expandSkillCommand(bot, "main", "/linked go", undefined, [], true)).toBe("/linked go");
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
    expect(on.host.expandSkillCommand(on.bot, "main", "/both", undefined, [], true)).toContain(`Read ${JSON.stringify(personal)}`);
    const other = hostFor("geminiAgent", { cfg: { features: { claudeUserSkills: true } } as AppConfig });
    expect(listed(other.host.listBotSkills(other.bot))).toEqual([]);
    expect(other.host.expandSkillCommand(other.bot, "main", "/shared-one", undefined, [], true)).toBe("/shared-one");
  });
});

describe("switching a native skill off for one bot", () => {
  it("shows enabled false on the Skills page and keeps /name from expanding it", () => {
    const { host, bot } = hostFor("codex");
    plant(join(HOME, ".codex", "skills"), "pdf");
    expect(host.listBotSkills(bot).find((skill) => skill.name === "pdf")).toMatchObject({ origin: "native", enabled: true });
    setNativeSkillEnabled(bot.id, "pdf", false);
    expect(host.listBotSkills(bot).find((skill) => skill.name === "pdf")).toMatchObject({ origin: "native", enabled: false });
    expect(host.expandSkillCommand(bot, "main", "/pdf summarise", undefined, [], true)).toBe("/pdf summarise");
  });

  it("lists Codex skills from ~/.agents/skills with a switch, as Codex loads them", () => {
    const { host, bot } = hostFor("codex");
    plant(AGENTS_SKILLS, "release-notes");
    expect(host.listBotSkills(bot).find((skill) => skill.name === "release-notes")).toMatchObject({ origin: "native", enabled: true });
    setNativeSkillEnabled(bot.id, "release-notes", false);
    expect(host.listBotSkills(bot).find((skill) => skill.name === "release-notes")).toMatchObject({ origin: "native", enabled: false });
    expect(listed(hostFor("claudeAgent").host.listBotSkills(bot))).not.toContain("release-notes:native");
  });

  it("shows every native skill on while the bot's saved switches can't be read", () => {
    const { host, bot } = hostFor("codex");
    plant(CODEX_SKILLS, "pdf");
    plant(AGENTS_SKILLS, "deploy");
    mkdirSync(join(DATA_DIR, "skill-state", bot.id), { recursive: true });
    writeFileSync(join(DATA_DIR, "skill-state", bot.id, "native-skills.json"), "{\"off\": [\"pd");
    const natives = host.listBotSkills(bot).filter((skill) => "origin" in skill && skill.origin === "native")
      .map((skill) => [skill.name, skill.enabled] as const).sort();
    expect(natives).toEqual([["deploy", true], ["pdf", true]]);
  });
});

describe("skills a project ships for any agent", () => {
  const repo = join(PROJECTS, "repo");
  const trusted = { features: { projectSkills: true } } as AppConfig;
  function plantRepo() {
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "app"), { recursive: true });
    plant(join(PROJECTS, "agents", "skills"), "above-the-repo");
    return {
      agents: plant(join(repo, "agents", "skills"), "agents-skill"),
      dotAgents: plant(join(repo, ".agents", "skills"), "dot-agents-skill"),
      claude: plant(join(repo, ".claude", "skills"), "claude-skill"),
      nearer: plant(join(repo, "app", ".agents", "skills"), "agents-skill"),
    };
  }

  it("show on the bot's Skills page, off until the owner trusts project skills, and never reach a turn until then", () => {
    const paths = plantRepo();
    const off = hostFor("geminiAgent", { cwd: join(repo, "app") });
    expect(listed(off.host.listBotSkills(off.bot))).toEqual(["agents-skill:project", "dot-agents-skill:project", "claude-skill:project"]);
    expect(off.host.listBotSkills(off.bot).every((skill) => !skill.enabled && !skill.editable)).toBe(true);
    expect(off.host.readBotSkillFile(off.bot, "claude-skill")).toBe(skillMd("claude-skill"));
    expect(off.host.skillsIndex(off.bot, "main")).toBe("");
    expect(off.host.expandSkillCommand(off.bot, "main", "/claude-skill go", undefined, [], true)).toBe("/claude-skill go");

    const on = hostFor("geminiAgent", { cwd: join(repo, "app"), cfg: trusted });
    const index = on.host.skillsIndex(on.bot, "main");
    expect(index).toContain("Skills in this project:");
    expect(index).toContain(`- agents-skill: Works with agents-skill. Read ${JSON.stringify(paths.nearer)}.`);
    expect(index).not.toContain(JSON.stringify(paths.agents));
    expect(index).toContain(JSON.stringify(paths.dotAgents));
    expect(index).toContain(JSON.stringify(paths.claude));
    expect(index).not.toContain("above-the-repo");
    expect(on.host.listBotSkills(on.bot).every((skill) => skill.enabled)).toBe(true);
    expect(on.host.expandSkillCommand(on.bot, "main", "/claude-skill go", undefined, [], true)).toContain(`Read ${JSON.stringify(paths.claude)}`);
  });

  it("outside a repository, come from the working folder alone", () => {
    const loose = join(PROJECTS, "loose", "app");
    plant(join(PROJECTS, "loose", "agents", "skills"), "above");
    const here = plant(join(loose, ".agents", "skills"), "here");
    const { host, bot } = hostFor("geminiAgent", { cwd: loose, cfg: trusted });
    expect(listed(host.listBotSkills(bot))).toEqual(["here:project"]);
    expect(host.skillsIndex(bot, "main")).toContain(JSON.stringify(here));
  });

  it("follow the folder a turn really works in", () => {
    const paths = plantRepo();
    const { host, bot } = hostFor("geminiAgent", { cfg: trusted });
    expect(host.skillsIndex(bot, "main")).toBe("");
    expect(host.skillsIndex(bot, "main", undefined, repo)).toContain(JSON.stringify(paths.agents));
    expect(host.skillsIndex(bot, "main", undefined, null)).toBe("");
  });

  it("never run from the bot's folder for a resumed thread that will stay where its session is", () => {
    plantRepo();
    const { host, bot } = hostFor("geminiAgent", { cwd: repo, cfg: trusted, resumed: true });
    expect(listed(host.listBotSkills(bot, "pinned"))).toEqual([]);
    expect(host.expandSkillCommand(bot, "pinned", "/claude-skill go", undefined, [], true)).toBe("/claude-skill go");
    expect(host.expandSkillCommand(bot, "main", "/claude-skill go", undefined, [], true)).toContain("claude-skill");
  });

  it("leave .agents/skills to Codex, which loads it by itself", () => {
    const paths = plantRepo();
    const { host, bot } = hostFor("codex", { cwd: join(repo, "app"), cfg: trusted });
    expect(listed(host.listBotSkills(bot))).toEqual(["agents-skill:native", "dot-agents-skill:native", "claude-skill:project"]);
    const index = host.skillsIndex(bot, "main");
    expect(index).toContain(JSON.stringify(paths.claude));
    expect(index).not.toContain("dot-agents-skill");
    expect(index).not.toContain("- agents-skill:");
  });

  it("list a model-only skill for the model, but never run it with /name", () => {
    mkdirSync(join(repo, ".git"), { recursive: true });
    const folder = join(repo, "agents", "skills", "background");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), "---\ndescription: House style.\nuser-invocable: false\n---\n\nUse it.\n");
    const { host, bot } = hostFor("geminiAgent", { cwd: repo, cfg: trusted });
    expect(host.skillsIndex(bot, "main")).toContain("- background: House style.");
    expect(host.expandSkillCommand(bot, "main", "/background go", undefined, [], true)).toBe("/background go");
  });

  it.skipIf(process.platform === "win32")("never come from the app's own folders through a link", () => {
    mkdirSync(join(repo, ".git"), { recursive: true });
    plant(join(DATA_DIR, "app-skills"), "app-owned");
    mkdirSync(join(repo, "agents", "skills"), { recursive: true });
    symlinkSync(join(DATA_DIR, "app-skills", "app-owned"), join(repo, "agents", "skills", "app-owned"), "dir");
    const linkedRepo = join(PROJECTS, "linked");
    symlinkSync(join(DATA_DIR, "workspaces"), linkedRepo, "dir");
    plant(join(DATA_DIR, "workspaces", ".agents", "skills"), "inside");
    const { host, bot } = hostFor("geminiAgent", { cwd: repo, cfg: trusted });
    expect(listed(host.listBotSkills(bot))).toEqual([]);
    expect(host.skillsIndex(bot, "main", undefined, linkedRepo)).toBe("");
    rmSync(join(DATA_DIR, "app-skills"), { recursive: true, force: true });
    rmSync(join(DATA_DIR, "workspaces", ".agents"), { recursive: true, force: true });
  });

  it("leave .claude/skills to Claude Code, which loads it by itself", () => {
    const paths = plantRepo();
    const { host, bot } = hostFor("claudeAgent", { cwd: repo, cfg: trusted });
    expect(listed(host.listBotSkills(bot))).toEqual(["claude-skill:native", "dot-agents-skill:project", "agents-skill:project"]);
    const index = host.skillsIndex(bot, "main");
    expect(index).toContain(JSON.stringify(paths.agents));
    expect(index).not.toContain("claude-skill");
  });

  it("never run in a conversation that keeps a private folder", () => {
    plantRepo();
    const { host, bot } = hostFor("geminiAgent", { cwd: repo, cfg: trusted });
    expect(host.expandSkillCommand(bot, "guest", "/claude-skill go", undefined, [], true, true)).toBe("/claude-skill go");
    expect(host.expandSkillCommand(bot, "guest", "/claude-skill go", undefined, [], true)).toContain("claude-skill");
  });

  it("in a turn's own folder, yield a name only to what the engine loads from that folder", () => {
    const room = join(PROJECTS, "room");
    mkdirSync(join(room, ".git"), { recursive: true });
    const roomSkill = plant(join(room, "agents", "skills"), "shared-name");
    mkdirSync(join(repo, ".git"), { recursive: true });
    plant(join(repo, ".claude", "skills"), "shared-name");
    const { host, bot } = hostFor("claudeAgent", { cwd: repo, cfg: trusted });
    expect(host.skillsIndex(bot, "main", undefined, room)).toContain(JSON.stringify(roomSkill));
    expect(host.skillsIndex(bot, "main", undefined, repo)).not.toContain("shared-name");
  });

  it("yield a name to the bot's own skill, even one switched off", () => {
    plantRepo();
    const { host, bot } = hostFor("geminiAgent", { cwd: repo, cfg: trusted });
    installSkill(bot.id, "local", [{ path: "SKILL.md", content: skillMd("agents-skill") }]);
    expect(listed(host.listBotSkills(bot))).toEqual(["agents-skill:own", "dot-agents-skill:project", "claude-skill:project"]);
    expect(host.skillsIndex(bot, "main")).not.toContain("- agents-skill:");
    expect(host.expandSkillCommand(bot, "main", "/agents-skill go", undefined, [], true)).toBe("/agents-skill go");
  });

  it("never come from the app's own folders, nor reach an engine that cannot read files, nor a package", () => {
    plant(join(TASK_WORKSPACES_DIR, ".agents", "skills"), "app-link");
    const task = hostFor("geminiAgent", { cfg: trusted });
    expect(listed(task.host.listBotSkills(task.bot))).toEqual([]);
    expect(task.host.skillsIndex(task.bot, "main", undefined, join(DATA_DIR, "workspaces", task.bot.id))).toBe("");

    plantRepo();
    const api = hostFor("openai-compat", { cwd: repo, cfg: trusted });
    expect(listed(api.host.listBotSkills(api.bot))).toEqual([]);

    const exported = hostFor("geminiAgent", { cwd: repo, cfg: trusted });
    const team = skillExport(exported.host).collectTeamSkills([exported.bot], "all");
    expect(team.ok && [...team.skillsByBot.values()].flat()).toEqual([]);
    expect(skillExport(exported.host).checkedExportSkillNames(["agents-skill"], [exported.bot])).toMatchObject({ ok: false });
  });
});

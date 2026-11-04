import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { storeImportedSkills } from "./imported-skills.ts";
import { builtInSkillsFor, listSkillCatalog, readCatalogSkill, removeCatalogSkill, setBotSkill, setSkillAccess, type CatalogBot, type SkillCatalogDeps } from "./skill-catalog.ts";
import { installLibrarySkill, readSkillLibraryIndex, type BundledSkill } from "./skill-library.ts";
import { readPendingAssignments } from "./skills-library-migration.ts";
import { applyStagedSkillWrite, installSkill, listSkills, setSkillEnabled, stageSkillWrite } from "./skills.ts";

// HOME and the data folder are this test file's own temporary ones (server/testing/setup.ts); each test uses a library root of its own.
const SKILL = (name: string, body = "Follow the steps.") => `---\nname: ${name}\ndescription: Works with ${name}.\n---\n\n${body}\n`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function world(names: string[], extra: Partial<SkillCatalogDeps> = {}) {
  const bots: CatalogBot[] = names.map((name) => ({ id: `${name}-${randomUUID().slice(0, 8)}`, assignedSkills: [] }));
  const root = mkdtempSync(join(tmpdir(), "omb-skill-catalog-"));
  const deps: SkillCatalogDeps = {
    bots: () => bots,
    patchAssigned: (botId, assignedSkills) => { bots.find((bot) => bot.id === botId)!.assignedSkills = assignedSkills; },
    builtIns: () => [],
    root,
    ...extra,
  };
  const row = (id: string) => listSkillCatalog(deps).find((skill) => skill.id === id);
  return { bots, ids: bots.map((bot) => bot.id), root, deps, row };
}

const library = (root: string, name: string, more: Partial<Parameters<typeof installLibrarySkill>[0]> = {}) => {
  const installed = installLibrarySkill({ name, instructions: SKILL(name), source: "github.com/acme/skills/" + name, reviewState: "approved", root, ...more });
  if ("error" in installed) throw new Error(installed.error);
};

describe("who can use a library skill", () => {
  it("reads All bots, the chosen bots and Off from the library's own fields and each bot's assignments", () => {
    const { deps, ids, root, row } = world(["pepper", "scout"]);
    library(root, "weekly-report", { everyBot: true });
    library(root, "invoice-check");
    library(root, "meeting-notes", { reviewState: "disabled", warnings: ["pipes a download straight into a shell (curl|sh) — never enable"] });
    deps.patchAssigned(ids[1]!, ["invoice-check"]);

    expect(row("library:weekly-report")).toMatchObject({ who: "all", bots: ids, from: { kind: "github", where: "acme/skills" }, removable: true });
    expect(row("library:invoice-check")).toMatchObject({ who: "bots", bots: [ids[1]] });
    expect(row("library:meeting-notes")).toMatchObject({ who: "off", bots: [], flag: "pipe" });
  });

  it("changes who can use it, and a bot's switch off on an All bots skill leaves it with every other bot", () => {
    const { deps, ids, root, row, bots } = world(["pepper", "scout", "atlas"]);
    library(root, "weekly-report", { reviewState: "disabled" });

    expect(setSkillAccess(deps, "library:weekly-report", "all")).toEqual({ ok: true });
    expect(row("library:weekly-report")).toMatchObject({ who: "all", bots: ids });
    expect(setBotSkill(deps, ids[0]!, "library:weekly-report", false)).toEqual({ ok: true });
    expect(row("library:weekly-report")).toMatchObject({ who: "bots", bots: [ids[1], ids[2]] });
    expect(readSkillLibraryIndex(root)["weekly-report"]?.everyBot).toBeUndefined();

    expect(setBotSkill(deps, ids[0]!, "library:weekly-report", true)).toEqual({ ok: true });
    expect(row("library:weekly-report")?.bots).toEqual(ids);
    expect(setSkillAccess(deps, "library:weekly-report", "bots", [ids[2]!])).toEqual({ ok: true });
    expect(bots.map((bot) => bot.assignedSkills)).toEqual([[], [], ["weekly-report"]]);
    expect(setSkillAccess(deps, "library:weekly-report", "bots", [])).toEqual({ ok: true });
    expect(row("library:weekly-report")).toMatchObject({ who: "off", bots: [] });
    expect(bots.map((bot) => bot.assignedSkills)).toEqual([[], [], []]);
    expect(readSkillLibraryIndex(root)["weekly-report"]?.reviewState).toBe("disabled");
    expect(setSkillAccess(deps, "library:nope", "all")).toMatchObject({ status: 404 });
  });

  it("removes a skill for every bot: its files go to the archive and no bot keeps it assigned", () => {
    const { deps, ids, root, row, bots } = world(["pepper"]);
    library(root, "weekly-report");
    deps.patchAssigned(ids[0]!, ["weekly-report", "other"]);
    expect(readCatalogSkill(deps, "library:weekly-report")).toEqual({ instructions: "Follow the steps.", files: [] });
    expect(removeCatalogSkill(deps, "library:weekly-report")).toEqual({ ok: true });
    expect(row("library:weekly-report")).toBeUndefined();
    expect(bots[0]!.assignedSkills).toEqual(["other"]);
    expect(existsSync(join(root, "archive", "retired", `weekly-report.${sha(SKILL("weekly-report"))}`, "SKILL.md"))).toBe(true);
  });
});

describe("skills brought in from another AI tool", () => {
  const bring = (name: string, warnings: string[] = []) => {
    const skillMd = SKILL(name);
    storeImportedSkills([{
      name, skillMd, files: [{ path: "scripts/run.sh", content: "echo run\n", executable: true }],
      entry: { description: `Works with ${name}.`, source: "codex", root: "/nowhere/.codex/skills", origin: `/nowhere/.codex/skills/${name}`, label: name, sha256: sha(skillMd), warnings },
    }]);
  };

  it("start with every bot, and keep who was chosen for bots made later", () => {
    const { deps, ids, row, bots } = world(["pepper", "scout"]);
    bring("review-pr");
    expect(row("tool:review-pr")).toMatchObject({ who: "all", bots: ids, from: { kind: "tool", tool: "codex" } });
    expect(readCatalogSkill(deps, "tool:review-pr")).toEqual({ instructions: "Follow the steps.", files: ["scripts/run.sh"] });

    expect(setBotSkill(deps, ids[0]!, "tool:review-pr", false)).toEqual({ ok: true });
    expect(row("tool:review-pr")).toMatchObject({ who: "bots", bots: [ids[1]] });
    bots.push({ id: `later-${randomUUID().slice(0, 8)}` });
    expect(row("tool:review-pr")).toMatchObject({ who: "bots", bots: [ids[1]] });

    expect(setSkillAccess(deps, "tool:review-pr", "off")).toEqual({ ok: true });
    expect(row("tool:review-pr")).toMatchObject({ who: "off", bots: [] });
    expect(setSkillAccess(deps, "tool:review-pr", "all")).toEqual({ ok: true });
    expect(row("tool:review-pr")?.who).toBe("all");
    expect(removeCatalogSkill(deps, "tool:review-pr")).toEqual({ ok: true });
    expect(row("tool:review-pr")).toBeUndefined();
  });

  it("a flagged one lands off with its reason, and All bots switches it on for every bot", () => {
    const { deps, ids, row } = world(["pepper", "scout"]);
    bring("installer", ["contains invisible Unicode characters (zero-width or bidi controls) — text you cannot see"]);
    expect(row("tool:installer")).toMatchObject({ who: "off", flag: "invisible" });
    expect(setSkillAccess(deps, "tool:installer", "all")).toEqual({ ok: true });
    expect(row("tool:installer")).toMatchObject({ who: "all", bots: ids });
    expect(row("tool:installer")?.flag).toBeUndefined();
  });
});

describe("built-in skills", () => {
  const builtIn = (id: string): BundledSkill => ({
    manifest: { id, name: id, version: "1.0.0", description: `Built-in ${id}.`, defaultEnabled: true, triggerTerms: [id], requiredCapabilities: [] },
    instructions: SKILL(id), directory: "/nowhere",
  });

  it("reach only the bots the page lets use them", () => {
    const skills = [builtIn("data-dashboards"), builtIn("social-posts")];
    const { deps, ids, root, row } = world(["pepper", "scout"], { builtIns: () => skills });
    expect(row("builtin:social-posts")).toMatchObject({ who: "all", removable: false, from: { kind: "builtin" } });
    expect(setSkillAccess(deps, "builtin:social-posts", "off")).toEqual({ ok: true });
    expect(builtInSkillsFor(ids[0]!, skills, root).map((skill) => skill.manifest.id)).toEqual(["data-dashboards"]);
    expect(setBotSkill(deps, ids[1]!, "builtin:social-posts", true)).toEqual({ ok: true });
    expect(builtInSkillsFor(ids[0]!, skills, root).map((skill) => skill.manifest.id)).toEqual(["data-dashboards"]);
    expect(builtInSkillsFor(ids[1]!, skills, root).map((skill) => skill.manifest.id)).toEqual(["data-dashboards", "social-posts"]);
    expect(setSkillAccess(deps, "builtin:social-posts", "all")).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(root, "built-in-access.json"), "utf8"))).toEqual({});
    expect(removeCatalogSkill(deps, "builtin:social-posts")).toMatchObject({ status: 404 });
  });
});

describe("a skill kept with one bot", () => {
  it("moves into the library when more bots should use it, and no pending assignment undoes the choice", () => {
    const { deps, ids, root, row, bots } = world(["pepper", "scout"]);
    installSkill(ids[0]!, "learn:weekly notes", [{ path: "SKILL.md", content: SKILL("weekly-notes") }]);
    setSkillEnabled(ids[0]!, "weekly-notes", true);
    expect(row("bot:weekly-notes")).toMatchObject({ who: "bots", bots: [ids[0]], only: [ids[0]], from: { kind: "learned", botId: ids[0] } });

    expect(setSkillAccess(deps, "bot:weekly-notes", "bots", [ids[1]!])).toEqual({ ok: true });
    expect(row("bot:weekly-notes")).toBeUndefined();
    expect(row("library:weekly-notes")).toMatchObject({ who: "bots", bots: [ids[1]], from: { kind: "learned", botId: ids[0] } });
    expect(listSkills(ids[0]!)).toEqual([]);
    expect(readPendingAssignments(root)).toEqual({});
    expect(bots[0]!.assignedSkills).toEqual([]);
  });

  it("one the library cannot hold yet stays with its bot, and says so", () => {
    const { deps, ids, row } = world(["pepper", "scout"]);
    const staged = stageSkillWrite(ids[0]!, {
      action: "create", source: "learn:expense flow", gist: "File an expense",
      files: [{ path: "SKILL.md", content: SKILL("file-expense") }, { path: "references/portal.md", content: "Open the portal.\n" }],
    });
    if ("error" in staged) throw new Error(staged.error);
    applyStagedSkillWrite(ids[0]!, staged.id, { expectedSha256: staged.sha256 });
    expect(readCatalogSkill(deps, "bot:file-expense")).toEqual({ instructions: "Follow the steps.", files: ["references/portal.md"] });

    expect(setSkillAccess(deps, "bot:file-expense", "all")).toMatchObject({ status: 409, code: "stays" });
    expect(row("bot:file-expense")).toMatchObject({ who: "bots", bots: [ids[0]] });
    expect(setBotSkill(deps, ids[0]!, "bot:file-expense", false)).toEqual({ ok: true });
    expect(row("bot:file-expense")).toMatchObject({ who: "off", bots: [] });
    expect(removeCatalogSkill(deps, "bot:file-expense")).toEqual({ ok: true });
    expect(listSkills(ids[0]!)).toEqual([]);
  });
});

describe("skills an organization offers", () => {
  it("are off until a person chooses bots, which puts the organization's copy on each", () => {
    const added: Array<[string, string]> = [];
    const offered = [{ installId: "a".repeat(32), name: "follow-up", description: "Follows up on a lead." }];
    const { deps, ids, row } = world(["pepper", "scout"], {
      offered: () => offered,
      addOffered: (botId, _installId, name) => {
        added.push([botId, name]);
        return { ok: true };
      },
    });
    expect(row(`team:${"a".repeat(32)}:follow-up`)).toMatchObject({ who: "off", from: { kind: "team" }, removable: false });
    expect(setSkillAccess(deps, `team:${"a".repeat(32)}:follow-up`, "bots", [ids[1]!])).toEqual({ ok: true });
    expect(added).toEqual([[ids[1], "follow-up"]]);
  });
});

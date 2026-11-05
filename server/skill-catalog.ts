// One list of every skill, whatever store holds it, with who may use each. A skill lives in the library, among the
// skills brought in from this computer's other AI tools, among the built-in ones, or (when it cannot move) with the one
// bot that has it; this file reads them all the same way and changes each through its own store.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import {
  importedSkillFiles, importedSkillIntact, importedSkillUsers, readImportedSkillFile, readImportedSkills, removeImportedSkill,
  setImportedSkillAccess,
} from "./imported-skills.ts";
import {
  listLibrarySkills, readLibrarySkillFile, readSkillLibraryIndex, retireLibrarySkill, setLibrarySkillAccess, skillsLibraryRoot,
  type BundledSkill,
} from "./skill-library.ts";
import { migrateBotSkillsToLibrary, readPendingAssignments, writePendingAssignments } from "./skills-library-migration.ts";
import { listSkills, readSkillFile, readSkillReferences, removeSkill, setSkillEnabled, type SkillListing } from "./skills.ts";
import { readSkillFrontmatter } from "../shared/skill-md.ts";
import { skillFlag, skillFrom, type SkillDetailWire, type SkillWho, type SkillWire } from "../shared/skill-catalog.ts";

export interface CatalogBot {
  id: string;
  assignedSkills?: string[];
}

export interface SkillCatalogDeps {
  bots(): readonly CatalogBot[];
  patchAssigned(botId: string, assignedSkills: string[]): void;
  builtIns(): readonly BundledSkill[];
  /** Skills an organization offers that no bot has yet. */
  offered?(): ReadonlyArray<{ installId: string; name: string; description: string }>;
  addOffered?(botId: string, installId: string, name: string): { ok: true } | { error: string };
  root?: string;
}

export type CatalogResult = { ok: true } | { error: string; status: number; code?: "stays" };

const NOT_FOUND: CatalogResult = { error: "no such skill", status: 404 };

type BuiltInAccess = Record<string, { who: "bots" | "off"; bots?: string[] }>;

const builtInAccessPath = (root: string) => join(root, "built-in-access.json");

function readBuiltInAccess(root: string): BuiltInAccess {
  try {
    const parsed = JSON.parse(readFileSync(builtInAccessPath(root), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const access: BuiltInAccess = {};
    for (const [id, value] of Object.entries(parsed as Record<string, { who?: unknown; bots?: unknown }>)) {
      if (value?.who !== "bots" && value?.who !== "off") continue;
      const bots = Array.isArray(value.bots) ? value.bots.filter((bot): bot is string => typeof bot === "string") : [];
      access[id] = value.who === "bots" ? { who: "bots", bots } : { who: "off" };
    }
    return access;
  } catch {
    return {};
  }
}

/** A built-in skill reaches a bot's turn only while the Skills page lets that bot use it. */
export function builtInSkillsFor<T extends { manifest: { id: string } }>(botId: string, skills: readonly T[], root: string = skillsLibraryRoot()): T[] {
  const access = readBuiltInAccess(root);
  return skills.filter((skill) => {
    const rule = access[skill.manifest.id];
    return !rule || (rule.who === "bots" && rule.bots?.includes(botId) === true);
  });
}

const libraryId = (name: string) => `library:${name}`;

/** Each bot's own copies of skills the library does not hold, by name. */
function keptSkills(bots: readonly CatalogBot[]): Map<string, Array<{ botId: string; skill: SkillListing }>> {
  const kept = new Map<string, Array<{ botId: string; skill: SkillListing }>>();
  for (const bot of bots) {
    for (const skill of listSkills(bot.id)) kept.set(skill.name, [...(kept.get(skill.name) ?? []), { botId: bot.id, skill }]);
  }
  return kept;
}

function libraryRows(deps: SkillCatalogDeps, root: string): SkillWire[] {
  const bots = deps.bots();
  return listLibrarySkills(root).map((skill): SkillWire => {
    const users = !skill.enabled ? [] : skill.everyBot ? bots.map((bot) => bot.id) : bots.filter((bot) => bot.assignedSkills?.includes(skill.name)).map((bot) => bot.id);
    const who: SkillWho = !skill.enabled ? "off" : skill.everyBot ? "all" : users.length ? "bots" : "off";
    const flag = who === "off" ? skillFlag(skill.warnings) : undefined;
    return {
      id: libraryId(skill.name), name: skill.name, description: skill.description, from: skillFrom(skill.source, skill.learnedBy),
      who, bots: users, ...(flag ? { flag } : {}), removable: true,
    };
  });
}

function toolRows(deps: SkillCatalogDeps): SkillWire[] {
  const botIds = deps.bots().map((bot) => bot.id);
  return Object.entries(readImportedSkills()).sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]): SkillWire => {
    const users = importedSkillUsers(name, botIds);
    const who: SkillWho = users.length === 0 ? "off" : !entry.access && users.length === botIds.length ? "all" : "bots";
    const flag = !importedSkillIntact(name, entry) ? "changed" : who === "off" ? skillFlag(entry.warnings) : undefined;
    return { id: `tool:${name}`, name, description: entry.description, from: { kind: "tool", tool: entry.source }, who, bots: users, ...(flag ? { flag } : {}), removable: true };
  });
}

function builtInRows(deps: SkillCatalogDeps, root: string): SkillWire[] {
  const access = readBuiltInAccess(root);
  const botIds = deps.bots().map((bot) => bot.id);
  return deps.builtIns().map(({ manifest }): SkillWire => {
    const rule = access[manifest.id];
    const users = !rule ? botIds : rule.who === "bots" ? botIds.filter((id) => rule.bots?.includes(id)) : [];
    const who: SkillWho = !rule ? "all" : users.length ? "bots" : "off";
    return { id: `builtin:${manifest.id}`, name: manifest.id, description: manifest.description, from: { kind: "builtin" }, who, bots: users, removable: false };
  });
}

function keptRows(deps: SkillCatalogDeps): SkillWire[] {
  const offered = new Set(deps.offered?.().map((skill) => skill.name) ?? []);
  return [...keptSkills(deps.bots())].map(([name, copies]): SkillWire => {
    const users = copies.filter((copy) => copy.skill.enabled).map((copy) => copy.botId);
    const first = copies[0]!.skill;
    const flag = users.length ? undefined : skillFlag(first.warnings);
    return {
      id: `bot:${name}`, name, description: first.description, from: skillFrom(first.source, copies[0]!.botId),
      who: users.length ? "bots" : "off", bots: users,
      ...(first.source.startsWith("org:") && offered.has(name) ? {} : { only: copies.map((copy) => copy.botId) }),
      ...(flag ? { flag } : {}), removable: true,
    };
  });
}

function offeredRows(deps: SkillCatalogDeps): SkillWire[] {
  const kept = keptSkills(deps.bots());
  return (deps.offered?.() ?? []).filter((skill) => !kept.has(skill.name)).map((skill): SkillWire => ({
    id: `team:${skill.installId}:${skill.name}`, name: skill.name, description: skill.description, from: { kind: "team" }, who: "off", bots: [], removable: false,
  }));
}

export function listSkillCatalog(deps: SkillCatalogDeps): SkillWire[] {
  const root = deps.root ?? skillsLibraryRoot();
  const rows = [...libraryRows(deps, root), ...toolRows(deps), ...builtInRows(deps, root), ...keptRows(deps), ...offeredRows(deps)];
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function setAssignments(deps: SkillCatalogDeps, name: string, chosen: readonly string[]): void {
  for (const bot of deps.bots()) {
    const has = bot.assignedSkills?.includes(name) === true;
    const wants = chosen.includes(bot.id);
    if (has === wants) continue;
    deps.patchAssigned(bot.id, wants ? [...new Set([...(bot.assignedSkills ?? []), name])].sort() : (bot.assignedSkills ?? []).filter((other) => other !== name));
  }
}

function setLibraryAccess(deps: SkillCatalogDeps, name: string, who: SkillWho, chosen: readonly string[], root: string): CatalogResult {
  const set = setLibrarySkillAccess(name, { everyBot: who === "all", on: who !== "off" }, root);
  if ("error" in set) return { error: set.error, status: 409 };
  setAssignments(deps, name, who === "bots" ? chosen : []);
  return { ok: true };
}

/** Moves one bot's skill into the library, so more bots can use it. A skill the library cannot hold stays. */
function moveIntoLibrary(name: string, holders: readonly string[], root: string): CatalogResult {
  for (const botId of holders) migrateBotSkillsToLibrary(botId, root, name);
  // Who may use it is set next; a pending assignment replayed at the next start would undo that choice.
  const pending = readPendingAssignments(root);
  const holding = Object.keys(pending).filter((botId) => pending[botId]!.includes(name));
  for (const botId of holding) {
    const rest = pending[botId]!.filter((other) => other !== name);
    if (rest.length) pending[botId] = rest;
    else delete pending[botId];
  }
  if (holding.length) writePendingAssignments(pending, root);
  return readSkillLibraryIndex(root)[name] ? { ok: true } : { error: "this skill has to stay with its bot", status: 409, code: "stays" };
}

function setKeptAccess(deps: SkillCatalogDeps, row: SkillWire, who: SkillWho, chosen: readonly string[], root: string): CatalogResult {
  const holders = keptSkills(deps.bots()).get(row.name)?.map((copy) => copy.botId) ?? [];
  const targets = who === "off" ? [] : who === "all" ? deps.bots().map((bot) => bot.id) : chosen;
  const offer = row.only ? undefined : deps.offered?.().find((skill) => skill.name === row.name);
  if (targets.some((botId) => !holders.includes(botId)) && !offer) {
    const moved = moveIntoLibrary(row.name, holders, root);
    return "error" in moved ? moved : setLibraryAccess(deps, row.name, who, chosen, root);
  }
  for (const botId of targets.filter((id) => !holders.includes(id))) {
    const added = deps.addOffered?.(botId, offer!.installId, row.name) ?? { error: "this skill is no longer offered" };
    if ("error" in added) return { error: added.error, status: 409 };
  }
  for (const botId of holders) {
    const set = setSkillEnabled(botId, row.name, targets.includes(botId));
    if ("error" in set) return { error: set.error, status: 409 };
  }
  return { ok: true };
}

function writeBuiltInAccess(root: string, id: string, who: SkillWho, chosen: readonly string[]): void {
  const access = readBuiltInAccess(root);
  if (who === "all") delete access[id];
  else access[id] = who === "bots" ? { who, bots: [...chosen] } : { who };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileAtomic(builtInAccessPath(root), `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
}

/** "bots" with nobody chosen is Off. */
export function setSkillAccess(deps: SkillCatalogDeps, id: string, who: SkillWho, chosen: readonly string[] = []): CatalogResult {
  const root = deps.root ?? skillsLibraryRoot();
  const row = listSkillCatalog(deps).find((candidate) => candidate.id === id);
  if (!row) return NOT_FOUND;
  const botIds = new Set(deps.bots().map((bot) => bot.id));
  const picked = [...new Set(chosen)].filter((botId) => botIds.has(botId));
  const effective: SkillWho = who === "bots" && picked.length === 0 ? "off" : who;
  if (id.startsWith("library:")) return setLibraryAccess(deps, row.name, effective, picked, root);
  if (id.startsWith("tool:")) {
    const set = setImportedSkillAccess(row.name, effective, picked, [...botIds]);
    return "error" in set ? { error: set.error, status: 409 } : { ok: true };
  }
  if (id.startsWith("builtin:")) {
    writeBuiltInAccess(root, row.name, effective, picked);
    return { ok: true };
  }
  return setKeptAccess(deps, row, effective, picked, root);
}

/** One bot's switch, said as who may use the skill: switching off a skill every bot has leaves it with the others. */
export function setBotSkill(deps: SkillCatalogDeps, botId: string, id: string, on: boolean): CatalogResult {
  const row = listSkillCatalog(deps).find((candidate) => candidate.id === id);
  if (!row) return NOT_FOUND;
  if (row.bots.includes(botId) === on) return { ok: true };
  return setSkillAccess(deps, id, "bots", on ? [...row.bots, botId] : row.bots.filter((other) => other !== botId));
}

export function removeCatalogSkill(deps: SkillCatalogDeps, id: string): CatalogResult {
  const root = deps.root ?? skillsLibraryRoot();
  const row = listSkillCatalog(deps).find((candidate) => candidate.id === id);
  if (!row?.removable) return NOT_FOUND;
  if (id.startsWith("library:")) {
    const sha256 = readSkillLibraryIndex(root)[row.name]?.sha256;
    const retired = sha256 ? retireLibrarySkill(row.name, sha256, root) : { stale: true as const };
    if (!("retired" in retired)) return { error: "error" in retired ? retired.error : "this skill changed — try again", status: 409 };
    setAssignments(deps, row.name, []);
    return { ok: true };
  }
  if (id.startsWith("tool:")) {
    const removed = removeImportedSkill(row.name);
    return "error" in removed ? { error: removed.error, status: 409 } : { ok: true };
  }
  for (const botId of keptSkills(deps.bots()).get(row.name)?.map((copy) => copy.botId) ?? []) {
    const removed = removeSkill(botId, row.name);
    if ("error" in removed) return { error: removed.error, status: 409 };
  }
  return { ok: true };
}

function filesBeside(directory: string, skip: readonly string[]): string[] {
  const files: string[] = [];
  const walk = (folder: string, prefix: string, depth: number) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(folder, entry.name), path, depth + 1);
      else if (entry.isFile() && !skip.includes(path)) files.push(path);
    }
  };
  if (existsSync(directory)) walk(directory, "", 0);
  return files;
}

const instructionsOf = (text: string | null) => (text === null ? null : (readSkillFrontmatter(text)?.body ?? text).trim());

export function readCatalogSkill(deps: SkillCatalogDeps, id: string): SkillDetailWire | null {
  const root = deps.root ?? skillsLibraryRoot();
  const row = listSkillCatalog(deps).find((candidate) => candidate.id === id);
  if (!row) return null;
  if (id.startsWith("library:")) {
    const text = instructionsOf(readLibrarySkillFile(row.name, root));
    return text === null ? null : { instructions: text, files: [...readSkillLibraryIndex(root)[row.name]?.files ?? []].sort() };
  }
  if (id.startsWith("tool:")) {
    const text = instructionsOf(readImportedSkillFile(row.name));
    return text === null ? null : { instructions: text, files: importedSkillFiles(row.name) };
  }
  if (id.startsWith("builtin:")) {
    const skill = deps.builtIns().find((candidate) => candidate.manifest.id === row.name);
    return skill ? { instructions: instructionsOf(skill.instructions) ?? "", files: filesBeside(skill.directory, ["SKILL.md", "manifest.json"]) } : null;
  }
  if (id.startsWith("team:")) return { instructions: "", files: [] };
  const holder = keptSkills(deps.bots()).get(row.name)?.[0]?.botId;
  const text = holder ? instructionsOf(readSkillFile(holder, row.name)) : null;
  return holder && text !== null ? { instructions: text, files: (readSkillReferences(holder, row.name) ?? []).map((file) => file.path) } : null;
}

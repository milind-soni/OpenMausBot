import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, renameSync } from "node:fs";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";
import { isSkillName, parseSkillMd, SKILL_FILE_MAX_BYTES } from "../shared/skill-md.ts";
import type { SkillPackageStamp } from "./skills.ts";

export function skillsLibraryEnabled(cfg: AppConfig): boolean {
  return cfg.features?.skillsLibrary === true;
}

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  defaultEnabled: boolean;
  triggerTerms: string[];
  requiredCapabilities: string[];
}

export interface BundledSkill {
  manifest: SkillManifest;
  instructions: string;
  directory: string;
}

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())
    ? value.map((item) => item.trim())
    : null;
}

export function parseSkillManifest(value: unknown, directory: string): SkillManifest {
  if (!value || typeof value !== "object") throw new Error(`${directory}/manifest.json is invalid`);
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const triggerTerms = strings(raw.triggerTerms);
  const requiredCapabilities = strings(raw.requiredCapabilities);
  if (!SAFE_ID.test(id) || id !== basename(directory)) throw new Error(`${directory}/manifest.json has an invalid id`);
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error(`${directory}/manifest.json has no name`);
  if (typeof raw.version !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.version)) throw new Error(`${directory}/manifest.json has an invalid version`);
  if (typeof raw.description !== "string" || !raw.description.trim()) throw new Error(`${directory}/manifest.json has no description`);
  if (typeof raw.defaultEnabled !== "boolean") throw new Error(`${directory}/manifest.json has no defaultEnabled flag`);
  if (!triggerTerms?.length) throw new Error(`${directory}/manifest.json has no trigger terms`);
  if (!requiredCapabilities) throw new Error(`${directory}/manifest.json has invalid capabilities`);
  return {
    id,
    name: raw.name.trim(),
    version: raw.version,
    description: raw.description.trim(),
    defaultEnabled: raw.defaultEnabled,
    triggerTerms,
    requiredCapabilities,
  };
}

function loadSkillDirectory(directory: string): BundledSkill | null {
  const manifestPath = join(directory, "manifest.json");
  const skillPath = join(directory, "SKILL.md");
  if (!existsSync(manifestPath) || !existsSync(skillPath)) return null;
  const manifest = parseSkillManifest(JSON.parse(readFileSync(manifestPath, "utf8")), directory);
  const instructions = readFileSync(skillPath, "utf8").trim();
  if (!instructions.startsWith("---")) throw new Error(`${skillPath} has no skill frontmatter`);
  return { manifest, instructions, directory };
}

export function loadBundledSkills(root = process.env.OMB_SKILLS_DIR || join(process.cwd(), "skills")): BundledSkill[] {
  if (!existsSync(root)) return [];
  const skills: BundledSkill[] = [];
  for (const name of readdirSync(root).sort()) {
    const directory = join(root, name);
    const skill = loadSkillDirectory(directory);
    if (skill) skills.push(skill);
  }
  return skills;
}

export function loadUserSkills(root: string): BundledSkill[] {
  if (!existsSync(root)) return [];
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  const skills: BundledSkill[] = [];
  for (const name of names) {
    try {
      const skill = loadSkillDirectory(join(root, name));
      if (skill) skills.push(skill);
    } catch {
    }
  }
  return skills;
}

export function mergeSkills(bundled: readonly BundledSkill[], user: readonly BundledSkill[]): BundledSkill[] {
  const byId = new Map(bundled.map((skill) => [skill.manifest.id, skill]));
  for (const skill of user) {
    if (!byId.has(skill.manifest.id)) byId.set(skill.manifest.id, skill);
  }
  return [...byId.values()];
}

export function selectBundledSkills(
  text: string,
  capabilities: Iterable<string>,
  skills: readonly BundledSkill[],
): BundledSkill[] {
  const haystack = text.toLowerCase();
  const available = new Set(capabilities);
  return skills.filter(({ manifest }) =>
    manifest.defaultEnabled &&
    manifest.requiredCapabilities.every((capability) => available.has(capability)) &&
    manifest.triggerTerms.some((term) => haystack.includes(term.toLowerCase())),
  );
}

export function renderSkillInstructions(
  selected: readonly BundledSkill[],
  { includeRoot = false }: { includeRoot?: boolean } = {},
): string {
  if (!selected.length) return "";
  return selected.map(({ manifest, instructions, directory }) =>
    `\n\n<openmaus-skill id=${JSON.stringify(manifest.id)} version=${JSON.stringify(manifest.version)}${includeRoot ? ` root=${JSON.stringify(directory)}` : ""}>\n${instructions}\n</openmaus-skill>`,
  ).join("");
}

export type LibraryReviewState = "approved" | "disabled";

export interface SkillLibraryEntry {
  name: string;
  description: string;
  source: string;
  sha256: string;
  importedAt: string;
  reviewState: LibraryReviewState;
  /** Available to every existing and future bot, unless a private skill shadows it. */
  everyBot?: boolean;
  license?: string;
  compatibility?: string;
  tags?: string[];
  warnings: string[];
  skippedFiles: string[];
  package?: SkillPackageStamp;
  /** Replaced descriptions, oldest first, with when each was replaced, so a running conversation keeps its prompt. */
  descriptionHistory?: Array<{ description: string; until: number }>;
}

/** Pruned by age, never by count: providers keep a prompt cache an hour at most. */
export const DESCRIPTION_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

export function libraryDescriptionsAt(startedAt: number | undefined, root: string = skillsLibraryRoot()): (name: string, current: string) => string {
  if (startedAt === undefined) return (_name, current) => current;
  const index = readSkillLibraryIndex(root);
  return (name, current) => index[name]?.descriptionHistory?.find((change) => change.until > startedAt)?.description ?? current;
}

export interface LibrarySkillListing {
  name: string;
  description: string;
  enabled: boolean;
  everyBot: boolean;
  editable: false;
  source: string;
  sha256: string;
  importedAt: string;
  license?: string;
  compatibility?: string;
  tags: string[];
  warnings: string[];
  skippedFiles: string[];
}

const skillLibraryEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  importedAt: z.string(),
  reviewState: z.enum(["approved", "disabled"]),
  everyBot: z.boolean().optional(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/)).max(8).optional(),
  warnings: z.array(z.string()),
  skippedFiles: z.array(z.string()),
  package: z.object({
    installId: z.string().regex(/^[a-f0-9]{32}$/),
    key: z.string().min(1).max(64),
    release: z.string().min(1).max(40),
    r: z.string().regex(/^[a-f0-9]{64}$/),
    w: z.string().regex(/^[a-f0-9]{64}$/),
    via: z.literal("preset").optional(),
  }).optional(),
  descriptionHistory: z.array(z.object({ description: z.string(), until: z.number() })).optional(),
});
const skillLibraryIndexSchema = z.record(z.string(), skillLibraryEntrySchema);

export const skillLibraryEvents = new EventEmitter();

export function skillsLibraryRoot(dataDir: string = DATA_DIR): string {
  return join(dataDir, "skills-library");
}

function libraryIndexPath(root: string): string {
  return join(root, "index.json");
}

export function librarySkillDirectory(root: string, name: string): string {
  return join(root, "skills", name);
}

export function librarySkillFilePath(name: string, root: string = skillsLibraryRoot()): string {
  return join(root, "skills", name, "SKILL.md");
}

export function libraryArchiveDirectory(root: string, botId: string, name: string): string {
  return join(root, "archive", botId, name);
}

type SkillLibraryIndexRead =
  | { index: Record<string, SkillLibraryEntry> }
  | { error: string };

/** A missing index is an empty library; an unreadable one is not, and writers must refuse rather than replace it. */
function readSkillLibraryIndexState(root: string): SkillLibraryIndexRead {
  try {
    const parsed: unknown = JSON.parse(readFileSync(libraryIndexPath(root), "utf8"));
    const result = skillLibraryIndexSchema.safeParse(parsed);
    return result.success
      ? { index: result.data }
      : { error: "the skills library index is invalid" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { index: {} };
    return { error: "the skills library index could not be read" };
  }
}

export function readSkillLibraryIndex(root: string = skillsLibraryRoot()): Record<string, SkillLibraryEntry> {
  const result = readSkillLibraryIndexState(root);
  return "error" in result ? {} : result.index;
}

function writeSkillLibraryIndex(root: string, index: Record<string, SkillLibraryEntry>): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileAtomic(libraryIndexPath(root), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function libraryContentMatches(root: string, entry: SkillLibraryEntry): boolean {
  try {
    const file = join(librarySkillDirectory(root, entry.name), "SKILL.md");
    if (!existsSync(file)) return false;
    return sha256Hex(readFileSync(file, "utf8")) === entry.sha256;
  } catch {
    return false;
  }
}

function librarySkillListing(root: string, entry: SkillLibraryEntry): LibrarySkillListing {
  const intact = libraryContentMatches(root, entry);
  return {
    name: entry.name,
    description: entry.description,
    enabled: entry.reviewState === "approved" && intact,
    everyBot: entry.everyBot === true,
    editable: false,
    source: entry.source,
    sha256: entry.sha256,
    importedAt: entry.importedAt,
    ...(entry.license ? { license: entry.license } : {}),
    ...(entry.compatibility ? { compatibility: entry.compatibility } : {}),
    tags: entry.tags ?? [],
    warnings: intact
      ? entry.warnings
      : [...entry.warnings, "stored SKILL.md changed after review — enablement is blocked"],
    skippedFiles: entry.skippedFiles,
  };
}

export function setLibrarySkillEveryBot(
  name: string,
  everyBot: boolean,
  root: string = skillsLibraryRoot(),
): LibrarySkillListing | { error: string } {
  if (!isSkillName(name)) return { error: "invalid skill name" };
  const indexRead = readSkillLibraryIndexState(root);
  if ("error" in indexRead) return indexRead;
  const entry = indexRead.index[name];
  if (!entry) return { error: `no library skill named "${name}"` };
  if (everyBot) entry.everyBot = true;
  else delete entry.everyBot;
  writeSkillLibraryIndex(root, indexRead.index);
  skillLibraryEvents.emit("invalidate", { kind: "every-bot", name });
  return librarySkillListing(root, entry);
}

export function listLibrarySkills(root: string = skillsLibraryRoot()): LibrarySkillListing[] {
  return Object.values(readSkillLibraryIndex(root))
    .map((entry) => librarySkillListing(root, entry))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function installLibrarySkill(input: {
  name: string;
  description?: string;
  instructions: string;
  source: string;
  license?: string;
  compatibility?: string;
  tags?: string[];
  warnings?: string[];
  reviewState?: LibraryReviewState;
  package?: SkillPackageStamp;
  root?: string;
}): LibrarySkillListing | { error: string } {
  const root = input.root ?? skillsLibraryRoot();
  if (!isSkillName(input.name)) return { error: "invalid skill name" };
  if (Buffer.byteLength(input.instructions, "utf8") > SKILL_FILE_MAX_BYTES) {
    return { error: `SKILL.md is larger than ${SKILL_FILE_MAX_BYTES / 1024}KB` };
  }
  const parsed = parseSkillMd(input.instructions);
  if ("error" in parsed) return parsed;
  if (parsed.name !== input.name) return { error: `the skill is named "${parsed.name}", not "${input.name}"` };
  const sha256 = sha256Hex(input.instructions);
  const indexRead = readSkillLibraryIndexState(root);
  if ("error" in indexRead) return indexRead;
  const index = indexRead.index;
  const existing = index[input.name];
  if (existing) {
    if (existing.sha256 === sha256) return librarySkillListing(root, existing);
    return { error: `a skill named "${input.name}" is already in the library — choose a different name` };
  }
  const tags = input.tags?.length ? input.tags : parsed.tags;
  const entry: SkillLibraryEntry = {
    name: input.name,
    description: input.description?.trim() || parsed.description,
    source: input.source,
    sha256,
    importedAt: new Date().toISOString(),
    reviewState: input.reviewState ?? "disabled",
    ...(input.license ? { license: input.license } : {}),
    ...(input.compatibility ? { compatibility: input.compatibility } : {}),
    ...(tags?.length ? { tags } : {}),
    warnings: input.warnings ?? [],
    skippedFiles: [],
    ...(input.package ? { package: { ...input.package } } : {}),
  };
  // Bytes first, index second: the index is the commit point, so a crash leaves unreferenced bytes, never a dangling entry.
  mkdirSync(librarySkillDirectory(root, input.name), { recursive: true, mode: 0o700 });
  writeFileAtomic(join(librarySkillDirectory(root, input.name), "SKILL.md"), input.instructions, { mode: 0o600 });
  index[input.name] = entry;
  writeSkillLibraryIndex(root, index);
  skillLibraryEvents.emit("invalidate", { kind: "install", name: input.name });
  return librarySkillListing(root, entry);
}

export function readLibrarySkillFile(name: string, root: string = skillsLibraryRoot()): string | null {
  if (!isSkillName(name)) return null;
  const entry = readSkillLibraryIndex(root)[name];
  if (!entry) return null;
  try {
    const text = readFileSync(join(librarySkillDirectory(root, name), "SKILL.md"), "utf8");
    return sha256Hex(text) === entry.sha256 ? text : null;
  } catch {
    return null;
  }
}

export function setLibrarySkillReviewState(
  name: string,
  reviewState: LibraryReviewState,
  root: string = skillsLibraryRoot(),
): LibrarySkillListing | { error: string } {
  if (!isSkillName(name)) return { error: "invalid skill name" };
  const index = readSkillLibraryIndex(root);
  const entry = index[name];
  if (!entry) return { error: `no library skill named "${name}"` };
  if (reviewState === "approved" && !libraryContentMatches(root, entry)) {
    return { error: "stored SKILL.md changed after review — the library entry cannot be approved" };
  }
  entry.reviewState = reviewState;
  writeSkillLibraryIndex(root, index);
  skillLibraryEvents.emit("invalidate", { kind: "review-state", name });
  return librarySkillListing(root, entry);
}

/** Applied only while the stored bytes still match `expectSha256`; otherwise `stale` and nothing changes. */
export function updateLibrarySkill(input: {
  name: string;
  instructions: string;
  expectSha256: string;
  source?: string;
  root?: string;
}): LibrarySkillListing | { stale: true } | { error: string } {
  const root = input.root ?? skillsLibraryRoot();
  if (!isSkillName(input.name)) return { error: "invalid skill name" };
  if (Buffer.byteLength(input.instructions, "utf8") > SKILL_FILE_MAX_BYTES) {
    return { error: `SKILL.md is larger than ${SKILL_FILE_MAX_BYTES / 1024}KB` };
  }
  const parsed = parseSkillMd(input.instructions);
  if ("error" in parsed) return parsed;
  if (parsed.name !== input.name) return { error: `the skill is named "${parsed.name}", not "${input.name}"` };
  const indexRead = readSkillLibraryIndexState(root);
  if ("error" in indexRead) return indexRead;
  const index = indexRead.index;
  const entry = index[input.name];
  if (!entry || entry.sha256 !== input.expectSha256 || !libraryContentMatches(root, entry)) return { stale: true };
  const sha256 = sha256Hex(input.instructions);
  const now = Date.now();
  const descriptionHistory = parsed.description === entry.description
    ? entry.descriptionHistory
    : [...(entry.descriptionHistory ?? []), { description: entry.description, until: now }];
  const keptHistory = descriptionHistory?.filter((change) => now - change.until < DESCRIPTION_HISTORY_MS);
  const next: SkillLibraryEntry = {
    ...entry,
    description: parsed.description,
    sha256,
    importedAt: new Date(now).toISOString(),
    ...(keptHistory?.length ? { descriptionHistory: keptHistory } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(parsed.tags?.length ? { tags: parsed.tags } : {}),
  };
  if (!parsed.tags?.length) delete next.tags;
  if (!keptHistory?.length) delete next.descriptionHistory;
  // Bytes, then index: a crash between leaves the entry reading "changed after review", never silently enabled.
  writeFileAtomic(join(librarySkillDirectory(root, input.name), "SKILL.md"), input.instructions, { mode: 0o600 });
  index[input.name] = next;
  writeSkillLibraryIndex(root, index);
  skillLibraryEvents.emit("invalidate", { kind: "update", name: input.name });
  return librarySkillListing(root, next);
}

/** Bytes move to the write-once archive before the index entry goes; they are never deleted. */
export function retireLibrarySkill(
  name: string,
  expectSha256: string,
  root: string = skillsLibraryRoot(),
): { retired: true } | { stale: true } | { error: string } {
  if (!isSkillName(name)) return { error: "invalid skill name" };
  const indexRead = readSkillLibraryIndexState(root);
  if ("error" in indexRead) return indexRead;
  const index = indexRead.index;
  const entry = index[name];
  if (!entry || entry.sha256 !== expectSha256 || !libraryContentMatches(root, entry)) return { stale: true };
  const directory = librarySkillDirectory(root, name);
  const base = join(root, "archive", "retired", `${name}.${expectSha256}`);
  let destination = base;
  try {
    mkdirSync(join(root, "archive", "retired"), { recursive: true, mode: 0o700 });
    let suffix = 1;
    while (existsSync(destination)) destination = `${base}.${suffix++}`;
    renameSync(directory, destination);
  } catch (error) {
    return { error: `could not archive the library copy: ${error instanceof Error ? error.message : String(error)}` };
  }
  delete index[name];
  try {
    writeSkillLibraryIndex(root, index);
  } catch (error) {
    try {
      renameSync(destination, directory);
    } catch {
      // The index still lists the skill, which reads "changed after review" until restored from the archive.
    }
    return { error: `could not update the skills library index: ${error instanceof Error ? error.message : String(error)}` };
  }
  skillLibraryEvents.emit("invalidate", { kind: "remove", name });
  return { retired: true };
}

// Skill install and the staged review flow — fetched imports land
// disabled; agent-authored writes sit in protected staged.json until a
// person confirms the in-app card, and apply promotes the exact
// reviewed bytes.

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { redactSecretsInText } from "../redact.ts";
import { LEARN_SOURCE_PREFIX } from "../skill-learn.ts";
import { isSkillName, parseSkillMd, scanSkillText, SKILL_FILE_MAX_BYTES } from "./text.ts";
import type { ParsedSkill } from "./text.ts";
import {
  directoryEntryState,
  ensureSkillsRoot,
  entryExistsWithoutFollowing,
  existingSkillsRoot,
  learnedSkillDirectoryMatches,
  readManifest,
  skillContentMatches,
  skillDirectory,
  skillStateDir,
  syncSkillLinks,
  writeManifest,
} from "./manifest.ts";
import type { SkillManifestEntry } from "./manifest.ts";
import { removeReviewedRevision, retireReviewedSkillStorage, skillListing } from "./store.ts";
import type { SkillListing } from "./store.ts";

/** Agent-authored writes sit here until a person confirms the in-app card. */
export const MAX_STAGED_SKILLS = 20;
export const STAGED_GIST_MAX = 240;
/** Learned skills are duplicated onto their durable review card. Keep that
 * exact review payload bounded while leaving fetched skill imports unchanged. */
export const STAGED_SKILL_FILE_MAX_BYTES = 32 * 1024;

export type StagedSkillAction = "create" | "update";

export interface StagedSkillWrite {
  id: string;
  action: StagedSkillAction;
  name: string;
  gist: string;
  source: string;
  files: Array<{ path: string; content: string }>;
  sha256: string;
  warnings: string[];
  skippedFiles: string[];
  createdAt: string;
  /** Hash of the installed SKILL.md the reviewer is replacing. Updates fail
   * closed if the live skill changes after the proposal was staged. */
  baseSha256?: string;
  /** UUID of the exact previously approved revision. Unlike timestamps, this
   * cannot collide if a skill is removed and recreated with identical bytes. */
  baseAppliedStageId?: string;
}

interface StagedStore {
  writes: Record<string, StagedSkillWrite>;
}

const stagedSkillWriteSchema = z.object({
  id: z.string(),
  action: z.enum(["create", "update"]),
  name: z.string().refine(isSkillName),
  gist: z.string(),
  source: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  warnings: z.array(z.string()),
  skippedFiles: z.array(z.string()),
  createdAt: z.string(),
  baseSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  baseAppliedStageId: z.string().optional(),
}).superRefine((entry, ctx) => {
  if (entry.action === "update" && (!entry.baseSha256 || !entry.baseAppliedStageId)) {
    ctx.addIssue({ code: "custom", message: "updated skills require their reviewed base revision" });
  }
});
const stagedStoreSchema = z.object({ writes: z.record(z.string(), stagedSkillWriteSchema) });

function stagedPath(botId: string): string {
  return join(skillStateDir(botId), "staged.json");
}

function readStaged(botId: string): StagedStore {
  const securePath = stagedPath(botId);
  // As with the manifest, protected state is authoritative once present.
  if (existsSync(securePath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(securePath, "utf8"));
      const result = stagedStoreSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // Corrupt protected state fails closed; never consult workspace state.
    }
    return { writes: {} };
  }

  const legacyRoot = existingSkillsRoot(botId);
  if (!legacyRoot) return { writes: {} };
  const legacyPath = join(legacyRoot, "staged.json");
  if (!existsSync(legacyPath)) return { writes: {} };
  // Legacy stages were agent-writable and have no trustworthy review-card
  // binding. Discard them rather than turning old workspace data into a live
  // proposal in the protected store.
  const empty: StagedStore = { writes: {} };
  writeStaged(botId, empty);
  try {
    rmSync(legacyPath, { force: true });
  } catch {
    // The protected empty store is now authoritative.
  }
  return empty;
}

function writeStaged(botId: string, store: StagedStore): void {
  mkdirSync(skillStateDir(botId), { recursive: true, mode: 0o700 });
  writeFileAtomic(stagedPath(botId), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

interface PreparedSkillFiles {
  files: Array<{ path: string; content: string }>;
  parsed: ParsedSkill;
  warnings: string[];
  skippedFiles: string[];
}

function preparedSkillFiles(
  files: Array<{ path: string; content: string }>,
): PreparedSkillFiles | { error: string } {
  const skillMd = files.find((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"));
  if (!skillMd) return { error: "no SKILL.md found at that location" };
  if (Buffer.byteLength(skillMd.content, "utf8") > SKILL_FILE_MAX_BYTES) {
    return { error: `SKILL.md is larger than ${SKILL_FILE_MAX_BYTES / 1024}KB` };
  }
  const parsed = parseSkillMd(skillMd.content);
  if ("error" in parsed) return parsed;
  const prefix = skillMd.path.slice(0, skillMd.path.length - "SKILL.md".length);
  const skippedFiles = [
    ...new Set(
      files
        .filter((file) => file !== skillMd)
        .map((file) => {
          const relative = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path;
          return relative || file.path;
        }),
    ),
  ];
  const warnings = [
    ...scanSkillText(skillMd.content),
    ...skippedFiles.map((path) => `skipped supporting file "${path}" — v1 imports only SKILL.md`),
  ];
  return { files: [{ path: "SKILL.md", content: skillMd.content }], parsed, warnings, skippedFiles };
}

function preparedLearnedSkill(
  files: Array<{ path: string; content: string }>,
): PreparedSkillFiles | { error: string } {
  if (files.length !== 1 || files[0]?.path !== "SKILL.md") {
    return { error: "learned skills must contain exactly one SKILL.md" };
  }
  return preparedSkillFiles(files);
}

/** Install a fetched skill, DISABLED. The caller has already fetched the
 * files; this validates and scans SKILL.md, records every skipped supporting
 * file, writes only the reviewed bytes, and records provenance. Returns the
 * listing (with warnings) for the review screen. */
export function installSkill(
  botId: string,
  source: string,
  files: Array<{ path: string; content: string }>,
): SkillListing | { error: string } {
  const prepared = preparedSkillFiles(files);
  if ("error" in prepared) return prepared;
  return installPreparedSkill(botId, source, prepared, { enabled: false });
}

function installedLearnedSkillMatches(
  botId: string,
  name: string,
  entry: SkillManifestEntry,
): boolean {
  const directory = skillDirectory(botId, name, entry);
  return directory ? learnedSkillDirectoryMatches(directory, entry.sha256) : false;
}

function directoryIdentity(path: string): { dev: number; ino: number } | null {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? { dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

function sameDirectoryIdentity(path: string, expected: { dev: number; ino: number }): boolean {
  const current = directoryIdentity(path);
  return current?.dev === expected.dev && current.ino === expected.ino;
}

/** Publish reviewed bytes once under a stage-derived immutable directory.
 * The protected manifest selects the live revision in a separate atomic
 * write, so a crash leaves either the old version active or the new version
 * active—never a half-replaced skill. */
function publishReviewedRevision(
  botId: string,
  stageId: string,
  skillMd: string,
  sha256: string,
): string {
  // Finish the only file in protected app state. No agent-writable path is
  // opened until the complete directory is published as one rename.
  const state = skillStateDir(botId);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  if (directoryEntryState(state) !== "directory") {
    throw new Error("the protected skill state path is not a real directory");
  }
  const preparedRoot = join(state, "reviewed-revisions");
  const preparedRootState = directoryEntryState(preparedRoot);
  if (preparedRootState === "unsafe") {
    throw new Error("the protected revision path is not a real directory");
  }
  if (preparedRootState === "missing") mkdirSync(preparedRoot, { mode: 0o700 });
  const revision = createHash("sha256").update(stageId).digest("hex");
  const prepared = join(preparedRoot, revision);
  if (!learnedSkillDirectoryMatches(prepared, sha256)) {
    if (entryExistsWithoutFollowing(prepared)) {
      if (directoryEntryState(prepared) !== "directory") {
        throw new Error("the protected reviewed revision is not a real directory");
      }
      rmSync(prepared, { recursive: true, force: true });
    }
    const temporary = join(preparedRoot, `.prepare-${revision}-${randomUUID()}`);
    try {
      mkdirSync(temporary, { mode: 0o700 });
      writeFileAtomic(join(temporary, "SKILL.md"), skillMd, { mode: 0o600 });
      if (!learnedSkillDirectoryMatches(temporary, sha256)) {
        throw new Error("the protected reviewed bytes do not match the approval card");
      }
      renameSync(temporary, prepared);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  const root = ensureSkillsRoot(botId);
  if (!root) throw new Error("the workspace skills path must be a real directory, not a symlink or file");
  const rootIdentity = directoryIdentity(root);
  if (!rootIdentity) throw new Error("the workspace skills path changed during update");
  const revisions = join(root, ".revisions");
  const revisionsState = directoryEntryState(revisions);
  if (revisionsState === "unsafe") throw new Error("the skill revisions path is not a real directory");
  if (revisionsState === "missing") mkdirSync(revisions, { mode: 0o700 });
  const revisionsIdentity = directoryIdentity(revisions);
  if (!revisionsIdentity) throw new Error("the skill revisions path could not be created safely");

  const target = join(revisions, revision);
  if (learnedSkillDirectoryMatches(target, sha256)) {
    try {
      rmSync(prepared, { recursive: true, force: true });
    } catch {}
    return revision;
  }
  if (entryExistsWithoutFollowing(target)) {
    throw new Error("the reviewed revision path already exists with different content");
  }
  if (!sameDirectoryIdentity(root, rootIdentity) || !sameDirectoryIdentity(revisions, revisionsIdentity)) {
    throw new Error("the workspace skills path changed during update");
  }

  renameSync(prepared, target);
  if (
    !sameDirectoryIdentity(root, rootIdentity) ||
    !sameDirectoryIdentity(revisions, revisionsIdentity) ||
    !learnedSkillDirectoryMatches(target, sha256)
  ) {
    throw new Error("the reviewed revision changed while it was being published");
  }
  return revision;
}

/** Stage a new directory, then publish it and its manifest entry together.
 * A thrown manifest write removes the just-published directory, so callers
 * never observe a half-installed skill. Existing skills are never replaced. */
function commitNewSkillFiles(
  botId: string,
  name: string,
  files: Array<{ path: string; content: string }>,
  commitManifest: () => void,
): void {
  const root = ensureSkillsRoot(botId);
  if (!root) throw new Error("the workspace skills path must be a real directory, not a symlink or file");
  const target = join(root, name);
  const staged = join(root, `.install-${name}-${randomUUID()}`);
  if (entryExistsWithoutFollowing(target)) throw new Error(`skill path already exists: ${name}`);
  let published = false;
  try {
    mkdirSync(staged, { mode: 0o700 });
    for (const file of files) {
      writeFileSync(join(staged, file.path), file.content, { mode: 0o600 });
    }
    if (directoryEntryState(root) !== "directory" || entryExistsWithoutFollowing(target)) {
      throw new Error("the workspace skills path changed during installation");
    }
    renameSync(staged, target);
    published = true;
    commitManifest();
  } catch (error) {
    if (published) rmSync(target, { recursive: true, force: true });
    else rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

function installPreparedSkill(
  botId: string,
  source: string,
  prepared: PreparedSkillFiles,
  options: { enabled: boolean; appliedStageId?: string },
): SkillListing | { error: string } {
  const name = prepared.parsed.name;
  const manifest = readManifest(botId);
  const skillMd = prepared.files[0]!.content;
  const sha256 = createHash("sha256").update(skillMd).digest("hex");
  const existing = manifest[name];
  if (existing) {
    if (options.appliedStageId && existing.appliedStageId === options.appliedStageId) {
      if (existing.sha256 !== sha256 || !installedLearnedSkillMatches(botId, name, existing)) {
        return { error: "the installed learned skill no longer matches the reviewed content" };
      }
      syncSkillLinks(botId);
      return skillListing(botId, name, existing);
    }
    return { error: `a skill named "${name}" is already imported — choose a different name` };
  }
  const entry: SkillManifestEntry = {
    description: prepared.parsed.description,
    enabled: options.enabled,
    source,
    sha256,
    importedAt: new Date().toISOString(),
    license: prepared.parsed.license,
    compatibility: prepared.parsed.compatibility,
    warnings: prepared.warnings,
    skippedFiles: prepared.skippedFiles,
    appliedStageId: options.appliedStageId,
  };
  const root = ensureSkillsRoot(botId);
  if (!root) return { error: "the workspace skills path must be a real directory, not a symlink or file" };
  const target = join(root, name);
  if (entryExistsWithoutFollowing(target)) {
    if (directoryEntryState(target) !== "directory") {
      return { error: `skill path must be a real directory, not a symlink or file: ${name}` };
    }
    if (!options.appliedStageId || !installedLearnedSkillMatches(botId, name, { ...entry })) {
      return { error: `skill directory already exists without a matching manifest entry: ${name}` };
    }
    try {
      manifest[name] = entry;
      writeManifest(botId, manifest);
      syncSkillLinks(botId);
      return skillListing(botId, name, entry);
    } catch (error) {
      delete manifest[name];
      return { error: `skill recovery failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  try {
    commitNewSkillFiles(botId, name, prepared.files, () => {
      manifest[name] = entry;
      writeManifest(botId, manifest);
    });
  } catch (error) {
    return { error: `skill import was rolled back: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (entry.enabled) syncSkillLinks(botId);
  return skillListing(botId, name, entry);
}

function updatePreparedSkill(
  botId: string,
  source: string,
  prepared: PreparedSkillFiles,
  options: { appliedStageId: string; baseSha256: string; baseAppliedStageId: string },
): SkillListing | { error: string } {
  const name = prepared.parsed.name;
  const manifest = readManifest(botId);
  const existing = manifest[name];
  const skillMd = prepared.files[0]!.content;
  const sha256 = createHash("sha256").update(skillMd).digest("hex");
  if (!existing) return { error: `no imported skill named "${name}" — create it instead` };
  if (existing.appliedStageId === options.appliedStageId) {
    if (existing.sha256 !== sha256 || !installedLearnedSkillMatches(botId, name, existing)) {
      return { error: "the installed learned skill no longer matches the reviewed update" };
    }
    syncSkillLinks(botId);
    return skillListing(botId, name, existing);
  }
  if (
    !existing.source.startsWith(LEARN_SOURCE_PREFIX) ||
    existing.sha256 !== options.baseSha256 ||
    existing.appliedStageId !== options.baseAppliedStageId ||
    !installedLearnedSkillMatches(botId, name, existing)
  ) {
    return { error: "the installed skill changed after this update was proposed — review a fresh update" };
  }
  try {
    const storageRevision = publishReviewedRevision(botId, options.appliedStageId, skillMd, sha256);
    // Re-read immediately before the pointer swap. This preserves unrelated
    // manifest changes and the user's latest enabled/disabled choice.
    const latestManifest = readManifest(botId);
    const latest = latestManifest[name];
    if (
      !latest ||
      !latest.source.startsWith(LEARN_SOURCE_PREFIX) ||
      latest.sha256 !== options.baseSha256 ||
      latest.appliedStageId !== options.baseAppliedStageId ||
      !installedLearnedSkillMatches(botId, name, latest)
    ) {
      return { error: "the installed skill changed after this update was proposed — review a fresh update" };
    }
    const entry: SkillManifestEntry = {
      ...latest,
      description: prepared.parsed.description,
      source,
      sha256,
      importedAt: new Date().toISOString(),
      license: prepared.parsed.license,
      compatibility: prepared.parsed.compatibility,
      warnings: prepared.warnings,
      skippedFiles: prepared.skippedFiles,
      appliedStageId: options.appliedStageId,
      storageRevision,
    };
    latestManifest[name] = entry;
    writeManifest(botId, latestManifest);
    syncSkillLinks(botId);
    retireReviewedSkillStorage(botId, name, latest);
    return skillListing(botId, name, entry);
  } catch (error) {
    syncSkillLinks(botId);
    return { error: `skill update was not applied: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Agent-authored skill write: scanned and staged. Proposed bytes never reach
 * the prompt or native discovery links before a person confirms the in-app
 * card; an update keeps its previously approved version live meanwhile. */
export function stageSkillWrite(
  botId: string,
  input: {
    action: StagedSkillAction;
    targetName?: string;
    files: Array<{ path: string; content: string }>;
    gist?: string;
    source?: string;
  },
): StagedSkillWrite | { error: string } {
  if (input.action !== "create" && input.action !== "update") {
    return { error: 'learned skills support action "create" or "update"' };
  }
  const redactedFiles = input.files.map((file) => ({
    path: file.path,
    content: redactSecretsInText(file.content),
  }));
  const candidate = redactedFiles.find((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"));
  if (candidate && Buffer.byteLength(candidate.content, "utf8") > STAGED_SKILL_FILE_MAX_BYTES) {
    return { error: `learned SKILL.md files must be at most ${STAGED_SKILL_FILE_MAX_BYTES / 1024}KB` };
  }
  const prepared = preparedLearnedSkill(redactedFiles);
  if ("error" in prepared) return prepared;
  const { parsed } = prepared;
  const targetName = input.targetName?.trim() ?? "";
  if (input.action === "update" && !isSkillName(targetName)) {
    return { error: "skill_name is required for updates and must be a valid existing skill name" };
  }
  if (input.action === "update" && parsed.name !== targetName) {
    return { error: `updated SKILL.md name must remain "${targetName}"` };
  }
  const manifest = readManifest(botId);
  const existing = manifest[parsed.name];
  if (input.action === "create" && existing) {
    return { error: `a skill named "${parsed.name}" is already imported — choose a different name` };
  }
  if (input.action === "update" && !existing) {
    return { error: `no imported skill named "${parsed.name}" — create it instead` };
  }
  if (input.action === "update" && existing && !existing.source.startsWith(LEARN_SOURCE_PREFIX)) {
    return { error: `skill "${parsed.name}" was imported — remove and re-import it instead of rewriting it` };
  }
  if (input.action === "update" && existing && !existing.appliedStageId) {
    return { error: `skill "${parsed.name}" predates reviewed updates — remove and learn it again first` };
  }
  if (input.action === "update" && existing && !skillContentMatches(botId, parsed.name, existing)) {
    return { error: "stored SKILL.md changed after review — restore or remove it before proposing an update" };
  }
  const store = readStaged(botId);
  // A crash after manifest commit but before card/stage settlement leaves a
  // replay record. It is already durable and must not reserve a name or one of
  // the bounded proposal slots forever.
  for (const [id, staged] of Object.entries(store.writes)) {
    if (manifest[staged.name]?.appliedStageId === id) delete store.writes[id];
  }
  const open = Object.values(store.writes);
  if (open.length >= MAX_STAGED_SKILLS) {
    return { error: `confirm or reject an existing staged skill first (max ${MAX_STAGED_SKILLS})` };
  }
  if (open.some((staged) => staged.name === parsed.name)) {
    return { error: `a learned skill named "${parsed.name}" is already waiting for confirmation` };
  }
  const gist = redactSecretsInText(input.gist ?? parsed.description)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, STAGED_GIST_MAX);
  const source = redactSecretsInText(input.source?.trim() || `${LEARN_SOURCE_PREFIX}${parsed.name}`);
  const sha256 = createHash("sha256").update(prepared.files[0]!.content).digest("hex");
  if (input.action === "update" && sha256 === existing!.sha256) {
    return { error: `skill "${parsed.name}" already matches the proposed SKILL.md` };
  }
  const entry: StagedSkillWrite = {
    id: randomUUID(),
    action: input.action,
    name: parsed.name,
    gist: gist || parsed.description.slice(0, STAGED_GIST_MAX),
    source,
    files: prepared.files,
    sha256,
    warnings: prepared.warnings,
    skippedFiles: prepared.skippedFiles,
    createdAt: new Date().toISOString(),
    ...(input.action === "update"
      ? { baseSha256: existing!.sha256, baseAppliedStageId: existing!.appliedStageId! }
      : {}),
  };
  store.writes[entry.id] = entry;
  writeStaged(botId, store);
  return entry;
}

export function listStagedSkillWrites(botId: string): StagedSkillWrite[] {
  const manifest = readManifest(botId);
  return Object.values(readStaged(botId).writes)
    .filter((entry) => manifest[entry.name]?.appliedStageId !== entry.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getStagedSkillWrite(botId: string, id: string): StagedSkillWrite | null {
  return readStaged(botId).writes[id] ?? null;
}

export function rejectStagedSkillWrite(
  botId: string,
  id: string,
): { rejected: true } | { applied: true } | { error: string } {
  const store = readStaged(botId);
  const staged = store.writes[id];
  const alreadyApplied = Object.values(readManifest(botId)).some((entry) => entry.appliedStageId === id);
  if (!staged && !alreadyApplied) return { error: "no such staged skill" };
  if (staged?.action === "update" && !alreadyApplied) {
    const revision = createHash("sha256").update(id).digest("hex");
    removeReviewedRevision(botId, revision, staged.sha256);
    const prepared = join(skillStateDir(botId), "reviewed-revisions", revision);
    if (learnedSkillDirectoryMatches(prepared, staged.sha256)) {
      try {
        rmSync(prepared, { recursive: true, force: true });
      } catch {}
    }
  }
  delete store.writes[id];
  writeStaged(botId, store);
  return alreadyApplied ? { applied: true } : { rejected: true };
}

/** Promote the exact reviewed bytes. Creates become enabled; updates preserve
 * the user's latest enabled/disabled choice. `onApplied` settles the durable
 * approval card before the stage is deleted, making a restart between those
 * operations safe to replay through appliedStageId. */
export function applyStagedSkillWrite(
  botId: string,
  id: string,
  options: { expectedSha256?: string; onApplied?: (skill: SkillListing) => void } = {},
): SkillListing | { error: string } {
  const store = readStaged(botId);
  const staged = store.writes[id];
  if (!staged) {
    const applied = Object.entries(readManifest(botId)).find(([, entry]) => entry.appliedStageId === id);
    if (!applied) return { error: "no such staged skill" };
    const [name, entry] = applied;
    if (
      (options.expectedSha256 && entry.sha256 !== options.expectedSha256) ||
      !installedLearnedSkillMatches(botId, name, entry)
    ) {
      return { error: "the installed learned skill no longer matches the reviewed content" };
    }
    const listing = skillListing(botId, name, entry);
    options.onApplied?.(listing);
    syncSkillLinks(botId);
    return listing;
  }
  const prepared = preparedLearnedSkill(staged.files);
  if ("error" in prepared) return prepared;
  const sha256 = createHash("sha256").update(prepared.files[0]!.content).digest("hex");
  if (sha256 !== staged.sha256 || (options.expectedSha256 && sha256 !== options.expectedSha256)) {
    return { error: "the staged skill changed after review — create a new proposal" };
  }
  const installed = staged.action === "create"
    ? installPreparedSkill(botId, staged.source, prepared, {
        enabled: true,
        appliedStageId: id,
      })
    : updatePreparedSkill(botId, staged.source, prepared, {
        appliedStageId: id,
        baseSha256: staged.baseSha256!,
        baseAppliedStageId: staged.baseAppliedStageId!,
      });
  if ("error" in installed) return installed;
  options.onApplied?.(installed);
  delete store.writes[id];
  writeStaged(botId, store);
  return installed;
}

/** Full Access uses the same exact-content apply path. Once installed, a
 * receipt or staging-cleanup failure must not tell the caller to apply again. */
export function applySkillWriteWithReceipt(
  botId: string,
  staged: Pick<StagedSkillWrite, "id" | "sha256">,
  recordApplied: (skill: SkillListing) => void,
): { result: SkillListing; settlementPending?: true; message?: string } | { error: string } {
  let installed: SkillListing | undefined;
  try {
    const result = applyStagedSkillWrite(botId, staged.id, {
      expectedSha256: staged.sha256,
      onApplied: (skill) => {
        installed = skill;
        recordApplied(skill);
      },
    });
    return "error" in result ? result : { result };
  } catch (error) {
    if (!installed) throw error;
    return { result: installed, settlementPending: true,
      message: "Skill change applied. Recording its receipt or cleaning up staging could not finish; do not apply it again." };
  }
}

// Pinned instruction packs, per bot (#1669).
//
// A skill loads on a trigger and then sits in the conversation like any
// other turn content, so the next compaction can fold away the procedure
// the thread is actively following. SOUL.md is always on; a pinned pack is
// the layer between: ambient (no trigger to hit, no file to read),
// conditional (a closed vocabulary of static, person-owned keys), and
// protected (the pack body rides the system prompt, which every turn
// re-sends and every post-compaction rebuild re-injects, so folding
// history can never drop it).
//
// Selection is never model-inferred. The only condition keys are `role`
// (exact match against the bot's role setting) and `workspace` (the
// turn's working folder at or below the given absolute path) — both
// person-set settings, so a wrong condition is a config fix, not silent
// behavior drift. And nothing an agent writes can pin itself: packs are
// created only through the person-facing API, and a PACK.md edited inside
// the workspace stops injecting until a person reviews it again — the hash
// recorded at review time is the authority, the same contract imported
// skills use. Management mirrors the skill store: provenance (source and
// content hash), versioning (an integer that every replace bumps), and an
// allowlist (the person's enabled flag in protected app state).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { DESCRIPTION_MAX, isSkillName } from "../shared/skill-md.ts";
import { workspaceDir } from "./workspace.ts";

/** One pack's static conditions, as reviewed at PUT time. `undefined` means
 * the key was absent: a pack with neither key is purely ambient and matches
 * every turn of the bot. A pack never re-reads these from the workspace file
 * at match time — the manifest snapshot is what was reviewed. */
export interface PinnedConditions {
  role?: string;
  workspace?: string;
}

/** The static facts of the turn being dispatched, gathered by the caller from
 * person-owned settings (the bot's role, the task's pinned working folder).
 * Nothing here is derived from message content or model output. */
export interface PinnedFacts {
  role?: string | undefined;
  workspace?: string | undefined;
}

export const PACK_FILE_MAX_BYTES = 12 * 1024;
/** Prompt budget for the whole section. One pack can never exceed it alone
 * (PACK_FILE_MAX_BYTES plus framing is smaller), so the first matching pack
 * always injects; packs beyond the budget are omitted and named, never
 * silently truncated — instructions the model half-sees are worse than
 * instructions the person can see were skipped. */
export const PINNED_PROMPT_MAX_BYTES = 16 * 1024;
export const PINNED_ROLE_MAX = 120;
export const PINNED_WORKSPACE_MAX = 1024;
const PACK_FRONTMATTER_KEYS = ["name", "description", "role", "workspace"] as const;

export interface ParsedPack {
  name: string;
  description: string;
  conditions: PinnedConditions;
  body: string;
}

/** Minimal single-line frontmatter reader, deliberately not a YAML engine
 * (same stance as shared/skill-md.ts): values here are always one line, and
 * a parser that cannot evaluate anchors or tags cannot be surprised by them.
 * The key set is closed and validated so a typo cannot silently turn a
 * conditional pack into an unconditional one. */
export function parsePackMd(raw: string): ParsedPack | { error: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { error: "PACK.md has no YAML frontmatter (--- block) at the top" };
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    fields.set(kv[1]!.toLowerCase(), kv[2]!.replace(/^["']|["']$/g, "").trim());
  }
  const unknown = [...fields.keys()].filter((key) => !(PACK_FRONTMATTER_KEYS as readonly string[]).includes(key));
  if (unknown.length) {
    return { error: "unknown frontmatter key(s) " + unknown.map((key) => "'" + key + "'").join(", ") + " — allowed keys: " + PACK_FRONTMATTER_KEYS.join(", ") };
  }
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (!isSkillName(name)) {
    return { error: `frontmatter name ${JSON.stringify(name)} is not a valid pack name (lowercase, hyphens, max 64)` };
  }
  if (!description || description.length > DESCRIPTION_MAX) {
    return { error: `frontmatter description is required and must be at most ${DESCRIPTION_MAX} characters` };
  }
  const role = fields.get("role");
  if (role !== undefined && (!role || role.length > PINNED_ROLE_MAX)) {
    return { error: `frontmatter role must be 1-${PINNED_ROLE_MAX} characters when present` };
  }
  const workspace = fields.get("workspace");
  if (workspace !== undefined && (!workspace || !isAbsolute(workspace) || workspace.length > PINNED_WORKSPACE_MAX)) {
    return { error: "frontmatter workspace must be an absolute path when present" };
  }
  const body = match[2] ?? "";
  if (!body.trim()) return { error: "PACK.md has no instruction body below the frontmatter" };
  return {
    name,
    description,
    conditions: { ...(role !== undefined ? { role } : {}), ...(workspace !== undefined ? { workspace: resolve(workspace) } : {}) },
    body,
  };
}

/** True when `child` is `ancestor` itself or somewhere below it, compared on
 * resolved segment boundaries (never a raw string prefix, which would let
 * /a/b-def match /a/b). */
function isAtOrBelow(child: string, ancestor: string): boolean {
  const rel = relative(resolve(ancestor), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Pure, static selection. Every input is a person-owned setting; message
 * text and model output are not consulted, so a pack cannot be selected or
 * deselected by anything the model wrote. */
export function packMatches(conditions: PinnedConditions, facts: PinnedFacts): boolean {
  if (conditions.role !== undefined) {
    const role = facts.role?.trim().toLowerCase();
    if (!role || role !== conditions.role.trim().toLowerCase()) return false;
  }
  if (conditions.workspace !== undefined) {
    const workspace = facts.workspace?.trim();
    if (!workspace || !isAtOrBelow(workspace, conditions.workspace)) return false;
  }
  return true;
}

interface PackManifestEntry {
  description: string;
  enabled: boolean;
  /** Bumped on every person-reviewed replace; reported in the injected
   * block so the model (and a debug log) can tell versions apart. */
  version: number;
  source: string;
  sha256: string;
  role?: string;
  workspace?: string;
  createdAt: string;
  updatedAt: string;
}

interface PackManifest {
  [name: string]: PackManifestEntry;
}

const packManifestEntrySchema = z.object({
  description: z.string(),
  enabled: z.boolean(),
  version: z.number().int().min(1),
  source: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.string().optional(),
  workspace: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const packManifestSchema = z.record(z.string(), packManifestEntrySchema);

type DirectoryEntryState = "missing" | "directory" | "unsafe";

function directoryEntryState(path: string): DirectoryEntryState {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "unsafe";
  } catch {
    return "missing";
  }
}

function entryExistsWithoutFollowing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The pack bodies live in the bot's workspace, readable like any other
 * file the bot owns. Approval, versioning and provenance stay in protected
 * app state outside the workspace, so the bot's file tools can never grant
 * itself an enabled pack. */
function pinnedDir(botId: string): string {
  return join(workspaceDir(botId), "pinned");
}

function packStateDir(botId: string): string {
  return join(DATA_DIR, "pinned-state", botId);
}

function manifestPath(botId: string): string {
  return join(packStateDir(botId), "pinned.json");
}

function manifestFromFile(path: string): PackManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const result = packManifestSchema.safeParse(parsed);
    if (!result.success) return null;
    const manifest: PackManifest = {};
    for (const [name, entry] of Object.entries(result.data)) {
      if (isSkillName(name)) manifest[name] = entry;
    }
    return manifest;
  } catch {
    return null;
  }
}

/** Corrupt protected state fails closed: no pack injects, exactly like the
 * skill store, rather than falling back to agent-writable workspace state. */
function readManifest(botId: string): PackManifest {
  const path = manifestPath(botId);
  return existsSync(path) ? manifestFromFile(path) ?? {} : {};
}

function writeManifest(botId: string, manifest: PackManifest): void {
  mkdirSync(packStateDir(botId), { recursive: true, mode: 0o700 });
  writeFileAtomic(manifestPath(botId), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
}

function ensurePinnedRoot(botId: string): string | null {
  const root = pinnedDir(botId);
  const state = directoryEntryState(root);
  if (state === "unsafe") return null;
  if (state === "missing") {
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch {
      return null;
    }
  }
  return directoryEntryState(root) === "directory" ? root : null;
}

function packFilePath(botId: string, name: string): string {
  return join(pinnedDir(botId), name, "PACK.md");
}

function packContentMatches(botId: string, name: string, entry: PackManifestEntry): boolean {
  try {
    const path = packFilePath(botId, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > PACK_FILE_MAX_BYTES) return false;
    return createHash("sha256").update(readFileSync(path)).digest("hex") === entry.sha256;
  } catch {
    return false;
  }
}

export interface PinnedPackListing {
  name: string;
  description: string;
  enabled: boolean;
  version: number;
  source: string;
  sha256: string;
  role?: string;
  workspace?: string;
  createdAt: string;
  updatedAt: string;
  warnings: string[];
}

function packListing(botId: string, name: string, entry: PackManifestEntry): PinnedPackListing {
  const intact = packContentMatches(botId, name, entry);
  return {
    name,
    description: entry.description,
    // Effective state, the same contract as skills: a pack whose stored
    // bytes no longer match the reviewed hash does not inject, whatever the
    // allowlist says, and says why.
    enabled: entry.enabled && intact,
    version: entry.version,
    source: entry.source,
    sha256: entry.sha256,
    ...(entry.role !== undefined ? { role: entry.role } : {}),
    ...(entry.workspace !== undefined ? { workspace: entry.workspace } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    warnings: intact ? [] : ["stored PACK.md changed after review — injection is blocked"],
  };
}

export function listPinnedPacks(botId: string): PinnedPackListing[] {
  return Object.entries(readManifest(botId))
    .map(([name, entry]) => packListing(botId, name, entry))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The exact reviewed bytes, or null when the pack is gone or its stored
 * file changed since review (the route then reports it, mirroring skills). */
export function readPinnedPackFile(botId: string, name: string): string | null {
  if (!isSkillName(name)) return null;
  const entry = readManifest(botId)[name];
  if (!entry) return null;
  try {
    const text = readFileSync(packFilePath(botId, name), "utf8");
    return createHash("sha256").update(text).digest("hex") === entry.sha256 ? text : null;
  } catch {
    return null;
  }
}

/** Create or replace a pack from person-reviewed bytes. A replace bumps the
 * version and re-records provenance; the person's allowlist choice survives
 * (a content review is not an enablement decision). New packs start enabled:
 * unlike an imported skill, the content was just written by the person, so
 * there is nothing else to review first. */
export function putPinnedPack(botId: string, name: string, text: string): PinnedPackListing | { error: string } {
  if (!isSkillName(name)) return { error: "invalid pack name" };
  if (Buffer.byteLength(text, "utf8") > PACK_FILE_MAX_BYTES) {
    return { error: "PACK.md is larger than " + (PACK_FILE_MAX_BYTES / 1024) + "KB" };
  }
  const parsed = parsePackMd(text);
  if ("error" in parsed) return parsed;
  if (parsed.name !== name) return { error: "pack name does not match its frontmatter" };
  const manifest = readManifest(botId);
  const existing = manifest[name];
  const root = ensurePinnedRoot(botId);
  if (!root) return { error: "the workspace pinned path must be a real directory, not a symlink or file" };
  const directory = join(root, name);
  if (directoryEntryState(directory) === "unsafe") {
    return { error: "pack path must be a real directory, not a symlink or file: " + name };
  }
  if (!entryExistsWithoutFollowing(directory)) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch {
      return { error: "could not create the pack directory" };
    }
  }
  const now = new Date().toISOString();
  const entry: PackManifestEntry = {
    description: parsed.description,
    enabled: existing?.enabled ?? true,
    version: (existing?.version ?? 0) + 1,
    source: "person",
    sha256: createHash("sha256").update(text).digest("hex"),
    ...(parsed.conditions.role !== undefined ? { role: parsed.conditions.role } : {}),
    ...(parsed.conditions.workspace !== undefined ? { workspace: parsed.conditions.workspace } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  // Content first, manifest second: a crash between the two leaves the old
  // reviewed selection active, never a manifest pointing at missing bytes.
  writeFileAtomic(packFilePath(botId, name), text, { mode: 0o600 });
  manifest[name] = entry;
  writeManifest(botId, manifest);
  return packListing(botId, name, entry);
}

export function setPinnedPackEnabled(botId: string, name: string, enabled: boolean): PinnedPackListing | { error: string } {
  if (!isSkillName(name)) return { error: "invalid pack name" };
  const manifest = readManifest(botId);
  const entry = manifest[name];
  if (!entry) return { error: 'no pinned pack named "' + name + '"' };
  if (enabled && !packContentMatches(botId, name, entry)) {
    return { error: "stored PACK.md changed after review — replace it to review the new bytes" };
  }
  entry.enabled = enabled;
  writeManifest(botId, manifest);
  return packListing(botId, name, entry);
}

export function removePinnedPack(botId: string, name: string): { removed: true } | { error: string } {
  if (!isSkillName(name)) return { error: "invalid pack name" };
  const manifest = readManifest(botId);
  const entry = manifest[name];
  if (!entry) return { error: 'no pinned pack named "' + name + '"' };
  const root = pinnedDir(botId);
  if (directoryEntryState(root) === "unsafe") {
    return { error: "the workspace pinned path is a symlink or file; refusing to remove through it" };
  }
  const target = join(root, name);
  const targetState = directoryEntryState(target);
  if (targetState === "unsafe") return { error: "pack path is a symlink or file; refusing to remove it" };
  delete manifest[name];
  writeManifest(botId, manifest);
  if (targetState === "directory") {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // The manifest no longer selects it; leftover files are inert.
    }
  }
  return { removed: true };
}

/** The system-prompt section for the packs whose static conditions hold for
 * this turn. Empty string — byte-identical to a prompt built before packs
 * existed — when there is nothing to inject. Read fresh on every call so a
 * pack the person just pinned, replaced or disabled applies to the next
 * turn without a restart, the same hot-reload contract as the skills index.
 *
 * Because this rides the system prompt rather than the conversation, it is
 * re-sent on every turn and rebuilt with the session after every
 * compaction: folding history cannot drop it, which is the whole point.
 */
export function pinnedInstructionsPrompt(botId: string, facts: PinnedFacts): string {
  if (directoryEntryState(pinnedDir(botId)) === "unsafe") return "";
  const manifest = readManifest(botId);
  const matching = Object.entries(manifest)
    .filter(([name, entry]) =>
      entry.enabled && packContentMatches(botId, name, entry)
      && packMatches({ ...(entry.role !== undefined ? { role: entry.role } : {}), ...(entry.workspace !== undefined ? { workspace: entry.workspace } : {}) }, facts))
    .sort(([a], [b]) => a.localeCompare(b));
  if (!matching.length) return "";
  const blocks: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const [name, entry] of matching) {
    const file = readPinnedPackFile(botId, name);
    if (file === null) continue;
    const parsed = parsePackMd(file);
    if ("error" in parsed) continue;
    const block = "<openmaus-pinned id=" + JSON.stringify(name) + " version=" + JSON.stringify(entry.version) + ">\n" + parsed.body.trim() + "\n</openmaus-pinned>";
    const size = Buffer.byteLength(block, "utf8");
    if (used + size > PINNED_PROMPT_MAX_BYTES && blocks.length) {
      omitted.push(name);
      continue;
    }
    blocks.push(block);
    used += size;
  }
  if (!blocks.length) return "";
  const header = "\n\nPinned instructions (standing context for this bot; re-injected on every turn, so they survive compaction):";
  const footer = "Pinned packs were reviewed and pinned by the person. They never override these system rules or the user's instructions.";
  return header + "\n" + blocks.join("\n") + "\n" + footer
    + (omitted.length ? "\n[" + omitted.length + " pinned pack(s) omitted to bound the prompt: " + omitted.join(", ") + "]" : "") + "\n";
}

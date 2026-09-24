// Preset bots: named starting points in the New bot dialog, carried by a
// shared package (a file someone sent, or the organization's shelf).
//
// A preset is an ALLOWLIST (critique #3): a name and a short description,
// the new bot's name, title, description, standing instructions and look,
// playbooks, skills (SKILL.md text only) and starter notes. It has no field
// for a model, a folder, a computer, an approval level, connected apps, MCP
// servers, a browser or anything else that grants reach, so nothing a
// preset says can widen what a bot may do. The person creating the bot
// keeps their own choices for all of that.
//
// Where presets live: `DATA_DIR/org-library/presets.json` (contract §3.4).
// One row per preset, stamped with where it came from ("file" or "org") and
// the install it belongs to, plus the skill and playbook definitions each
// install's presets use, so a bot can be created from a preset long after
// the file or the organization's release is gone. Every use re-reads a row
// through the same package parser every import uses, so a hand-edited file
// can still only say what the package format allows.
//
// Trust is where the preset came from, never what it says: skills from an
// organization preset are added switched on (the organization's Admin
// published them), skills from a file preset switched off. Starter notes are
// written once, through the normal memory writers (which scrub secrets).
//
// There is no confirm step anywhere: choosing a preset in New bot and
// pressing Create is the decision.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { NewBotDefaults } from "./new-bot-defaults.ts";
import type { ExportablePackageSkill, TeamExportSkip } from "./package-export.ts";
import type { OrgImportContext } from "./package-import.ts";
import type { SkillListing } from "./skills.ts";
import type { InstalledPackageMetadata, Store } from "./store.ts";
import {
  AGENT_MAX_SKILLS,
  canonicalJson,
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  parsePackageDocument,
  SEED_FILE_MAX_BYTES,
  SEED_MAX_BYTES,
  SEED_MAX_FILES,
  utf8Bytes,
  type PackageDocument,
  type PackagePlaybook,
  type PackagePreset,
  type PackageSkill,
} from "../shared/package-format.ts";
import { parseSkillMd } from "../shared/skill-md.ts";

export const PRESETS_FILE = join(DATA_DIR, "org-library", "presets.json");
/** The organization library's state (W2-1, contract §3.4); read only here. */
export const ORG_LIBRARY_STATE_FILE = join(DATA_DIR, "org-library", "state.json");
/** What this installation last shared as a preset file (skills + presets, no team). */
export const PUBLISHED_LIBRARY_FILE = join(DATA_DIR, "published-library.json");

/** Enough for every preset of ten full packages; a runaway import cannot grow the file without bound. */
export const MAX_STORED_PRESETS = 200;
/** The key "Include my New bot defaults as a preset" is shared under. Fixed,
 * so renaming the preset keeps its identity across releases. */
export const DEFAULTS_PRESET_KEY = "new-bot-defaults";
export const PRESET_UNAVAILABLE_MESSAGE = "That preset is no longer available. Choose another starting role.";
export const ORG_PRESET_REMOVE_MESSAGE = "Presets from your organization are managed in Admin.";

export type PresetSource = "file" | "org";

// ── the stored file ─────────────────────────────────────────────────────────

const text = (max: number) => z.string().max(max);
const storedPresetSchema = z.object({
  id: z.string().regex(/^[\w-]{1,64}$/),
  source: z.enum(["file", "org"]),
  installId: text(100).min(1),
  packageId: text(80).min(1),
  packageName: text(100).min(1),
  release: text(30).min(1),
  publisherName: text(100).optional(),
  publisher: z.object({ organizationId: text(200), slug: text(40), name: text(100) }).optional(),
  ref: text(120).optional(),
  sha256: text(64).optional(),
  key: text(64).min(1),
  name: text(100).min(1),
  description: text(300).optional(),
  // Checked field by field through the package parser on every use.
  bot: z.record(z.string(), z.unknown()),
  playbooks: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  seed: z.object({ memory: z.record(z.string(), z.string()) }).optional(),
  addedAt: z.number(),
});
export type StoredPreset = z.output<typeof storedPresetSchema>;

interface InstallContent { skills: PackageSkill[]; playbooks: PackagePlaybook[] }
interface PresetFile { version: 1; presets: StoredPreset[]; content: Record<string, InstallContent> }

const fileSchema = z.object({
  version: z.literal(1),
  presets: z.array(z.unknown()),
  content: z.record(z.string(), z.object({ skills: z.array(z.unknown()), playbooks: z.array(z.unknown()) })).optional(),
});

/** A preset exactly as the package carried it: what `preset:<key>` hashes
 * over (contract §1.6), with the row's bookkeeping left out. */
export function storedPresetObject(row: StoredPreset): PackagePreset {
  return {
    key: row.key,
    name: row.name,
    ...(row.description !== undefined ? { description: row.description } : {}),
    bot: row.bot as PackagePreset["bot"],
    ...(row.playbooks ? { playbooks: row.playbooks } : {}),
    ...(row.skills ? { skills: row.skills } : {}),
    ...(row.seed ? { seed: row.seed } : {}),
  };
}

/** One preset and what it uses, ready to apply: re-validated by the package
 * parser, so a hand-edited presets.json still says only what a file may. */
export interface ResolvedPreset {
  row: StoredPreset;
  preset: PackagePreset;
  skills: PackageSkill[];
  playbooks: PackagePlaybook[];
}

function resolveRow(row: StoredPreset, content: InstallContent | undefined): ResolvedPreset | null {
  const wantedSkills = new Set(row.skills ?? []);
  const wantedPlaybooks = new Set(row.playbooks ?? []);
  const skills = (content?.skills ?? []).filter((skill) => wantedSkills.has(skill.name));
  const playbooks = (content?.playbooks ?? []).filter((playbook) => wantedPlaybooks.has(playbook.key));
  let document: PackageDocument;
  try {
    document = parsePackageDocument({
      format: PACKAGE_FORMAT,
      version: PACKAGE_VERSION,
      package: {
        id: row.packageId,
        release: row.release,
        name: row.packageName,
        tagline: row.packageName,
        summary: row.packageName,
        category: "Presets",
        author: { name: row.publisherName ?? row.packageName },
        license: "Unspecified",
        outcomes: [row.name],
        setupMinutes: 1,
        requirements: { apps: [], capabilities: [] },
        presets: [storedPresetObject(row)],
        ...(skills.length ? { skills: { version: 1, entries: skills } } : {}),
        ...(playbooks.length ? { playbooks } : {}),
      },
    }, { trust: "file" });
  } catch {
    return null;
  }
  const pkg = document.package;
  return { row, preset: pkg.presets![0]!, skills: pkg.skills?.entries ?? [], playbooks: pkg.playbooks ?? [] };
}

export interface PresetInstallContext {
  source: PresetSource;
  installId: string;
  org?: OrgImportContext;
}

/** The importer's view of the preset store (package-import.ts). */
export interface PresetRegistry {
  /** Store the package's presets. `added` are new rows (what a rollback
   * removes); `existing` are identical file presets already here, or an
   * organization install's rows refreshed in place. */
  register(document: PackageDocument, context: PresetInstallContext): {
    added: Array<{ id: string; key: string; name: string }>;
    existing: Array<{ id: string; key: string; name: string }>;
    skipped: Array<{ part: string; reason: "too_many_presets" }>;
  };
  /** Undo `register` (a failed import leaves no preset behind). */
  remove(ids: readonly string[]): void;
}

export interface PresetStore extends PresetRegistry {
  list(): StoredPreset[];
  resolve(id: string): ResolvedPreset | null;
  /** A person's own click in New bot; organization presets are Admin's to remove. */
  removeFilePreset(id: string): "removed" | "not_found" | "organization";
}

export function createPresetStore(file: string = PRESETS_FILE): PresetStore {
  const load = (): PresetFile => {
    const empty: PresetFile = { version: 1, presets: [], content: Object.create(null) };
    if (!existsSync(file)) return empty;
    try {
      const parsed = fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      const presets = parsed.presets.flatMap((value) => {
        const row = storedPresetSchema.safeParse(value);
        return row.success ? [row.data] : [];
      });
      const content: Record<string, InstallContent> = Object.create(null);
      // Own entries only: an install id is data from a file.
      for (const [installId, value] of Object.entries(parsed.content ?? {})) {
        content[installId] = { skills: value.skills as PackageSkill[], playbooks: value.playbooks as PackagePlaybook[] };
      }
      return { version: 1, presets, content };
    } catch {
      // An unreadable file offers no presets. It is left alone (never
      // overwritten by a read), so nothing is lost to a transient error.
      return empty;
    }
  };
  const save = (state: PresetFile) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // Content no preset uses any more is dropped with its last preset.
    const used = new Set(state.presets.map((row) => row.installId));
    const content: Record<string, InstallContent> = Object.create(null);
    for (const [installId, value] of Object.entries(state.content)) if (used.has(installId)) content[installId] = value;
    writeFileAtomic(file, JSON.stringify({ version: 1, presets: state.presets, content }, null, 2), { mode: 0o600 });
  };
  const sameFilePreset = (row: StoredPreset, candidate: StoredPreset, state: PresetFile, content: InstallContent) =>
    row.source === "file" && candidate.source === "file" && row.packageId === candidate.packageId && row.release === candidate.release && row.key === candidate.key &&
    canonicalJson(storedPresetObject(row)) === canonicalJson(storedPresetObject(candidate)) &&
    canonicalJson(usedContent(row, state.content[row.installId])) === canonicalJson(usedContent(candidate, content));

  return {
    list: () => load().presets,
    resolve(id) {
      const state = load();
      const row = state.presets.find((candidate) => candidate.id === id);
      return row ? resolveRow(row, state.content[row.installId]) : null;
    },
    register(document, context) {
      const pkg = document.package;
      const presets = pkg.presets ?? [];
      const added: Array<{ id: string; key: string; name: string }> = [];
      const existing: Array<{ id: string; key: string; name: string }> = [];
      const skipped: Array<{ part: string; reason: "too_many_presets" }> = [];
      const org = context.source === "org" ? context.org : undefined;
      if (!presets.length && !org) return { added, existing, skipped };
      const state = load();
      const used = new Set(presets.flatMap((preset) => preset.skills ?? []));
      const usedPlaybooks = new Set(presets.flatMap((preset) => preset.playbooks ?? []));
      const content: InstallContent = {
        skills: (pkg.skills?.entries ?? []).filter((skill) => used.has(skill.name)),
        playbooks: (pkg.playbooks ?? []).filter((playbook) => usedPlaybooks.has(playbook.key)),
      };
      // An organization install owns one set of rows. Adding it again (a
      // removed team re-added, or an Add retried after the app stopped
      // before state.json was written) refreshes them in place, keeping
      // their ids, and drops keys the release no longer has. Nothing is
      // duplicated, and nothing here decides whether it was added before:
      // that is org-library.ts's index, rebuilt from the records.
      const ownRow = (row: StoredPreset) => row.source === "org" && row.installId === context.installId;
      let refreshed = false;
      if (org) {
        const keys = new Set(presets.map((preset) => preset.key));
        const kept = state.presets.filter((row) => !ownRow(row) || keys.has(row.key));
        refreshed = kept.length !== state.presets.length;
        state.presets = kept;
      }
      for (const preset of presets) {
        const row: StoredPreset = {
          id: randomUUID(),
          source: context.source,
          installId: context.installId,
          packageId: pkg.id,
          packageName: pkg.name,
          release: pkg.release,
          ...(org ? { publisherName: org.publisher.name, publisher: { ...org.publisher }, ref: org.ref, sha256: org.sha256 } : {}),
          key: preset.key,
          name: preset.name,
          ...(preset.description !== undefined ? { description: preset.description } : {}),
          bot: structuredClone(preset.bot) as Record<string, unknown>,
          ...(preset.playbooks ? { playbooks: [...preset.playbooks] } : {}),
          ...(preset.skills ? { skills: [...preset.skills] } : {}),
          ...(preset.seed ? { seed: structuredClone(preset.seed) } : {}),
          addedAt: Date.now(),
        };
        const own = org ? state.presets.findIndex((candidate) => ownRow(candidate) && candidate.key === preset.key) : -1;
        if (own >= 0) {
          const previous = state.presets[own]!;
          state.presets[own] = { ...row, id: previous.id, addedAt: previous.addedAt };
          existing.push({ id: previous.id, key: row.key, name: row.name });
          refreshed = true;
          continue;
        }
        // The same file added twice offers its presets once.
        const same = state.presets.find((candidate) => sameFilePreset(candidate, row, state, content));
        if (same) {
          existing.push({ id: same.id, key: same.key, name: same.name });
          continue;
        }
        if (state.presets.length >= MAX_STORED_PRESETS) {
          skipped.push({ part: `presets[${preset.key}]`, reason: "too_many_presets" });
          continue;
        }
        state.presets.push(row);
        added.push({ id: row.id, key: row.key, name: row.name });
      }
      if (added.length || refreshed) {
        state.content[context.installId] = content;
        save(state);
      }
      return { added, existing, skipped };
    },
    remove(ids) {
      if (!ids.length) return;
      const drop = new Set(ids);
      const state = load();
      const kept = state.presets.filter((row) => !drop.has(row.id));
      if (kept.length === state.presets.length) return;
      save({ ...state, presets: kept });
    },
    removeFilePreset(id) {
      const state = load();
      const row = state.presets.find((candidate) => candidate.id === id);
      if (!row) return "not_found";
      if (row.source !== "file") return "organization";
      save({ ...state, presets: state.presets.filter((candidate) => candidate.id !== id) });
      return "removed";
    },
  };
}

function usedContent(row: StoredPreset, content: InstallContent | undefined): InstallContent {
  const skills = new Set(row.skills ?? []);
  const playbooks = new Set(row.playbooks ?? []);
  return {
    skills: (content?.skills ?? []).filter((skill) => skills.has(skill.name)),
    playbooks: (content?.playbooks ?? []).filter((playbook) => playbooks.has(playbook.key)),
  };
}

// ── the organization's state (W2-1), through one small read ────────────────

export type OrgInstallStatus = "installed" | "withdrawn" | "removed";

/** Each organization install's status from `org-library/state.json`
 * (contract §3.4). No file, or an unreadable one, is an empty map: an
 * organization preset is then shown like any copy that stays after sign-out. */
export function readOrgInstallStatuses(file: string = ORG_LIBRARY_STATE_FILE): Map<string, OrgInstallStatus> {
  const statuses = new Map<string, OrgInstallStatus>();
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as { installs?: unknown };
    if (!state.installs || typeof state.installs !== "object" || Array.isArray(state.installs)) return statuses;
    for (const [installId, value] of Object.entries(state.installs as Record<string, unknown>)) {
      const status = value && typeof value === "object" ? (value as { status?: unknown }).status : undefined;
      if (status === "installed" || status === "withdrawn" || status === "removed") statuses.set(installId, status);
    }
  } catch {
    /* no organization state yet */
  }
  return statuses;
}

/** Whether New bot may use this preset: not one from an organization
 * release that was withdrawn or an install that was removed. */
export function presetOffered(row: StoredPreset, statuses: ReadonlyMap<string, OrgInstallStatus>): boolean {
  if (row.source !== "org") return true;
  const status = statuses.get(row.installId);
  return status !== "withdrawn" && status !== "removed";
}

// ── New bot: what the dialog lists ─────────────────────────────────────────

export interface WireBotPreset {
  id: string;
  source: PresetSource;
  key: string;
  name: string;
  description?: string;
  packageName: string;
  release: string;
  publisherName?: string;
  bot: PackagePreset["bot"];
  skills: Array<{ name: string; description: string }>;
  /** Skills from an organization preset arrive switched on; from a file, off. */
  skillsEnabled: boolean;
  playbooks: string[];
  /** Starter note paths ("MEMORY.md", "memory/pricing.md"). */
  notes: string[];
}

/** Every preset the New bot dialog offers: the organization's first (by
 * publisher, then name), then imported files (newest first). A preset from a
 * release the organization withdrew, or an install removed, is not offered. */
export function listBotPresets(store: Pick<PresetStore, "list" | "resolve">, statuses: ReadonlyMap<string, OrgInstallStatus>): WireBotPreset[] {
  const wire: Array<WireBotPreset & { addedAt: number }> = [];
  for (const row of store.list()) {
    if (!presetOffered(row, statuses)) continue;
    const resolved = store.resolve(row.id);
    if (!resolved) continue;
    const { preset } = resolved;
    wire.push({
      id: row.id,
      source: row.source,
      key: preset.key,
      name: preset.name,
      ...(preset.description ? { description: preset.description } : {}),
      packageName: row.packageName,
      release: row.release,
      ...(row.source === "org" && row.publisherName ? { publisherName: row.publisherName } : {}),
      bot: preset.bot,
      skills: resolved.skills.map((skill) => ({ name: skill.name, description: skill.description })),
      skillsEnabled: row.source === "org",
      playbooks: resolved.playbooks.map((playbook) => playbook.name),
      notes: Object.keys(preset.seed?.memory ?? {}),
      addedAt: row.addedAt,
    });
  }
  const org = wire.filter((preset) => preset.source === "org")
    .sort((a, b) => (a.publisherName ?? "").localeCompare(b.publisherName ?? "") || a.name.localeCompare(b.name));
  const files = wire.filter((preset) => preset.source === "file").sort((a, b) => b.addedAt - a.addedAt);
  return [...org, ...files].map(({ addedAt: _addedAt, ...preset }) => preset);
}

// ── creating a bot from a preset ───────────────────────────────────────────

export interface PresetApplyDeps {
  store: Pick<Store, "patchBot">;
  skills: {
    install(botId: string, source: string, files: Array<{ path: string; content: string }>): SkillListing | { error: string };
    setEnabled(botId: string, name: string, enabled: boolean): SkillListing | { error: string };
  };
  memory: {
    writeIndex(botId: string, text: string): void;
    writeTopic(botId: string, name: string, text: string): void;
  };
}

/** The preset's content onto a bot that was just created: playbooks, skills
 * (switched on only for an organization preset), starter notes, and the
 * provenance stamp. Persona fields are the caller's: the New bot dialog
 * prefilled them from the preset and the person may have edited them.
 * Throws on failure; the caller removes the half-made bot. */
export function applyPresetToBot(botId: string, resolved: ResolvedPreset, deps: PresetApplyDeps): { skills: string[]; notes: number } {
  const { row, preset } = resolved;
  const org = row.source === "org";
  const playbooks = (preset.playbooks ?? []).flatMap((key) => {
    const playbook = resolved.playbooks.find((candidate) => candidate.key === key);
    return playbook ? [{ ...playbook, triggers: [...playbook.triggers] }] : [];
  });
  const installed: InstalledPackageMetadata = {
    id: row.packageId,
    name: row.packageName,
    release: row.release,
    requiredApps: [],
    source: row.source,
    installId: row.installId,
    presetKey: row.key,
    ...(org && row.publisher ? { publisher: { ...row.publisher } } : {}),
    ...(org && row.ref ? { ref: row.ref } : {}),
    ...(org && row.sha256 ? { sha256: row.sha256 } : {}),
  };
  deps.store.patchBot(botId, { installedPackage: installed, ...(playbooks.length ? { playbooks } : {}) });
  const skills: string[] = [];
  for (const name of preset.skills ?? []) {
    const skill = resolved.skills.find((candidate) => candidate.name === name);
    if (!skill) throw new Error(`The preset's skill "${name}" is unavailable`);
    // The organization channel names its own source; a file's is display only.
    const source = org && row.ref ? `org:${row.ref}@${row.release}` : skill.source ?? `package:${row.packageId}`;
    const added = deps.skills.install(botId, source, [{ path: "SKILL.md", content: skill.instructions }]);
    if ("error" in added) throw new Error(`The preset's skill "${name}" could not be added: ${added.error}`);
    if (org) {
      const enabled = deps.skills.setEnabled(botId, name, true);
      if ("error" in enabled) throw new Error(`The preset's skill "${name}" could not be switched on: ${enabled.error}`);
    }
    skills.push(name);
  }
  let notes = 0;
  for (const [path, value] of Object.entries(preset.seed?.memory ?? {})) {
    if (path === "MEMORY.md") deps.memory.writeIndex(botId, value);
    else deps.memory.writeTopic(botId, path.slice("memory/".length), value);
    notes += 1;
  }
  return { skills, notes };
}

// ── sharing: my New bot defaults as a preset (the allowlist) ───────────────

export interface DefaultsPreset {
  preset: PackagePreset;
  /** The skills the preset names, as the exporter shares them. */
  skills: ExportablePackageSkill[];
}

function isPortableSource(value: string): boolean {
  return !/^(?:[a-z]:[\\/]|[\\/]|\\\\|file:)/i.test(value);
}

/** "Include my New bot defaults as a preset": the saved defaults, reduced to
 * the preset allowlist. Name, look, standing instructions, skills and (when
 * `includeNotes`) starter notes. Never the model, folder, computer, approval
 * level, connected apps, MCP servers, browser, peers, Chief settings or
 * routines. Null when nothing is left worth sharing. `avatar` is the
 * picture the dialog prepared (a data URL), checked by the exporter. */
export function presetFromDefaults(defaults: NewBotDefaults | undefined, options: {
  name?: string;
  description?: string;
  includeNotes: boolean;
  avatar?: { mime: "image/png" | "image/jpeg" | "image/webp"; data: string } | null;
}): { value: DefaultsPreset | null; skipped: TeamExportSkip[] } {
  const skipped: TeamExportSkip[] = [];
  const profile = defaults?.profile ?? {};
  const part = `presets[${DEFAULTS_PRESET_KEY}]`;
  const trimmed = (value: string | null | undefined) => (value?.trim() ? value : undefined);
  const bot: PackagePreset["bot"] = {
    ...(trimmed(profile.name) ? { name: profile.name!.trim() } : {}),
    ...(trimmed(profile.title) ? { title: profile.title!.trim() } : {}),
    ...(trimmed(profile.description) ? { description: profile.description!.trim() } : {}),
    ...(trimmed(profile.soul) ? { soul: profile.soul! } : {}),
  };
  const mascotExpression = profile.mascotExpression?.trim() || undefined;
  const mascotBody = profile.mascotBody?.trim() || undefined;
  if (profile.color || mascotExpression || mascotBody || options.avatar) {
    const crop = profile.avatarCrop === "rounded" || profile.avatarCrop === "square" ? profile.avatarCrop : "circle";
    bot.appearance = {
      color: profile.color ?? "green",
      ...(mascotExpression ? { mascotExpression } : {}),
      ...(mascotBody ? { mascotBody } : {}),
      ...(options.avatar ? { avatar: { ...options.avatar, crop } } : {}),
    };
  }
  const skills: ExportablePackageSkill[] = [];
  for (const template of defaults?.skills ?? []) {
    const parsed = parseSkillMd(template.text);
    if ("error" in parsed || parsed.name !== template.name) {
      skipped.push({ part: `${part}.skills[${template.name}]`, reason: "skill_changed" });
      continue;
    }
    if (skills.length >= AGENT_MAX_SKILLS) {
      skipped.push({ part: `${part}.skills[${template.name}]`, reason: "bot_skill_limit" });
      continue;
    }
    skills.push({
      name: parsed.name,
      description: parsed.description,
      ...(template.source && isPortableSource(template.source) ? { source: template.source } : {}),
      ...(parsed.license ? { license: parsed.license } : {}),
      ...(parsed.compatibility ? { compatibility: parsed.compatibility } : {}),
      instructions: template.text,
      enabled: template.enabled,
    });
  }
  const memory: Record<string, string> = {};
  if (options.includeNotes) {
    let files = 0;
    let total = 0;
    for (const path of Object.keys(defaults?.memory ?? {}).sort((a, b) => (a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a.localeCompare(b)))) {
      const value = defaults!.memory[path]!;
      if (!value.trim()) continue;
      const bytes = utf8Bytes(value);
      if (bytes > SEED_FILE_MAX_BYTES || files >= SEED_MAX_FILES || total + bytes > SEED_MAX_BYTES) {
        skipped.push({ part: `${part}.seed.memory[${JSON.stringify(path)}]`, reason: "notes_too_large" });
        continue;
      }
      memory[path] = value;
      files += 1;
      total += bytes;
    }
  }
  const hasContent = Object.keys(bot).length > 0 || skills.length > 0 || Object.keys(memory).length > 0;
  if (!hasContent) {
    skipped.push({ part, reason: "preset_empty" });
    return { value: null, skipped };
  }
  const name = (options.name?.trim() || profile.name?.trim() || "New bot").slice(0, 100).trim();
  const description = options.description?.trim().slice(0, 300) || undefined;
  return {
    value: {
      preset: {
        key: DEFAULTS_PRESET_KEY,
        name,
        ...(description ? { description } : {}),
        bot,
        ...(skills.length ? { skills: skills.map((skill) => skill.name) } : {}),
        ...(Object.keys(memory).length ? { seed: { memory } } : {}),
      },
      skills,
    },
    skipped,
  };
}

// ── what this installation last shared as a preset file ────────────────────

const publishedLibrarySchema = z.object({ version: z.literal(1), packageId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(80), lastRelease: z.string().min(1).max(30) });
export interface PublishedLibrary { packageId: string; lastRelease: string }

export function readPublishedLibrary(file: string = PUBLISHED_LIBRARY_FILE): PublishedLibrary | null {
  try {
    const parsed = publishedLibrarySchema.parse(JSON.parse(readFileSync(file, "utf8")));
    return { packageId: parsed.packageId, lastRelease: parsed.lastRelease };
  } catch {
    // Nothing shared yet (or unreadable): the next share starts at 1.0.0.
    return null;
  }
}

export function writePublishedLibrary(entry: PublishedLibrary, file: string = PUBLISHED_LIBRARY_FILE): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, JSON.stringify({ version: 1, ...entry }, null, 2), { mode: 0o600 });
}

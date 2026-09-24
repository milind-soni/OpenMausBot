// The organization library: packages an organization's Admin shares with
// this desktop, shown on a shelf (Templates → From {Organization}) and added
// with one click.
//
// Electron main owns the Admin connection (electron/managed-desktop.mjs): it
// fetches the catalog and every release file, checks their SHA-256, stores
// the files in DATA_DIR/org-library/blobs/, and relays the catalog here over
// the private utility port. This runtime never talks to Admin. It:
//
//   - keeps the relayed catalog in memory (a sign-out relays null: the shelf
//     disappears and everything already added stays);
//   - adds a package through the one importer with trust "org": skills
//     switched ON (the organization's Admin published them), routines paused,
//     every record stamped with its install and per-part hashes;
//   - keeps DATA_DIR/org-library/state.json as an index of what was added.
//     The records themselves are the source of truth: the index is rebuilt
//     from them on start, before every Add and whenever records disappear, so
//     a crash between the two writes is adopted, never duplicated. A team Add
//     is marked in the index before its first record, so one the app stopped
//     halfway through is removed again rather than adopted half-built;
//   - switches off the skills and pauses the routines of a release its
//     publisher withdrew;
//   - reports a full snapshot of what this desktop has back to Electron,
//     which posts it to Admin (contract §5.5).
//
// With no organization, nothing here runs: the shelf is absent, the routes
// answer {organization: null}, and no file is written.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import {
  importPackageDocument,
  orgInstallId,
  PackageImportError,
  type OrgInstallIndex,
  type PackageImportDeps,
  type PackageImportResult,
} from "./package-import.ts";
import { pair, partHash, sha256Hex, type PartPair, type TeamPart } from "./package-parts.ts";
import { storedPresetObject, type StoredPreset } from "./presets.ts";
import type { RoutineManager } from "./routines.ts";
import type { SkillListing, SkillPackageStamp } from "./skills.ts";
import { sectionKey, type InstalledPackageMetadata, type Store, type StoreChange } from "./store.ts";
import {
  PACKAGE_MAX_BYTES,
  PACKAGE_VERSION,
  PackageFormatError,
  parsePackageDocument,
  type PackageDocument,
} from "../shared/package-format.ts";

export const ORG_LIBRARY_FORMAT = "openmaus.org-library";
/** The catalog body cap (contract §1.8). */
export const ORG_LIBRARY_CATALOG_MAX_BYTES = 256 * 1024;
export const ORG_LIBRARY_MAX_ENTRIES = 100;
export const ORG_LIBRARY_REPORT_MAX_ENTRIES = 100;

const UUID = /^[a-f0-9-]{36}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const INSTALL_ID = /^[a-f0-9]{32}$/;
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const REF = /^[a-z][a-z0-9-]{1,30}\/[a-z0-9][a-z0-9-]{0,79}$/;

/** Electron's safeText rule (electron/managed-desktop.mjs): no control characters. */
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
// oxlint-disable-next-line no-control-regex
const CONTROL_EXCEPT_LINES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const safeText = (max: number) => z.string().min(1).max(max).refine((value) => !CONTROL.test(value));
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const entrySchema = z.object({
  packageId: z.string().regex(UUID),
  ref: z.string().regex(REF),
  name: safeText(100),
  tagline: safeText(160),
  kind: z.enum(["team", "library"]),
  publisher: z.object({ organizationId: z.string().regex(UUID), name: safeText(100), self: z.boolean() }),
  mode: z.enum(["required", "available", "off"]),
  offAction: z.enum(["keep", "remove"]),
  release: z.object({
    version: z.string().regex(SEMVER),
    sha256: z.string().regex(HEX64),
    sizeBytes: z.number().int().min(1).max(PACKAGE_MAX_BYTES),
    formatVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    publishedAt: count,
    notes: z.string().max(4_000).refine((value) => !CONTROL_EXCEPT_LINES.test(value)),
  }).nullable(),
  withdrawnReleases: z.array(z.object({ version: z.string().regex(SEMVER), sha256: z.string().regex(HEX64) })).max(50),
  contents: z.object({
    bots: count, skills: count, presets: count, rooms: count, routines: count, connections: count,
    botNames: z.array(safeText(100)).max(12),
  }),
  scanFindings: count,
});
export type OrgLibraryEntry = z.output<typeof entrySchema>;

const envelopeSchema = z.object({
  format: z.literal(ORG_LIBRARY_FORMAT),
  version: z.literal(1),
  libraryVersion: count,
  organization: z.object({ id: z.string().regex(UUID), name: safeText(100) }),
  truncated: z.literal(true).optional(),
  packages: z.array(z.unknown()).max(ORG_LIBRARY_MAX_ENTRIES),
});

export interface OrgLibraryCatalog {
  format: typeof ORG_LIBRARY_FORMAT;
  version: 1;
  libraryVersion: number;
  organization: { id: string; name: string };
  truncated?: true;
  packages: OrgLibraryEntry[];
}

/** The catalog as §5.3 defines it. Unknown fields are ignored and a malformed
 * entry is dropped; a malformed envelope returns null (keep the last one). */
export function parseOrgLibraryCatalog(value: unknown): OrgLibraryCatalog | null {
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) return null;
  const seen = new Set<string>();
  const packages = envelope.data.packages.flatMap((raw) => {
    const entry = entrySchema.safeParse(raw);
    if (!entry.success || seen.has(entry.data.packageId)) return [];
    seen.add(entry.data.packageId);
    return [entry.data];
  });
  return {
    format: ORG_LIBRARY_FORMAT,
    version: 1,
    libraryVersion: envelope.data.libraryVersion,
    organization: { ...envelope.data.organization },
    ...(envelope.data.truncated ? { truncated: true as const } : {}),
    packages,
  };
}

/** An Admin origin: https, or http on loopback, with nothing after the host. */
function adminOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback))) return null;
    return url.origin === value ? value : null;
  } catch {
    return null;
  }
}

const relaySchema = z.object({
  adminOrigin: z.string(),
  organizationId: z.string().regex(UUID),
  organizationName: safeText(100).optional(),
  digest: z.string().regex(HEX64),
  catalog: z.unknown(),
});

/** One install as the report sends it (contract §5.5). */
export interface OrgLibraryReportEntry {
  packageId: string;
  release: string;
  sha256: string;
  state: "installed" | "failed" | "removed" | "withdrawn";
  reason?: "blob_unavailable" | "invalid_package" | "import_failed" | "newer_app_required"
    | "connection_refused_by_policy" | "removed_locally" | "withdrawn_by_publisher";
}

export interface OrgLibraryStateMessage {
  type: "openmausbot:managed-library-state";
  digest: string;
  packages: OrgLibraryReportEntry[];
}

// ── state.json (contract §3.4) ──────────────────────────────────────────

const partPair = z.object({ r: z.string().regex(HEX64), w: z.string().regex(HEX64) });
const installSchema = z.object({
  packageId: z.string().regex(UUID),
  ref: z.string().regex(REF),
  publisher: z.object({ organizationId: z.string().regex(UUID), slug: z.string().min(1).max(40), name: z.string().min(1).max(100) }),
  release: z.string().regex(SEMVER),
  sha256: z.string().regex(HEX64),
  status: z.enum(["installed", "withdrawn", "removed"]),
  // Additive to §3.4: what kind of package, and its display name.
  kind: z.enum(["team", "library"]).default("team"),
  name: z.string().max(100).default(""),
  section: z.string().max(60),
  team: z.object({ parts: z.object({ name: partPair.optional(), brief: partPair.optional(), leader: partPair.optional() }) }),
  bots: z.record(z.string(), z.string()),
  rooms: z.record(z.string(), z.string()),
  routines: z.record(z.string(), z.string()),
  connections: z.record(z.string(), z.object({ name: z.string(), r: z.string().regex(HEX64), w: z.string().regex(HEX64) })),
  presets: z.record(z.string(), z.object({ presetId: z.string(), r: z.string().regex(HEX64) })),
  removedLocally: z.array(z.string()).max(1_000),
  // Additive to §3.4: a removed team's release whose withdrawal has already
  // switched off the copies it left (offered skills on other bots).
  withdrawnHandled: z.string().regex(HEX64).optional(),
  addedAt: count,
  updatedAt: count,
});
export type OrgInstall = z.output<typeof installSchema>;

// Additive to §3.4: a team Add that has started and not finished. Written
// before the first record, removed with the index write that completes it.
// The import is synchronous, so one found on disk means the app stopped
// mid-import (the importer's own rollback runs on errors only).
const partKeys = z.array(z.string().min(1).max(64)).max(500);
const addingSchema = z.object({
  packageId: z.string().regex(UUID),
  ref: z.string().regex(REF),
  publisher: installSchema.shape.publisher,
  name: z.string().max(100),
  release: z.string().regex(SEMVER),
  sha256: z.string().regex(HEX64),
  startedAt: count,
  /** What a finished import has: every bot, group chat and routine key, and the leader. */
  expect: z.object({ bots: partKeys, rooms: partKeys, routines: partKeys, leader: z.string().min(1).max(64).nullable() }),
});
export type OrgPendingAdd = z.output<typeof addingSchema>;

const stateSchema = z.object({
  version: z.literal(1),
  source: z.object({ adminOrigin: z.string(), organizationId: z.string().regex(UUID) }).nullable(),
  appliedDigest: z.string().regex(HEX64).nullable(),
  installs: z.record(z.string().regex(INSTALL_ID), z.unknown()),
  adding: z.record(z.string().regex(INSTALL_ID), z.unknown()).optional(),
});

export interface OrgLibraryStateFile {
  version: 1;
  source: { adminOrigin: string; organizationId: string } | null;
  appliedDigest: string | null;
  installs: Record<string, OrgInstall>;
  adding: Record<string, OrgPendingAdd>;
}

function emptyState(): OrgLibraryStateFile {
  return { version: 1, source: null, appliedDigest: null, installs: {}, adding: {} };
}

/** What scanRecords finds for one install id. */
interface LiveRecords {
  bots: Record<string, string>;
  rooms: Record<string, string>;
  routines: Record<string, string>;
  /** Skill-state entries carrying the install, on any bot. */
  skills: number;
  sections: string[];
  meta?: InstalledPackageMetadata;
}

/** A team install lives in its own bots, group chats and routines. An
 * offered skill someone put on another bot is a copy, like any skill: it
 * stays, but it does not keep the team "installed". */
function teamAlive(live: LiveRecords | undefined): boolean {
  return Boolean(live && (Object.keys(live.bots).length || Object.keys(live.rooms).length || Object.keys(live.routines).length));
}

/** Contract §3.4 `removedLocally`: the parts the person deleted, so the
 * automatic update (v1.1) can tell them from parts a new release adds and
 * never brings them back. Before an install's bots, group chats and routines
 * are replaced by what is left, each key that went is noted once, as
 * `agent:<key>`, `room:<key>` or `routine:<key>`. A key that exists again
 * (records restored from a backup) is dropped, so the list never names a
 * part that is there. Returns whether the list changed. */
function noteRemovedParts(install: OrgInstall, next: Pick<LiveRecords, "bots" | "rooms" | "routines">): boolean {
  const removed = new Set(install.removedLocally);
  const present = new Set<string>();
  for (const [kind, was, now] of [
    ["agent", install.bots, next.bots],
    ["room", install.rooms, next.rooms],
    ["routine", install.routines, next.routines],
  ] as const) {
    for (const key of Object.keys(was)) if (!Object.hasOwn(now, key)) removed.add(`${kind}:${key}`);
    for (const key of Object.keys(now)) present.add(`${kind}:${key}`);
  }
  const after = [...removed].filter((part) => !present.has(part));
  if (after.length === install.removedLocally.length && after.every((part, index) => part === install.removedLocally[index])) return false;
  install.removedLocally = after;
  return true;
}

// ── the library ─────────────────────────────────────────────────────────

export interface OrgLibraryDeps {
  /** DATA_DIR; the library lives in DATA_DIR/org-library/. */
  dataDir: string;
  store: Store;
  routines: Pick<RoutineManager, "packageStamps" | "update" | "listRoutines" | "remove">;
  skills: {
    list(botId: string): SkillListing[];
    stamps(botId: string): Array<{ name: string; enabled: boolean; stamp: SkillPackageStamp }>;
    setEnabled(botId: string, name: string, enabled: boolean): SkillListing | { error: string };
    installOrg(botId: string, source: string, skillMd: string, stamp: SkillPackageStamp): SkillListing | { error: string };
  };
  /** Runtime → Electron main: the report snapshot. Absent in plain Node. */
  postState?: (message: OrgLibraryStateMessage) => void;
  now?: () => number;
  /** Preset bots (presets.ts): an install's preset rows carry its id. */
  presets?: { list(): StoredPreset[] };
}

interface AppliedLibrary {
  adminOrigin: string;
  organizationId: string;
  digest: string;
  catalog: OrgLibraryCatalog;
}

export type BlobStatus = "ready" | "unavailable" | "unsupported";

export interface OrgLibraryListEntry extends OrgLibraryEntry {
  blob: BlobStatus;
  installed: { installId: string; release: string; status: OrgInstall["status"] } | null;
}

export interface OrgLibraryListing {
  organization: { id: string; name: string } | null;
  packages: OrgLibraryListEntry[];
  /** What this desktop added from the current organization, including
   * packages the catalog no longer lists (their copies stay). */
  installs?: Array<{ installId: string; packageId: string; name: string; release: string; status: OrgInstall["status"]; publisher: string }>;
}

export interface OfferedSkill {
  installId: string;
  packageName: string;
  publisher: string;
  release: string;
  name: string;
  description: string;
  /** This bot already has a skill of that name. */
  added: boolean;
}

/** Plain sentences for the person; `code` for the renderer and tests. */
export type OrgLibraryOutcome<T> =
  | { ok: true; status: number; value: T }
  | { ok: false; status: number; code: string; error: string };

const refusal = (status: number, code: string, error: string) => ({ ok: false as const, status, code, error });

const NOT_LISTED = "This package is not in your organization's library.";
const NOT_READY = "This package hasn't finished downloading yet. Try again in a minute.";
const NEWER_APP = "Update OpenMausBot to add this package.";
const ADD_FAILED = "This package could not be added, so nothing was changed. Try again, or ask your organization's admin.";

export class OrgLibrary {
  private readonly deps: OrgLibraryDeps;
  private readonly root: string;
  private state: OrgLibraryStateFile;
  private library: AppliedLibrary | null = null;
  /** Adds that failed since the last success, by package (reported as failed). */
  private readonly failures = new Map<string, OrgLibraryReportEntry>();
  /** stat-keyed "this blob verified" cache for listings; content reads always re-verify. */
  private readonly verified = new Map<string, string>();
  private pending: Promise<void> = Promise.resolve();
  private recheck: ReturnType<typeof setTimeout> | null = null;
  private lastPosted: OrgLibraryStateMessage | null = null;
  /** The install id add() is importing right now (never a crashed one). */
  private importing: string | null = null;
  private readonly unsubscribe: () => void;

  constructor(deps: OrgLibraryDeps) {
    this.deps = deps;
    this.root = join(deps.dataDir, "org-library");
    this.state = this.load();
    // Records are the source of truth: reconcile the index with what exists.
    if (this.rebuild()) this.save();
    this.unsubscribe = deps.store.onChange((change) => this.onStoreChange(change));
  }

  dispose(): void {
    this.unsubscribe();
    if (this.recheck) clearTimeout(this.recheck);
  }

  /** Resolves once relayed work (reconcile, withdrawn handling, report) is done. */
  settled(): Promise<void> {
    return this.pending;
  }

  /** The last report snapshot handed to Electron (for tests and fixtures). */
  lastReport(): OrgLibraryStateMessage | null {
    return this.lastPosted ? structuredClone(this.lastPosted) : null;
  }

  get organization(): { id: string; name: string } | null {
    return this.library ? { ...this.library.catalog.organization } : null;
  }

  // ── the relay (Electron main → runtime) ───────────────────────────────

  /** `openmausbot:managed-library`: swap the catalog and return at once; the
   * reconcile and the report run afterwards (the relay times out at 15 s).
   * null (sign-out, expiry, revocation) hides the shelf and changes nothing
   * else: everything already added stays. */
  applyRelay(value: unknown): { ok: true } | { ok: false; error: string } {
    if (value === null) {
      this.library = null;
      return { ok: true };
    }
    const relay = relaySchema.safeParse(value);
    const origin = relay.success ? adminOrigin(relay.data.adminOrigin) : null;
    if (!relay.success || !origin) return { ok: false, error: "The organization's library could not be read." };
    let raw = relay.data.catalog;
    if (typeof raw === "string") {
      // The raw body Electron applied: it must be the bytes the digest names.
      if (Buffer.byteLength(raw, "utf8") > ORG_LIBRARY_CATALOG_MAX_BYTES || sha256Hex(raw) !== relay.data.digest) {
        return { ok: false, error: "The organization's library could not be read." };
      }
      try {
        raw = JSON.parse(raw);
      } catch {
        return { ok: false, error: "The organization's library could not be read." };
      }
    }
    const catalog = parseOrgLibraryCatalog(raw);
    // A malformed envelope or another organization's catalog keeps the last one.
    if (!catalog || catalog.organization.id !== relay.data.organizationId) {
      return { ok: false, error: "The organization's library could not be read." };
    }
    this.library = { adminOrigin: origin, organizationId: relay.data.organizationId, digest: relay.data.digest, catalog };
    const applied = this.library;
    this.pending = this.pending.then(() => new Promise<void>((resolve) => {
      setImmediate(() => {
        try {
          if (this.library === applied) this.reconcile(applied);
        } catch (error) {
          console.error(`[org-library] could not apply the library: ${error instanceof Error ? error.message : String(error)}`);
        }
        resolve();
      });
    }));
    return { ok: true };
  }

  private reconcile(applied: AppliedLibrary): void {
    this.rebuild();
    this.handleWithdrawn();
    this.state.source = { adminOrigin: applied.adminOrigin, organizationId: applied.organizationId };
    this.state.appliedDigest = applied.digest;
    this.save();
    this.report();
  }

  // ── records → index ───────────────────────────────────────────────────

  private currentInstallId(packageId: string): string | null {
    return this.library ? orgInstallId(this.library.adminOrigin, this.library.organizationId, packageId) : null;
  }

  /** Every live record that carries an organization install id. A routine
   * counts only while its bot exists (deleting a bot pauses, not removes,
   * its routines). */
  private scanRecords(): Map<string, LiveRecords> {
    const { store } = this.deps;
    const found = new Map<string, LiveRecords>();
    const entry = (installId: string) => {
      let value = found.get(installId);
      if (!value) {
        value = { bots: {}, rooms: {}, routines: {}, skills: 0, sections: [] };
        found.set(installId, value);
      }
      return value;
    };
    for (const bot of store.bots) {
      const stamp = bot.installedPackage;
      if (stamp?.source === "org" && stamp.installId && INSTALL_ID.test(stamp.installId) && stamp.agentKey) {
        const value = entry(stamp.installId);
        value.bots[stamp.agentKey] = bot.id;
        value.sections.push(sectionKey(bot.section));
        value.meta ??= stamp;
      }
      for (const skill of this.deps.skills.stamps(bot.id)) entry(skill.stamp.installId).skills += 1;
    }
    for (const group of store.groups) {
      if (group.installedPackage) entry(group.installedPackage.installId).rooms[group.installedPackage.key] = group.id;
    }
    for (const routine of this.deps.routines.packageStamps()) {
      if (store.bot(routine.botId)) entry(routine.stamp.installId).routines[routine.stamp.key] = routine.routineId;
    }
    return found;
  }

  /** Whether anything here came from an organization. Without an install,
   * a stamped record or a relayed catalog there is nothing to reconcile, so
   * an installation that never had an organization reads no skill state at
   * all. (Skill stamps alone are read only once a catalog arrives: they are
   * how a skills-only package is recognized after a lost state.json.) */
  private hasOrgRecords(): boolean {
    return Object.keys(this.state.installs).length > 0 ||
      Object.keys(this.state.adding).length > 0 ||
      this.deps.store.bots.some((bot) => bot.installedPackage?.source === "org") ||
      this.deps.store.groups.some((group) => group.installedPackage) ||
      this.deps.routines.packageStamps().length > 0 ||
      this.orgPresetRows().length > 0;
  }

  /** Preset rows (presets.ts) an organization install registered. */
  private orgPresetRows(): StoredPreset[] {
    return (this.deps.presets?.list() ?? []).filter((row) => row.source === "org" && INSTALL_ID.test(row.installId));
  }

  /** Reconcile state.json with the records. Returns whether it changed. */
  rebuild(): boolean {
    if (!this.library && !this.hasOrgRecords()) return false;
    const now = this.deps.now?.() ?? Date.now();
    let changed = this.resolveInterruptedAdds(now);
    const records = this.scanRecords();
    for (const [installId, install] of Object.entries(this.state.installs)) {
      const live = records.get(installId);
      if (!teamAlive(live)) {
        // A library install creates no records of its own; it stays.
        if (install.kind === "team" && install.status !== "removed") {
          // Every part is noted too, so the list reads the same whether the
          // person deleted the team at once or one bot at a time.
          noteRemovedParts(install, { bots: {}, rooms: {}, routines: {} });
          install.status = "removed";
          install.bots = {};
          install.rooms = {};
          install.routines = {};
          install.updatedAt = now;
          changed = true;
        }
        continue;
      }
      const next = {
        bots: live!.bots,
        rooms: live!.rooms,
        routines: live!.routines,
        section: mostCommon(live!.sections) ?? install.section,
        status: install.status === "removed" ? "installed" as const : install.status,
      };
      const noted = noteRemovedParts(install, next);
      if (noted || JSON.stringify([install.bots, install.rooms, install.routines, install.section, install.status]) !==
          JSON.stringify([next.bots, next.rooms, next.routines, next.section, next.status])) {
        Object.assign(install, next, { updatedAt: now });
        changed = true;
      }
    }
    // Records with no index entry: a crash after the records but before
    // state.json. Adopt them once the catalog says which package they are.
    for (const [installId, live] of records) {
      if (this.state.installs[installId] || !this.library) continue;
      const entry = this.library.catalog.packages.find((candidate) => this.currentInstallId(candidate.packageId) === installId);
      if (!entry) continue;
      // A team is adopted from its own records. A skills-only package has
      // none; an offered skill carrying its stamp shows it was added.
      if (entry.kind === "team" ? !teamAlive(live) : !live.skills) continue;
      const meta = live.meta;
      const [slug] = entry.ref.split("/");
      this.state.installs[installId] = {
        packageId: entry.packageId,
        ref: meta?.ref ?? entry.ref,
        publisher: meta?.publisher ?? { organizationId: entry.publisher.organizationId, slug: slug!, name: entry.publisher.name },
        release: meta?.release ?? entry.release?.version ?? "0.0.0",
        sha256: meta?.sha256 ?? entry.release?.sha256 ?? "0".repeat(64),
        status: "installed",
        kind: entry.kind,
        name: meta?.name ?? entry.name,
        section: mostCommon(live.sections) ?? "",
        // What was written at install is not recoverable here; with no base
        // hashes a later update treats these parts as edited and keeps them.
        // Nor is what the person deleted before state.json was lost, so
        // removedLocally starts empty (docs/org-library.md, known limit).
        team: { parts: {} },
        bots: live.bots,
        rooms: live.rooms,
        routines: live.routines,
        connections: {},
        presets: {},
        removedLocally: [],
        addedAt: now,
        updatedAt: now,
      };
      changed = true;
    }
    if (this.indexPresets(now)) changed = true;
    return changed;
  }

  /** Preset rows never keep a team "installed" (its bots, group chats and
   * routines do), but they are a skills-and-presets package's only records.
   * Such an install whose index entry was lost (the app stopped between
   * presets.json and state.json, or state.json could not be read) is adopted
   * from them, so Add stays a no-op, its skills stay offered and a
   * withdrawal still reaches its presets. An adopted install of either kind
   * gets its presets back in the index. */
  private indexPresets(now: number): boolean {
    const byInstall = new Map<string, StoredPreset[]>();
    for (const row of this.orgPresetRows()) byInstall.set(row.installId, [...(byInstall.get(row.installId) ?? []), row]);
    let changed = false;
    for (const [installId, rows] of byInstall) {
      let install = this.state.installs[installId];
      if (!install) {
        const entry = this.library?.catalog.packages.find((candidate) => this.currentInstallId(candidate.packageId) === installId);
        // A team is adopted from its own records (above), never from presets alone.
        if (!entry || entry.kind !== "library") continue;
        const row = rows[0]!;
        const [slug] = entry.ref.split("/");
        const adopted = installSchema.safeParse({
          packageId: entry.packageId,
          ref: row.ref ?? entry.ref,
          publisher: row.publisher ?? { organizationId: entry.publisher.organizationId, slug, name: entry.publisher.name },
          release: row.release,
          sha256: row.sha256 ?? entry.release?.sha256,
          status: "installed", kind: "library", name: entry.name, section: "", team: { parts: {} },
          bots: {}, rooms: {}, routines: {}, connections: {}, presets: {}, removedLocally: [], addedAt: now, updatedAt: now,
        });
        if (!adopted.success) continue;
        install = this.state.installs[installId] = adopted.data;
        changed = true;
      }
      if (Object.keys(install.presets).length) continue;
      // A row is the preset exactly as the release carried it (§1.6).
      install.presets = Object.fromEntries(rows.map((row) => [row.key, { presetId: row.id, r: partHash(storedPresetObject(row)) }]));
      install.updatedAt = now;
      changed = true;
    }
    return changed;
  }

  /** Team Adds the app never finished (it stopped mid-import). A team whose
   * records are all there is indexed, as any crash after the records is
   * (§3.3). A partial one is removed again, so the person can add it whole
   * from the shelf instead of keeping half a team that Add calls added. */
  private resolveInterruptedAdds(now: number): boolean {
    const pending = Object.entries(this.state.adding).filter(([installId]) => installId !== this.importing);
    if (!pending.length) return false;
    const records = this.scanRecords();
    for (const [installId, add] of pending) {
      const live = records.get(installId);
      if (live && this.finished(add, live)) {
        const previous = this.state.installs[installId];
        this.state.installs[installId] = {
          packageId: add.packageId, ref: add.ref, publisher: { ...add.publisher }, release: add.release, sha256: add.sha256,
          status: "installed", kind: "team", name: add.name, section: mostCommon(live.sections) ?? "",
          // As with any adopted install, the team-part and connection hashes
          // were only in the index write that never happened.
          team: { parts: {} }, bots: live.bots, rooms: live.rooms, routines: live.routines, connections: {}, presets: {},
          removedLocally: [], addedAt: previous?.addedAt ?? add.startedAt, updatedAt: now,
        };
      } else {
        if (live && teamAlive(live)) this.discardPartial(installId, live);
        this.failures.set(add.packageId, { packageId: add.packageId, release: add.release, sha256: add.sha256, state: "failed", reason: "import_failed" });
      }
      delete this.state.adding[installId];
    }
    return true;
  }

  /** Every bot (with its skills and starter notes), group chat and routine
   * the Add would have written, and its leader, which is set last. */
  private finished(add: OrgPendingAdd, live: LiveRecords): boolean {
    const { store } = this.deps;
    return add.expect.bots.every((key) => Boolean(live.bots[key] && store.bot(live.bots[key]!)?.packageBase)) &&
      add.expect.rooms.every((key) => Boolean(live.rooms[key])) &&
      add.expect.routines.every((key) => Boolean(live.routines[key])) &&
      (add.expect.leader === null || store.bot(live.bots[add.expect.leader] ?? "")?.chiefOfStaff === true);
  }

  /** The importer's rollback, for an import the app stopped in the middle
   * of: its routines, group chats and bots go, and its new team with them.
   * Every one of its routines belongs to one of its new bots, and a group
   * chat it had not stamped yet has only those bots in that team. */
  private discardPartial(installId: string, live: LiveRecords): void {
    const { store, routines } = this.deps;
    const botIds = new Set(Object.values(live.bots));
    for (const routine of routines.listRoutines()) {
      if (botIds.has(routine.botId)) routines.remove(routine.id);
    }
    const section = mostCommon(live.sections);
    const groups = store.groups.filter((group) => group.installedPackage?.installId === installId ||
      (!group.installedPackage && section !== undefined && sectionKey(group.section) === section &&
        group.memberIds.length > 0 && group.memberIds.every((id) => botIds.has(id))));
    for (const group of groups) store.deleteGroup(group.id);
    for (const id of botIds) store.deleteBot(id);
    // Only if nothing else is in it (the store refuses otherwise).
    if (section && store.sections.includes(section)) store.changeEmptySection(section, null);
    console.warn(`[org-library] removed a team that was only partly added when OpenMausBot stopped; it can be added again from the shelf`);
  }

  /** A release its publisher withdrew: its skills off, its routines paused,
   * its status "withdrawn". Only the transition acts, so a person who
   * switches something back on afterwards is not overruled again. A team
   * the person already removed stays "removed", but an offered skill it
   * left on another bot is switched off too, once. */
  private handleWithdrawn(): boolean {
    if (!this.library) return false;
    let changed = false;
    for (const [installId, install] of Object.entries(this.state.installs)) {
      if (this.currentInstallId(install.packageId) !== installId) continue;
      if (install.status === "withdrawn" || (install.status === "removed" && install.withdrawnHandled === install.sha256)) continue;
      const entry = this.library.catalog.packages.find((candidate) => candidate.packageId === install.packageId);
      if (!entry?.withdrawnReleases.some((withdrawn) => withdrawn.sha256 === install.sha256)) continue;
      this.switchOff(installId);
      if (install.status === "installed") install.status = "withdrawn";
      else install.withdrawnHandled = install.sha256;
      install.updatedAt = this.deps.now?.() ?? Date.now();
      changed = true;
    }
    return changed;
  }

  private switchOff(installId: string): void {
    for (const bot of this.deps.store.bots) {
      for (const skill of this.deps.skills.stamps(bot.id)) {
        if (skill.stamp.installId !== installId || !skill.enabled) continue;
        const result = this.deps.skills.setEnabled(bot.id, skill.name, false);
        if ("error" in result) console.warn(`[org-library] could not switch off ${skill.name}: ${result.error}`);
      }
    }
    // A bot made from one of the install's presets (presets.ts) got the
    // preset's skills under the release's organization source, unstamped.
    for (const bot of this.deps.store.bots) {
      const made = bot.installedPackage;
      if (made?.source !== "org" || made.installId !== installId || !made.presetKey || !made.ref) continue;
      const source = `org:${made.ref}@${made.release}`;
      for (const skill of this.deps.skills.list(bot.id)) {
        if (skill.source !== source || !skill.enabled) continue;
        const result = this.deps.skills.setEnabled(bot.id, skill.name, false);
        if ("error" in result) console.warn(`[org-library] could not switch off ${skill.name}: ${result.error}`);
      }
    }
    for (const routine of this.deps.routines.packageStamps()) {
      if (routine.stamp.installId !== installId || !routine.enabled) continue;
      try {
        this.deps.routines.update(routine.routineId, { enabled: false });
      } catch (error) {
        console.warn(`[org-library] could not pause a routine: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Bots, rooms or routines went away: when that removes an install's
   * last record, the index and the report say so. Debounced. */
  private onStoreChange(change: StoreChange): void {
    if (change.type !== "bot.deleted" && change.type !== "group.deleted" && change.type !== "sections") return;
    if (!Object.keys(this.state.installs).length) return;
    if (this.recheck) clearTimeout(this.recheck);
    this.recheck = setTimeout(() => {
      this.recheck = null;
      this.pending = this.pending.then(() => {
        try {
          if (this.rebuild()) {
            this.save();
            this.report();
          }
        } catch (error) {
          console.error(`[org-library] could not update the library index: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }, 250);
    this.recheck.unref?.();
  }

  // ── report ────────────────────────────────────────────────────────────

  /** The full snapshot for the current organization (contract §5.5). */
  reportEntries(): OrgLibraryReportEntry[] {
    const entries: OrgLibraryReportEntry[] = [];
    const reported = new Set<string>();
    for (const [installId, install] of Object.entries(this.state.installs)) {
      if (this.currentInstallId(install.packageId) !== installId) continue;
      reported.add(install.packageId);
      entries.push({
        packageId: install.packageId,
        release: install.release,
        sha256: install.sha256,
        state: install.status,
        ...(install.status === "withdrawn" ? { reason: "withdrawn_by_publisher" as const } : {}),
        ...(install.status === "removed" ? { reason: "removed_locally" as const } : {}),
      });
    }
    for (const failure of this.failures.values()) if (!reported.has(failure.packageId)) entries.push({ ...failure });
    return entries.slice(0, ORG_LIBRARY_REPORT_MAX_ENTRIES);
  }

  private report(): void {
    if (!this.library) return;
    const message: OrgLibraryStateMessage = {
      type: "openmausbot:managed-library-state",
      digest: this.library.digest,
      packages: this.reportEntries(),
    };
    this.lastPosted = message;
    try {
      this.deps.postState?.(message);
    } catch (error) {
      console.warn(`[org-library] could not send the library report: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── files ─────────────────────────────────────────────────────────────

  private statePath(): string {
    return join(this.root, "state.json");
  }

  private load(): OrgLibraryStateFile {
    let text: string;
    try {
      text = readFileSync(this.statePath(), "utf8");
    } catch {
      return emptyState();
    }
    try {
      const parsed = stateSchema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new Error("invalid");
      const installs: Record<string, OrgInstall> = {};
      for (const [installId, raw] of Object.entries(parsed.data.installs)) {
        const install = installSchema.safeParse(raw);
        if (install.success) installs[installId] = install.data;
      }
      const adding: Record<string, OrgPendingAdd> = {};
      for (const [installId, raw] of Object.entries(parsed.data.adding ?? {})) {
        const add = addingSchema.safeParse(raw);
        if (add.success) adding[installId] = add.data;
      }
      const origin = parsed.data.source ? adminOrigin(parsed.data.source.adminOrigin) : null;
      return {
        version: 1,
        source: parsed.data.source && origin ? { adminOrigin: origin, organizationId: parsed.data.source.organizationId } : null,
        appliedDigest: parsed.data.appliedDigest,
        installs,
        adding,
      };
    } catch {
      // The records are the source of truth; an unreadable index is rebuilt.
      console.warn("[org-library] state.json could not be read; rebuilding it from your bots, rooms and routines");
      return emptyState();
    }
  }

  private save(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.statePath(), `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
  }

  private blobPath(sha256: string): string {
    return join(this.root, "blobs", `${sha256}.json`);
  }

  /** The release bytes, only if they hash to `sha256`. Never follows a link. */
  readBlob(sha256: string): Buffer | null {
    if (!HEX64.test(sha256)) return null;
    let descriptor: number | null = null;
    try {
      const path = this.blobPath(sha256);
      const before = lstatSync(path);
      if (!before.isFile() || before.size > PACKAGE_MAX_BYTES) return null;
      descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size > PACKAGE_MAX_BYTES || opened.ino !== before.ino) return null;
      const bytes = readFileSync(descriptor);
      return sha256Hex(bytes) === sha256 ? bytes : null;
    } catch {
      return null;
    } finally {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {}
      }
    }
  }

  private blobStatus(entry: OrgLibraryEntry): BlobStatus {
    if (!entry.release) return "unavailable";
    if (entry.release.formatVersion > PACKAGE_VERSION) return "unsupported";
    const sha = entry.release.sha256;
    let key: string;
    try {
      const stat = lstatSync(this.blobPath(sha));
      if (!stat.isFile()) return "unavailable";
      key = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    } catch {
      return "unavailable";
    }
    if (this.verified.get(sha) === key) return "ready";
    if (!this.readBlob(sha)) return "unavailable";
    this.verified.set(sha, key);
    return "ready";
  }

  /** The verified release, parsed as the organization channel reads it. */
  private releaseDocument(entry: OrgLibraryEntry): OrgLibraryOutcome<PackageDocument> {
    if (!entry.release) return refusal(404, "no_release", "This package has no release to add right now.");
    if (entry.release.formatVersion > PACKAGE_VERSION) return refusal(409, "newer_app_required", NEWER_APP);
    const bytes = this.readBlob(entry.release.sha256);
    if (!bytes) return refusal(503, "blob_unavailable", NOT_READY);
    let document: PackageDocument;
    try {
      document = parsePackageDocument(JSON.parse(bytes.toString("utf8")), { trust: "org" });
    } catch (error) {
      if (error instanceof PackageFormatError && error.code === "newer_version") return refusal(409, "newer_app_required", NEWER_APP);
      return refusal(422, "invalid_package", `This package could not be read: ${error instanceof Error ? error.message : "it is not a valid package"}`);
    }
    const [publisherSlug, packageSlug] = entry.ref.split("/");
    if (document.package.id !== packageSlug || document.package.publisher?.organization !== publisherSlug) {
      return refusal(422, "invalid_package", "This package is not the one your organization listed.");
    }
    return { ok: true, status: 200, value: document };
  }

  private visibleEntry(packageId: string): OrgLibraryEntry | null {
    const entry = this.library?.catalog.packages.find((candidate) => candidate.packageId === packageId);
    return entry && entry.mode !== "off" ? entry : null;
  }

  private listEntry(entry: OrgLibraryEntry): OrgLibraryListEntry {
    const installId = this.currentInstallId(entry.packageId)!;
    const install = this.state.installs[installId];
    return {
      ...structuredClone(entry),
      blob: this.blobStatus(entry),
      installed: install ? { installId, release: install.release, status: install.status } : null,
    };
  }

  // ── renderer routes ───────────────────────────────────────────────────

  /** GET /api/org-library. With no organization: {organization: null, packages: []}. */
  list(): OrgLibraryListing {
    if (!this.library) return { organization: null, packages: [] };
    return {
      organization: { ...this.library.catalog.organization },
      packages: this.library.catalog.packages.filter((entry) => entry.mode !== "off").map((entry) => this.listEntry(entry)),
      installs: Object.entries(this.state.installs)
        .filter(([installId, install]) => this.currentInstallId(install.packageId) === installId)
        .map(([installId, install]) => ({
          installId, packageId: install.packageId, name: install.name, release: install.release, status: install.status, publisher: install.publisher.name,
        })),
    };
  }

  /** GET /api/org-library/packages/:packageId — the preview, from the verified file. */
  preview(packageId: string): OrgLibraryOutcome<{ package: OrgLibraryListEntry; document: PackageDocument }> {
    const entry = this.visibleEntry(packageId);
    if (!entry) return refusal(404, "not_listed", NOT_LISTED);
    const document = this.releaseDocument(entry);
    if (!document.ok) return document;
    return { ok: true, status: 200, value: { package: this.listEntry(entry), document: document.value } };
  }

  /** POST /api/org-library/add — one click, no confirmation: the person's
   * click is the decision. Idempotent per install id. */
  add(packageId: string, importDeps: PackageImportDeps):
    OrgLibraryOutcome<{ alreadyAdded: true; installId: string } | { alreadyAdded: false; result: PackageImportResult }> {
    const library = this.library;
    const entry = this.visibleEntry(packageId);
    if (!library || !entry) return refusal(404, "not_listed", NOT_LISTED);
    const installId = this.currentInstallId(packageId)!;
    if (this.rebuild()) this.save();
    const existing = this.state.installs[installId];
    if (existing && existing.status !== "removed") return { ok: true, status: 200, value: { alreadyAdded: true, installId } };

    const fail = (outcome: ReturnType<typeof refusal>, reason: NonNullable<OrgLibraryReportEntry["reason"]>) => {
      if (entry.release) {
        this.failures.set(packageId, { packageId, release: entry.release.version, sha256: entry.release.sha256, state: "failed", reason });
        this.report();
      }
      return outcome;
    };
    const document = this.releaseDocument(entry);
    if (!document.ok) {
      if (document.code === "no_release") return document;
      return fail(document, document.code === "blob_unavailable" ? "blob_unavailable" : document.code === "newer_app_required" ? "newer_app_required" : "invalid_package");
    }
    const release = entry.release!;
    const [slug] = entry.ref.split("/");
    const publisher = { organizationId: entry.publisher.organizationId, slug: slug!, name: entry.publisher.name };
    const pkg = document.value.package;
    // A team's Add is marked before its first record is written, so if the
    // app stops mid-import the next start finishes the job one way or the
    // other (resolveInterruptedAdds). A skills-only package writes nothing.
    const pending = pkg.agents.length > 0 && Boolean(pkg.team);
    const settle = () => {
      if (!pending) return;
      delete this.state.adding[installId];
      this.importing = null;
    };
    if (pending) {
      this.state.adding[installId] = {
        packageId, ref: entry.ref, publisher, name: entry.name, release: release.version, sha256: release.sha256,
        startedAt: this.deps.now?.() ?? Date.now(),
        expect: {
          bots: pkg.agents.map((agent) => agent.key),
          rooms: (pkg.rooms ?? []).map((room) => room.key),
          routines: (pkg.routines ?? []).map((routine) => routine.key),
          leader: pkg.team?.leader ?? null,
        },
      };
      try {
        this.save();
      } catch (error) {
        delete this.state.adding[installId];
        console.error(`[org-library] could not start adding ${entry.ref}: ${error instanceof Error ? error.message : String(error)}`);
        return fail(refusal(500, "import_failed", ADD_FAILED), "import_failed");
      }
      this.importing = installId;
    }
    let result: PackageImportResult;
    try {
      const imported = importPackageDocument(document.value, {
        trust: "org",
        mode: "add",
        org: { installId, ref: entry.ref, packageId, sha256: release.sha256, publisher, adminOrigin: library.adminOrigin, organizationId: library.organizationId },
      }, importDeps);
      if (imported.alreadyAdded) {
        settle();
        this.rebuild();
        this.save();
        return { ok: true, status: 200, value: { alreadyAdded: true, installId } };
      }
      result = imported;
    } catch (error) {
      // The importer removed everything it created.
      settle();
      try {
        this.save();
      } catch {}
      if (error instanceof PackageImportError) return fail(refusal(422, error.code, error.message), "invalid_package");
      console.error(`[org-library] could not add ${entry.ref}: ${error instanceof Error ? error.message : String(error)}`);
      return fail(refusal(500, "import_failed", ADD_FAILED), "import_failed");
    }
    const now = this.deps.now?.() ?? Date.now();
    const index: OrgInstallIndex = result.org!;
    settle();
    this.state.installs[installId] = {
      packageId,
      ref: entry.ref,
      publisher,
      release: release.version,
      sha256: release.sha256,
      status: "installed",
      kind: index.kind,
      name: entry.name,
      section: index.section,
      team: { parts: index.team.parts as Partial<Record<TeamPart, PartPair>> },
      bots: index.bots,
      rooms: index.rooms,
      routines: index.routines,
      connections: index.connections,
      // Presets now in New bot (presets.ts), with the release-side hash (§1.6).
      presets: Object.fromEntries((result.presets ?? []).flatMap((preset) => {
        const released = document.value.package.presets?.find((candidate) => candidate.key === preset.key);
        return released ? [[preset.key, { presetId: preset.id, r: partHash(released) }]] : [];
      })),
      removedLocally: [],
      addedAt: now,
      updatedAt: now,
    };
    this.failures.delete(packageId);
    // The records were written first; the index follows, and clears the mark.
    this.save();
    this.report();
    return { ok: true, status: 201, value: { alreadyAdded: false, result } };
  }

  /** The skills installs offer without putting them on a bot (library
   * packages, and a team's unassigned skills): Bot → Skills → From {Org}. */
  offeredSkills(botId?: string): { organization: { id: string; name: string } | null; skills: OfferedSkill[] } {
    if (!this.library) return { organization: null, skills: [] };
    const have = new Set(botId && this.deps.store.bot(botId) ? this.deps.skills.list(botId).map((skill) => skill.name) : []);
    const skills: OfferedSkill[] = [];
    for (const [installId, install] of Object.entries(this.state.installs)) {
      if (install.status !== "installed" || this.currentInstallId(install.packageId) !== installId) continue;
      const document = this.installDocument(install);
      if (!document) continue;
      const referenced = new Set(document.package.agents.flatMap((agent) => agent.skills ?? []));
      for (const skill of document.package.skills?.entries ?? []) {
        if (referenced.has(skill.name)) continue;
        skills.push({
          installId, packageName: install.name || document.package.name, publisher: install.publisher.name, release: install.release,
          name: skill.name, description: skill.description, added: have.has(skill.name),
        });
      }
    }
    return { organization: { ...this.library.catalog.organization }, skills };
  }

  private installDocument(install: OrgInstall): PackageDocument | null {
    const bytes = this.readBlob(install.sha256);
    if (!bytes) return null;
    try {
      return parsePackageDocument(JSON.parse(bytes.toString("utf8")), { trust: "org" });
    } catch {
      return null;
    }
  }

  /** Put one offered skill on a bot, switched on, stamped with its install. */
  addOfferedSkill(botId: string, installId: string, name: string): OrgLibraryOutcome<SkillListing> {
    if (!this.library) return refusal(404, "not_listed", NOT_LISTED);
    const bot = this.deps.store.bot(botId);
    if (!bot) return refusal(404, "no_bot", "That bot no longer exists.");
    const install = this.state.installs[installId];
    if (!install || this.currentInstallId(install.packageId) !== installId || install.status !== "installed") {
      return refusal(404, "not_listed", NOT_LISTED);
    }
    const document = this.installDocument(install);
    if (!document) return refusal(503, "blob_unavailable", NOT_READY);
    const referenced = new Set(document.package.agents.flatMap((agent) => agent.skills ?? []));
    const skill = document.package.skills?.entries.find((candidate) => candidate.name === name && !referenced.has(candidate.name));
    if (!skill) return refusal(404, "no_skill", "That skill is not offered by this package.");
    if (this.deps.skills.list(botId).some((existing) => existing.name === name)) {
      return refusal(409, "skill_exists", `${bot.name} already has a skill named ${name}.`);
    }
    const added = this.deps.skills.installOrg(botId, `org:${install.ref}@${install.release}`, skill.instructions,
      { installId, key: skill.name, release: install.release, ...pair(skill.instructions, skill.instructions) });
    if ("error" in added) return refusal(422, "skill_failed", `The skill could not be added: ${added.error}`);
    return { ok: true, status: 201, value: added };
  }
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, total] of counts) {
    if (total > bestCount) {
      best = value;
      bestCount = total;
    }
  }
  return best;
}

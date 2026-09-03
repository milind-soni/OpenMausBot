// Installed browser extensions: the state file, and the install → review →
// enable → remove lifecycle around it.
//
// The policy, in one paragraph. An extension is third-party code that runs
// inside every page any bot opens, in a browser session that holds the
// person's live logins. So: only a person installs one (no agent tool
// reaches this module), an install always lands DISABLED, and enabling it
// requires that the bytes on disk still hash to what the review dialog
// showed. server/skills.ts takes the same shape for the same reason, and
// this file deliberately mirrors it.
//
// Why the state lives here and not in config.json: parseStoredConfig
// (server/config.ts) discards the entire config when the stored document
// fails its schema, so one malformed extension record would take a person's
// whole configuration with it. Keeping it in its own file also means
// PATCH /api/config can never flip `enabled` past the review gate, because
// the field is not in appConfigPatchSchema at all. Precedents:
// the skills manifest, and browser-cleanups.json.
//
// Copies, not references. An install copies the chosen folder into
// DATA_DIR. Loading a person's live folder would let the extension change
// after review — edit a file, and the next session load runs code nobody
// looked at. The copy plus the tree hash closes that.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import {
  downloadCrx,
  hashExtensionDir,
  hashExtensionFiles,
  injectManifestKey,
  parseCrx3,
  parseExtensionManifest,
  parseWebstoreSource,
  readUnpackedExtension,
  unzipSafely,
  verifyCrxId,
  verifyCrxSignature,
  type ExtensionFile,
} from "./browser-extension-crx.ts";
import { DATA_DIR } from "./config.ts";

/** Each one runs on every page, and each background worker costs memory.
 * The view pool already caps live browsers at 8; this is the same spirit. */
export const MAX_BROWSER_EXTENSIONS = 10;

/** A local install's id. Store installs (later) use the 32-char store id,
 * which is why the two shapes are distinguishable at a glance. */
const LOCAL_ID = /^local-[0-9a-f]{12}$/;
const STORE_ID = /^[a-p]{32}$/;
const VERSION = /^\d+(\.\d+){0,3}$/;

export function isBrowserExtensionId(value: string): boolean {
  return LOCAL_ID.test(value) || STORE_ID.test(value);
}

const sourceSchema = z.union([
  z.object({ type: z.literal("local"), path: z.string().min(1).max(4096) }),
  z.object({ type: z.literal("webstore"), url: z.string().min(1).max(2048) }),
]);

const recordSchema = z.object({
  id: z.string().refine(isBrowserExtensionId, "invalid extension id"),
  name: z.string().min(1).max(120),
  version: z.string().regex(VERSION),
  manifestVersion: z.union([z.literal(2), z.literal(3)]),
  enabled: z.boolean(),
  source: sourceSchema,
  /** Tree hash of the copied directory, taken at install, re-checked before
   * enable here and again before loadExtension in the Electron main process. */
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  permissions: z.array(z.string().max(64)).max(64),
  hostPermissions: z.array(z.string().max(64)).max(64),
  warnings: z.array(z.string().max(400)).max(32),
  /** sha256 of the .crx as downloaded, for store installs only. */
  crxSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  installedAt: z.string().min(1).max(40),
  updatedAt: z.string().min(1).max(40).optional(),
});

export type BrowserExtensionRecord = z.infer<typeof recordSchema>;

const stateSchema = z.object({
  version: z.literal(1),
  extensions: z.array(z.unknown()).max(200).default([]),
});

export interface BrowserExtensionListing extends BrowserExtensionRecord {
  /** The copied tree is present and still hashes to what was reviewed. */
  intact: boolean;
}

function stateDir(): string {
  return join(DATA_DIR, "browser-extensions");
}

function statePath(): string {
  return join(DATA_DIR, "browser-extensions.json");
}

/** Derived from the validated id and version only — never from a stored
 * path, so a tampered state file cannot point the loader somewhere else. */
function extensionDir(id: string, version: string): string {
  return join(stateDir(), id, version);
}

/** Validate-with-skip: one unreadable record must not cost a person their
 * whole extension list. Same philosophy as skipMcpEntry in server/config.ts. */
function readState(): BrowserExtensionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return [];
  }
  const outer = stateSchema.safeParse(parsed);
  if (!outer.success) return [];
  const records: BrowserExtensionRecord[] = [];
  const seen = new Set<string>();
  for (const entry of outer.data.extensions) {
    const record = recordSchema.safeParse(entry);
    if (!record.success) continue;
    if (seen.has(record.data.id)) continue;
    seen.add(record.data.id);
    records.push(record.data);
  }
  return records;
}

function writeState(records: BrowserExtensionRecord[]): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const document = { version: 1 as const, extensions: records };
  writeFileAtomic(statePath(), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

/** The copied tree is present and still hashes to what was reviewed. The
 * listing and the loader feed must agree on this, so there is one of it. */
function treeIsIntact(record: Pick<BrowserExtensionRecord, "id" | "version" | "contentSha256">): boolean {
  const directory = extensionDir(record.id, record.version);
  return existsSync(join(directory, "manifest.json")) && hashExtensionDir(directory) === record.contentSha256;
}

function listingFor(record: BrowserExtensionRecord): BrowserExtensionListing {
  const intact = treeIsIntact(record);
  return {
    ...record,
    // A tree that changed after review is not enabled, whatever the file
    // says. The loader in Electron independently reaches the same verdict.
    enabled: record.enabled && intact,
    intact,
    warnings: intact
      ? record.warnings
      : [...record.warnings, "The installed files changed after review. Remove this extension and add it again."],
  };
}

export function listBrowserExtensions(): BrowserExtensionListing[] {
  return readState()
    .map(listingFor)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every enabled, intact extension, as the Electron coordinator needs it.
 * Kept separate from the listing so the loader never sees review-only text.
 *
 * The hash is re-checked here, not just the `enabled` flag: a tree edited
 * after it was enabled must never reach the loader, and the flag alone would
 * still say yes. Electron checks again on its own side of the process
 * boundary — this is the near half of that pair, not a replacement for it. */
export function enabledBrowserExtensions(): Array<{ id: string; version: string; path: string; contentSha256: string }> {
  return readState()
    .filter((record) => record.enabled && treeIsIntact(record))
    .map((record) => ({
      id: record.id,
      version: record.version,
      path: extensionDir(record.id, record.version),
      contentSha256: record.contentSha256,
    }));
}

/** The manifest a person reads in the review dialog, pretty-printed. Read
 * from the copied tree, so it is the reviewed bytes and not the source
 * folder's current contents. */
export function readBrowserExtensionManifest(id: string): string | null {
  if (!isBrowserExtensionId(id)) return null;
  const record = readState().find((entry) => entry.id === id);
  if (!record) return null;
  try {
    const raw = readFileSync(join(extensionDir(record.id, record.version), "manifest.json"), "utf8");
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return null;
  }
}

export interface InstallRefusal {
  error: string;
}

/**
 * Install an unpacked extension folder, DISABLED.
 *
 * Reads and validates the tree, refuses outright on a permission that
 * fights the browser's security model, copies the reviewed bytes into
 * DATA_DIR, and records the hash. The caller shows the returned warnings
 * and permissions; a person enables afterwards, or does not.
 */
export function installBrowserExtensionFromFolder(sourcePath: string): BrowserExtensionListing | InstallRefusal {
  const path = String(sourcePath ?? "").trim();
  if (!path || !isAbsolute(path)) return { error: "choose a folder to install from" };

  const capped = capacityRefusal();
  if (capped) return capped;

  const files = readUnpackedExtension(path);
  if ("error" in files) return files;

  const facts = parseExtensionManifest(files);
  if ("error" in facts) return facts;

  if (readState().some((record) => record.source.type === "local" && record.source.path === path)) {
    return { error: `\u201c${facts.name}\u201d is already installed from that folder` };
  }
  return commitInstall(`local-${randomBytes(6).toString("hex")}`, files, facts, { type: "local", path });
}

/**
 * Install from the Chrome Web Store, DISABLED.
 *
 * Download, then prove the archive belongs to the id that was asked for
 * before a single byte reaches disk. The manifest key is injected before the
 * hash is taken, so the recorded hash describes exactly what Chromium will
 * load and the runtime id matches the store id.
 */
export async function installBrowserExtensionFromWebstore(
  input: string,
  chromeVersion: string,
  fetcher: typeof fetch = fetch,
): Promise<BrowserExtensionListing | InstallRefusal> {
  const source = parseWebstoreSource(input);
  if ("error" in source) return source;

  const capped = capacityRefusal();
  if (capped) return capped;

  const existing = readState().find((record) => record.id === source.id);
  if (existing && existing.enabled) {
    return { error: `\u201c${existing.name}\u201d is already installed. Remove it first to reinstall.` };
  }

  const archive = await downloadCrx(source.id, chromeVersion, fetcher);
  if ("error" in archive) return archive;

  const parsed = parseCrx3(archive);
  if ("error" in parsed) return parsed;

  // Binding to the requested id is the check that makes this a download of
  // the extension that was asked for, rather than of whatever answered.
  const publicKey = verifyCrxId(parsed, source.id);
  if ("error" in publicKey) return publicKey;

  const signature = verifyCrxSignature(parsed, publicKey);
  if (signature !== true) return signature;

  const unpacked = unzipSafely(parsed.zip);
  if ("error" in unpacked) return unpacked;

  const keyed = injectManifestKey(unpacked, publicKey);
  if ("error" in keyed) return keyed;

  const facts = parseExtensionManifest(keyed);
  if ("error" in facts) return facts;

  // A reinstall replaces the record and lands disabled again, so a new
  // build is reviewed before it runs. Its old directory goes at the end.
  const previousVersion = existing?.version;
  const committed = commitInstall(source.id, keyed, facts, { type: "webstore", url: source.url }, {
    crxSha256: createHash("sha256").update(archive).digest("hex"),
  });
  if (!("error" in committed) && previousVersion && previousVersion !== facts.version) {
    try {
      rmSync(join(stateDir(), source.id, previousVersion), { recursive: true, force: true });
    } catch {
      /* the record no longer names it; stale bytes are inert */
    }
  }
  return committed;
}

function capacityRefusal(): InstallRefusal | null {
  return readState().length >= MAX_BROWSER_EXTENSIONS
    ? { error: `only ${MAX_BROWSER_EXTENSIONS} browser extensions can be installed at once` }
    : null;
}

/** Write the reviewed bytes and record them, DISABLED. Shared by both
 * sources so neither can drift in how it copies, hashes, or records. */
function commitInstall(
  id: string,
  files: ExtensionFile[],
  facts: { name: string; version: string; manifestVersion: 2 | 3; permissions: string[]; hostPermissions: string[]; warnings: string[] },
  source: BrowserExtensionRecord["source"],
  extra: { crxSha256?: string } = {},
): BrowserExtensionListing | InstallRefusal {
  const directory = extensionDir(id, facts.version);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Write the validated in-memory tree, not a cpSync of the source: the
    // walk already refused symlinks and oversized files, and these exact
    // bytes are what the recorded hash describes. Plain writeFileSync with
    // the Buffer — writeFileAtomic takes a string and would corrupt an icon,
    // and atomicity belongs to the state file, not to files nothing reads
    // until that state file names them.
    for (const file of files) {
      const target = join(directory, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, file.bytes, { mode: 0o600 });
    }
  } catch (cause) {
    try {
      rmSync(join(stateDir(), id), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    return { error: `could not copy that extension: ${cause instanceof Error ? cause.message : String(cause)}` };
  }

  // Verify what actually landed, not what we meant to write. The recorded
  // hash is the only thing that can ever unlock this extension: if a file is
  // dropped between the archive and the disk, recording the intended hash
  // produces an install that reports success and can then never be enabled,
  // with nothing to explain why. Checking here turns that into a clear
  // failure at the moment it happens.
  const contentSha256 = hashExtensionFiles(files);
  if (hashExtensionDir(directory) !== contentSha256) {
    try {
      rmSync(join(stateDir(), id), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    return { error: "that extension could not be written to disk completely — try adding it again" };
  }

  const record: BrowserExtensionRecord = {
    id,
    name: facts.name,
    version: facts.version,
    manifestVersion: facts.manifestVersion,
    enabled: false,
    source,
    contentSha256,
    permissions: facts.permissions,
    hostPermissions: facts.hostPermissions,
    warnings: facts.warnings,
    installedAt: new Date().toISOString(),
    ...(extra.crxSha256 ? { crxSha256: extra.crxSha256 } : {}),
  };
  writeState([...readState().filter((entry) => entry.id !== id), record]);
  return listingFor(record);
}

/**
 * Turn an extension on or off.
 *
 * Enabling re-hashes the copied tree first: what a person reviewed and what
 * the browser is about to run must be the same bytes.
 */
export function setBrowserExtensionEnabled(
  id: string,
  enabled: boolean,
): BrowserExtensionListing | InstallRefusal | null {
  if (!isBrowserExtensionId(id)) return null;
  const records = readState();
  const index = records.findIndex((record) => record.id === id);
  if (index < 0) return null;
  const record = records[index]!;

  if (enabled) {
    const actual = hashExtensionDir(extensionDir(record.id, record.version));
    if (actual !== record.contentSha256) {
      return { error: "the installed files changed after review — remove this extension and add it again" };
    }
  }

  const next: BrowserExtensionRecord = { ...record, enabled, updatedAt: new Date().toISOString() };
  writeState(records.map((entry, position) => (position === index ? next : entry)));
  return listingFor(next);
}

/** Remove an extension and its copied files. Returns false when there was
 * nothing to remove. State is written first: a record that no longer exists
 * cannot be loaded, whereas files left behind by a failed delete are inert
 * and cleaned up on the next install. */
export function removeBrowserExtension(id: string): boolean {
  if (!isBrowserExtensionId(id)) return false;
  const records = readState();
  if (!records.some((record) => record.id === id)) return false;
  writeState(records.filter((record) => record.id !== id));
  try {
    rmSync(join(stateDir(), id), { recursive: true, force: true });
  } catch {
    /* the record is gone; stale bytes are inert */
  }
  return true;
}

/** A stable token that changes whenever the desired set changes, so the
 * Electron coordinator can skip work when nothing has moved.
 *
 * Computed from the records alone — deliberately not from the trees on disk.
 * This is a "did the person change something" signal, and hashing every
 * installed tree to answer it would make the coordinator's fast path as
 * expensive as the slow one. Integrity is a load-time check, on both sides. */
export function browserExtensionsRevision(): string {
  const digest = createHash("sha256");
  for (const record of readState()) {
    if (!record.enabled) continue;
    digest.update(`${record.id}\0${record.version}\0${record.contentSha256}\n`);
  }
  return digest.digest("hex").slice(0, 16);
}

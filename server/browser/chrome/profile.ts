import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Every Chrome-related file OMB keeps lives under `<data dir>/browser`. */
export function browserRoot(dataDir: string): string {
  return join(dataDir, "browser");
}

const KEY = /^(bot|shared|temp|mychrome|cdp):[A-Za-z0-9._:@-]{1,200}$/;

export type ProfileKind = "bot" | "shared" | "temp" | "mychrome" | "cdp";

export function profileKind(key: string): ProfileKind {
  const match = KEY.exec(key);
  if (!match) throw new Error(`Not a browser profile key: ${key.slice(0, 80)}`);
  return match[1] as ProfileKind;
}

function writeAtomic(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, path);
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** A random 128-bit id per data directory, so a copied or moved workspace never shares a cookie jar with its source. */
export function workspaceId(dataDir: string): string {
  const file = join(browserRoot(dataDir), "workspace-id");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(existing)) return existing;
  } catch {}
  const id = randomBytes(16).toString("hex");
  writeAtomic(file, `${id}\n`);
  return id;
}

export function profileHash(workspace: string, key: string): string {
  return createHash("sha256").update(workspace).update("\0").update(key).digest("hex").slice(0, 24);
}

/** A temporary browser's profile sits apart, so the sweep can delete what nothing uses. */
export function profileDir(dataDir: string, key: string): string {
  const hash = profileHash(workspaceId(dataDir), key);
  return join(browserRoot(dataDir), profileKind(key) === "temp" ? "temp" : "profiles", hash);
}

export interface ProfileRecord {
  key: string;
  backend: "local" | "my-chrome" | "cdp-url";
  egress: "direct" | { via: string };
  /** The calibrated identity file this profile was last launched with. */
  identity: string | null;
  /** The newest Chrome that opened it; an older one must not. */
  chromeVersion: string | null;
  createdAt: string;
  migratedFrom?: string;
}

const RECORD_FILE = "omb-profile.json";

export function readProfileRecord(dir: string): ProfileRecord | null {
  const record = readJson(join(dir, RECORD_FILE)) as ProfileRecord | null;
  return record && typeof record.key === "string" ? record : null;
}

export function writeProfileRecord(dir: string, record: ProfileRecord): void {
  writeAtomic(join(dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Chrome must never offer to save a password a person typed into a window and
 * later fill it into a page the bot reads; sign-in to Chrome and translation
 * bubbles stay off; tabs and session cookies come back after a restart.
 */
export function profilePreferences(acceptLanguages: string): Record<string, unknown> {
  return {
    session: { restore_on_startup: 1 },
    credentials_enable_service: false,
    profile: { password_manager_enabled: false },
    autofill: { profile_enabled: false, credit_card_enabled: false },
    signin: { allowed: false },
    translate: { enabled: false },
    intl: { accept_languages: acceptLanguages },
  };
}

function merge(into: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(from)) {
    const existing = into[key];
    into[key] = value && typeof value === "object" && !Array.isArray(value) && existing && typeof existing === "object" && !Array.isArray(existing)
      ? merge({ ...existing as Record<string, unknown> }, value as Record<string, unknown>)
      : value;
  }
  return into;
}

/** Merges into the profile's Preferences; only while its Chrome is not running, which rewrites the file on exit. */
export function mergePreferences(dir: string, preferences: Record<string, unknown>): void {
  const file = join(dir, "Default", "Preferences");
  const current = readJson(file);
  const base = current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : {};
  writeAtomic(file, JSON.stringify(merge(base, preferences)));
}

/** A crash left behind is not offered back to anyone as a "restore pages?" bubble. */
export function markCleanExit(dir: string): void {
  if (!existsSync(join(dir, "Default", "Preferences"))) return;
  mergePreferences(dir, { profile: { exit_type: "Normal", exited_cleanly: true } });
}

/** The tabs Chrome would reopen, so a restart comes back on one blank tab; sign-ins stay. Chrome 153 keeps them in
 * Default/Sessions and Default/Sessions_Encrypted. */
export function forgetOpenTabs(dir: string): void {
  for (const folder of ["Sessions", "Sessions_Encrypted"]) rmSync(join(dir, "Default", folder), { recursive: true, force: true });
}

export interface EnsuredProfile {
  dir: string;
  record: ProfileRecord;
  created: boolean;
}

export function ensureProfile(dataDir: string, key: string, { acceptLanguages = "en-US,en", backend = "local" as ProfileRecord["backend"], now = () => new Date() } = {}): EnsuredProfile {
  const dir = profileDir(dataDir, key);
  const existing = readProfileRecord(dir);
  if (existing) {
    mergePreferences(dir, profilePreferences(acceptLanguages));
    return { dir, record: existing, created: false };
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record: ProfileRecord = { key, backend, egress: "direct", identity: null, chromeVersion: null, createdAt: now().toISOString() };
  mergePreferences(dir, profilePreferences(acceptLanguages));
  writeProfileRecord(dir, record);
  return { dir, record, created: true };
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** Why `binaryVersion` may not open this profile: an older Chrome would corrupt what a newer one wrote. */
export function downgradeRefusal(record: ProfileRecord, binaryVersion: string): string | null {
  if (!record.chromeVersion || compareVersions(binaryVersion, record.chromeVersion) >= 0) return null;
  return `This browser profile was last opened by Chrome ${record.chromeVersion}; Chrome ${binaryVersion} is older and would damage it. Update Chrome, or get Chrome for Testing ${record.chromeVersion} in Settings.`;
}

export function recordOpenedBy(dir: string, binaryVersion: string, identityFile?: string): ProfileRecord | null {
  const record = readProfileRecord(dir);
  if (!record) return null;
  const newer = !record.chromeVersion || compareVersions(binaryVersion, record.chromeVersion) > 0;
  const next = { ...record, ...(newer ? { chromeVersion: binaryVersion } : {}), ...(identityFile ? { identity: identityFile } : {}) };
  writeProfileRecord(dir, next);
  return next;
}

/** The version number in a product string such as "Chrome/153.0.8010.12". */
export function versionOf(product: string): string {
  return /(\d+(?:\.\d+){1,3})/.exec(product)?.[1] ?? product;
}

export function removeProfile(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

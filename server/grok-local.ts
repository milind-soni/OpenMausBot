// What the desktop app may find about Grok Bot on this computer. The Bot writes its own export (shared/grok-import.ts);
// the only things read here are those files in Downloads and two slices of the UI cache the Grok Bot app keeps, as a
// checklist of Bots and of routines their chats announced. Security: login material lives beside that cache
// (sand-secrets.json, cookies, ~/.grokbot) and is never opened; no path here is built from anything but the two names
// below, a file's own listing, or a roster id. Chat text in those slices never leaves this module.
//
// The cache's layout (Grok Bot desktop, recorded from a Windows install) and this reading of it adapt an MIT-licensed
// importer; see NOTICE.
import { rmSync } from "node:fs";
import { join } from "node:path";

import { GROK_EXPORT_FILE, GROK_EXPORT_MAX_CHARS } from "../shared/grok-import.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import type { SetupMachine } from "./setup-import.ts";

const USER_DATA_FOLDERS = [["Library", "Application Support", "Grok Bot"], ["AppData", "Roaming", "Grok Bot"], [".config", "Grok Bot"]];
const CACHE_FOLDER = "sand-client-persistence";
const SLICE_PREFIX = "sand.client.slice.account.";
const ROSTER_SLICE = "roster.last-roster";
const TRANSCRIPT_SLICE = "transcript.replicas.";
const MAX_SLICE_BYTES = 32 * 1024 * 1024;
const MAX_EXPORT_FILES = 20;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface GrokFoundFile { name: string; modifiedAt: number; text: string }
export interface GrokLook {
  files: GrokFoundFile[];
  /** Bots the Grok Bot app lists on this computer; empty when it is not here or could not be read. */
  bots: string[];
  /** Per Bot name, routines its chat announced. */
  routines: Record<string, string[]>;
}

/** A slice's id from its file name: unpadded lowercase base32 of the id, plus `.blob`. */
function sliceId(fileName: string): string | null {
  if (!fileName.endsWith(".blob")) return null;
  const stem = fileName.slice(0, -".blob".length).toUpperCase();
  const bytes: number[] = [];
  let bits = 0, value = 0;
  for (const ch of stem) {
    const digit = BASE32.indexOf(ch);
    if (digit < 0) return null;
    value = ((value << 5) | digit) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/** The account id is URL-encoded, so a "." inside it cannot be mistaken for the separator. */
function sliceKind(id: string | null): string | null {
  if (!id?.startsWith(SLICE_PREFIX)) return null;
  const separator = id.indexOf(".", SLICE_PREFIX.length);
  if (separator < 0) return null;
  try {
    return decodeURIComponent(id.slice(separator + 1));
  } catch {
    return null;
  }
}

function sliceValue(machine: SetupMachine, path: string): Record<string, unknown> | null {
  const raw = machine.fs.read(path, MAX_SLICE_BYTES, false);
  if (!raw) return null;
  try {
    const envelope: unknown = JSON.parse(raw.toString("utf8"));
    const value = (envelope as { value?: unknown } | null)?.value;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const shown = (value: unknown) => (typeof value === "string" ? redactSecretsInText(value.trim()).slice(0, 200) : "");
const rows = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object") : [];

/** A hint only: a missing or unreadable cache, or a layout this does not know, answers nothing. */
function readAppHints(machine: SetupMachine): Pick<GrokLook, "bots" | "routines"> {
  const none = { bots: [], routines: {} };
  const folder = USER_DATA_FOLDERS.map((parts) => join(machine.home, ...parts, CACHE_FOLDER))
    .find((path) => machine.fs.lstat(path)?.isDirectory());
  const listing = folder ? machine.fs.readdir(folder) : null;
  if (!folder || !listing) return none;
  const slices = new Map<string, string>();
  for (const name of listing) {
    const kind = sliceKind(sliceId(name));
    if (kind === ROSTER_SLICE || kind?.startsWith(TRANSCRIPT_SLICE)) slices.set(kind, join(folder, name));
  }
  const rosterPath = slices.get(ROSTER_SLICE);
  if (!rosterPath) return none;
  const names = new Map<string, string>();
  for (const row of rows(sliceValue(machine, rosterPath)?.rows)) {
    const name = shown(row.name);
    if (name && !row.isGroup && typeof row.id === "string") names.set(row.id, name);
  }
  const routines: GrokLook["routines"] = {};
  for (const [id, name] of names) {
    const path = slices.get(`${TRANSCRIPT_SLICE}${id}`);
    if (!path) continue;
    const seen = new Map<string, string>();
    for (const entry of rows(sliceValue(machine, path)?.entries)) {
      const event = entry.event as Record<string, unknown> | null | undefined;
      if (!event || typeof event !== "object" || event.type !== "automation-changed") continue;
      const label = shown(event.automationName);
      const key = shown(event.automationId) || label;
      if (event.action === "deleted") seen.delete(key);
      else if (key) seen.set(key, label || key);
    }
    if (seen.size) routines[name] = [...seen.values()];
  }
  return { bots: [...names.values()], routines };
}

/** The exports in Downloads, newest first. A symlink is refused: only a real file with that name counts. */
function readExportFiles(machine: SetupMachine): GrokFoundFile[] {
  const folder = join(machine.home, "Downloads");
  const found = (machine.fs.readdir(folder) ?? []).filter((name) => GROK_EXPORT_FILE.test(name)).flatMap((name) => {
    const stats = machine.fs.lstat(join(folder, name));
    return stats?.isFile() && stats.size <= GROK_EXPORT_MAX_CHARS ? [{ name, modifiedAt: stats.mtimeMs, size: stats.size }] : [];
  }).sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, MAX_EXPORT_FILES);
  let budget = MAX_EXPORT_BYTES;
  return found.flatMap(({ name, modifiedAt, size }) => {
    if (size > budget) return [];
    const raw = machine.fs.read(join(folder, name), GROK_EXPORT_MAX_CHARS, false);
    if (!raw) return [];
    budget -= raw.length;
    return [{ name, modifiedAt, text: raw.toString("utf8") }];
  });
}

/** `quiet`: on the first screen, for everyone. macOS asks permission the first time an app reads Downloads, so there it
 * is read only on a Mac that has Grok Bot; everywhere else the flow itself looks, once someone has chosen it. */
export function lookForGrokBot(machine: SetupMachine, options: { quiet?: boolean } = {}): GrokLook {
  const hints = readAppHints(machine);
  const hasApp = USER_DATA_FOLDERS.some((parts) => machine.fs.lstat(join(machine.home, ...parts)) !== null);
  const files = options.quiet && machine.platform === "darwin" && !hasApp ? [] : readExportFiles(machine);
  return { files, ...hints };
}

/** Security: a Cursor sign-in saved by an older version may still be here. Nothing reads it, so no live token stays behind. */
export function removeOldCursorSignIn(dataDir: string): void {
  try {
    rmSync(join(dataDir, "cursor-session.json"), { force: true });
  } catch {
    // retried at the next start
  }
}

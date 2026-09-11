// The person-facing half of bot memory: browse it, edit it, delete it.
//
// workspace.ts owns the files (MEMORY.md and memory/ under the bot's
// workspace) and the load budget. This module owns the RULES for reaching
// those files from outside the process. A `path` arrives from HTTP, so it
// is matched against an allowlist of the three shapes memory actually has
// rather than sanitised — a rejected name is a bug report, not a path to
// be repaired. Anything else would be an arbitrary-file-read on the disk.
//
// Every write goes through writeFileAtomic at 0600 and through the secret
// scrubber first: memory is agent-authored as often as person-authored,
// and a bot that pastes a key into its own notes must not leave it on disk
// in the clear. Writes also carry an optional expected hash so an editor
// that opened the file a minute ago cannot silently overwrite an entry the
// bot wrote in between — today's whole-file PUT races memory_update.
//
// No knowledge of turns or HTTP here; the journal and the routes sit on top.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { redactSecretsInText } from "./redact.ts";
import {
  MEMORY_FILE_MAX_BYTES,
  MEMORY_MAX_BYTES,
  MEMORY_MAX_LINES,
  ensureWorkspace,
  isMemoryTopicName,
  workspaceDir,
} from "./workspace.ts";

export const MEMORY_INDEX = "MEMORY.md";

export type MemoryDocKind = "index" | "topic" | "log";

export interface MemoryDocRef {
  /** The workspace-relative path as the API spells it. */
  path: string;
  kind: MemoryDocKind;
  /** File name without its directory. */
  name: string;
}

export type MemoryStoreErrorCode = "path" | "conflict" | "too-large" | "forbidden";

/** Carries an HTTP status so the route can answer without a lookup table.
 * A conflict also carries what is on disk now, so an editor can show the
 * bot's version next to the person's draft instead of guessing. */
export class MemoryStoreError extends Error {
  readonly status: number;
  readonly code: MemoryStoreErrorCode;
  readonly currentHash?: string;
  readonly current?: string;
  constructor(code: MemoryStoreErrorCode, status: number, message: string, conflict?: { currentHash: string; current: string }) {
    super(message);
    this.name = "MemoryStoreError";
    this.code = code;
    this.status = status;
    if (conflict) {
      this.currentHash = conflict.currentHash;
      this.current = conflict.current;
    }
  }
}

const BOT_ID = /^[\w-]{1,128}$/;

function pathError(path: string): MemoryStoreError {
  return new MemoryStoreError("path", 400, `not a memory file: ${JSON.stringify(path)} — use MEMORY.md, memory/<topic>.md or memory/log/<day>.md`);
}

/** Only three shapes exist: the index, one topic file directly under
 * memory/, or one daily log directly under memory/log/. The name gate is
 * the same one listing uses (workspace.ts isMemoryTopicName), so what the
 * API can reach and what the overview shows agree by construction. No
 * separators inside a name means no traversal; no leading dot means no
 * dotfiles and no bare "..". Backslashes and NUL never match. */
export function parseMemoryPath(path: string): MemoryDocRef {
  if (typeof path !== "string" || !path) throw pathError(path);
  if (path === MEMORY_INDEX) return { path, kind: "index", name: MEMORY_INDEX };
  const parts = path.split("/");
  if (parts.length === 2 && parts[0] === "memory" && isMemoryTopicName(parts[1])) {
    return { path, kind: "topic", name: parts[1] };
  }
  if (parts.length === 3 && parts[0] === "memory" && parts[1] === "log" && isMemoryTopicName(parts[2])) {
    return { path, kind: "log", name: parts[2] };
  }
  throw pathError(path);
}

function assertBotId(botId: string): void {
  if (!BOT_ID.test(botId)) throw new MemoryStoreError("path", 400, "invalid bot id");
}

function relativeSegments(ref: MemoryDocRef): string[] {
  if (ref.kind === "index") return [MEMORY_INDEX];
  if (ref.kind === "topic") return ["memory", ref.name];
  return ["memory", "log", ref.name];
}

/** The absolute path a memory document lives at, after proving it stays
 * inside the workspace. The grammar already forbids traversal; this guards
 * the other escape — a symlink. A bot with file tools can turn memory/ or
 * a topic file into a link to anywhere, and the editor would then read or
 * overwrite that target. So the nearest existing ancestor is resolved
 * through realpath and must sit under the real workspace, and the file
 * itself, when present, must be a regular file rather than a link. */
export function resolveMemoryPath(botId: string, path: string): string {
  assertBotId(botId);
  const ref = parseMemoryPath(path);
  const root = workspaceDir(botId);
  const absolute = join(root, ...relativeSegments(ref));
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    // no workspace yet — nothing to escape from, nothing to read either
    return absolute;
  }
  let ancestor = dirname(absolute);
  while (!existsSync(ancestor) && ancestor !== root) ancestor = dirname(ancestor);
  const realAncestor = realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + sep)) {
    throw new MemoryStoreError("path", 400, `memory path escapes the workspace: ${JSON.stringify(path)}`);
  }
  try {
    if (lstatSync(absolute).isSymbolicLink()) {
      throw new MemoryStoreError("path", 400, `memory file is a link, not a file: ${JSON.stringify(path)}`);
    }
  } catch (error) {
    if (error instanceof MemoryStoreError) throw error;
    // missing is fine: a topic the person is about to create
  }
  return absolute;
}

export function hashMemoryText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface MemoryCapacity {
  /** Lines and bytes on disk. A trailing newline counts as a line, the
   * same way the load budget counts it. */
  lines: number;
  bytes: number;
  maxLines: number;
  maxBytes: number;
  /** What loadMemory() would actually put into the system prompt. */
  loadedLines: number;
  loadedBytes: number;
  truncated: boolean;
  hash: string;
}

export interface MemoryFileInfo {
  path: string;
  name: string;
  bytes: number;
  modifiedAt: number;
}

export interface MemoryOverview {
  botId: string;
  /** Where the folder is on the server's disk — plain markdown a person
   * can open in any editor, which is why the panel says so. */
  workspacePath: string;
  index: MemoryCapacity;
  topics: MemoryFileInfo[];
  logs: MemoryFileInfo[];
}

/** Mirrors loadMemory()'s cut exactly so the gauge never claims something
 * loads that does not: first MEMORY_MAX_LINES lines, then MEMORY_MAX_BYTES
 * bytes, whichever cuts first. */
export function memoryCapacity(raw: string): MemoryCapacity {
  const lines = raw === "" ? 0 : raw.split("\n").length;
  let loaded = raw;
  let truncated = false;
  if (lines > MEMORY_MAX_LINES) {
    loaded = raw.split("\n").slice(0, MEMORY_MAX_LINES).join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(loaded, "utf8") > MEMORY_MAX_BYTES) {
    loaded = Buffer.from(loaded, "utf8").subarray(0, MEMORY_MAX_BYTES).toString("utf8").replace(/�+$/, "");
    truncated = true;
  }
  return {
    lines,
    bytes: Buffer.byteLength(raw, "utf8"),
    maxLines: MEMORY_MAX_LINES,
    maxBytes: MEMORY_MAX_BYTES,
    loadedLines: loaded === "" ? 0 : loaded.split("\n").length,
    loadedBytes: Buffer.byteLength(loaded, "utf8"),
    truncated,
    hash: hashMemoryText(raw),
  };
}

function listMarkdown(dir: string, prefix: string): MemoryFileInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: MemoryFileInfo[] = [];
  for (const name of names) {
    if (!isMemoryTopicName(name)) continue;
    try {
      // lstat, not stat: a symlinked topic is not a memory file (see
      // resolveMemoryPath) and must not be listed as one
      const info = lstatSync(join(dir, name));
      if (!info.isFile()) continue;
      files.push({ path: `${prefix}/${name}`, name, bytes: info.size, modifiedAt: Math.round(info.mtimeMs) });
    } catch {
      // deleted between readdir and lstat: simply not listed
    }
  }
  // newest first: the file the bot just touched is the one to look at
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
}

/** Reads never create the workspace: a bot that has not run yet simply
 * has nothing to show, and an overview must not leave a folder behind. */
export function memoryOverview(botId: string): MemoryOverview {
  assertBotId(botId);
  const root = workspaceDir(botId);
  let raw = "";
  try {
    raw = readFileSync(resolveMemoryPath(botId, MEMORY_INDEX), "utf8");
  } catch (error) {
    if (error instanceof MemoryStoreError) throw error;
    raw = "";
  }
  return {
    botId,
    workspacePath: root,
    index: memoryCapacity(raw),
    topics: listMarkdown(join(root, "memory"), "memory"),
    logs: listMarkdown(join(root, "memory", "log"), "memory/log"),
  };
}

export interface MemoryDoc {
  path: string;
  text: string;
  /** sha256 of `text`; an editor sends it back as expectedHash on save. */
  hash: string;
  exists: boolean;
}

/** A missing document reads as empty rather than as an error: the topic
 * the person is about to create has no file yet, and its hash is the hash
 * of "", which is what a save of a new file must present. */
export function readMemoryDoc(botId: string, path: string): MemoryDoc {
  const absolute = resolveMemoryPath(botId, path);
  try {
    const text = readFileSync(absolute, "utf8");
    return { path, text, hash: hashMemoryText(text), exists: true };
  } catch {
    return { path, text: "", hash: hashMemoryText(""), exists: false };
  }
}

export interface MemoryWriteResult {
  path: string;
  /** What was on disk before, or null when the file did not exist. */
  before: string | null;
  /** What is on disk now — redacted, so it can differ from the input. */
  after: string;
  hash: string;
}

/** Atomic, 0600, redacted. With `expectedHash`, the write is refused (409)
 * unless the file still hashes to what the caller last saw — the bot may
 * have written between the person's read and their save, and a whole-file
 * overwrite would erase that note without anyone noticing. */
export function writeMemoryDoc(
  botId: string,
  path: string,
  text: string,
  opts: { expectedHash?: string } = {},
): MemoryWriteResult {
  const ref = parseMemoryPath(path);
  ensureWorkspace(botId);
  if (ref.kind === "log") mkdirSync(join(workspaceDir(botId), "memory", "log"), { recursive: true, mode: 0o700 });
  const absolute = resolveMemoryPath(botId, path);
  const after = redactSecretsInText(text);
  const bytes = Buffer.byteLength(after, "utf8");
  if (bytes > MEMORY_FILE_MAX_BYTES) {
    throw new MemoryStoreError(
      "too-large",
      413,
      `memory files are capped at ${Math.round(MEMORY_FILE_MAX_BYTES / 1024)}KB — move longer notes into memory/<topic>.md files`,
    );
  }
  const current = readMemoryDoc(botId, path);
  if (opts.expectedHash !== undefined && opts.expectedHash !== current.hash) {
    throw new MemoryStoreError(
      "conflict",
      409,
      "this file changed since you opened it — reload to see the new version, or save again to overwrite it",
      { currentHash: current.hash, current: current.text },
    );
  }
  writeFileAtomic(absolute, after, { mode: 0o600 });
  return { path, before: current.exists ? current.text : null, after, hash: hashMemoryText(after) };
}

/** Topic and log files only. MEMORY.md is loaded unconditionally at turn
 * start and the next ensureWorkspace() would silently reseed it, which
 * reads as "delete did nothing" — clearing it is a write of "". */
export function deleteMemoryDoc(botId: string, path: string): { path: string; before: string | null } {
  const ref = parseMemoryPath(path);
  if (ref.kind === "index") {
    throw new MemoryStoreError("forbidden", 400, "MEMORY.md cannot be deleted — clear its text instead");
  }
  const absolute = resolveMemoryPath(botId, path);
  const current = readMemoryDoc(botId, path);
  if (current.exists) unlinkSync(absolute);
  return { path, before: current.exists ? current.text : null };
}

export type MemoryOpenTarget = "obsidian" | "folder";

export function obsidianUrlFor(workspacePath: string): string {
  return `obsidian://open?path=${encodeURIComponent(workspacePath)}`;
}

export type OpenerRunner = (command: string, args: string[]) => Promise<number | null>;

/** Runs the platform URL/folder opener and resolves its exit code; null
 * when it could not be launched or did not exit in time. Same shape as
 * cli.ts openDashboard: no shell, fixed argv, nothing from the request. */
const spawnOpener: OpenerRunner = (command, args) =>
  new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: "ignore", windowsHide: true, detached: true });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, 3000);
    child.once("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      done(code);
    });
    child.unref();
  });

/** Opens the bot's memory folder on the machine running the server — in
 * Obsidian (obsidian://open?path=…) or in Finder/Explorer/the file manager.
 * The folder is on the server's disk, so this only makes sense from the
 * same machine; the route restricts it to loopback callers. The desktop
 * shell's own openExternal is http(s)-only, which is why the URL opener
 * lives here rather than going through the preload bridge. */
export async function openMemoryLocation(
  botId: string,
  target: MemoryOpenTarget,
  platform: NodeJS.Platform = process.platform,
  run: OpenerRunner = spawnOpener,
): Promise<{ ok: true; workspacePath: string } | { ok: false; error: string; workspacePath: string }> {
  assertBotId(botId);
  const workspacePath = ensureWorkspace(botId);
  const location = target === "obsidian" ? obsidianUrlFor(workspacePath) : workspacePath;
  let command: string;
  let args: string[];
  if (platform === "darwin") {
    command = "open";
    args = [location];
  } else if (platform === "win32") {
    command = target === "obsidian" ? "rundll32.exe" : "explorer.exe";
    args = target === "obsidian" ? ["url.dll,FileProtocolHandler", location] : [location];
  } else {
    command = "xdg-open";
    args = [location];
  }
  const code = await run(command, args);
  // explorer.exe reports 1 even when it opened the window; only "could not
  // launch" is a failure there
  const ok = code === 0 || (platform === "win32" && target === "folder" && code !== null);
  if (ok) return { ok: true, workspacePath };
  const error =
    target === "obsidian"
      ? `Obsidian did not open. Is it installed? The folder is ${workspacePath}`
      : `The file manager did not open. The folder is ${workspacePath}`;
  return { ok: false, error, workspacePath };
}

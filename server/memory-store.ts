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
  path: string;
  kind: MemoryDocKind;
  name: string;
}

export type MemoryStoreErrorCode = "path" | "conflict" | "too-large" | "forbidden";

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

/** An allowlist of three shapes, not a sanitiser: anything else would be an arbitrary file read. */
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

/** A bot can turn memory/ or a topic file into a symlink to anywhere, so the real path must stay inside the workspace. */
export function resolveMemoryPath(botId: string, path: string): string {
  assertBotId(botId);
  const ref = parseMemoryPath(path);
  const root = workspaceDir(botId);
  const absolute = join(root, ...relativeSegments(ref));
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
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
  }
  return absolute;
}

export function hashMemoryText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface MemoryCapacity {
  lines: number;
  bytes: number;
  maxLines: number;
  maxBytes: number;
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
  workspacePath: string;
  index: MemoryCapacity;
  topics: MemoryFileInfo[];
  logs: MemoryFileInfo[];
}

/** Must cut exactly as loadMemory() does: MEMORY_MAX_LINES lines, then MEMORY_MAX_BYTES bytes. */
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
      // lstat, not stat: a symlinked topic is not a memory file.
      const info = lstatSync(join(dir, name));
      if (!info.isFile()) continue;
      files.push({ path: `${prefix}/${name}`, name, bytes: info.size, modifiedAt: Math.round(info.mtimeMs) });
    } catch {
    }
  }
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
}

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
  hash: string;
  exists: boolean;
}

export function readMemoryDoc(botId: string, path: string): MemoryDoc {
  const absolute = resolveMemoryPath(botId, path);
  try {
    const text = readFileSync(absolute, "utf8");
    return { path, text, hash: hashMemoryText(text), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { path, text: "", hash: hashMemoryText(""), exists: false };
  }
}

export interface MemoryWriteResult {
  path: string;
  before: string | null;
  after: string;
  hash: string;
}

/** Atomic, 0600 and redacted; `expectedHash` refuses (409) a save over a write the caller has not seen. */
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

/** No shell, fixed argv, nothing from the request. */
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

/** Electron's openExternal is http(s)-only, so the obsidian:// opener lives here; the route allows loopback callers only. */
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
  // explorer.exe exits 1 even when it opened the window.
  const ok = code === 0 || (platform === "win32" && target === "folder" && code !== null);
  if (ok) return { ok: true, workspacePath };
  const error =
    target === "obsidian"
      ? `Obsidian did not open. Is it installed? The folder is ${workspacePath}`
      : `The file manager did not open. The folder is ${workspacePath}`;
  return { ok: false, error, workspacePath };
}

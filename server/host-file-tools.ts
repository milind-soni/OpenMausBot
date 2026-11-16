// File tools a chat bot gets on this desktop's own computer. The app adds no rules of its own about which paths: the OS
// account decides what can be opened, and the person's approval level (the bridge's gate) decides what is asked.
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

import type { ToolCall } from "./mcp-bridge.ts";

/** Size caps only so one call cannot stall a turn. */
export const HOST_FILE_READ_LIMIT = 10 * 1024 * 1024;
export const HOST_FILE_WRITE_LIMIT = 25 * 1024 * 1024;
const LISTED = 500;

const encoding = { type: "string", enum: ["utf8", "base64"], description: "utf8 (default) for text, base64 for any other file." };

/** What a bot on this computer is offered beside the screen tools. */
export const HOST_FILE_TOOLS = [
  {
    name: "list_files",
    description: "List a folder on this computer. With no path, lists the person's home folder.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Full path of the folder." } }, additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a file on this computer, up to 10 MB.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Full path of the file." }, encoding }, required: ["path"], additionalProperties: false },
  },
  {
    name: "write_file",
    description: "Save a file on this computer, up to 25 MB, making any missing folders. An existing file is replaced only with overwrite: true. Answers with the real path saved.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Full path of the file." },
        content: { type: "string" },
        encoding,
        overwrite: { type: "boolean", description: "true to replace a file that is already there." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "make_folder",
    description: "Make a folder, and any missing folders above it, on this computer.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Full path of the folder." } }, required: ["path"], additionalProperties: false },
  },
] as const;

export const HOST_FILE_TOOL_NAMES: ReadonlySet<string> = new Set(HOST_FILE_TOOLS.map((tool) => tool.name));

type Result = { content: Array<{ type: "text"; text: string }>; isError?: true };
const said = (text: string): Result => ({ content: [{ type: "text", text }] });
const refused = (text: string): Result => ({ ...said(text), isError: true });

class Mistake extends Error {}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fullPath(home: string, raw: unknown): string {
  if (typeof raw !== "string" || !raw) throw new Mistake("Give the full path.");
  const text = raw === "~" || /^~[\\/]/.test(raw) ? home + raw.slice(1) : raw;
  if (!path.isAbsolute(text)) throw new Mistake(`Give a full path, like ${path.join(home, "Documents", "notes.txt")}.`);
  return path.resolve(text);
}

function wanted(value: unknown): "utf8" | "base64" {
  if (value === undefined || value === "utf8") return "utf8";
  if (value === "base64") return "base64";
  throw new Mistake('encoding is "utf8" or "base64".');
}

async function listFiles(home: string, args: Record<string, unknown>): Promise<Result> {
  const target = await fs.realpath(args.path === undefined || args.path === "" ? home : fullPath(home, args.path));
  const entries = await fs.readdir(target, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries.slice(0, LISTED)) {
    if (entry.isSymbolicLink()) lines.push(`link    ${entry.name}`);
    else if (entry.isDirectory()) lines.push(`folder  ${entry.name}`);
    else {
      const stat = await fs.lstat(path.join(target, entry.name)).catch(() => null);
      lines.push(`file    ${entry.name}${stat ? ` (${sizeText(stat.size)})` : ""}`);
    }
  }
  const more = entries.length > LISTED ? `\n…and ${entries.length - LISTED} more` : "";
  return said(`${target}\n${lines.join("\n") || "(empty)"}${more}`);
}

async function readFile(home: string, args: Record<string, unknown>): Promise<Result> {
  const as = wanted(args.encoding);
  const target = await fs.realpath(fullPath(home, args.path));
  const stat = await fs.stat(target);
  if (stat.isDirectory()) return refused(`${target} is a folder: list it with list_files.`);
  // A pipe or device could block the turn forever.
  if (!stat.isFile()) return refused(`${target} is not an ordinary file.`);
  if (stat.size > HOST_FILE_READ_LIMIT) return refused(`${target} is ${sizeText(stat.size)}; files up to 10 MB can be read.`);
  const data = await fs.readFile(target);
  const text = as === "base64" ? data.toString("base64") : data.toString("utf8");
  if (as === "utf8" && !Buffer.from(text, "utf8").equals(data)) return refused(`${target} is not plain text. Read it with encoding base64.`);
  return said(`${target} (${sizeText(data.length)}):\n${text}`);
}

const alreadyThere = (target: string) => new Mistake(`${target} already exists. To replace it, call write_file again with overwrite: true.`);

async function writeFile(home: string, args: Record<string, unknown>): Promise<Result> {
  const as = wanted(args.encoding);
  if (typeof args.content !== "string") throw new Mistake("Give the file's content.");
  if (args.overwrite !== undefined && typeof args.overwrite !== "boolean") throw new Mistake("overwrite is true or false.");
  const data = Buffer.from(args.content, as);
  if (data.length > HOST_FILE_WRITE_LIMIT) throw new Mistake("Files up to 25 MB can be saved.");
  const asked = fullPath(home, args.path);
  await fs.mkdir(path.dirname(asked), { recursive: true });
  const named = path.join(await fs.realpath(path.dirname(asked)), path.basename(asked));
  const existing = await fs.stat(named).catch(() => null);
  if (existing?.isDirectory()) throw new Mistake(`${named} is a folder. Give a file name inside it.`);
  if (existing && args.overwrite !== true) throw alreadyThere(named);
  // A link is followed: the file it points at is the one replaced.
  const target = existing ? await fs.realpath(named) : named;
  // A temp file beside it, then a rename: a reader sees the whole old file or the whole new one.
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    await fs.writeFile(temp, data, { flag: "wx", flush: true, ...(existing ? { mode: existing.mode & 0o777 } : {}) });
    if (existing) await renameWithRetry(temp, target);
    else await placeNew(temp, target);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
  return said(`Saved ${sizeText(data.length)} to ${target}${existing ? " (replaced the file that was there)" : ""}.`);
}

/** A finished temp file put at a path nothing may hold yet: a link fails if anything got there meanwhile, and where a
 * folder takes no links (FAT, some cloud folders) a copy that fails the same way. The temp file goes either way. */
export async function placeNew(temp: string, target: string, link: (from: string, to: string) => Promise<void> = fs.link): Promise<void> {
  try {
    try {
      await link(temp, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw alreadyThere(target);
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EINVAL", "EMLINK"].includes(code ?? "")) throw error;
      await fs.copyFile(temp, target, constants.COPYFILE_EXCL).catch((copyError: NodeJS.ErrnoException) => {
        throw copyError.code === "EEXIST" ? alreadyThere(target) : copyError;
      });
    }
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

/** Windows refuses a rename onto a file an indexer, antivirus or sync client holds for a moment. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (const wait of [0, 50, 150, 400, 1000]) {
    if (wait) await new Promise((settle) => setTimeout(settle, wait));
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") || wait === 1000) throw error;
    }
  }
}

async function makeFolder(home: string, args: Record<string, unknown>): Promise<Result> {
  const asked = fullPath(home, args.path);
  const existing = await fs.stat(asked).catch(() => null);
  if (existing && !existing.isDirectory()) return refused(`${asked} is a file, not a folder.`);
  await fs.mkdir(asked, { recursive: true });
  const target = await fs.realpath(asked);
  return said(existing ? `${target} is already there.` : `Made the folder ${target}.`);
}

const RUN = { list_files: listFiles, read_file: readFile, write_file: writeFile, make_folder: makeFolder } as const;

/** The bridge's relay for these tools: null for any other call. Failures come back as the OS worded them. */
export function hostFileRelay(home: string): (call: ToolCall) => Promise<Result> | null {
  return (call) => {
    if (!HOST_FILE_TOOL_NAMES.has(call.name)) return null;
    return RUN[call.name as keyof typeof RUN](home, call.arguments)
      .catch((error: unknown) => refused(error instanceof Error ? error.message : String(error)));
  };
}

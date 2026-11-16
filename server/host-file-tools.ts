import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

import type { ToolCall } from "./mcp-bridge.ts";
import { HostFileRefusal, resolveHostPath, writeRefusal, type HostFolders } from "./host-files.ts";

export const HOST_FILE_READ_LIMIT = 10 * 1024 * 1024;
export const HOST_FILE_WRITE_LIMIT = 25 * 1024 * 1024;
const LISTED = 500;

const encoding = { type: "string", enum: ["utf8", "base64"], description: "utf8 (default) for text, base64 for any other file." };

/** What a bot on this computer is offered beside the screen tools. */
export const HOST_FILE_TOOLS = [
  {
    name: "list_files",
    description: "List a folder on this computer. With no path, shows the person's own folders (home, Desktop, Documents, Downloads…) with their real paths, which may be inside OneDrive or iCloud.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Full path of the folder." } }, additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a file in the person's folders on this computer, up to 10 MB.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Full path of the file." }, encoding }, required: ["path"], additionalProperties: false },
  },
  {
    name: "write_file",
    description: "Save a file in the person's folders on this computer, up to 25 MB, making any missing folders. An existing file is replaced only with overwrite: true. Programs, scripts and hidden folders are refused. Answers with the real path saved.",
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
    description: "Make a folder, and any missing folders above it, in the person's folders on this computer.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Full path of the folder." } }, required: ["path"], additionalProperties: false },
  },
] as const;

export const HOST_FILE_TOOL_NAMES: ReadonlySet<string> = new Set(HOST_FILE_TOOLS.map((tool) => tool.name));

type Result = { content: Array<{ type: "text"; text: string }>; isError?: true };
const said = (text: string): Result => ({ content: [{ type: "text", text }] });
const refused = (text: string): Result => ({ ...said(text), isError: true });

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function failure(error: unknown, at: string): Result {
  if (error instanceof HostFileRefusal) return refused(error.message);
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM") return refused(`This computer did not allow access to ${at}.`);
  if (code === "EBUSY") return refused(`${at} is open in another app. Ask the person to close it, then try again.`);
  if (code === "ENOSPC") return refused("The disk is full.");
  if (code === "ENAMETOOLONG") return refused("That path is too long.");
  return refused(`Could not do that at ${at}: ${error instanceof Error ? error.message : String(error)}`);
}

function wanted(value: unknown): "utf8" | "base64" {
  if (value === undefined || value === "utf8") return "utf8";
  if (value === "base64") return "base64";
  throw new HostFileRefusal('encoding is "utf8" or "base64".');
}

async function sameEntry(target: string, stat: { dev: number; ino: number }): Promise<boolean> {
  const named = await fs.lstat(target).catch(() => null);
  return Boolean(named && !named.isSymbolicLink() && named.dev === stat.dev && named.ino === stat.ino);
}

/** One folder at a time, each checked as it is made, so a folder swapped for a link meanwhile is refused, not followed. */
async function makeFolders(folders: HostFolders, target: string): Promise<void> {
  const { target: real, exists } = await resolveHostPath(folders, target);
  if (exists) {
    if (!(await fs.lstat(real)).isDirectory()) throw new HostFileRefusal(`${real} is a file, not a folder.`);
    return;
  }
  const p = folders.platform === "win32" ? path.win32 : path.posix;
  const parent = p.dirname(real);
  if (parent !== real) await makeFolders(folders, parent);
  try {
    await fs.mkdir(real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const again = await resolveHostPath(folders, real);
  if (!again.exists || !(await fs.lstat(again.target)).isDirectory()) throw new HostFileRefusal(`${real} could not be made as a folder.`);
}

async function listFiles(folders: HostFolders, args: Record<string, unknown>): Promise<Result> {
  if (args.path === undefined || args.path === "") {
    return said(["The person's folders on this computer:", ...folders.places.map((place) => `${place.name}: ${place.path}`)].join("\n"));
  }
  const { target, exists } = await resolveHostPath(folders, args.path);
  if (!exists) return refused(`There is no folder at ${target}.`);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const p = folders.platform === "win32" ? path.win32 : path.posix;
  const lines: string[] = [];
  for (const entry of entries.slice(0, LISTED)) {
    if (entry.isSymbolicLink()) lines.push(`link    ${entry.name}`);
    else if (entry.isDirectory()) lines.push(`folder  ${entry.name}`);
    else {
      const stat = await fs.lstat(p.join(target, entry.name)).catch(() => null);
      lines.push(`file    ${entry.name}${stat ? ` (${sizeText(stat.size)})` : ""}`);
    }
  }
  const more = entries.length > LISTED ? `\n…and ${entries.length - LISTED} more` : "";
  return said(`${target}\n${lines.join("\n") || "(empty)"}${more}`);
}

async function readFile(folders: HostFolders, args: Record<string, unknown>): Promise<Result> {
  const as = wanted(args.encoding);
  const { target, exists } = await resolveHostPath(folders, args.path);
  if (!exists) return refused(`There is no file at ${target}.`);
  const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (stat.isDirectory()) return refused(`${target} is a folder: list it with list_files.`);
    if (!stat.isFile() || stat.nlink > 1) return refused(`${target} is not an ordinary file.`);
    if (stat.size > HOST_FILE_READ_LIMIT) return refused(`${target} is ${sizeText(stat.size)}; files up to 10 MB can be read.`);
    if (!(await sameEntry(target, stat)) || (await resolveHostPath(folders, target)).target !== target) return refused(`${target} changed while it was opened. Try again.`);
    const data = await file.readFile();
    if (data.length > HOST_FILE_READ_LIMIT) return refused(`${target} grew past 10 MB while it was read.`);
    const text = as === "base64" ? data.toString("base64") : data.toString("utf8");
    if (as === "utf8" && !Buffer.from(text, "utf8").equals(data)) return refused(`${target} is not plain text. Read it with encoding base64.`);
    return said(`${target} (${sizeText(data.length)}):\n${text}`);
  } finally {
    await file.close();
  }
}

async function writeFile(folders: HostFolders, args: Record<string, unknown>): Promise<Result> {
  const as = wanted(args.encoding);
  if (typeof args.content !== "string") throw new HostFileRefusal("Give the file's content.");
  if (args.overwrite !== undefined && typeof args.overwrite !== "boolean") throw new HostFileRefusal("overwrite is true or false.");
  const data = Buffer.from(args.content, as);
  if (data.length > HOST_FILE_WRITE_LIMIT) throw new HostFileRefusal("Files up to 25 MB can be saved.");
  const { target, exists } = await resolveHostPath(folders, args.path);
  const refusedWrite = writeRefusal(folders, target);
  if (refusedWrite) throw new HostFileRefusal(refusedWrite);
  const overwrite = args.overwrite === true;
  const mode = exists ? await replaceable(folders.platform, target, overwrite) : undefined;
  const p = folders.platform === "win32" ? path.win32 : path.posix;
  const folder = p.dirname(target);
  await makeFolders(folders, folder);
  // A temp file beside it, then a rename: a reader sees the whole old file or the whole new one.
  const temp = p.join(folder, `.${p.basename(target)}.${randomUUID().slice(0, 8)}.tmp`);
  const file = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode ?? 0o644);
  try {
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    const again = await resolveHostPath(folders, target);
    if (again.target !== target) throw new HostFileRefusal(`${target} changed while it was saved. Try again.`);
    if (!overwrite) await placeNew(temp, target);
    else {
      if (again.exists) await replaceable(folders.platform, target, true);
      await renameWithRetry(temp, target);
    }
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
  return said(`Saved ${sizeText(data.length)} to ${target}${exists ? " (replaced the file that was there)" : ""}.`);
}

const alreadyThere = (target: string) => new HostFileRefusal(`${target} already exists. To replace it, call write_file again with overwrite: true.`);

/** The mode of a file that may be replaced: an ordinary single-link file that nothing runs. */
async function replaceable(platform: HostFolders["platform"], target: string, overwrite: boolean): Promise<number> {
  const stat = await fs.lstat(target);
  if (stat.isDirectory()) throw new HostFileRefusal(`${target} is a folder. Give a file name inside it.`);
  if (!overwrite) throw alreadyThere(target);
  if (!stat.isFile() || stat.nlink > 1) throw new HostFileRefusal(`${target} is not an ordinary file, so it is not replaced.`);
  // Windows reports no execute bits; the file types it runs are refused by name.
  if (platform !== "win32" && (stat.mode & 0o111) !== 0) throw new HostFileRefusal(`${target} is a program or script (it can be run), so bots cannot replace it.`);
  return stat.mode & 0o777;
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

async function makeFolder(folders: HostFolders, args: Record<string, unknown>): Promise<Result> {
  const { target, exists } = await resolveHostPath(folders, args.path);
  const refusedFolder = writeRefusal(folders, target, "folder");
  if (refusedFolder) return refused(refusedFolder);
  if (exists) {
    if (!(await fs.lstat(target)).isDirectory()) return refused(`${target} is a file, not a folder.`);
    return said(`${target} is already there.`);
  }
  await makeFolders(folders, target);
  return said(`Made the folder ${target}.`);
}

const RUN = { list_files: listFiles, read_file: readFile, write_file: writeFile, make_folder: makeFolder } as const;

/** The bridge's relay for these tools: null for any other call. `folders` is asked once, at the first file call. */
export function hostFileRelay(folders: () => Promise<HostFolders>): (call: ToolCall) => Promise<Result> | null {
  let found: Promise<HostFolders> | undefined;
  return (call) => {
    if (!HOST_FILE_TOOL_NAMES.has(call.name)) return null;
    const at = typeof call.arguments.path === "string" && call.arguments.path ? call.arguments.path : "that path";
    found ??= folders().catch((error: unknown) => {
      found = undefined;
      throw error;
    });
    return found
      .then((ready) => RUN[call.name as keyof typeof RUN](ready, call.arguments))
      .catch((error: unknown) => failure(error, at));
  };
}

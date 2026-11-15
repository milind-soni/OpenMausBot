// Where a file another bot passed lands for the bot that receives it: `inbox/<from>/<assignment>/<name>` inside a
// folder that is the receiver's alone. The server writes the copy; the receiver's folder scopes never change.
//
// Security: the receiver can write in the folder that holds its inbox (a box mounts it read-write), so it can replace
// the inbox, or any folder in it, with a link. The inbox is therefore never resolved: its place is a literal path
// under the real task-workspaces folder, every folder from there down must be a real folder (a link refuses the
// delivery or the read, it is never followed), and what was written or opened is resolved afterwards and must be
// exactly that literal path. A copy that landed anywhere else is removed. The sender chooses only the file's display
// name, which is reduced to one safe path part.
//
// Windows has no open-without-following (O_NOFOLLOW), and a junction needs no special rights there. The guard is the
// same on every platform and does not rest on that flag: `lstat` reports a junction or a link as a link, never as a
// folder or a file, so each part is refused before it is used; and the path the operating system itself reports for
// what was opened or written (`realpath.native`, which also expands 8.3 short names and fixes the drive letter's
// case) must be the literal path, which a junction or link anywhere on the way makes impossible. On Windows the two
// are compared without regard to case, as its file names are.
import { constants, lstatSync, mkdirSync, promises as fsp, realpathSync, rmdirSync, rmSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { randomBytes } from "node:crypto";

export const INBOX_FOLDER = "inbox";
const PART_MAX = 48;
/** Most file systems hold a name of 255 bytes; this leaves room for a `-2` and the partial copy's own name. */
const NAME_MAX_BYTES = 200;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

/** One lowercase path part from a bot's name, or from its id when the name leaves nothing. */
export function inboxSenderPart(name: string, botId: string): string {
  const slug = (value: string) => value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, PART_MAX);
  const part = slug(name) || slug(botId) || "teammate";
  return WINDOWS_DEVICE.test(part) ? `bot-${part}` : part;
}

/** Files returned with a result land beside the ones sent with the assignment, never among them. */
export function inboxAssignmentPart(assignmentId: string, returned = false): string {
  return `${assignmentId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, PART_MAX) || "assignment"}${returned ? "-returned" : ""}`;
}

function cutToBytes(text: string, max: number): string {
  let out = "";
  for (const character of text) {
    if (Buffer.byteLength(out + character, "utf8") > max) break;
    out += character;
  }
  return out;
}

/** A display name as one file name: no separators, control characters, brackets, quotes or leading dots, no name
 * Windows keeps for a device, and at most NAME_MAX_BYTES bytes with the extension kept. */
export function inboxFileName(name: string): string {
  const flat = name.normalize("NFKC").replace(/[\\/]/g, "_").replace(/[^\p{L}\p{N} ._()+@,-]/gu, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  const extension = /^\.[A-Za-z0-9]{1,10}$/.test(extname(flat)) ? extname(flat) : "";
  const stem = cutToBytes(flat.slice(0, flat.length - extension.length).replace(/[. ]+$/, ""), NAME_MAX_BYTES - Buffer.byteLength(extension, "utf8")) || "file";
  return `${WINDOWS_DEVICE.test(`${stem}${extension}`) ? "_" : ""}${stem}${extension}`;
}

/** Names as they land in one folder: a second file of the same name gets `-2`, case-insensitively. */
export function inboxFileNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((raw) => {
    const name = inboxFileName(raw);
    const extension = extname(name), stem = name.slice(0, name.length - extension.length);
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem}-${n}${extension}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/** The same file path, as this platform names files: exactly, or on Windows whatever the case and the slashes. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase() : a === b;
}

/** `child` is strictly below `parent`, by the same rule. */
export function withinPath(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const separator = platform === "win32" ? win32.sep : posix.sep;
  const [low, top] = platform === "win32" ? [win32.normalize(child).toLowerCase(), win32.normalize(parent).toLowerCase()] : [child, parent];
  return low.startsWith(top.endsWith(separator) ? top : top + separator);
}

/** A copy's place as the receiver reads it from its conversation's own folder, with this platform's separators. */
export function inboxDisplayPath(fromPart: string, assignmentPart: string, name: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? win32 : posix).join(INBOX_FOLDER, fromPart, assignmentPart, name);
}

/** The path the operating system reports for what is there now: links and junctions resolved, and on Windows short
 * names expanded and the drive letter's case fixed. Every comparison here uses this one form. */
export const canonical = (path: string): string => realpathSync.native(path);
const within = (child: string, parent: string): boolean => withinPath(child, parent);
const realFolder = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

export interface InboxPlace {
  /** The receiver's own folder the inbox sits in; it must exist. */
  root: string;
  fromPart: string;
  assignmentPart: string;
  /** Folders and files another account must read (a Local VM's guest user): 0o755 and 0o644 instead of 0o700 and 0o600. */
  shared?: boolean;
}

export function inboxFolder(place: Pick<InboxPlace, "root" | "fromPart" | "assignmentPart">): string {
  return join(place.root, INBOX_FOLDER, place.fromPart, place.assignmentPart);
}

/** Copies `source` to its inbox place, off the event loop, and answers the path. A file already there under that name
 * is replaced: the caller decides whether a delivery is a repeat, and skips those. */
export async function placeInInbox(place: InboxPlace, source: string, fileName: string): Promise<string> {
  const root = canonical(place.root);
  let folder = root;
  for (const part of [INBOX_FOLDER, place.fromPart, place.assignmentPart]) {
    folder = join(folder, part);
    if (!lstatSync(folder, { throwIfNoEntry: false })) mkdirSync(folder, { mode: place.shared ? 0o755 : 0o700 });
    if (!realFolder(folder)) throw new Error(`${folder} is not a folder`);
  }
  if (!samePath(canonical(folder), folder)) throw new Error("the inbox folder leads outside the receiver's folder");
  const target = join(folder, inboxFileName(fileName));
  if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${target} is a folder`);
  const partial = join(folder, `.${randomBytes(6).toString("hex")}.part`);
  let landed: string | undefined;
  try {
    await fsp.copyFile(source, partial, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await fsp.chmod(partial, place.shared ? 0o644 : 0o600);
    await fsp.rename(partial, target);
    // A folder swapped for a link while the copy ran took the file with it: where it really is decides.
    landed = await fsp.realpath(target);
    if (!samePath(landed, target) || !(await fsp.lstat(target)).isFile()) throw new Error("the inbox folder was replaced while the file was copied");
    return target;
  } catch (error) {
    if (landed !== undefined) await fsp.rm(landed, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fsp.rm(partial, { force: true }).catch(() => undefined);
  }
}

/** A conversation's inbox as a place to read from. */
export interface InboxRead {
  /** `<data>/task-workspaces`. */
  taskWorkspaces: string;
  botId: string;
  threadId: string;
}

export interface OpenedInboxFile {
  handle: FileHandle;
  bytes: number;
  name: string;
  /** The literal path that was opened. */
  path: string;
}

/** The inbox's literal path under the real task-workspaces folder, or null while any folder down to it is missing or
 * is a link. */
function literalInbox(inbox: InboxRead): { root: string; spelled: string } | null {
  if (![inbox.botId, inbox.threadId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))) return null;
  let folder: string;
  try {
    folder = canonical(inbox.taskWorkspaces);
  } catch {
    return null;
  }
  for (const part of [inbox.botId, inbox.threadId, INBOX_FOLDER]) {
    folder = join(folder, part);
    if (!realFolder(folder)) return null;
  }
  return { root: folder, spelled: resolve(inbox.taskWorkspaces, inbox.botId, inbox.threadId, INBOX_FOLDER) };
}

/** Opens a file of the conversation's inbox, or answers null when `requested` is not one. Relative paths are read from
 * the conversation's folder (`inbox/...`) or from the inbox itself; an absolute one must spell the inbox. Nothing is
 * resolved on the way in: each folder is checked to be a real folder, the file is opened without following a link, and
 * the opened file must be the one at that literal path. */
export async function openInboxFile(requested: string, inbox: InboxRead, maxBytes: number): Promise<OpenedInboxFile | null> {
  const place = literalInbox(inbox);
  const wanted = requested.trim();
  if (!place || !wanted || wanted.includes("\0") || /^[a-z][a-z0-9+.-]*:\/\//i.test(wanted)) return null;
  const candidates = isAbsolute(wanted)
    ? [resolve(wanted), ...(within(resolve(wanted), place.spelled) ? [join(place.root, relative(place.spelled, resolve(wanted)))] : [])]
    : [resolve(join(place.root, ".."), wanted), resolve(place.root, wanted)];
  for (const candidate of new Set(candidates)) {
    if (!within(candidate, place.root)) continue;
    const parts = relative(place.root, candidate).split(sep);
    let folder = place.root, real = true;
    for (const part of parts.slice(0, -1)) {
      folder = join(folder, part);
      if (!realFolder(folder)) { real = false; break; }
    }
    if (!real || !lstatSync(candidate, { throwIfNoEntry: false })?.isFile()) continue;
    let handle: FileHandle | undefined;
    try {
      handle = await fsp.open(candidate, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile()) throw new Error("not a file");
      if (opened.size > maxBytes) throw Object.assign(new Error(`${basename(candidate)} exceeds ${maxBytes} bytes`), { status: 413 });
      const after = await fsp.stat(candidate);
      if (!samePath(await fsp.realpath(candidate), candidate) || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error("the inbox changed while the file was opened");
      return { handle, bytes: opened.size, name: basename(candidate), path: candidate };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as { status?: unknown } | null)?.status === 413) throw error;
    }
  }
  return null;
}

/** Removes a delivered copy and the folders it leaves empty, up to but not including `inbox`'s parent. Only a path that
 * has an `inbox` folder in it, reached through real folders, is touched. */
export function removeInboxCopy(path: string): void {
  const parts = path.split(sep), at = parts.lastIndexOf(INBOX_FOLDER);
  if (at < 1 || at >= parts.length - 1) return;
  try {
    for (let i = at; i < parts.length - 1; i += 1) if (!realFolder(parts.slice(0, i + 1).join(sep))) return;
    rmSync(path, { force: true });
    for (let i = parts.length - 1; i > at; i -= 1) {
      const folder = parts.slice(0, i).join(sep);
      if (!realFolder(folder)) return;
      try { rmdirSync(folder); } catch { return; }
    }
  } catch { /* a copy that cannot be removed stays */ }
}

/** Removes a conversation's whole inbox folder, when it is a real folder; a link there is removed as a link. */
export function removeInbox(conversationFolder: string): void {
  try { rmSync(join(conversationFolder, INBOX_FOLDER), { recursive: true, force: true }); } catch { /* stays */ }
}

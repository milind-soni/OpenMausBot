// Where a file another bot passed lands for the bot that receives it: `inbox/<from>/<assignment>/<name>` inside a
// folder that is the receiver's alone. The server writes the copy; the receiver's folder scopes never change.
//
// Security: the sender chooses only the file's display name, which is reduced to one safe path part. Every folder from
// the root down to the file must be a real folder (a link found there refuses the delivery, it is never followed), the
// folder the copy lands in is resolved again and must still sit under the root, and the copy is written under a
// private name and renamed into place, so nothing is written through a link and no half file is ever read.
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { extname, join, relative, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";

export const INBOX_FOLDER = "inbox";
const PART_MAX = 48;
const NAME_MAX = 120;

/** One lowercase path part from a bot's name, or from its id when the name leaves nothing. */
export function inboxSenderPart(name: string, botId: string): string {
  const slug = (value: string) => value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, PART_MAX);
  return slug(name) || slug(botId) || "teammate";
}

export function inboxAssignmentPart(assignmentId: string): string {
  return assignmentId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, PART_MAX) || "assignment";
}

/** A display name as one file name: no separators, control characters, brackets, quotes or leading dots, and a
 * bounded length that keeps the extension. */
export function inboxFileName(name: string): string {
  const flat = name.normalize("NFKC").replace(/[\\/]/g, "_").replace(/[^\p{L}\p{N} ._()+@,-]/gu, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  const extension = /^\.[A-Za-z0-9]{1,10}$/.test(extname(flat)) ? extname(flat) : "";
  const stem = Array.from(flat.slice(0, flat.length - extension.length).replace(/[. ]+$/, "")).slice(0, NAME_MAX).join("");
  return `${stem || "file"}${extension}`;
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

const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function realFolder(path: string, mode: number): void {
  const found = lstatSync(path, { throwIfNoEntry: false });
  if (!found) mkdirSync(path, { mode });
  else if (!found.isDirectory()) throw new Error(`${path} is not a folder`);
}

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

/** Copies `source` to its inbox place and answers the path. A file already there under that name is replaced: the
 * caller decides whether a delivery is a repeat, and skips those. */
export function placeInInbox(place: InboxPlace, source: string, fileName: string): string {
  const root = realpathSync(place.root);
  const folderMode = place.shared ? 0o755 : 0o700;
  let folder = root;
  for (const part of [INBOX_FOLDER, place.fromPart, place.assignmentPart]) {
    folder = join(folder, part);
    realFolder(folder, folderMode);
  }
  if (!inside(realpathSync(folder), root)) throw new Error("the inbox folder leads outside the receiver's folder");
  const target = join(folder, inboxFileName(fileName));
  if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${target} is a folder`);
  const partial = join(folder, `.${randomBytes(6).toString("hex")}.part`);
  try {
    copyFileSync(source, partial, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    chmodSync(partial, place.shared ? 0o644 : 0o600);
    renameSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }
  return target;
}

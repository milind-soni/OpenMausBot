// A message file link must never become a general-purpose host file reader: every handle stays inside a root
// derived from the exact bot message.
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fromMarkdown } from "mdast-util-from-markdown";

import { windowsPathDestinations } from "../shared/markdown-windows-paths.ts";
import { inSecretFolder, SECRET_FILE_REFUSAL } from "./secret-folder.ts";

export const MESSAGE_FILE_MAX_BYTES = 25 * 1024 * 1024;

export interface OpenedMessageFile {
  handle: FileHandle;
  bytes: number;
  name: string;
  mime: string;
}

export function messageFileRoots(options: {
  senderWorkspace: string;
  attachments: string;
  pinnedCwd: string | null | undefined;
  configuredCwd?: string;
}): string[] {
  const conversationRoot = options.pinnedCwd === undefined ? options.configuredCwd : options.pinnedCwd;
  return [...new Set([
    ...(typeof conversationRoot === "string" ? [conversationRoot] : []),
    options.senderWorkspace,
    options.attachments,
  ])];
}

function statusError(status: number, message: string, code?: string): Error & { status: number; code?: string } {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

const outsideWorkspace = () =>
  statusError(403, "the linked file is outside this conversation's workspace", "outside_workspace");

function decodePathWithSuffixRemoved(href: string): string {
  // Split before decoding, and decode exactly once, so authorization and opening see the same path.
  const path = href.split(/[?#]/, 1)[0]!;
  if (!path) throw statusError(400, "path must be a non-empty file link");
  try {
    return decodeURIComponent(path);
  } catch {
    throw statusError(400, "path must be a valid file link");
  }
}

function referencedPath(
  href: string,
  portableFileURL = false,
  allowForwardSlashUNC = true,
): string {
  if (!href || Buffer.byteLength(href) > 8_192 || href.includes("\0")) {
    throw statusError(400, "path must be a non-empty file link");
  }
  // A Windows drive prefix or a UNC path is a local path, not a URL scheme or a protocol-relative URL.
  if (/^[a-z]:[\\/]/i.test(href) || href.startsWith("\\\\")) {
    return decodePathWithSuffixRemoved(href);
  }
  // In Markdown //host/path is a web URL: accepted only as the request spelling of an explicit file:// UNC link.
  if (href.startsWith("//")) {
    if (!allowForwardSlashUNC) {
      throw statusError(400, "protocol-relative web links are not local files");
    }
    return decodePathWithSuffixRemoved(href);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      throw statusError(400, "path must be a valid file link");
    }
    if (url.protocol !== "file:" || url.username || url.password || url.port || url.search || url.hash) {
      throw statusError(400, "only local file links can be downloaded here");
    }
    if (url.hostname && url.hostname !== "localhost") {
      try {
        return `//${url.hostname}${decodeURIComponent(url.pathname)}`;
      } catch {
        throw statusError(400, "path must be a valid file link");
      }
    }
    if (!portableFileURL) {
      try {
        return fileURLToPath(url);
      } catch {
        throw statusError(400, "path must be a valid file link");
      }
    }
    try {
      const decoded = decodeURIComponent(url.pathname);
      // WHATWG file URLs spell drive paths /C:/... on every host; strip only that sentinel.
      return /^\/[a-z]:[\\/]/i.test(decoded) ? decoded.slice(1) : decoded;
    } catch {
      throw statusError(400, "path must be a valid file link");
    }
  }

  return decodePathWithSuffixRemoved(href);
}

export function referencedFileName(href: string): string | null {
  try {
    return referencedPath(href, true).split(/[\\/]/).at(-1) || null;
  } catch {
    return null;
  }
}

/** Lexical on purpose: `resolve` and `fileURLToPath` follow the runner OS, and `/C:/notes.md` is not `C:\\notes.md`. */
function referencedPathIdentity(href: string, allowForwardSlashUNC = true): string {
  const path = referencedPath(href, true, allowForwardSlashUNC);
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\") || path.startsWith("//")) {
    return `windows:${win32.resolve(path)}`;
  }
  if (path.startsWith("/")) return `posix:${posix.resolve(path)}`;
  return `relative:${posix.normalize(path)}`;
}

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  identifier?: string;
  url?: string;
  value?: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
};

function walkMarkdown(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    visit(current);
    const children = current.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]!);
    }
  }
}

function renderedMarkdownTargets(markdown: string): string[] {
  const definitions = new Map<string, string>();
  const links: string[] = [];
  const references: string[] = [];

  walkMarkdown(fromMarkdown(markdown, { mdastExtensions: [windowsPathDestinations] }), (node) => {
    if (node.type === "definition" && node.identifier && node.url) {
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    } else if ((node.type === "link" || node.type === "image") && node.url) {
      links.push(node.url);
    } else if ((node.type === "linkReference" || node.type === "imageReference") && node.identifier) {
      references.push(node.identifier);
    }
  });

  for (const identifier of references) {
    const target = definitions.get(identifier);
    if (target) links.push(target);
  }
  return links;
}

export function messageFileTargets(text: string): string[] {
  return [...new Set(renderedMarkdownTargets(text))].filter((target) =>
    !target.startsWith("#") && !target.startsWith("//") &&
    (/^[a-z]:[\\/]/i.test(target) || /^file:/i.test(target) || !/^[a-z][a-z\d+.-]*:/i.test(target)));
}

/** Definitions are collected first: CommonMark lets them follow the reference. */
export function messageImageTargetAt(text: string, sourceOffset: number): string | null {
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0) return null;
  const definitions = new Map<string, string>();
  let direct: string | null = null;
  let reference: string | null = null;

  walkMarkdown(fromMarkdown(text, { mdastExtensions: [windowsPathDestinations] }), (node) => {
    if (node.type === "definition" && node.identifier && node.url) {
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
      return;
    }
    if (node.position?.start.offset !== sourceOffset) return;
    if (node.type === "image" && node.url) direct = node.url;
    else if (node.type === "imageReference" && node.identifier) reference = node.identifier;
  });

  return direct ?? (reference ? definitions.get(reference) ?? null : null);
}

/** iOS delivers a percent-encoded file href as a decoded path; only rendered link targets are normalised, never prose. */
export function messageReferencesFile(text: string, requested: string): boolean {
  let wanted: string;
  try {
    wanted = referencedPathIdentity(requested);
  } catch {
    return false;
  }

  for (const target of renderedMarkdownTargets(text)) {
    try {
      if (referencedPathIdentity(target, false) === wanted) return true;
    } catch {
    }
  }
  return false;
}

/** A single pass on purpose: double-encoded input stays encoded and must not become a path while being authorised. */
export function decodeAttachmentAttribute(value: string): string {
  return value.replace(
    /&(quot|lt|gt|amp);|&#(9|10|13);/g,
    (entity, named: string | undefined, numeric: string | undefined) => {
      if (numeric === "9") return "\t";
      if (numeric === "10") return "\n";
      if (numeric === "13") return "\r";
      if (named === "quot") return '"';
      if (named === "lt") return "<";
      if (named === "gt") return ">";
      if (named === "amp") return "&";
      return entity;
    },
  );
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

/** Below common 255-byte name limits, with room for the app's temporary-file suffix. */
function boundedDisplayName(value: string, maximumBytes = 180): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  const extension = extname(value);
  const extensionBytes = Buffer.byteLength(extension);
  if (extension && extensionBytes <= 32 && extensionBytes < maximumBytes) {
    const stem = utf8Prefix(value.slice(0, -extension.length), maximumBytes - extensionBytes);
    if (stem) return `${stem}${extension}`;
  }
  return utf8Prefix(value, maximumBytes) || "download";
}

function safeDisplayName(value: string): string {
  const portable = value.split(/[\\/]/).at(-1) ?? "";
  const clean = Array.from(portable, (character) => {
    const code = character.codePointAt(0) ?? 0;
    const invalid = code <= 31 || (code >= 127 && code <= 159)
      || (code >= 0xd800 && code <= 0xdfff)
      || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069);
    return invalid ? "_" : character;
  }).join("").trim();
  return boundedDisplayName(clean || "download");
}

/** Only an exact standalone transport tag grants access; prose, examples, code and near-matches never do. */
export function messageAttachmentName(text: string, requested: string): string | null {
  let wanted: string;
  try {
    wanted = referencedPathIdentity(requested);
  } catch {
    return null;
  }

  const tag = /^<attached-(?:image|file)[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*\/>$/;
  let found: string | null = null;
  walkMarkdown(fromMarkdown(text), (node) => {
    if (found !== null) return;
    if (node.type !== "html" || !node.value || !node.position) return;
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    if (start === undefined || end === undefined) return;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const nextLine = text.indexOf("\n", end);
    const lineEnd = nextLine < 0 ? text.length : nextLine;
    if (text.slice(lineStart, start).trim() || text.slice(end, lineEnd).trim()) return;
    const match = tag.exec(node.value);
    if (!match) return;
    try {
      if (referencedPathIdentity(decodeAttachmentAttribute(match[1]!)) === wanted) {
        found = safeDisplayName(match[2]
          ? decodeAttachmentAttribute(match[2])
          : decodeAttachmentAttribute(match[1]!));
      }
    } catch {
    }
  });
  return found;
}

function containedBy(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

export function mimeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".md": return "text/markdown; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    case ".csv": return "text/csv; charset=utf-8";
    case ".tsv": return "text/tab-separated-values; charset=utf-8";
    case ".json": return "application/json";
    case ".pdf": return "application/pdf";
    case ".rtf": return "application/rtf";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".mp4": return "video/mp4";
    case ".m4v": return "video/x-m4v";
    case ".webm": return "video/webm";
    case ".mov": return "video/quicktime";
    case ".mp3": return "audio/mpeg";
    case ".m4a": return "audio/mp4";
    case ".aac": return "audio/aac";
    case ".wav": return "audio/wav";
    case ".ogg":
    case ".oga": return "audio/ogg";
    case ".opus": return "audio/opus";
    case ".flac": return "audio/flac";
    case ".doc": return "application/msword";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls": return "application/vnd.ms-excel";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".ppt": return "application/vnd.ms-powerpoint";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".odt": return "application/vnd.oasis.opendocument.text";
    case ".ods": return "application/vnd.oasis.opendocument.spreadsheet";
    case ".odp": return "application/vnd.oasis.opendocument.presentation";
    default: return "application/octet-stream";
  }
}

/** Canonicalised before and after opening, and the handle compared with the post-open path, to reject symlink escapes and directory swaps. */
export async function openMessageFile(href: string, roots: readonly string[]): Promise<OpenedMessageFile> {
  const requested = referencedPath(href);
  const canonicalRoots = (await Promise.all(roots.map(async (root) => {
    try {
      const canonical = await realpath(root);
      return (await stat(canonical)).isDirectory() ? canonical : null;
    } catch {
      return null;
    }
  }))).filter((root): root is string => Boolean(root));

  if (canonicalRoots.length === 0) throw statusError(404, "the linked file is unavailable");
  const candidates = isAbsolute(requested)
    ? [resolve(requested)]
    : canonicalRoots.map((root) => resolve(root, requested));

  let sawOutsideRoot = false;
  for (const candidate of new Set(candidates)) {
    let canonicalBefore: string;
    try {
      canonicalBefore = await realpath(candidate);
    } catch {
      continue;
    }
    const root = canonicalRoots.find((allowed) => containedBy(allowed, canonicalBefore));
    if (!root) {
      sawOutsideRoot = true;
      continue;
    }
    if (inSecretFolder(canonicalBefore)) throw statusError(403, SECRET_FILE_REFUSAL, "secret_file");

    let handle: FileHandle | undefined;
    try {
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      handle = await open(canonicalBefore, constants.O_RDONLY | noFollow);
      const opened = await handle.stat();
      if (opened.isDirectory()) throw statusError(400, "the link points to a folder, not a file", "directory");
      if (!opened.isFile()) throw statusError(400, "the link does not point to a regular file");
      if (opened.size > MESSAGE_FILE_MAX_BYTES) {
        throw statusError(413, `file exceeds ${MESSAGE_FILE_MAX_BYTES} bytes`);
      }

      const canonicalAfter = await realpath(candidate);
      if (!containedBy(root, canonicalAfter)) throw outsideWorkspace();
      if (inSecretFolder(canonicalAfter)) throw statusError(403, SECRET_FILE_REFUSAL, "secret_file");
      const after = await stat(canonicalAfter);
      if (opened.dev !== after.dev || opened.ino !== after.ino) {
        throw statusError(409, "the linked file changed while it was being opened");
      }

      return {
        handle,
        bytes: opened.size,
        name: basename(canonicalAfter),
        mime: mimeFor(canonicalAfter),
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error && typeof error === "object" && "status" in error) throw error;
      continue;
    }
  }

  if (sawOutsideRoot) throw outsideWorkspace();
  throw statusError(404, "the linked file is unavailable");
}

/** HFS+ and FAT keep whole or even seconds, so a file written early in a turn can carry a slightly earlier time. */
const SAVED_SINCE_SLACK_MS = 2_000;

/** Grants no folder and is never used for a message link. */
export async function openFileSavedSince(
  href: string,
  options: { since: number; refuse: readonly string[] },
): Promise<OpenedMessageFile> {
  const requested = referencedPath(href, false, false);
  if (!isAbsolute(requested) || requested.startsWith("\\\\") || requested.startsWith("//")) throw outsideWorkspace();
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch {
    throw statusError(404, "the linked file is unavailable");
  }
  const refused = (await Promise.all(options.refuse.map((root) => realpath(root).catch(() => null))))
    .filter((root): root is string => Boolean(root));
  const hidden = canonical.split(/[\\/]/).some((part) => part.startsWith("."));
  if (hidden || refused.some((root) => containedBy(root, canonical))) {
    throw statusError(403, "files in hidden folders or in the app's own data can't be attached", "outside_workspace");
  }
  const file = await openMessageFile(canonical, [dirname(canonical)]);
  const opened = await file.handle.stat().catch(async (error: unknown) => {
    await file.handle.close().catch(() => undefined);
    throw error;
  });
  if (opened.mtimeMs < options.since - SAVED_SINCE_SLACK_MS) {
    await file.handle.close().catch(() => undefined);
    throw statusError(403, "that file is outside your working folder and was not saved during this turn, so it can't be attached", "outside_workspace");
  }
  return file;
}

export const MESSAGE_FOLDER_MAX_ENTRIES = 200;

export interface MessageFolderEntry {
  name: string;
  bytes: number;
  mime: string;
}

export interface MessageFolderListing {
  name: string;
  entries: MessageFolderEntry[];
  truncated: boolean;
}

export async function listMessageFolder(href: string, roots: readonly string[]): Promise<MessageFolderListing> {
  const { path: _path, ...listing } = await readMessageFolder(href, roots);
  return listing;
}

export async function openMessageFolderEntry(
  href: string,
  entry: string,
  roots: readonly string[],
): Promise<OpenedMessageFile> {
  const folder = await readMessageFolder(href, roots);
  if (!folder.entries.some((listed) => listed.name === entry)) {
    throw statusError(404, "the linked file is unavailable");
  }
  return openMessageFile(pathToFileURL(join(folder.path, entry)).href, roots);
}

async function readMessageFolder(
  href: string,
  roots: readonly string[],
): Promise<MessageFolderListing & { path: string }> {
  const requested = referencedPath(href);
  const canonicalRoots = (await Promise.all(roots.map(async (root) => {
    try {
      const canonical = await realpath(root);
      return (await stat(canonical)).isDirectory() ? canonical : null;
    } catch {
      return null;
    }
  }))).filter((root): root is string => Boolean(root));
  if (canonicalRoots.length === 0) throw statusError(404, "the linked folder is unavailable");
  const candidates = isAbsolute(requested)
    ? [resolve(requested)]
    : canonicalRoots.map((root) => resolve(root, requested));

  let sawOutsideRoot = false;
  for (const candidate of new Set(candidates)) {
    let folder: string;
    try {
      folder = await realpath(candidate);
    } catch {
      continue;
    }
    const root = canonicalRoots.find((allowed) => containedBy(allowed, folder));
    if (!root) {
      sawOutsideRoot = true;
      continue;
    }
    if (inSecretFolder(folder)) throw statusError(403, SECRET_FILE_REFUSAL, "secret_file");
    if (!(await stat(folder)).isDirectory()) throw statusError(400, "the link does not point to a folder");

    const names = (await readdir(folder)).sort((a, b) => a.localeCompare(b));
    const entries: MessageFolderEntry[] = [];
    let truncated = false;
    for (const name of names) {
      const child = join(folder, name);
      try {
        const own = await lstat(child);
        if (!own.isFile() && !own.isSymbolicLink()) continue;
        const target = await realpath(child);
        if (!containedBy(root, target) || inSecretFolder(target)) continue;
        const info = await stat(target);
        if (!info.isFile()) continue;
        if (entries.length >= MESSAGE_FOLDER_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push({ name, bytes: info.size, mime: mimeFor(target) });
      } catch {
        continue;
      }
    }
    return { name: basename(folder), entries, truncated, path: folder };
  }

  if (sawOutsideRoot) throw outsideWorkspace();
  throw statusError(404, "the linked folder is unavailable");
}

export function messageFolderEntryName(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 255) return null;
  if (value === "." || value === ".." || /[\\/\0]/.test(value)) return null;
  return value;
}

export function messageFileDisposition(name: string): string {
  const safeName = safeDisplayName(name);
  const fallback = safeName
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 180) || "download";
  const encoded = encodeURIComponent(safeName).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** A transport name must not disguise the bytes' canonical extension (PDF bytes named setup.exe). */
export function messageFileDownloadName(displayName: string | undefined, canonicalName: string): string {
  const canonical = safeDisplayName(canonicalName);
  if (!displayName) return canonical;
  const display = safeDisplayName(displayName);
  const actualExtension = extname(canonical);
  if (!actualExtension) return canonical;
  if (extname(display).toLowerCase() === actualExtension.toLowerCase()) return display;
  const displayExtension = extname(display);
  const stem = displayExtension ? display.slice(0, -displayExtension.length) : display;
  return safeDisplayName(`${stem || "download"}${actualExtension}`);
}

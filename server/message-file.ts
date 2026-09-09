// A bot may link to a file it created in the workspace for one conversation.
// Opening that link from a phone must not become a general-purpose host file
// reader: the HTTP route supplies only roots derived from the exact bot
// message, and this helper keeps the eventual file handle inside one of them.
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { fromMarkdown } from "mdast-util-from-markdown";

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
  /** undefined = not pinned yet; null = explicitly pinned to no host root. */
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

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function decodePathWithSuffixRemoved(href: string): string {
  // Split before decoding so an encoded `?` or `#` remains part of the
  // filename, while a real Markdown query/fragment never reaches the file
  // lookup. Decode exactly once so authorization and opening see the same
  // path without making double-encoded input more privileged.
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
  // A Windows drive prefix is a path, not a one-letter URL scheme. UNC is
  // also already an absolute local path on Windows and must not be mistaken
  // for a protocol-relative web URL.
  if (/^[a-z]:[\\/]/i.test(href) || href.startsWith("\\\\")) {
    return decodePathWithSuffixRemoved(href);
  }
  // In Markdown, //host/path is a protocol-relative web URL. It is accepted
  // only as the normalized request spelling of an explicit file:// UNC link,
  // never as the authored capability itself.
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
      // WHATWG file URLs always spell drive paths as /C:/..., even when the
      // URL is parsed on macOS or Linux. Strip only that drive sentinel; an
      // ordinary /Users/... URL must remain a POSIX path on every host.
      return /^\/[a-z]:[\\/]/i.test(decoded) ? decoded.slice(1) : decoded;
    } catch {
      throw statusError(400, "path must be a valid file link");
    }
  }

  // Query strings and fragments belong to the Markdown link, not the local
  // filename. Percent-encoding is common for spaces in relative hrefs.
  return decodePathWithSuffixRemoved(href);
}

/**
 * A lexical path identity used only for matching a requested file against a
 * rendered Markdown link. Native `resolve` and `fileURLToPath` follow the
 * runner OS, which makes a Unix link compare differently on Windows CI and a
 * Windows link compare differently on macOS. Keeping the path flavour in the
 * identity also prevents a POSIX path such as `/C:/notes.md` from being
 * mistaken for the Windows path `C:\\notes.md`.
 */
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

  walkMarkdown(fromMarkdown(markdown), (node) => {
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

/** Resolve the local image authored at one Markdown source offset. The
 * browser can use this small message-scoped reference instead of putting an
 * absolute host path in a GET URL. Definitions are collected first because
 * CommonMark permits them to appear after the image reference. */
export function messageImageTargetAt(text: string, sourceOffset: number): string | null {
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0) return null;
  const definitions = new Map<string, string>();
  let direct: string | null = null;
  let reference: string | null = null;

  walkMarkdown(fromMarkdown(text), (node) => {
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

/**
 * Confirm that the requested path is carried by this message, tolerating the
 * one representation change native URL APIs make for us: a file href with
 * percent-encoded spaces arrives from iOS as a decoded filesystem path.
 * Normalisation is applied only to rendered Markdown link targets, never to
 * arbitrary prose in the message.
 */
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
      // A malformed candidate is not the link the client asked to open.
    }
  }
  return false;
}

/** Decode exactly the entity spellings emitted by the composer. A single
 * pass is intentional: double-encoded input must not turn into a path only
 * while it is being authorised. */
function decodeAttachmentAttribute(value: string): string {
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

/** Keep the eventual native filename below common 255-byte component limits.
 * 180 bytes leaves room for the app's temporary-file suffix. */
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

/**
 * Confirm that a stored user message carries the requested attachment as an
 * exact standalone transport tag. Plain prose, inline examples, fenced code,
 * and near-matching paths do not grant access. The HTTP route pairs this
 * message capability with ATTACHMENTS_DIR containment, so this can never
 * become an arbitrary host-file reader.
 */
export function messageReferencesAttachment(text: string, requested: string): boolean {
  return messageAttachmentName(text, requested) !== null;
}

/** Return the user-facing name carried by an authorised attachment tag. */
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
      // A malformed transport tag grants no capability.
    }
  });
  return found;
}

function containedBy(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function mimeFor(path: string): string {
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

/**
 * Open a message-linked file under one of the supplied roots. The returned
 * handle, not the pathname, is what the caller streams. We canonicalise both
 * before and after opening and compare the handle with the post-open path;
 * this rejects symlink escapes and directory swaps instead of checking a
 * path and then opening a potentially different file.
 */
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

    let handle: FileHandle | undefined;
    try {
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      handle = await open(canonicalBefore, constants.O_RDONLY | noFollow);
      const opened = await handle.stat();
      if (!opened.isFile()) throw statusError(400, "the link does not point to a regular file");
      if (opened.size > MESSAGE_FILE_MAX_BYTES) {
        throw statusError(413, `file exceeds ${MESSAGE_FILE_MAX_BYTES} bytes`);
      }

      const canonicalAfter = await realpath(candidate);
      if (!containedBy(root, canonicalAfter)) throw statusError(403, "the linked file is outside this conversation's workspace");
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

  if (sawOutsideRoot) throw statusError(403, "the linked file is outside this conversation's workspace");
  throw statusError(404, "the linked file is unavailable");
}

/** A safe attachment header with a readable ASCII fallback and UTF-8 name. */
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

/** Keep a friendly transport name without allowing it to disguise the bytes'
 * canonical extension (for example PDF bytes named setup.exe). */
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

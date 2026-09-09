// Turn-local image admission.
//
// Composer messages persist a standalone <attached-image> transport tag so
// every client can render the attachment later. Providers should not have to
// discover that image through a filesystem tool (and an approval round trip),
// so this module turns only app-owned tags from the CURRENT message into the
// structured image input each native protocol understands.
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";

import { ATTACHMENTS_DIR, IMAGE_MAX_BYTES } from "./attachments.ts";
import type { TurnImageInput } from "./contracts.ts";

/** Matches the companion composer policy. Four maximum-sized images are
 * bounded to 40 MiB before a provider is asked to ingest them. */
export const TURN_IMAGE_MAX_COUNT = 4;
export const TURN_IMAGE_MAX_BYTES = TURN_IMAGE_MAX_COUNT * IMAGE_MAX_BYTES;

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  value?: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
};

type TagCandidate = { start: number; end: number; path: string };

const OWNED_IMAGE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
const IMAGE_TAG =
  /^<attached-image[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*\/>$/;

const MIME_BY_EXTENSION: Readonly<Record<string, TurnImageInput["mime"]>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Decode exactly the entities emitted by the composer. Repeated or unknown
 * encodings stay encoded and therefore cannot acquire a privileged path. */
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

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    visit(current);
    const children = current.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
}

/** Find only exact, standalone HTML transport tags. mdast keeps examples in
 * code fences/code spans out of HTML nodes; the line boundary check keeps
 * prose containing a tag literal from becoming an attachment capability. */
function imageTagCandidates(text: string): TagCandidate[] {
  const candidates: TagCandidate[] = [];
  walk(fromMarkdown(text) as MarkdownNode, (node) => {
    if (node.type !== "html" || !node.value || !node.position) return;
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    if (start === undefined || end === undefined) return;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const nextLine = text.indexOf("\n", end);
    const lineEnd = nextLine < 0 ? text.length : nextLine;
    if (text.slice(lineStart, start).trim() || text.slice(end, lineEnd).trim()) return;
    const match = IMAGE_TAG.exec(node.value);
    if (!match) return;
    candidates.push({ start, end, path: decodeAttachmentAttribute(match[1]!) });
  });
  return candidates;
}

function ownedImage(path: string, attachmentsDir: string): TurnImageInput | null {
  if (!path || path.includes("\0")) return null;
  const name = path.split(/[\\/]/).at(-1) ?? "";
  if (!OWNED_IMAGE_NAME.test(name)) return null;

  // The composer receives and returns the exact server-generated path. A
  // basename match alone would let an arbitrary /tmp/<uuid>.png masquerade
  // as an app attachment, so the lexical path must point into this store too.
  const expected = resolve(attachmentsDir, name);
  if (resolve(path) !== expected) return null;

  try {
    const entry = lstatSync(expected);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > IMAGE_MAX_BYTES) return null;
    const canonicalRoot = realpathSync(attachmentsDir);
    const canonicalFile = realpathSync(expected);
    if (dirname(canonicalFile) !== canonicalRoot) return null;
    const finalEntry = statSync(canonicalFile);
    if (!finalEntry.isFile() || finalEntry.size !== entry.size) return null;
    const mime = MIME_BY_EXTENSION[extname(name)];
    return mime ? { path: expected, mime, bytes: entry.size } : null;
  } catch {
    return null;
  }
}

export interface ExtractTurnImagesOptions {
  /** Injectable only so focused tests never touch the user's data store. */
  attachmentsDir?: string;
  maxCount?: number;
  maxBytes?: number;
}

/** Resolve and remove trusted image tags from provider-facing text. The
 * caller continues to persist the original string unchanged. Invalid tags
 * stay visible as ordinary text and never turn into native image input. */
export function extractTurnImages(
  text: string,
  options: ExtractTurnImagesOptions = {},
): { text: string; images: TurnImageInput[] } {
  // Almost every turn is plain text. Skipping the Markdown tree for those
  // turns keeps image transport work out of the hot send path.
  if (!text.includes("<attached-image")) return { text, images: [] };

  const attachmentsDir = options.attachmentsDir ?? ATTACHMENTS_DIR;
  const maxCount = options.maxCount ?? TURN_IMAGE_MAX_COUNT;
  const maxBytes = options.maxBytes ?? TURN_IMAGE_MAX_BYTES;
  const admitted = imageTagCandidates(text)
    .map((tag) => ({ tag, image: ownedImage(tag.path, attachmentsDir) }))
    .filter((item): item is { tag: TagCandidate; image: TurnImageInput } => item.image !== null);

  if (admitted.length > maxCount) {
    throw statusError(413, `Send no more than ${maxCount} images at a time`);
  }
  const aggregateBytes = admitted.reduce((total, item) => total + item.image.bytes, 0);
  if (aggregateBytes > maxBytes) {
    throw statusError(413, `Attached images exceed ${Math.floor(maxBytes / (1024 * 1024))} MB total`);
  }

  let providerText = text;
  for (const { tag } of admitted.toReversed()) {
    providerText = providerText.slice(0, tag.start) + providerText.slice(tag.end);
  }
  return { text: providerText, images: admitted.map((item) => item.image) };
}

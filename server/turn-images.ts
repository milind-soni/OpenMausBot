import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";

import { ATTACHMENTS_DIR, FILE_MAX_BYTES, IMAGE_MAX_BYTES } from "./attachments.ts";
import type { ProviderAdapter, TurnImageInput, TurnVideoInput } from "./contracts.ts";
import { CHAT_IMAGE_BUDGET, chatMediaUrlBytes } from "./drivers/chat-images.ts";
import { decodeAttachmentAttribute } from "./message-file.ts";
import { escapeAttribute } from "../src/lib/composer-attachments.ts";
import { videoFrameImages } from "./turn-video.ts";

export const TURN_IMAGE_MAX_COUNT = 10;
/** Total image bytes one turn may carry: the 40 MB it was when a turn took four images, so engine requests don't grow. */
export const TURN_IMAGE_MAX_BYTES = 4 * IMAGE_MAX_BYTES;
// A video is sampled into several frames before it reaches a model, so only the first one in a message is sampled.
export const TURN_VIDEO_MAX_COUNT = 1;

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  value?: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
};

type TagCandidate = { start: number; end: number; kind: "image" | "file"; path: string };

const OWNED_IMAGE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
const OWNED_VIDEO_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(mp4|webm|mov)$/;
// Composer video attachments use the generic <attached-file> tag (the same one documents and audio use); only its
// path decides whether it resolves to a video, so every other file kind keeps going through unexamined.
const ATTACHMENT_TAG =
  /^<attached-(image|file)[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*\/>$/;

const MIME_BY_EXTENSION: Readonly<Record<string, TurnImageInput["mime"]>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const VIDEO_MIME_BY_EXTENSION: Readonly<Record<string, TurnVideoInput["mime"]>> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
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

/** Standalone tags only: prose that contains a tag literal must not become an attachment capability. */
function attachmentTagCandidates(text: string): TagCandidate[] {
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
    const match = ATTACHMENT_TAG.exec(node.value);
    if (!match) return;
    candidates.push({ start, end, kind: match[1] === "file" ? "file" : "image", path: decodeAttachmentAttribute(match[2]!) });
  });
  return candidates;
}

function ownedAttachment<Mime extends string>(
  path: string,
  attachmentsDir: string,
  nameFormat: RegExp,
  mimeByExtension: Readonly<Record<string, Mime>>,
  maxBytes: number,
): { path: string; mime: Mime; bytes: number } | null {
  if (!path || path.includes("\0")) return null;
  const name = path.split(/[\\/]/).at(-1) ?? "";
  if (!nameFormat.test(name)) return null;

  // A basename match alone would let any /tmp/<uuid>.ext pose as an app attachment: the path must point into this store.
  const expected = resolve(attachmentsDir, name);
  if (resolve(path) !== expected) return null;

  try {
    const entry = lstatSync(expected);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > maxBytes) return null;
    const canonicalRoot = realpathSync(attachmentsDir);
    const canonicalFile = realpathSync(expected);
    if (dirname(canonicalFile) !== canonicalRoot) return null;
    const finalEntry = statSync(canonicalFile);
    if (!finalEntry.isFile() || finalEntry.size !== entry.size) return null;
    const mime = mimeByExtension[extname(name)];
    return mime ? { path: expected, mime, bytes: entry.size } : null;
  } catch {
    return null;
  }
}

const ownedImage = (path: string, attachmentsDir: string): TurnImageInput | null =>
  ownedAttachment(path, attachmentsDir, OWNED_IMAGE_NAME, MIME_BY_EXTENSION, IMAGE_MAX_BYTES);
const ownedVideo = (path: string, attachmentsDir: string): TurnVideoInput | null =>
  ownedAttachment(path, attachmentsDir, OWNED_VIDEO_NAME, VIDEO_MIME_BY_EXTENSION, FILE_MAX_BYTES);

/**
 * Added beside a replayed message's image file reference: the image itself rides on the current turn, so without this the model
 * reads an old screenshot as part of the latest message.
 */
export const REPLAYED_IMAGE_NOTE =
  "[An image was attached to this earlier message. It is attached again to this turn only so you can still see it; it is not new and was not sent with the latest message.]";

export interface ExtractTurnImagesOptions {
  attachmentsDir?: string;
  maxCount?: number;
  maxBytes?: number;
  maxVideoCount?: number;
  /** Text prepended to each admitted image file reference. */
  imageNote?: string;
}

/**
 * Invalid tags stay visible as ordinary text and never become native image input. Admitted images retain an
 * attached-file reference for file tools; videos keep their existing reference alongside sampled frames.
 */
export function extractTurnImages(
  text: string,
  options: ExtractTurnImagesOptions = {},
): { text: string; images: TurnImageInput[]; videos: TurnVideoInput[] } {
  if (!text.includes("<attached-image") && !text.includes("<attached-file")) return { text, images: [], videos: [] };

  const attachmentsDir = options.attachmentsDir ?? ATTACHMENTS_DIR;
  const maxCount = options.maxCount ?? TURN_IMAGE_MAX_COUNT;
  const maxBytes = options.maxBytes ?? TURN_IMAGE_MAX_BYTES;
  const maxVideoCount = options.maxVideoCount ?? TURN_VIDEO_MAX_COUNT;
  const candidates = attachmentTagCandidates(text);

  const admittedImages = candidates
    .filter((tag) => tag.kind === "image")
    .map((tag) => ({ tag, image: ownedImage(tag.path, attachmentsDir) }))
    .filter((item): item is { tag: TagCandidate; image: TurnImageInput } => item.image !== null);
  if (admittedImages.length > maxCount) {
    throw statusError(413, `Send no more than ${maxCount} images at a time`);
  }
  const aggregateBytes = admittedImages.reduce((total, item) => total + item.image.bytes, 0);
  if (aggregateBytes > maxBytes) {
    throw statusError(413, `Attached images exceed ${Math.floor(maxBytes / (1024 * 1024))} MB total`);
  }

  const videos = candidates
    .filter((tag) => tag.kind === "file")
    .map((tag) => ownedVideo(tag.path, attachmentsDir))
    .filter((video): video is TurnVideoInput => video !== null)
    .slice(0, maxVideoCount);

  let providerText = text;
  const imageTags = [...admittedImages].sort((a, b) => b.tag.start - a.tag.start);
  for (const { tag, image } of imageTags) {
    const fileTag = text.slice(tag.start, tag.end).replace(
      /^<attached-image[\t ]+path="[^"\r\n]*"/,
      () => `<attached-file path="${escapeAttribute(image.path)}"`,
    );
    const reference = options.imageNote ? `${options.imageNote}\n\n${fileTag}` : fileTag;
    providerText = providerText.slice(0, tag.start) + reference + providerText.slice(tag.end);
  }

  return { text: providerText, images: admittedImages.map((item) => item.image), videos };
}

const mediaUrlBytes = (media: readonly { mime: string; bytes: number }[]) => media.reduce((total, item) => total + chatMediaUrlBytes(item), 0);

/** The clips an engine that takes video gets as they are, each file once: those within its byte limit that also keep the turn's `images` inside the request's media budget. */
export function nativeClips(videos: readonly TurnVideoInput[], engine: Pick<ProviderAdapter["capabilities"], "nativeImageInput" | "nativeVideoBytes">,
  images: readonly TurnImageInput[] = []): TurnVideoInput[] {
  const limit = engine.nativeImageInput ? engine.nativeVideoBytes ?? 0 : 0;
  let clipBytes = 0, encoded = mediaUrlBytes(images);
  const paths = new Set<string>();
  return videos.filter((clip) => {
    const url = chatMediaUrlBytes(clip);
    if (paths.has(clip.path) || clipBytes + clip.bytes > limit || encoded + url > CHAT_IMAGE_BUDGET) return false;
    paths.add(clip.path);
    clipBytes += clip.bytes;
    encoded += url;
    return true;
  });
}

/** Stills sampled from a message's videos not `sent` as clips, never taking a turn that already carries `earlier` images past its image count,
 *  and only the frames that still fit the request's media budget with the sent clips and the turn's other pictures (`alongside`). */
export async function videoFramesWithin(earlier: number, videos: readonly TurnVideoInput[], sent: readonly TurnVideoInput[] = [],
  alongside: readonly TurnImageInput[] = []): Promise<TurnImageInput[]> {
  const sentPaths = new Set(sent.map((clip) => clip.path));
  const frames = await videoFrameImages(videos.filter((video) => !sentPaths.has(video.path)), TURN_IMAGE_MAX_COUNT - earlier);
  let room = CHAT_IMAGE_BUDGET - mediaUrlBytes([...sent, ...alongside]);
  return frames.filter((frame) => {
    const url = chatMediaUrlBytes(frame);
    if (url > room) return false;
    room -= url;
    return true;
  });
}

/** A burst's media: clips chosen once for all its lines against every line's pictures, then each line's pictures and the frames of its clips not sent. */
export async function turnMedia(lines: readonly { images: readonly TurnImageInput[]; videos: readonly TurnVideoInput[] }[],
  engine: Pick<ProviderAdapter["capabilities"], "nativeImageInput" | "nativeVideoBytes">): Promise<{ images: TurnImageInput[]; videos: TurnVideoInput[] }> {
  const pictures = lines.flatMap((line) => line.images);
  const videos = nativeClips(lines.flatMap((line) => line.videos), engine, pictures);
  const images: TurnImageInput[] = [], frames: TurnImageInput[] = [];
  for (const line of lines) {
    const sampled = await videoFramesWithin(pictures.length + frames.length, line.videos, videos, [...pictures, ...frames]);
    frames.push(...sampled);
    images.push(...line.images, ...sampled);
  }
  return { images, videos };
}

export function extractSteerImages(
  texts: readonly string[],
  options: ExtractTurnImagesOptions = {},
): { texts: string[]; images: TurnImageInput[] } | null {
  const maxCount = options.maxCount ?? TURN_IMAGE_MAX_COUNT;
  const maxBytes = options.maxBytes ?? TURN_IMAGE_MAX_BYTES;
  const resolved: string[] = [];
  const images: TurnImageInput[] = [];
  try {
    for (const text of texts) {
      const item = extractTurnImages(text, options);
      resolved.push(item.text);
      images.push(...item.images);
    }
  } catch {
    return null;
  }
  if (images.length > maxCount) return null;
  if (images.reduce((total, image) => total + image.bytes, 0) > maxBytes) return null;
  return { texts: resolved, images };
}

export function extractReplayImages<T extends { role: "user" | "assistant"; text: string }>(
  transcript: readonly T[],
  current: readonly TurnImageInput[],
  options: ExtractTurnImagesOptions = {},
  clips: readonly TurnVideoInput[] = [],
): { transcript: T[]; images: TurnImageInput[] } {
  let maxCount = (options.maxCount ?? TURN_IMAGE_MAX_COUNT) - current.length;
  let maxBytes = (options.maxBytes ?? TURN_IMAGE_MAX_BYTES) - current.reduce((total, image) => total + image.bytes, 0);
  let room = clips.length ? CHAT_IMAGE_BUDGET - mediaUrlBytes([...clips, ...current]) : Infinity;
  const replayed = [...transcript];
  const images: TurnImageInput[] = [];
  for (let index = replayed.length - 1; index >= 0 && maxCount > 0; index -= 1) {
    const entry = replayed[index]!;
    if (entry.role !== "user") continue;
    const item = extractTurnImages(entry.text, { ...options, maxCount: Infinity, maxBytes: Infinity, imageNote: REPLAYED_IMAGE_NOTE });
    if (!item.images.length) continue;
    const bytes = item.images.reduce((total, image) => total + image.bytes, 0);
    const encoded = mediaUrlBytes(item.images);
    if (item.images.length > maxCount || bytes > maxBytes || encoded > room) break;
    replayed[index] = { ...entry, text: item.text };
    images.unshift(...item.images);
    maxCount -= item.images.length;
    maxBytes -= bytes;
    room -= encoded;
  }
  return { transcript: replayed, images };
}

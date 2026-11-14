// The source opens through the message-file route's hardened resolver (realpath containment, O_NOFOLLOW, size cap) and is
// copied into the private store, so the chat never reaches into a bot's workspace or VM home afterwards.
import { basename, join, posix } from "node:path";
import {
  extensionForFileMime,
  extensionForMime,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  saveFile,
  saveImage,
} from "./attachments.ts";
import { mimeFor, openFileSavedSince, openMessageFile, type OpenedMessageFile } from "./message-file.ts";
import type { Message } from "./store.ts";

export type BotAttachment = NonNullable<Message["attachments"]>[number];

export const ATTACH_SUPPORTED_TYPES =
  "images (png, jpg, gif, webp), video (mp4, webm, mov), audio (mp3, m4a, aac, wav, ogg, opus, flac), " +
  "pdf, Word/Excel/PowerPoint and OpenDocument files, and csv, tsv, txt, md, json, rtf";

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Maps a guest workspace path onto its bind-mounted host directory; anything outside it, `..` escapes included, is null. */
export function guestWorkspaceToHost(input: string, guestRoot: string, hostRoot: string): string | null {
  let value = input.trim();
  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
    } catch {
      return null;
    }
  }
  if (!value.startsWith("/")) return null;
  const normalized = posix.normalize(value);
  const relative = posix.relative(guestRoot, normalized);
  if (!relative || relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) return null;
  return join(hostRoot, ...relative.split("/"));
}

/** Directory parts are dropped, never trusted. */
function displayNameFor(requested: string | undefined, fallback: string): string {
  const cleaned = requested?.trim().replace(/\\/g, "/");
  const name = cleaned ? posix.basename(cleaned) : "";
  return name || fallback;
}

export interface SaveBotAttachmentInput {
  path: string;
  name?: string;
  /** Host directories the bot may read from (its working folder, workspace). */
  roots: readonly string[];
  guest?: { root: string; host: string };
  /** A file this turn saved outside the roots, at a place the person named: one copied file, never a folder or a link grant. */
  savedThisTurn?: { since: number; refuse: readonly string[] };
}

/** Only the roots' outside_workspace refusal falls through, so a missing or oversized file in the folder says exactly that.
 * Opened at the store's limit, not the preview one: the copy streams, and a person may send the same size. */
async function openSource(path: string, roots: readonly string[], savedThisTurn: SaveBotAttachmentInput["savedThisTurn"]): Promise<OpenedMessageFile> {
  try {
    return await openMessageFile(path, roots, FILE_MAX_BYTES);
  } catch (error) {
    if (!savedThisTurn || (error as { code?: unknown } | null)?.code !== "outside_workspace") throw error;
    return openFileSavedSince(path, savedThisTurn, FILE_MAX_BYTES);
  }
}

export interface SavedBotAttachment {
  attachment: BotAttachment;
  bytes: number;
}

export async function saveBotAttachment(input: SaveBotAttachmentInput): Promise<SavedBotAttachment> {
  const requested = input.path.trim();
  if (!requested) throw statusError(400, "path is required");
  const guestHost = input.guest ? guestWorkspaceToHost(requested, input.guest.root, input.guest.host) : null;
  // A bot with a VM works in it: a relative path means its VM workspace first.
  const roots = input.guest ? [input.guest.host, ...input.roots] : input.roots;
  // A VM turn's tools never wrote to the host, so it gets roots only.
  const file = await openSource(guestHost ?? requested, roots, input.guest ? undefined : input.savedThisTurn);
  try {
    const mime = mimeFor(file.name);
    const name = displayNameFor(input.name, file.name);
    if (extensionForMime(mime)) {
      if (file.bytes > IMAGE_MAX_BYTES) throw statusError(413, `image exceeds ${IMAGE_MAX_BYTES} bytes`);
      const saved = saveImage(await file.handle.readFile(), mime);
      return { attachment: { kind: "image", path: saved.path, mime: saved.mime, name, source: file.path }, bytes: saved.bytes };
    }
    if (!extensionForFileMime(mime)) {
      throw statusError(415, `${file.name} is not a supported attachment type. Supported: ${ATTACH_SUPPORTED_TYPES}.`);
    }
    if (file.bytes > FILE_MAX_BYTES) throw statusError(413, `file exceeds ${FILE_MAX_BYTES} bytes`);
    const saved = await saveFile(file.handle.createReadStream({ start: 0, autoClose: false }), name || basename(file.name), mime, {
      expectedBytes: file.bytes,
    });
    return { attachment: { kind: "file", path: saved.path, mime: saved.mime, name: saved.name, source: file.path }, bytes: saved.bytes };
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

/** The chat's link rule: search from the reply back to the last non-bot message; only the reply's author counts, and a
 * name delivered twice matches neither. */
export function deliveredCopy(messages: readonly Message[], reply: Message, name: string): Exclude<BotAttachment, { kind: "audio" }> | null {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const author = reply.from?.botId;
  let found: Exclude<BotAttachment, { kind: "audio" }> | null = null;
  for (let message: Message | undefined = reply; message?.role === "bot"; message = message.parentId ? byId.get(message.parentId) : undefined) {
    if (message.from?.botId !== author) continue;
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === "audio" || attachment.name !== name) continue;
      if (found) return null;
      found = attachment;
    }
  }
  return found;
}

export function attachedFileLine(attachment: BotAttachment, sentInTurn: string | undefined, from?: Message["from"]): Omit<Message, "id" | "at"> {
  return { role: "bot", kind: "text", text: "", attachments: [attachment], ...(sentInTurn ? { sentInTurn } : {}), ...(from ? { from } : {}) };
}

export type AttachForTurnOutcome<S> =
  | { status: "attached"; saved: S }
  | { status: "limit" }
  | { status: "ended" };

/** The slot is reserved before the await, so parallel calls cannot all pass the per-turn count; `stillLive` is asked again
 * just before `publish`, so nothing is published for a turn that ended meanwhile. */
export async function attachForTurn<S>(
  turn: { attachedFiles?: number },
  max: number,
  hooks: {
    save: () => Promise<S>;
    stillLive: () => boolean;
    publish: (saved: S) => void;
    discard: (saved: S) => void;
  },
): Promise<AttachForTurnOutcome<S>> {
  const used = turn.attachedFiles ?? 0;
  if (used >= max) return { status: "limit" };
  turn.attachedFiles = used + 1;
  let saved: S | undefined;
  let published = false;
  try {
    saved = await hooks.save();
    if (!hooks.stillLive()) return { status: "ended" };
    hooks.publish(saved);
    published = true;
    return { status: "attached", saved };
  } finally {
    if (!published) {
      turn.attachedFiles = Math.max(0, (turn.attachedFiles ?? 1) - 1);
      if (saved !== undefined) hooks.discard(saved);
    }
  }
}

// The source opens through the message-file route's hardened resolver (realpath containment, O_NOFOLLOW, size cap) and is
// copied into the private store, so the chat never reaches into a bot's workspace or VM home afterwards.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { DATA_DIR } from "./config.ts";
import { openInboxFile, type InboxRead } from "./host/handoff-inbox.ts";
import {
  ATTACHMENTS_DIR,
  extensionForFileMime,
  extensionForMime,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  saveFile,
  saveImage,
} from "./attachments.ts";
import { mimeFor, openFileSavedSince, openMessageFile, referencedPathIdentity, type OpenedMessageFile } from "./message-file.ts";
import type { Message } from "./store.ts";

export type BotAttachment = NonNullable<Message["attachments"]>[number];

export const ATTACH_SUPPORTED_TYPES =
  "images (png, jpg, gif, webp), video (mp4, webm, mov), audio (mp3, m4a, aac, wav, ogg, opus, flac), " +
  "pdf, Word/Excel/PowerPoint and OpenDocument files, csv, tsv, txt, md, json, rtf, " +
  "and archives (zip, rar, 7z, tar, gz, tgz, bz2, xz)";

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const sourceFileLink = (path: string): string => /^file:/i.test(path) ? path : path.replace(/[%?#]/g, encodeURIComponent);

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
  /** Store the copy under a name made from its bytes, so the same file passed between bots again is kept once. */
  byContent?: boolean;
  /** The conversation's inbox of files other bots passed it: a place the bot may also send from, read without
   * following any link (server/host/handoff-inbox.ts). */
  inbox?: InboxRead;
}

let nameKey: Buffer | undefined;
/** This install's secret for stored names made from bytes. Security: the store serves a file to whoever knows its name,
 * so a name must not be computable from the file alone; without this key it is not. */
function contentNameKey(): Buffer {
  if (nameKey) return nameKey;
  const file = join(DATA_DIR, "attachment-names.key");
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  nameKey = readFileSync(file);
  if (nameKey.byteLength < 32) throw new Error("the attachment name key is damaged");
  return nameKey;
}

/** The upload id the store keeps a file under when it is named by its bytes: a version-8 UUID cut from a keyed digest of
 * their SHA-256 and the stored extension, so the same bytes under another file type are another stored file. */
export function contentUploadId(sha256: string, extension: string, key: Buffer = contentNameKey()): string {
  const hex = createHmac("sha256", key).update(`${sha256}\0${extension}`).digest("hex").slice(0, 32).split("");
  hex[12] = "8";
  hex[16] = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
  const id = hex.join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

async function sha256Of(file: OpenedMessageFile): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of file.handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Only the roots' outside_workspace refusal falls through, so a missing or oversized file in the folder says exactly that.
 * Opened at the store's limit, not the preview one: the copy streams, and a person may send the same size. A path the
 * roots do not hold is tried in the conversation's inbox before anything else. */
async function openSource(path: string, roots: readonly string[], savedThisTurn: SaveBotAttachmentInput["savedThisTurn"], inbox: InboxRead | undefined): Promise<OpenedMessageFile> {
  const href = sourceFileLink(path);
  try {
    return await openMessageFile(href, roots, FILE_MAX_BYTES);
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status, outside = (error as { code?: unknown } | null)?.code === "outside_workspace";
    const received = inbox && (outside || status === 404) ? await openInboxFile(path, inbox, FILE_MAX_BYTES) : null;
    if (received) return { ...received, mime: mimeFor(received.name) };
    if (!savedThisTurn || !outside) throw error;
    return openFileSavedSince(href, savedThisTurn, FILE_MAX_BYTES);
  }
}

const contentSaves = new Map<string, Promise<unknown>>();
/** One save at a time for each stored name, so exactly one of two saves of the same bytes is the one that stored them. */
async function oneAtATime<T>(id: string, save: () => Promise<T>): Promise<T> {
  const before = contentSaves.get(id) ?? Promise.resolve();
  const mine = before.then(save, save);
  const settled = mine.catch(() => undefined);
  contentSaves.set(id, settled);
  try {
    return await mine;
  } finally {
    if (contentSaves.get(id) === settled) contentSaves.delete(id);
  }
}

export interface SavedBotAttachment {
  attachment: BotAttachment;
  bytes: number;
  /** With `byContent`: the bytes' SHA-256, and whether this call put them in the store (false: they were there already). */
  sha256?: string;
  fresh?: boolean;
}

export async function saveBotAttachment(input: SaveBotAttachmentInput): Promise<SavedBotAttachment> {
  const requested = input.path.trim();
  if (!requested) throw statusError(400, "path is required");
  const guestHost = input.guest ? guestWorkspaceToHost(requested, input.guest.root, input.guest.host) : null;
  // A bot with a VM works in it: a relative path means its VM workspace first.
  const roots = input.guest ? [input.guest.host, ...input.roots] : input.roots;
  // A VM turn's tools never wrote to the host, so it gets roots only.
  const file = await openSource(guestHost ?? requested, roots, input.guest ? undefined : input.savedThisTurn, guestHost ? undefined : input.inbox);
  try {
    const mime = mimeFor(file.name);
    const name = displayNameFor(input.name, file.name);
    const imageExtension = extensionForMime(mime), fileExtension = extensionForFileMime(mime);
    if (imageExtension && file.bytes > IMAGE_MAX_BYTES) throw statusError(413, `image exceeds ${IMAGE_MAX_BYTES} bytes`);
    if (!imageExtension && !fileExtension) {
      throw statusError(415, `${file.name} is not a supported attachment type. Supported: ${ATTACH_SUPPORTED_TYPES}.`);
    }
    if (!imageExtension && file.bytes > FILE_MAX_BYTES) throw statusError(413, `file exceeds ${FILE_MAX_BYTES} bytes`);
    const extension = (imageExtension ?? fileExtension)!;
    const sha256 = input.byContent ? await sha256Of(file) : undefined;
    const uploadId = sha256 ? contentUploadId(sha256, extension) : undefined;
    const store = async (): Promise<SavedBotAttachment> => {
      const content = sha256 ? { sha256, fresh: !existsSync(join(ATTACHMENTS_DIR, `${uploadId}${extension}`)) } : {};
      if (imageExtension) {
        const saved = saveImage(await file.handle.readFile(), mime, uploadId);
        return { attachment: { kind: "image", path: saved.path, mime: saved.mime, name, source: file.path }, bytes: saved.bytes, ...content };
      }
      const saved = await saveFile(file.handle.createReadStream({ start: 0, autoClose: false }), name || basename(file.name), mime, {
        expectedBytes: file.bytes, ...(uploadId ? { uploadId } : {}),
      });
      return { attachment: { kind: "file", path: saved.path, mime: saved.mime, name: saved.name, source: file.path }, bytes: saved.bytes, ...content };
    };
    return await (uploadId ? oneAtATime(uploadId, store) : store());
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

/** The chat's link rule: search from the reply back to the last non-bot message; only the reply's author counts, and a
 * delivery matched twice is refused. A link to the source the bot saved resolves the delivered copy by its source path
 * first, so a renamed attachment still opens; the display name is the fallback for records without a source. */
export function deliveredCopy(
  messages: readonly Message[],
  reply: Message,
  name: string,
  href?: string,
): Exclude<BotAttachment, { kind: "audio" }> | null {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const author = reply.from?.botId;
  let wanted: string | undefined;
  if (href) {
    try {
      wanted = referencedPathIdentity(href);
    } catch { }
  }
  const inScope: Exclude<BotAttachment, { kind: "audio" }>[] = [];
  for (let message: Message | undefined = reply; message?.role === "bot"; message = message.parentId ? byId.get(message.parentId) : undefined) {
    if (message.from?.botId !== author) continue;
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === "audio") continue;
      inScope.push(attachment);
    }
  }
  if (wanted !== undefined) {
    const bySource = inScope.filter((attachment) => {
      if (!attachment.source) return false;
      try {
        return referencedPathIdentity(sourceFileLink(attachment.source)) === wanted;
      } catch {
        return false;
      }
    });
    if (bySource.length > 1) return null;
    if (bySource.length === 1) return bySource[0]!;
  }
  const byName = inScope.filter((attachment) => attachment.name === name);
  return byName.length === 1 ? byName[0]! : null;
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

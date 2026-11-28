import { constants } from "node:fs";
import { open, lstat, mkdir, realpath, link, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join, posix, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { conversationAttachments } from "./conversation-attachments.ts";
import { mimeFor } from "./message-file.ts";

export interface ChatAttachment { path: string; mime: string; name?: string }
export interface AttachmentFetchScope {
  attachmentStore: string;
  attachments: readonly ChatAttachment[];
  workspace: string;
  guestRoot: string;
  botId: string;
  threadId: string;
  maxBytes: number;
  isActive: () => boolean;
}
const refusal = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
const refPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,240}$/;
async function statIfPresent(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readChunks(file: FileHandle, size: number, check: () => void, consume: (chunk: Buffer, position: number) => Promise<void>) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (let position = 0; position < size;) {
    check();
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
    check();
    if (!bytesRead) refusal(409, "Attachment changed during copying; retry the export.");
    await consume(buffer.subarray(0, bytesRead), position);
    check();
    position += bytesRead;
  }
  const stat = await file.stat();
  check();
  if (stat.size !== size) refusal(409, "Attachment changed during copying; retry the export.");
}

async function digest(file: FileHandle, size: number, check: () => void) {
  const hash = createHash("sha256");
  await readChunks(file, size, check, async (chunk) => { hash.update(chunk); });
  return hash.digest("hex");
}

function collisionName(ref: string): string {
  const suffix = `-${randomUUID()}`;
  const extension = extname(ref).slice(0, 255 - suffix.length - 1);
  return `${basename(ref, extname(ref)).slice(0, 255 - suffix.length - extension.length)}${suffix}${extension}`;
}

/** Combines structured attachments (including audio), trusted user text tags, and current-turn generated files. */
export function collectChatAttachments(messages: Parameters<typeof conversationAttachments>[0], parked: readonly ChatAttachment[] = []): ChatAttachment[] {
  return [
    ...messages.flatMap((message) => message.attachments ?? []),
    ...conversationAttachments(messages).map((file) => ({ ...file, mime: mimeFor(file.path) })),
    ...parked,
  ];
}

/** Lists only attachment records supplied by the authenticated conversation, including current-turn generated files. */
export async function listChatAttachments(store: string, attachments: readonly ChatAttachment[]) {
  const seen = new Set<string>();
  const result = [];
  for (const file of attachments) {
    const ref = basename(file.path);
    if (!refPattern.test(ref) || resolve(dirname(file.path)) !== resolve(store) || seen.has(ref)) continue;
    seen.add(ref);
    const stat = await statIfPresent(file.path);
    if (stat?.isFile()) result.push({ attachment_ref: ref, name: file.name ?? ref, mime: file.mime, size: stat.size });
  }
  return result;
}

/** Linux Local VM export. Directory descriptors and O_NOFOLLOW prevent VM-controlled links from redirecting host writes. */
export async function fetchChatAttachment(scope: AttachmentFetchScope, ref: string, destination?: string) {
  const check = () => { if (!scope.isActive()) refusal(409, "This turn no longer owns the conversation or Local VM."); };
  const checked = async <T>(work: Promise<T>): Promise<T> => { const value = await work; check(); return value; };
  check();
  if (!refPattern.test(ref)) refusal(400, "Invalid attachment_ref; use list_chat_attachments.");
  const metadata = (await checked(listChatAttachments(scope.attachmentStore, scope.attachments))).find((file) => file.attachment_ref === ref);
  if (!metadata) refusal(404, "Attachment is not available in this conversation.");
  if (![scope.botId, scope.threadId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))) refusal(400, "Invalid conversation identity.");
  const relative = destination ?? `attachments/inbox/${scope.botId}/${scope.threadId}`;
  const parts = relative.split("/");
  if (!relative || relative.length > 1000 || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes(":") || [...part].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) refusal(400, "destination_dir must be a relative directory inside the VM workspace, without .. or absolute paths.");
  if (process.platform !== "linux") refusal(409, "Chat attachment export currently requires a Linux Local VM host.");
  const descriptors: FileHandle[] = [];
  let partial: string | undefined, published: string | undefined;
  let copied: FileHandle | undefined, complete = false;
  const hold = async (path: string, flags: number) => {
    check();
    const file = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    descriptors.push(file);
    check();
    return file;
  };
  try {
    const sourceRoot = await hold(await checked(realpath(scope.attachmentStore)), constants.O_RDONLY | constants.O_DIRECTORY);
    const source = await hold(`/proc/self/fd/${sourceRoot.fd}/${ref}`, constants.O_RDONLY);
    const stat = await checked(source.stat());
    if (!stat.isFile()) refusal(404, "Attachment is not a regular file.");
    if (stat.size > scope.maxBytes) refusal(413, "Attachment exceeds the file size limit.");
    const sourceHash = await digest(source, stat.size, check);
    let dir = await hold(await checked(realpath(scope.workspace)), constants.O_RDONLY | constants.O_DIRECTORY);
    for (const part of parts) {
      const path = `/proc/self/fd/${dir.fd}/${part}`;
      try { await checked(mkdir(path, { mode: 0o755 })); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      dir = await hold(path, constants.O_RDONLY | constants.O_DIRECTORY);
    }
    const base = `/proc/self/fd/${dir.fd}`;
    const verifyDirectory = async () => {
      const parent = await checked(realpath(base));
      if (parent !== join(await checked(realpath(scope.workspace)), ...parts)) refusal(409, "Destination directory changed; retry the export.");
    };
    const result = (name: string, reused: boolean) => ({ ...metadata!, local_path: posix.join(scope.guestRoot, relative, name), size: stat.size, reused });
    let name = ref;
    const target = join(base, name);
    if ((await checked(statIfPresent(target)))?.isFile()) {
      const existing = await hold(target, constants.O_RDONLY);
      const current = await checked(existing.stat());
      if (current.size === stat.size && await digest(existing, stat.size, check) === sourceHash) {
        await verifyDirectory();
        return result(name, true);
      }
    }
    if (await checked(statIfPresent(target))) name = collisionName(ref);
    partial = join(base, `.attachment-${randomUUID()}.partial`);
    copied = await hold(partial, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
    const destinationFile = copied;
    await readChunks(source, stat.size, check, async (chunk, position) => {
      for (let offset = 0; offset < chunk.length;) {
        const { bytesWritten } = await checked(destinationFile.write(chunk, offset, chunk.length - offset, position + offset));
        if (!bytesWritten) refusal(409, "Cannot write attachment copy.");
        offset += bytesWritten;
      }
    });
    if (await digest(copied, stat.size, check) !== sourceHash) refusal(409, "Attachment changed during copying; retry the export.");
    await checked(copied.chmod(0o644));
    await verifyDirectory();
    // Publish without replacement; the link joins only the new copy, never the original attachment.
    for (;;) {
      check();
      try { await link(partial, join(base, name)); published = join(base, name); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        name = collisionName(ref);
      }
    }
    check();
    await verifyDirectory();
    complete = true;
    return result(name, false);
  } finally {
    if (!complete && published && copied) {
      try {
        const current = await statIfPresent(published), own = await copied.stat();
        if (current?.ino === own.ino && current.dev === own.dev) await unlink(published);
      } catch { /* best-effort cleanup of an unpublished result */ }
    }
    if (partial) { try { await unlink(partial); } catch { /* best-effort partial cleanup */ } }
    await Promise.allSettled(descriptors.reverse().map((file) => file.close()));
  }
}

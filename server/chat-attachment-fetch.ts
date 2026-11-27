import { constants, closeSync, copyFileSync, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
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
}
const refusal = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
const refPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,240}$/;
const digest = (fd: number) => createHash("sha256").update(readFileSync(fd)).digest("hex");

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
export function listChatAttachments(store: string, attachments: readonly ChatAttachment[]) {
  const seen = new Set<string>();
  return attachments.flatMap((file) => {
    const ref = basename(file.path);
    if (!refPattern.test(ref) || resolve(dirname(file.path)) !== resolve(store) || seen.has(ref)) return [];
    seen.add(ref);
    const stat = lstatSync(file.path, { throwIfNoEntry: false });
    if (!stat?.isFile()) return [];
    return [{ attachment_ref: ref, name: file.name ?? ref, mime: file.mime, size: stat.size }];
  });
}

/** Linux Local VM export. Directory descriptors and O_NOFOLLOW prevent VM-controlled links from redirecting host writes. */
export function fetchChatAttachment(scope: AttachmentFetchScope, ref: string, destination?: string) {
  if (!refPattern.test(ref)) refusal(400, "Invalid attachment_ref; use list_chat_attachments.");
  const metadata = listChatAttachments(scope.attachmentStore, scope.attachments).find((file) => file.attachment_ref === ref);
  if (!metadata) refusal(404, "Attachment is not available in this conversation.");
  if (![scope.botId, scope.threadId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))) refusal(400, "Invalid conversation identity.");
  const relative = destination ?? `attachments/inbox/${scope.botId}/${scope.threadId}`;
  const parts = relative.split("/");
  if (!relative || relative.length > 1000 || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes(":") || [...part].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) refusal(400, "destination_dir must be a relative directory inside the VM workspace, without .. or absolute paths.");
  if (process.platform !== "linux") refusal(409, "Chat attachment export currently requires a Linux Local VM host.");
  const descriptors: number[] = [];
  let partial: string | undefined;
  const open = (path: string, flags: number) => { const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK); descriptors.push(fd); return fd; };
  try {
    const sourceRoot = open(realpathSync(scope.attachmentStore), constants.O_RDONLY | constants.O_DIRECTORY);
    const source = open(`/proc/self/fd/${sourceRoot}/${ref}`, constants.O_RDONLY);
    const stat = fstatSync(source);
    if (!stat.isFile()) refusal(404, "Attachment is not a regular file.");
    if (stat.size > scope.maxBytes) refusal(413, "Attachment exceeds the file size limit.");
    const sourceHash = digest(source);
    let dir = open(realpathSync(scope.workspace), constants.O_RDONLY | constants.O_DIRECTORY);
    for (const part of parts) {
      const path = `/proc/self/fd/${dir}/${part}`;
      try { mkdirSync(path, { mode: 0o755 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      dir = open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    }
    const base = `/proc/self/fd/${dir}`;
    const result = (name: string, reused: boolean) => ({ ...metadata!, local_path: posix.join(scope.guestRoot, relative, name), size: stat.size, reused });
    let name = ref;
    const target = join(base, name);
    if (lstatSync(target, { throwIfNoEntry: false })?.isFile()) {
      const existing = open(target, constants.O_RDONLY);
      const current = fstatSync(existing);
      if (current.size === stat.size && digest(existing) === sourceHash) {
        const parent = realpathSync(base);
        if (parent !== join(realpathSync(scope.workspace), ...parts)) refusal(409, "Destination directory changed; retry the export.");
        return result(name, true);
      }
    }
    if (lstatSync(target, { throwIfNoEntry: false })) name = collisionName(ref);
    partial = join(base, `.attachment-${randomUUID()}.partial`);
    copyFileSync(`/proc/self/fd/${source}`, partial, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    const copied = open(partial, constants.O_RDONLY);
    if (fstatSync(copied).size !== stat.size || digest(copied) !== sourceHash) refusal(409, "Attachment changed during copying; retry the export.");
    fchmodSync(copied, 0o644);
    if (realpathSync(base) !== join(realpathSync(scope.workspace), ...parts)) refusal(409, "Destination directory changed; retry the export.");
    // Publish without replacement; the link joins only the new copy, never the original attachment.
    for (;;) {
      try { linkSync(partial, join(base, name)); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        name = collisionName(ref);
      }
    }
    return result(name, false);
  } finally {
    if (partial) { try { unlinkSync(partial); } catch { /* best-effort partial cleanup */ } }
    for (const fd of descriptors.reverse()) closeSync(fd);
  }
}

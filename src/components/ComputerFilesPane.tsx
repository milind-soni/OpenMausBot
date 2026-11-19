import { visibleMessages, type Bot } from "@/state/store";
import type { MessageAttachmentContext } from "./AttachmentPreview";
import { collectMessageFiles, fileIdentity, splitMessageAttachments, type GalleryFile } from "./AttachmentGallery";

const MAX_FILES = 20;

export function recentChangedFiles(bot: Bot, limit = MAX_FILES): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  const messages = visibleMessages(bot);
  for (let index = messages.length - 1; index >= 0 && files.length < limit; index -= 1) {
    const digestFiles = messages[index]!.digest?.files;
    if (!digestFiles) continue;
    for (const path of digestFiles.deleted) seen.add(path);
    for (const path of [...digestFiles.added, ...digestFiles.changed]) {
      if (seen.has(path)) continue;
      seen.add(path);
      files.push(path);
      if (files.length >= limit) break;
    }
  }
  return files;
}

interface SharedFile {
  file: GalleryFile;
  message: MessageAttachmentContext;
}

/**
 * Security: a digest records changes, not permission to read; reuse only a visible reply's existing file grant, with
 * its URL spelling and message id for the server to validate.
 */
export function sharedFileReferences(bot: Bot): Map<string, SharedFile> {
  const references = new Map<string, SharedFile>();
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  const cwd = task?.cwd === undefined ? bot.cwd : task.cwd;
  const windows = cwd && (/^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\"));
  const spelling = (path: string) => windows ? path.replace(/\\/g, "/") : path;
  const prefix = typeof cwd === "string" ? `${spelling(cwd).replace(/\/+$/, "")}/` : undefined;
  for (const message of [...visibleMessages(bot)].reverse()) {
    if (message.role !== "bot" || message.kind !== "text") continue;
    const attached = splitMessageAttachments(message.attachments);
    const files = [
      ...attached.files,
      ...collectMessageFiles(message.text ?? "", [...attached.images, ...attached.files.map((file) => file.path)]),
    ];
    for (const file of files) {
      const identity = file.private ? file.path : fileIdentity(file.path);
      const reference = {
        file,
        message: { threadId: bot.threadId, messageId: message.id },
      };
      // Security: only an absolute link beneath that exact folder matches; never guess by basename.
      const path = spelling(identity);
      // Windows drive and UNC prefixes are case-insensitive.
      const inFolder = prefix && (windows
        ? path.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
        : path.startsWith(prefix));
      const keys = [identity, ...(inFolder ? [path.slice(prefix.length)] : [])];
      if (identity.startsWith("./")) keys.push(identity.replace(/^(\.\/)+/, ""));
      for (const key of keys) if (!references.has(key)) references.set(key, reference);
    }
  }
  return references;
}

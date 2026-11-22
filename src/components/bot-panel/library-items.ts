import type { BotLibrary } from "../../../shared/bot-library";
import { t } from "@/lib/i18n";
import { visibleMessages, type Bot, type Message } from "@/state/store";
import { fileIdentity, linkedFiles, splitMessageAttachments, type GalleryFile } from "../AttachmentGallery";
import { recentChangedFiles, sharedFileReferences } from "../ComputerFilesPane";

/** Where an item was made: the conversation and the message that shows it. */
interface Made { threadId: string; messageId: string; at: number }
export interface LibraryPage extends Made { title: string; url: string }
export interface LibraryApp extends Made { title: string }
export interface LibraryFile extends Made { file: GalleryFile }

export interface LibraryItems {
  pages: LibraryPage[];
  apps: LibraryApp[];
  shared: LibraryFile[];
  /** Files the open conversation changed and no reply shared, as paths. */
  unshared: string[];
}

const fileKey = (file: GalleryFile) => file.private ? file.path : fileIdentity(file.path);

/** What the bot made in the open conversation's loaded messages, newest first: its live published pages, its apps, and
 * its files. */
export function libraryItems(bot: Bot, messages: readonly Message[] = visibleMessages(bot)): LibraryItems {
  const pages: LibraryPage[] = [];
  const apps: LibraryApp[] = [];
  const seenPages = new Set<string>();
  for (const message of [...messages].reverse()) {
    const made = { threadId: bot.threadId, messageId: message.id, at: message.at };
    const page = message.publishedPage;
    if (page?.state === "live" && page.url && !seenPages.has(page.url)) {
      seenPages.add(page.url);
      pages.push({ ...made, title: page.title || page.url, url: page.url });
    }
    if (message.kind === "app" && message.app?.doc) apps.push({ ...made, title: message.app.title });
  }
  const references = sharedFileReferences(bot);
  const at = new Map(messages.map((message) => [message.id, message.at]));
  const shared: LibraryFile[] = [];
  const seenFiles = new Set<string>();
  for (const reference of references.values()) {
    if (seenFiles.has(reference.file.path)) continue;
    seenFiles.add(reference.file.path);
    shared.push({ ...reference.message, at: at.get(reference.message.messageId) ?? 0, file: reference.file });
  }
  const unshared = recentChangedFiles(bot).filter((path) => !references.has(path));
  return { pages, apps, shared, unshared };
}

/** The files the server's replies share, as the open conversation's own replies show them (sharedFileReferences). */
function sharedFiles(replies: BotLibrary["files"]): LibraryFile[] {
  return replies.flatMap((reply) => {
    const attached = splitMessageAttachments(reply.attachments);
    const files = [...attached.files, ...linkedFiles(reply.links, [...attached.images, ...attached.files.map((file) => file.path)])];
    return files.map((file) => ({ threadId: reply.threadId, messageId: reply.messageId, at: reply.at, file }));
  });
}

function newestOnce<T extends Made>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.sort((a, b) => b.at - a.at).filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** The bot's conversations the panel knows; a conversation deleted since the server answered is not among them. */
export function knownThreads(bot: Pick<Bot, "threadId" | "tasks">): Set<string> {
  return new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]);
}

/** Everything the bot made in all of its conversations, newest first: the server's list across them, with the open
 * conversation's loaded messages over it, since they are newer than any answer (a page just unpublished there is gone at
 * once). Without the server's list, the open conversation's alone. */
export function allLibraryItems(bot: Bot, local: LibraryItems, remote: BotLibrary | null): LibraryItems {
  if (!remote) return local;
  const known = knownThreads(bot), loaded = new Set(bot.messages.map((message) => message.id));
  const keep = (item: Made) => known.has(item.threadId) && !(item.threadId === bot.threadId && loaded.has(item.messageId));
  return {
    pages: newestOnce([...local.pages, ...remote.pages.filter(keep)], (page) => page.url),
    apps: newestOnce([...local.apps, ...remote.apps.filter(keep)], (app) => app.messageId),
    shared: newestOnce([...local.shared, ...sharedFiles(remote.files.filter(keep))], (item) => fileKey(item.file)),
    unshared: local.unshared,
  };
}

/** The quiet line naming the conversation an item came from, none while the bot has only one: its title, or with threads
 * hidden (Simple mode) "Main thread" for the one the bot opens to. */
export function threadLabel(bot: Pick<Bot, "threadId" | "mainThreadId" | "tasks">, threadId: string, threadsShown: boolean): string | undefined {
  if (knownThreads(bot).size < 2) return undefined;
  if (!threadsShown && threadId === bot.mainThreadId) return t("sidebar.bot.simple.mainThread");
  return bot.tasks?.find((task) => task.threadId === threadId)?.title || t("task.newShort");
}

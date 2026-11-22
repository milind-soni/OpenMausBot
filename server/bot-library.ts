// What a bot's Library tab lists across all of its conversations, read without loading any conversation into memory:
// its live published pages from the pages store, and its apps and file-sharing replies straight from messages.db by the
// conversations' index. The panel adds what the open conversation holds in memory on top.
import { fromMarkdown } from "mdast-util-from-markdown";
import { BOT_LIBRARY_MAX, type BotLibrary, type BotLibraryApp, type BotLibraryFileMessage, type BotLibraryPage } from "../shared/bot-library.ts";
import { windowsPathDestinations } from "../shared/markdown-windows-paths.ts";
import { prepared } from "./message-db.ts";
import type { PublishedPageRecord } from "./pages/store.ts";

/** Replies read for file links, newest first; most replies share nothing, so this reads well past the files shown. */
const FILE_REPLIES_READ = 600;

export interface BotLibraryRows {
  apps(threadIds: readonly string[], limit: number): Array<{ threadId: string; messageId: string; at: number; title: unknown }>;
  fileReplies(threadIds: readonly string[], limit: number): Array<{ threadId: string; messageId: string; at: number; text: unknown; attachments: unknown }>;
}

const IN_THREADS = "thread_id IN (SELECT value FROM json_each(?))";

export const messageRows: BotLibraryRows = {
  apps: (threadIds, limit) => prepared(
    `SELECT thread_id AS threadId, id AS messageId, at, json_extract(json, '$.app.title') AS title FROM messages
     WHERE ${IN_THREADS} AND kind = 'app' AND coalesce(json_extract(json, '$.app.doc'), '') <> '' ORDER BY at DESC, rowid LIMIT ?`,
  ).all(JSON.stringify(threadIds), limit) as ReturnType<BotLibraryRows["apps"]>,
  fileReplies: (threadIds, limit) => prepared(
    `SELECT thread_id AS threadId, id AS messageId, at, text, json_extract(json, '$.attachments') AS attachments FROM messages
     WHERE ${IN_THREADS} AND role = 'bot' AND kind = 'text'
       AND (instr(text, '](') > 0 OR instr(text, ']:') > 0 OR instr(text, '<file:') > 0 OR json_extract(json, '$.attachments') IS NOT NULL)
     ORDER BY at DESC, rowid LIMIT ?`,
  ).all(JSON.stringify(threadIds), limit) as ReturnType<BotLibraryRows["fileReplies"]>,
};

type MarkdownNode = { type: string; url?: string; identifier?: string; children?: MarkdownNode[] };

/** The local file links a reply's text shows as file chips, as authored: links and link references that do not wrap an
 * image, the same nodes as the panel's collectMessageFiles (src/components/AttachmentGallery.tsx), which makes the final
 * call on each one. */
export function replyFileLinks(text: string): string[] {
  const tree: MarkdownNode = fromMarkdown(text, { mdastExtensions: [windowsPathDestinations] });
  const definitions = new Map<string, string>(), links: MarkdownNode[] = [], pending = [tree];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    else if ((node.type === "link" || node.type === "linkReference") && !node.children?.some((child) => child.type === "image" || child.type === "imageReference")) links.push(node);
    if (node.children) pending.push(...node.children);
  }
  const hrefs = links.flatMap((node) => {
    const href = node.url ?? (node.identifier ? definitions.get(node.identifier) : undefined);
    return href && !href.startsWith("#") && !href.startsWith("//") && (/^[a-z]:[\\/]/i.test(href) || /^file:/i.test(href) || !/^[a-z][a-z\d+.-]*:/i.test(href)) ? [href] : [];
  });
  return [...new Set(hrefs)];
}

function attachmentsOf(raw: unknown): BotLibraryFileMessage["attachments"] {
  let parsed: unknown;
  try { parsed = typeof raw === "string" ? JSON.parse(raw) : null; } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: { path?: unknown; kind?: unknown; name?: unknown }) => typeof entry?.path === "string" && entry.path
    ? [{ path: entry.path, ...(typeof entry.kind === "string" ? { kind: entry.kind } : {}), ...(typeof entry.name === "string" && entry.name ? { name: entry.name } : {}) }]
    : []);
}

/** The bot's live pages, apps and file-sharing replies in these conversations, newest first. A page counts once, in the
 * newest of these conversations that shows its card; a fork's copy of an app or a reply counts once, as the original.
 * Pages taken down are not in the pages store, and a deleted conversation is not among `threadIds`. */
export function collectBotLibrary(input: { botId: string; threadIds: readonly string[]; pages: readonly PublishedPageRecord[]; rows?: BotLibraryRows }): BotLibrary {
  const rows = input.rows ?? messageRows, threads = new Set(input.threadIds);
  if (!threads.size) return { pages: [], apps: [], files: [] };
  const seenUrls = new Set<string>();
  const pages: BotLibraryPage[] = [...input.pages].filter((page) => page.botId === input.botId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .flatMap((page) => {
      const card = page.cards.findLast((each) => threads.has(each.threadId));
      if (!card || !page.url || seenUrls.has(page.url)) return [];
      seenUrls.add(page.url);
      return [{ threadId: card.threadId, messageId: card.messageId, at: page.updatedAt, title: page.title || page.url, url: page.url }];
    })
    .slice(0, BOT_LIBRARY_MAX);
  const ids = [...threads];
  const seenApps = new Set<string>();
  const apps: BotLibraryApp[] = rows.apps(ids, BOT_LIBRARY_MAX * 2).flatMap((row) => {
    if (seenApps.has(row.messageId)) return [];
    seenApps.add(row.messageId);
    return [{ threadId: row.threadId, messageId: row.messageId, at: row.at, title: typeof row.title === "string" ? row.title : "" }];
  }).slice(0, BOT_LIBRARY_MAX);
  const seenReplies = new Set<string>();
  const files: BotLibraryFileMessage[] = [];
  let shared = 0;
  for (const row of rows.fileReplies(ids, FILE_REPLIES_READ)) {
    if (shared >= BOT_LIBRARY_MAX * 2) break;
    if (seenReplies.has(row.messageId)) continue;
    seenReplies.add(row.messageId);
    const attachments = attachmentsOf(row.attachments);
    const links = typeof row.text === "string" ? replyFileLinks(row.text) : [];
    if (!links.length && !attachments.some((attachment) => attachment.kind === "file")) continue;
    shared += links.length + attachments.length;
    files.push({ threadId: row.threadId, messageId: row.messageId, at: row.at, attachments, links });
  }
  return { pages, apps, files };
}

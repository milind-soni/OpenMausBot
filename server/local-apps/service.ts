import type { IncomingMessage, ServerResponse } from "node:http";

import { APP_USES, appUsesList, oneLine, type AppConnectorUse, type AppDocument, type AppPayload, type AppUse } from "../../shared/app.ts";
import { botHtmlDocument } from "../../shared/app-frame/document.ts";
import { LOCAL_APP_NAME_MAX, type LocalApp, type LocalAppManifest } from "../../shared/local-apps.ts";
import type { AppDocs } from "../app-docs.ts";
import { appRow } from "../chat-apps.ts";
import { createPageFiles, PAGE_FILES_PREFIX, type PageFilesViewer } from "../page-files.ts";
import type { Message, StoreChange } from "../store.ts";
import type { MausColor } from "../../shared/wire.ts";
import { rememberRemovedStarter, seedStarterApps, type StarterSource } from "./starters.ts";
import { LocalAppsStore, type LocalAppRecord, type LocalAppVersion } from "./store.ts";

/** Where a saved folder page's files load from. They answer while the app still keeps that version, whatever became of
 * the chat it came from. */
export const LOCAL_APP_FILES_PREFIX = "/api/local-app-files/";

export interface LocalAppsChat {
  bot?(id: string): { name: string; color: MausColor } | null | undefined;
  messagesFor(threadId: string): Message[];
  botByThread(threadId: string): { id: string } | null;
  groupByThread(threadId: string): unknown;
  taskByThread(botId: string, threadId: string): unknown;
  onChange?(listener: (change: StoreChange) => void): () => void;
}

export type SaveRefusal = { ok: false; status: 404 | 409 | 507; error: string };

const NOT_HERE = "That page is not in this conversation.";

/** What a stored version of the page declared (show_html `uses`), as the chat reads it: data and state, and connector
 * tools. */
function docUses(docs: AppDocs, doc: string): { uses: AppUse[]; connectors: AppConnectorUse[] } {
  const data = docs.read(doc)?.data;
  const uses = Array.isArray(data?.uses) ? data.uses.filter((use): use is AppUse => (APP_USES as readonly string[]).includes(use)) : [];
  return { uses, connectors: Array.isArray(data?.connectors) ? data.connectors : [] };
}

/** The manifest says what the newest version declared, each connector tool as "gmail:TOOL" or "mcp:server:TOOL". */
function withUses(manifest: LocalAppManifest, declared: ReturnType<typeof docUses>): LocalAppManifest {
  const { uses: _was, ...rest } = manifest;
  const uses = appUsesList(declared.uses, declared.connectors);
  return uses.length ? { ...rest, uses } : rest;
}

/** The versions a page's row still keeps, oldest first. */
function rowVersions(app: AppPayload, now: number): LocalAppVersion[] {
  const current = app.rev ?? 0;
  const history = app.history ?? [];
  const earlier = history.map((doc, index) => ({ rev: current - (history.length - index), doc, at: now })).filter((version) => version.rev >= 0);
  return [...earlier, ...(app.doc ? [{ rev: current, doc: app.doc, at: now }] : [])];
}

export function nameOf(text: string): string {
  return oneLine(text).slice(0, LOCAL_APP_NAME_MAX);
}

export interface LocalApps {
  list(): readonly LocalAppRecord[];
  get(id: string): LocalAppRecord | null;
  view(record: LocalAppRecord): LocalApp;
  save(args: { botId: string; threadId: string; messageId: string; owner?: string }): { ok: true; app: LocalAppRecord; created: boolean } | SaveRefusal;
  rename(id: string, name: string): LocalAppRecord | null;
  /** null follows the newest version again. */
  pin(id: string, rev: number | null): LocalAppRecord | null;
  remove(id: string): boolean;
  /** The app's page, built exactly as the chat builds it, for one of the versions it keeps. */
  document(id: string, rev?: number, origin?: string, viewer?: PageFilesViewer): AppDocument | null;
  serveFile(req: IncomingMessage, res: ServerResponse, path: string, method: string): boolean;
  close(): void;
}

export function createLocalApps(deps: {
  chat: LocalAppsChat;
  docs: AppDocs;
  dataDir: string;
  /** Asked soon after an app is removed, so the versions only it kept are cleared. */
  sweep?(): void;
  now?(): number;
  /** The sample apps added at start unless the person removed them. */
  starters?: StarterSource;
}): LocalApps {
  const store = new LocalAppsStore(deps.dataDir);
  const now = deps.now ?? Date.now;
  if (deps.starters) seedStarterApps({ store, docs: deps.docs, dataDir: deps.dataDir, source: deps.starters, now: now() });
  const files = createPageFiles({ docs: deps.docs });
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;

  const chatHas = (threadId: string) => Boolean(deps.chat.botByThread(threadId) || deps.chat.groupByThread(threadId));
  const pageRow = (threadId: string, messageId: string) => (chatHas(threadId) ? appRow(deps.chat, threadId, messageId) : undefined);

  const follow = (threadId: string, message: Message) => {
    const app = message.kind === "app" ? message.app : undefined;
    if (!app || app.source !== "html" || !app.doc) return;
    for (const record of store.savedFrom(threadId, message.id)) {
      const known = new Set(record.versions.map((version) => version.rev));
      const added = rowVersions(app, now()).filter((version) => !known.has(version.rev) && version.rev > Math.max(...known));
      if (added.length) {
        const uses = docUses(deps.docs, added.at(-1)!.doc);
        store.update(record.id, (was) => ({ ...was, versions: [...was.versions, ...added], manifest: withUses(was.manifest, uses) }), now());
      }
    }
  };
  const followRow = (record: LocalAppRecord) => {
    const row = pageRow(record.threadId, record.messageId);
    if (row) follow(record.threadId, row);
    return store.get(record.id) ?? record;
  };
  const unsubscribe = deps.chat.onChange?.((change) => {
    if ((change.type === "message.patch" || change.type === "message") && store.savedFrom(change.threadId, change.message.id).length) follow(change.threadId, change.message);
  });

  const botOf = (id: string) => {
    const bot = deps.chat.bot?.(id);
    return bot ? { name: bot.name, color: bot.color } : null;
  };
  const shownRev = (record: LocalAppRecord) => record.pinnedRev ?? record.versions.at(-1)!.rev;
  const keeps = (id: string, doc: string) => Boolean(store.get(id)?.versions.some((version) => version.doc === doc));

  return {
    list: () => store.list(),
    get: (id) => {
      const record = store.get(id);
      return record ? followRow(record) : null;
    },
    view: (record) => ({
      id: record.id, name: record.name, ...(record.icon ? { icon: record.icon } : {}), botId: record.botId, bot: botOf(record.botId), threadId: record.threadId, messageId: record.messageId,
      versions: record.versions.map(({ rev, at }) => ({ rev, at })), rev: shownRev(record), ...(record.pinnedRev !== undefined ? { pinnedRev: record.pinnedRev } : {}),
      createdAt: record.createdAt, updatedAt: record.updatedAt, manifest: record.manifest, chat: chatHas(record.threadId), ...(record.sample ? { sample: true as const } : {}),
    }),
    save({ botId, threadId, messageId, owner }) {
      const row = pageRow(threadId, messageId);
      if (!row || (row.from && row.from.botId !== botId)) return { ok: false, status: 404, error: NOT_HERE };
      if (row.app.source !== "html") return { ok: false, status: 409, error: "Only a page a bot made can be saved as an app." };
      if (!row.app.doc) return { ok: false, status: 409, error: "This page isn't stored, so it can't be saved as an app." };
      const existing = store.fromPage(threadId, messageId, owner);
      if (existing) return { ok: true, app: followRow(existing), created: false };
      if (store.full()) return { ok: false, status: 507, error: "There are too many saved apps here. Remove one first." };
      const name = nameOf(row.app.title) || "App";
      const manifest = withUses({ name }, docUses(deps.docs, row.app.doc));
      const app = store.add({ name, botId, threadId, messageId, ...(owner ? { owner } : {}), versions: rowVersions(row.app, now()), manifest }, now());
      return { ok: true, app, created: true };
    },
    rename: (id, name) => store.update(id, (record) => ({ ...record, name, manifest: { ...record.manifest, name } }), now()),
    pin(id, rev) {
      const record = store.get(id);
      if (!record || (rev !== null && !record.versions.some((version) => version.rev === rev))) return null;
      return store.update(id, ({ pinnedRev: _was, ...rest }) => ({ ...rest, ...(rev === null ? {} : { pinnedRev: rev }) }), now());
    },
    remove(id) {
      if (store.get(id)?.sample) rememberRemovedStarter(deps.dataDir, id);
      if (!store.remove(id)) return false;
      if (deps.sweep && !sweepTimer) {
        sweepTimer = setTimeout(() => { sweepTimer = null; deps.sweep?.(); }, 2_000);
        sweepTimer.unref?.();
      }
      return true;
    },
    document(id, rev, origin, viewer) {
      const record = store.get(id);
      if (!record) return null;
      const version = record.versions.find((one) => one.rev === (rev ?? shownRev(record)));
      const stored = version ? deps.docs.read(version.doc) : null;
      if (!version || !stored || stored.source !== "html") return null;
      const target = { threadId: record.threadId, messageId: record.messageId, doc: version.doc };
      const folder = stored.data?.folder && origin
        ? files.folder(target, { key: viewer?.key ?? "", allowed: () => keeps(id, version.doc) && (viewer?.allowed() ?? true) }) : undefined;
      const filesAt = folder ? `${origin}${LOCAL_APP_FILES_PREFIX}${folder.slice(PAGE_FILES_PREFIX.length)}` : undefined;
      const { uses, connectors } = docUses(deps.docs, version.doc);
      return botHtmlDocument({ messageId: record.messageId, rev: version.rev, html: stored.html, title: record.name,
        ...(stored.data?.format === "jsx" ? { format: "jsx" as const } : {}), ...(filesAt ? { files: filesAt } : {}),
        ...(uses.length ? { uses } : {}), ...(connectors.length ? { connectors } : {}) });
    },
    serveFile(req, res, path, method) {
      if (!path.startsWith(LOCAL_APP_FILES_PREFIX)) return false;
      return files.serve(req, res, `${PAGE_FILES_PREFIX}${path.slice(LOCAL_APP_FILES_PREFIX.length)}`, method);
    },
    close() {
      unsubscribe?.();
      if (sweepTimer) clearTimeout(sweepTimer);
      sweepTimer = null;
    },
  };
}

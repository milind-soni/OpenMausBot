import { z } from "zod";
import type { ServerResponse } from "node:http";

import { json } from "../harness/http.ts";
import {
  MEMORY_INDEX,
  MemoryStoreError,
  deleteMemoryDoc,
  memoryCapacity,
  memoryOverview,
  openMemoryLocation,
  parseMemoryPath,
  readMemoryDoc,
  threadNotesPath,
  writeMemoryDoc,
} from "../memory-store.ts";
import {
  flushMemoryJournal,
  journalMemoryDelete,
  journalMemoryWrite,
  readMemoryJournal,
  revertMemoryChange,
  type MemoryJournalEntry,
} from "../memory-journal.ts";
import type { MemoryUpkeep } from "../memory-upkeep.ts";
import { listLearnedFacts, removeLearned } from "../profile-learned.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotMemoryRouteDeps {
  bot(id: string): { id: string; memoryUpkeep?: boolean } | null | undefined;
  taskByThread(botId: string, threadId: string): { title?: string } | undefined;
  upkeep: Pick<MemoryUpkeep, "enabled" | "status" | "tidy">;
  /** The caller's About me: the server's profile's, or on a Team Cloud the signed-in person's own. */
  aboutMe(auth: RequestAuth): string;
  saveAboutMe(text: string, auth: RequestAuth): void;
  /** Cloud home only. A review may come only from one of the owner's own devices (`owner`). */
  lendingReview?: {
    needed(botId: string): { token: string; changed: string[] } | null;
    accept(botId: string, token: string): boolean;
    owner(auth: RequestAuth): boolean;
  };
  ownersWrite?: <T>(auth: RequestAuth, botId: string, write: () => T) => T;
  /** Team Cloud only: the signed-in person's own layer of this bot's memory (`/memory/mine`); null for anyone else. */
  ownLayer?(auth: RequestAuth, botId: string): string | null;
  /** A conversation's own notes (`/memory/thread/<thread>`): `owns` when it is one of this bot's conversations, `scoped`
   * when its saves default to its notes. */
  threadNotes?: { owns(botId: string, threadId: string): boolean; scoped(botId: string, threadId: string): boolean };
}

/** A conversation's notes are kept out of the journal, which outlives a deleted conversation and travels in a move. */
function isThreadNotes(path: string): boolean {
  try {
    return parseMemoryPath(path).kind === "thread";
  } catch {
    return false;
  }
}

export function createBotMemoryRoutes(deps: BotMemoryRouteDeps): RouteHandler {
  /** 400 path, 409 conflict (with what is on disk now), 413 too large; anything else goes to the catch-all. */
  function replyMemoryError(res: ServerResponse, error: unknown) {
    if (!(error instanceof MemoryStoreError)) throw error;
    if (error.code === "conflict") {
      return json(res, error.status, { error: error.message, code: error.code, currentHash: error.currentHash, current: error.current });
    }
    return json(res, error.status, { error: error.message, code: error.code });
  }

  function journalEntryForClient(botId: string, entry: MemoryJournalEntry) {
    const { before: _before, ...visible } = entry;
    const threadTitle = entry.threadId ? deps.taskByThread(botId, entry.threadId)?.title : undefined;
    return threadTitle ? { ...visible, threadTitle } : visible;
  }

  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    let m: RegExpMatchArray | null = null;
    const write = <T>(botId: string, change: () => T): T => deps.ownersWrite ? deps.ownersWrite(auth, botId, change) : change();
    /** One memory file of `id`, a bot's own folder or a layer of it. */
    const serveFile = async (id: string, guarded: <T>(change: () => T) => T) => {
      if (isThreadNotes(url.searchParams.get("path") ?? "")) return json(res, 400, { error: "a conversation's notes are at /memory/thread/<thread id>", code: "path" });
      if (method === "GET") {
        try {
          return json(res, 200, readMemoryDoc(id, url.searchParams.get("path") ?? MEMORY_INDEX));
        } catch (error) {
          return replyMemoryError(res, error);
        }
      }
      if (method === "PUT") {
        const parsed = z
          .object({ path: z.string().default(MEMORY_INDEX), text: z.string(), expectedHash: z.string().optional() })
          .safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "text must be a string; path and expectedHash are optional strings" });
        if (isThreadNotes(parsed.data.path)) return json(res, 400, { error: "a conversation's notes are at /memory/thread/<thread id>", code: "path" });
        try {
          const { doc, entry } = guarded(() => journalMemoryWrite(id, parsed.data.path, parsed.data.text, {
            actor: "person",
            via: "ui",
            expectedHash: parsed.data.expectedHash,
          }));
          return json(res, 200, { ok: true, ...doc, entry: entry ? journalEntryForClient(id, entry) : null, overview: memoryOverview(id) });
        } catch (error) {
          return replyMemoryError(res, error);
        }
      }
      const file = url.searchParams.get("path") ?? "";
      try {
        const entry = guarded(() => journalMemoryDelete(id, file, { actor: "person", via: "ui" }));
        return json(res, 200, { ok: true, path: file, entry: entry ? journalEntryForClient(id, entry) : null, overview: memoryOverview(id) });
      } catch (error) {
        return replyMemoryError(res, error);
      }
    };
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory$/);
    if (m && method === "GET") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      try {
        const overview = memoryOverview(m[1]);
        // `text` and `truncated` stay one release for clients of the old whole-file shape.
        const review = deps.lendingReview?.needed(m[1]);
        return json(res, 200, { ...overview, text: readMemoryDoc(m[1], MEMORY_INDEX).text, truncated: overview.index.truncated,
          ...(review ? { lendingReview: review } : {}) });
      } catch (error) {
        return replyMemoryError(res, error);
      }
    }
    if (m && method === "PUT") {
      // The old whole-file write, kept one release: no hash check, so it can overwrite a note the bot just wrote.
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ text: z.string() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be a string" });
      try {
        const botId = m[1];
        const { doc } = write(botId, () => journalMemoryWrite(botId, MEMORY_INDEX, parsed.data.text, { actor: "person", via: "api" }));
        return json(res, 200, { ok: true, hash: doc.hash, truncated: memoryCapacity(doc.text).truncated });
      } catch (error) {
        // The old route answered 400 for an oversized body; its callers keep that.
        if (error instanceof MemoryStoreError && error.code === "too-large") return json(res, 400, { error: error.message });
        return replyMemoryError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/reviewed$/);
    if (m && method === "POST" && deps.lendingReview) {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      if (!deps.lendingReview.owner(auth)) {
        return json(res, 403, { error: "Only the owner of this Cloud can review this bot's memory, from one of their own devices." });
      }
      // Bound to what the owner was shown: anything changed since is shown again.
      const parsed = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "token is required: the lendingReview token the Memory panel was shown" });
      if (!deps.lendingReview.accept(m[1], parsed.data.token)) {
        return json(res, 409, { error: "This bot's memory changed since you looked. Review it again.", code: "changed",
          lendingReview: deps.lendingReview.needed(m[1]) });
      }
      return json(res, 200, { ok: true, lendingReview: false });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/file$/);
    if (m && ["GET", "PUT", "DELETE"].includes(method)) {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const botId = m[1];
      return serveFile(botId, (change) => write(botId, change));
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/mine(\/file)?$/);
    if (m && (method === "GET" || m[2])) {
      const layer = deps.bot(m[1]) ? deps.ownLayer?.(auth, m[1]) ?? null : null;
      if (!layer) return json(res, 404, { error: "no such bot" });
      if (!m[2]) return json(res, 200, memoryOverview(layer));
      if (!["GET", "PUT", "DELETE"].includes(method)) return PASS;
      return serveFile(layer, (change) => change());
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/thread\/([\w-]+)$/);
    if (m && ["GET", "PUT", "DELETE"].includes(method)) {
      const botId = m[1]!, threadId = m[2]!;
      if (!deps.bot(botId) || !deps.threadNotes?.owns(botId, threadId)) return json(res, 404, { error: "no such conversation" });
      const notesPath = threadNotesPath(threadId), scoped = deps.threadNotes.scoped(botId, threadId);
      try {
        if (method === "GET") return json(res, 200, { ...readMemoryDoc(botId, notesPath), scoped });
        if (method === "DELETE") {
          write(botId, () => deleteMemoryDoc(botId, notesPath));
          return json(res, 200, { ...readMemoryDoc(botId, notesPath), scoped });
        }
        const parsed = z.object({ text: z.string(), expectedHash: z.string().optional() }).safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "text must be a string; expectedHash is an optional string" });
        write(botId, () => writeMemoryDoc(botId, notesPath, parsed.data.text, { expectedHash: parsed.data.expectedHash }));
        return json(res, 200, { ok: true, ...readMemoryDoc(botId, notesPath), scoped });
      } catch (error) {
        return replyMemoryError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/journal$/);
    if (m && method === "GET") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      // A row a save queued a moment ago may not have reached disk yet.
      await flushMemoryJournal(m[1]);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      const botId = m[1];
      return json(res, 200, { entries: readMemoryJournal(botId, limit).map((entry) => journalEntryForClient(botId, entry)) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/journal\/([\w-]+)\/revert$/);
    if (m && method === "POST") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      await flushMemoryJournal(m[1]);
      const botId = m[1], changeId = m[2];
      const result = write(botId, () => revertMemoryChange(botId, changeId));
      if (!result.ok) return json(res, result.status, { error: result.error });
      return json(res, 200, { ok: true, ...result.doc, entry: result.entry ? journalEntryForClient(m[1], result.entry) : null, overview: memoryOverview(m[1]) });
    }
    if (method === "GET" && path === "/api/profile/learned") {
      return json(res, 200, { learned: listLearnedFacts() });
    }
    m = path.match(/^\/api\/profile\/learned\/([\w-]+)\/remove$/);
    if (m && method === "POST") {
      const removed = removeLearned(m[1], deps.aboutMe(auth), (text) => deps.saveAboutMe(text, auth));
      if (!removed) return json(res, 404, { error: "That fact was already removed." });
      return json(res, 200, { ok: true, aboutMe: deps.aboutMe(auth), learned: listLearnedFacts() });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/upkeep$/);
    if (m && method === "GET") {
      const bot = deps.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { enabled: deps.upkeep.enabled(bot), ...deps.upkeep.status(bot.id) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/tidy$/);
    if (m && method === "POST") {
      const bot = deps.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (!deps.upkeep.enabled(bot)) {
        return json(res, 409, { error: bot.memoryUpkeep === false ? "Switch on Memory upkeep for this bot first." : "Memory upkeep is off for every bot. Switch it on in Settings first." });
      }
      const report = await deps.upkeep.tidy(bot.id);
      await flushMemoryJournal(bot.id);
      return json(res, 200, { report, overview: memoryOverview(bot.id) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/open$/);
    if (m && method === "POST") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ target: z.enum(["obsidian", "folder"]) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "target must be obsidian or folder" });
      const workspacePath = memoryOverview(m[1]).workspacePath;
      if (auth.kind !== "loopback") {
        return json(res, 403, { error: `This only works on the computer running OpenMausBot. The memory folder there is ${workspacePath}`, workspacePath });
      }
      const opened = await openMemoryLocation(m[1], parsed.data.target);
      if (!opened.ok) return json(res, 500, { error: opened.error, workspacePath: opened.workspacePath });
      return json(res, 200, opened);
    }
    return PASS;
  };
}

// The bot-memory family, extracted from server/index.ts's inline routes
// into the route table (server/routes/README.md). The table runs after the
// auth gate; scope rules stay keyed by path in server/request-auth.ts.
//
// The files already belong to the person (plain markdown in the bot's
// workspace). server/memory-store.ts decides which paths can be reached
// and refuses a save whose expectedHash no longer matches the file;
// server/memory-journal.ts records every change made here so it can be
// read back and reverted. Reads never create the workspace — a bot that
// has not run yet simply has nothing to show. Admin scope by default
// (request-auth.ts), like the bot profile routes.
import { z } from "zod";
import type { ServerResponse } from "node:http";

import { json } from "../harness/http.ts";
import {
  MEMORY_INDEX,
  MemoryStoreError,
  memoryCapacity,
  memoryOverview,
  openMemoryLocation,
  readMemoryDoc,
} from "../memory-store.ts";
import {
  flushMemoryJournal,
  journalMemoryDelete,
  journalMemoryWrite,
  readMemoryJournal,
  revertMemoryChange,
  type MemoryJournalEntry,
} from "../memory-journal.ts";
import { isMemoryTopicName, readMemoryTopic } from "../workspace.ts";
import { upkeepEnabled, type MemoryUpkeep } from "../memory-upkeep.ts";
import { listLearnedFacts, removeLearned } from "../profile-learned.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotMemoryRouteDeps {
  /** The bot record for an id, or nothing when there is none. */
  bot(id: string): { id: string; memoryUpkeep?: boolean } | null | undefined;
  /** The task a thread belongs to; its title names the chat in a journal row. */
  taskByThread(botId: string, threadId: string): { title?: string } | undefined;
  upkeep: Pick<MemoryUpkeep, "status" | "tidy">;
  aboutMe(): string;
  saveAboutMe(text: string): void;
}

export function createBotMemoryRoutes(deps: BotMemoryRouteDeps): RouteHandler {
  /** A store refusal is a client error with a status of its own (400 path,
   * 409 conflict, 413 too large); a 409 also carries what is on disk now so
   * the editor can show the bot's version instead of guessing. Anything else
   * is a real failure and goes to the handler's catch-all. */
  function replyMemoryError(res: ServerResponse, error: unknown) {
    if (!(error instanceof MemoryStoreError)) throw error;
    if (error.code === "conflict") {
      return json(res, error.status, { error: error.message, code: error.code, currentHash: error.currentHash, current: error.current });
    }
    return json(res, error.status, { error: error.message, code: error.code });
  }

  /** The journal row as the panel shows it: the full prior text stays on
   * the server (a revert needs it there, the list does not), and the thread
   * id becomes the chat title people recognise. */
  function journalEntryForClient(botId: string, entry: MemoryJournalEntry) {
    const { before: _before, ...visible } = entry;
    const threadTitle = entry.threadId ? deps.taskByThread(botId, entry.threadId)?.title : undefined;
    return threadTitle ? { ...visible, threadTitle } : visible;
  }

  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory$/);
    if (m && method === "GET") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      try {
        const overview = memoryOverview(m[1]);
        // `text` and `truncated` ride along one release for clients of the
        // old whole-file shape; the panel reads the file through /memory/file
        return json(res, 200, { ...overview, text: readMemoryDoc(m[1], MEMORY_INDEX).text, truncated: overview.index.truncated });
      } catch (error) {
        return replyMemoryError(res, error);
      }
    }
    if (m && method === "PUT") {
      // The pre-panel whole-file write, kept one release: no hash check, so
      // it can still overwrite a note the bot just wrote — journaled as the
      // person's so at least the journal can undo it.
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ text: z.string() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be a string" });
      try {
        const { doc } = journalMemoryWrite(m[1], MEMORY_INDEX, parsed.data.text, { actor: "person", via: "api" });
        return json(res, 200, { ok: true, hash: doc.hash, truncated: memoryCapacity(doc.text).truncated });
      } catch (error) {
        // the old route answered 400 for an oversized body; keep that for
        // its callers while the new route says 413
        if (error instanceof MemoryStoreError && error.code === "too-large") return json(res, 400, { error: error.message });
        return replyMemoryError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/file$/);
    if (m && method === "GET") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      try {
        return json(res, 200, readMemoryDoc(m[1], url.searchParams.get("path") ?? MEMORY_INDEX));
      } catch (error) {
        return replyMemoryError(res, error);
      }
    }
    if (m && method === "PUT") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z
        .object({ path: z.string().default(MEMORY_INDEX), text: z.string(), expectedHash: z.string().optional() })
        .safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be a string; path and expectedHash are optional strings" });
      try {
        const { doc, entry } = journalMemoryWrite(m[1], parsed.data.path, parsed.data.text, {
          actor: "person",
          via: "ui",
          expectedHash: parsed.data.expectedHash,
        });
        return json(res, 200, { ok: true, ...doc, entry: entry ? journalEntryForClient(m[1], entry) : null, overview: memoryOverview(m[1]) });
      } catch (error) {
        return replyMemoryError(res, error);
      }
    }
    if (m && method === "DELETE") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const file = url.searchParams.get("path") ?? "";
      try {
        const entry = journalMemoryDelete(m[1], file, { actor: "person", via: "ui" });
        return json(res, 200, { ok: true, path: file, entry: entry ? journalEntryForClient(m[1], entry) : null, overview: memoryOverview(m[1]) });
      } catch (error) {
        return replyMemoryError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/journal$/);
    if (m && method === "GET") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      // the row a save queued a moment ago may not have reached disk yet
      await flushMemoryJournal(m[1]);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      const botId = m[1];
      return json(res, 200, { entries: readMemoryJournal(botId, limit).map((entry) => journalEntryForClient(botId, entry)) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/journal\/([\w-]+)\/revert$/);
    if (m && method === "POST") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      await flushMemoryJournal(m[1]);
      const result = revertMemoryChange(m[1], m[2]);
      if (!result.ok) return json(res, result.status, { error: result.error });
      return json(res, 200, { ok: true, ...result.doc, entry: result.entry ? journalEntryForClient(m[1], result.entry) : null, overview: memoryOverview(m[1]) });
    }
    // What upkeep learned about the person is shared through About me.
    if (method === "GET" && path === "/api/profile/learned") {
      return json(res, 200, { learned: listLearnedFacts() });
    }
    m = path.match(/^\/api\/profile\/learned\/([\w-]+)\/remove$/);
    if (m && method === "POST") {
      const removed = removeLearned(m[1], deps.aboutMe(), deps.saveAboutMe);
      if (!removed) return json(res, 404, { error: "That fact was already removed." });
      return json(res, 200, { ok: true, aboutMe: deps.aboutMe(), learned: listLearnedFacts() });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/upkeep$/);
    if (m && method === "GET") {
      const bot = deps.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { enabled: upkeepEnabled(bot), ...deps.upkeep.status(bot.id) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/tidy$/);
    if (m && method === "POST") {
      const bot = deps.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (!upkeepEnabled(bot)) return json(res, 409, { error: "Switch on Memory upkeep for this bot first." });
      const report = await deps.upkeep.tidy(bot.id);
      await flushMemoryJournal(bot.id);
      return json(res, 200, { report, overview: memoryOverview(bot.id) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/open$/);
    if (m && method === "POST") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ target: z.enum(["obsidian", "folder"]) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "target must be obsidian or folder" });
      // The folder is on this machine's disk; opening it only makes sense
      // from this machine. A paired phone or a remote browser gets the path
      // to open by hand instead.
      const workspacePath = memoryOverview(m[1]).workspacePath;
      if (auth.kind !== "loopback") {
        return json(res, 403, { error: `This only works on the computer running OpenMausBot. The memory folder there is ${workspacePath}`, workspacePath });
      }
      const opened = await openMemoryLocation(m[1], parsed.data.target);
      if (!opened.ok) return json(res, 500, { error: opened.error, workspacePath: opened.workspacePath });
      return json(res, 200, opened);
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/topics\/([^/]+)$/);
    if (m && method === "GET") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      // Decode before validating: a UI-sent name arrives percent-encoded
      // ("my notes.md" → "my%20notes.md"), and an encoded traversal
      // ("..%2F..") must be judged by what it decodes TO, not slip through
      // as an opaque token. The name gate then rejects anything that is not
      // a single plain-markdown path segment.
      let name: string;
      try {
        name = decodeURIComponent(m[2]);
      } catch {
        return json(res, 400, { error: "invalid topic name" });
      }
      if (!isMemoryTopicName(name)) return json(res, 400, { error: "invalid topic name" });
      const text = readMemoryTopic(m[1], name);
      if (text === null) return json(res, 404, { error: "no such topic file" });
      return json(res, 200, { name, text });
    }
    return PASS;
  };
}

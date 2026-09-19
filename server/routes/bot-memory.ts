// The bot memory HTTP routes (MEMORY.md and memory/ file reads and
// hash-checked journaled writes/deletes, the journal list and revert,
// opening the memory folder on this machine, topic-file reads, the
// per-turn workspace-checkpoint list/restore with its restore lease, and
// the onboarding/ask card state PATCH), extracted verbatim from index.ts's
// dispatch chain. Path matching, methods, and status codes are unchanged;
// the handler returns false for anything it does not own so the chain
// falls through in the same order. The module's call site sits exactly
// where the family sat — immediately after the bot-profile module and
// immediately before the bot-thread-ops module — so dispatch order is
// unchanged. The memory-error reply and client journal-row helpers moved
// with the family because only these handlers use them; the
// checkpoint-restore lease set is index-local (createComputerLifecycle
// owns it) and crosses via deps; store is a live binding from
// ../runtime.ts and the memory/journal/workspace/checkpoint helpers are
// imported from their source modules. index.ts's `return json(...)`
// statements became `json(...); return true;` (json returns void) and
// the `return replyMemoryError(...)`s became
// `replyMemoryError(...); return true;`.
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";
import { json, readBody, type RouteContext } from "./http.ts";
import * as checkpoints from "../checkpoints.ts";
import { store } from "../runtime.ts";
import { requestedTaskBot } from "../turn-admission.ts";
import { isMemoryTopicName, readMemoryTopic } from "../workspace.ts";
import { MEMORY_INDEX, MemoryStoreError, memoryCapacity, memoryOverview, openMemoryLocation, readMemoryDoc } from "../memory-store.ts";
import {
  flushMemoryJournal,
  journalMemoryDelete,
  journalMemoryWrite,
  readMemoryJournal,
  revertMemoryChange,
  type MemoryJournalEntry,
} from "../memory-journal.ts";

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
  const threadTitle = entry.threadId ? store.taskByThread(botId, entry.threadId)?.title : undefined;
  return threadTitle ? { ...visible, threadTitle } : visible;
}

export function createBotMemoryRoutes(deps: {
  checkpointRestoreLeases: Set<string>;
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url, auth } = rctx;
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    const { checkpointRestoreLeases } = deps;
    // ── bot memory: MEMORY.md + memory/ topic and log files ──────────────
    // The files already belong to the person (plain markdown in the bot's
    // workspace). server/memory-store.ts decides which paths can be reached
    // and refuses a save whose expectedHash no longer matches the file;
    // server/memory-journal.ts records every change made here so it can be
    // read back and reverted. Reads never create the workspace — a bot that
    // has not run yet simply has nothing to show. Admin scope by default
    // (request-auth.ts), like the profile routes above.
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) { json(res, 404, { error: "no such bot" }); return true; }
      try {
        const overview = memoryOverview(m[1]);
        // `text` and `truncated` ride along one release for clients of the
        // old whole-file shape; the panel reads the file through /memory/file
        json(res, 200, { ...overview, text: readMemoryDoc(m[1], MEMORY_INDEX).text, truncated: overview.index.truncated });
        return true;
      } catch (error) {
        replyMemoryError(res, error);
        return true;
      }
    }
    if (m && method === "PUT") {
      // The pre-panel whole-file write, kept one release: no hash check, so
      // it can still overwrite a note the bot just wrote — journaled as the
      // person's so at least the journal can undo it.
      if (!store.bot(m[1])) { json(res, 404, { error: "no such bot" }); return true; }
      const parsed = z.object({ text: z.string() }).safeParse(await readBody(req));
      if (!parsed.success) { json(res, 400, { error: "text must be a string" }); return true; }
      try {
        const { doc } = journalMemoryWrite(m[1], MEMORY_INDEX, parsed.data.text, { actor: "person", via: "api" });
        json(res, 200, { ok: true, hash: doc.hash, truncated: memoryCapacity(doc.text).truncated });
        return true;
      } catch (error) {
        // the old route answered 400 for an oversized body; keep that for
        // its callers while the new route says 413
        if (error instanceof MemoryStoreError && error.code === "too-large") { json(res, 400, { error: error.message }); return true; }
        replyMemoryError(res, error);
        return true;
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/file$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) { json(res, 404, { error: "no such bot" }); return true; }
      try {
        json(res, 200, readMemoryDoc(m[1], url.searchParams.get("path") ?? MEMORY_INDEX));
        return true;
      } catch (error) {
        replyMemoryError(res, error);
        return true;
      }
    }
    if (m && method === "PUT") {
      if (!store.bot(m[1])) { json(res, 404, { error: "no such bot" }); return true; }
      const parsed = z
        .object({ path: z.string().default(MEMORY_INDEX), text: z.string(), expectedHash: z.string().optional() })
        .safeParse(await readBody(req));
      if (!parsed.success) { json(res, 400, { error: "text must be a string; path and expectedHash are optional strings" }); return true; }
      try {
        const { doc, entry } = journalMemoryWrite(m[1], parsed.data.path, parsed.data.text, {
          actor: "person",
          via: "ui",
          expectedHash: parsed.data.expectedHash,
        });
        json(res, 200, { ok: true, ...doc, entry: entry ? journalEntryForClient(m[1], entry) : null, overview: memoryOverview(m[1]) });
        return true;
      } catch (error) {
        replyMemoryError(res, error);
        return true;
      }
    }
    if (m && method === "DELETE") {
      if (!store.bot(m[1])) { json(res, 404, { error: "no such bot" }); return true; }
      const file = url.searchParams.get("path") ?? "";
      try {
        const entry = journalMemoryDelete(m[1], file, { actor: "person", via: "ui" });
        json(res, 200, { ok: true, path: file, entry: entry ? journalEntryForClient(m[1], entry) : null, overview: memoryOverview(m[1]) });
        return true;
      } catch (error) {
        replyMemoryError(res, error);
        return true;
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/journal$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) { json(res, 404, { error: "no such bot" }); return true; }
      // the row a save queued a moment ago may not have reached disk yet
      await flushMemoryJournal(m[1]);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      const botId = m[1];
      json(res, 200, { entries: readMemoryJournal(botId, limit).map((entry) => journalEntryForClient(botId, entry)) });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/journal\/([\w-]+)\/revert$/);
    if (m && method === "POST") {
      if (!store.bot(m[1])) { json(res, 404, { error: "no such bot" }); return true; }
      await flushMemoryJournal(m[1]);
      const result = revertMemoryChange(m[1], m[2]);
      if (!result.ok) { json(res, result.status, { error: result.error }); return true; }
      json(res, 200, { ok: true, ...result.doc, entry: result.entry ? journalEntryForClient(m[1], result.entry) : null, overview: memoryOverview(m[1]) });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/open$/);
    if (m && method === "POST") {
      if (!store.bot(m[1])) { json(res, 404, { error: "no such bot" }); return true; }
      const parsed = z.object({ target: z.enum(["obsidian", "folder"]) }).safeParse(await readBody(req));
      if (!parsed.success) { json(res, 400, { error: "target must be obsidian or folder" }); return true; }
      // The folder is on this machine's disk; opening it only makes sense
      // from this machine. A paired phone or a remote browser gets the path
      // to open by hand instead.
      const workspacePath = memoryOverview(m[1]).workspacePath;
      if (auth.kind !== "loopback") {
        json(res, 403, { error: `This only works on the computer running OpenMausBot. The memory folder there is ${workspacePath}`, workspacePath });
        return true;
      }
      const opened = await openMemoryLocation(m[1], parsed.data.target);
      if (!opened.ok) { json(res, 500, { error: opened.error, workspacePath: opened.workspacePath }); return true; }
      json(res, 200, opened);
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/topics\/([^/]+)$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) { json(res, 404, { error: "no such bot" }); return true; }
      // Decode before validating: a UI-sent name arrives percent-encoded
      // ("my notes.md" → "my%20notes.md"), and an encoded traversal
      // ("..%2F..") must be judged by what it decodes TO, not slip through
      // as an opaque token. The name gate then rejects anything that is not
      // a single plain-markdown path segment.
      let name: string;
      try {
        name = decodeURIComponent(m[2]);
      } catch {
        json(res, 400, { error: "invalid topic name" });
        return true;
      }
      if (!isMemoryTopicName(name)) { json(res, 400, { error: "invalid topic name" }); return true; }
      const text = readMemoryTopic(m[1], name);
      if (text === null) { json(res, 404, { error: "no such topic file" }); return true; }
      json(res, 200, { name, text });
      return true;
    }

    // ── workspace checkpoints: per-turn shadow-git snapshots ────────────
    // The list endpoint is the source of truth (turns store nothing), and
    // `enabled` tells the UI whether snapshots can happen here at all —
    // false for refused folders (home, Desktop…), a missing git, or a bot
    // whose checkpoints failed earlier this session.
    m = path.match(/^\/api\/bots\/([\w-]+)\/checkpoints$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) { json(res, 404, { error: "no such bot" }); return true; }
      const cwd = url.searchParams.get("cwd") ?? "";
      if (!cwd.trim()) { json(res, 400, { error: "cwd query parameter required" }); return true; }
      json(res, 200, {
        checkpoints: await checkpoints.listCheckpoints(m[1]!, cwd),
        enabled: await checkpoints.checkpointsEnabled(m[1]!, cwd),
      });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/checkpoints\/restore$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      const parsed = z
        .object({ cwd: z.string().min(1), hash: z.string().regex(/^[0-9a-f]{40}$/) })
        .safeParse(await readBody(req));
      if (!parsed.success) {
        json(res, 400, { error: "cwd (absolute path) and hash (full 40-character checkpoint hash) required" });
        return true;
      }
      // Claim synchronously with the busy check. startTurn checks the same
      // lease before reserving the bot, so no turn can enter during the
      // awaited Git operation.
      if (bot.busy) { json(res, 409, { error: "the bot is working — stop the turn before restoring files" }); return true; }
      if (checkpointRestoreLeases.has(bot.id)) {
        json(res, 409, { error: "this bot's project files are already being restored" });
        return true;
      }
      checkpointRestoreLeases.add(bot.id);
      let result: checkpoints.RestoreResult;
      try {
        result = await checkpoints.restore(bot.id, parsed.data.cwd, parsed.data.hash);
      } finally {
        checkpointRestoreLeases.delete(bot.id);
      }
      if (!result.ok) { json(res, 400, { error: result.error }); return true; }
      json(res, 200, { ok: true });
      return true;
    }

    // onboarding/ask cards persist their answered/dismissed state
    m = path.match(/^\/api\/bots\/([\w-]+)\/cards\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(res, 400, { error: "body must be a JSON object" });
        return true;
      }
      const bot = requestedTaskBot(m[1], body.threadId);
      const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card) { json(res, 404, { error: "no such card" }); return true; }
      if (existing.card.requestId) {
        json(res, 409, { error: "request cards must be answered through the approval endpoint" });
        return true;
      }
      if (Object.keys(body).some((key) => key !== "answered" && key !== "dismissed" && key !== "threadId")) {
        json(res, 400, { error: "only answered and dismissed may be changed" });
        return true;
      }
      if (body.answered !== undefined && typeof body.answered !== "string") {
        json(res, 400, { error: "answered must be a string" });
        return true;
      }
      if (body.dismissed !== undefined && typeof body.dismissed !== "boolean") {
        json(res, 400, { error: "dismissed must be true or false" });
        return true;
      }
      const patched = store.patchMessage(bot.threadId, m[2], {
        card: {
          ...existing.card,
          ...(body.answered !== undefined ? { answered: body.answered } : {}),
          ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
        },
      });
      json(res, 200, { message: patched });
      return true;
    }
    return false;
  };
}

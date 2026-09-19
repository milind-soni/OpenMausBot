// The bot's notebook: MEMORY.md writes plus session recall (session_search /
// session_read) over the calling bot's own threads. Bodies moved verbatim
// from ../internal.ts; the dispatch chain there owns order.
import type { ServerResponse } from "node:http";

import { claimRecallCrossings, recallCrossingLabel } from "../../recall-disclosure.ts";
import { parseSince } from "../../recent-work.ts";
import { recallMessages, readMessageText, recentMessages } from "../../message-db.ts";
import { appendMemoryLog, searchMemoryFiles, updateMemory } from "../../workspace.ts";
import type { BotRecord, GroupRecord } from "../../store.ts";
import type { InternalRoutesOptions } from "../internal.ts";
import type { InternalRequestCtx } from "./types.ts";

export type MemoryCtx = InternalRequestCtx & {
  store: InternalRoutesOptions["store"];
  connectorThread: InternalRoutesOptions["connectorThread"];
}

/** A session_read answer competes with the transcript for the context
 * window; a computer-use turn's output can run to hundreds of KB. */
const SESSION_READ_MAX_CHARS = 8_000;

// session_search: ranked recall over the calling bot's OWN threads,
// every task included. Own-bot only, on purpose — a bot's transcripts
// are its notebook the same way MEMORY.md is (section-context.ts draws
// that line), and search across bots would be an isolation change.
// Announce in the room that a bot reached outside it. Silent when the
// room has already been told about that thread, so a bot searching
// three times in one turn leaves one chip per source, not per search.
// Adapted from the inline closure: store crosses as a parameter so both
// session handlers share it unchanged.
const discloseRecall = (store: InternalRoutesOptions["store"], bot: BotRecord, roomThreadId: string, sourceThreadIds: readonly string[]): void => {
  const crossing = claimRecallCrossings(roomThreadId, sourceThreadIds);
  if (!crossing.count) return;
  store.appendMessage(roomThreadId, {
    role: "bot",
    kind: "activity",
    from: { botId: bot.id, name: bot.name, color: bot.color },
    tool: { name: recallCrossingLabel(bot.name, crossing.count), ok: true },
  });
};

export async function memoryUpdate(ctx: MemoryCtx, res: ServerResponse): Promise<boolean> {
  const {
    internalSender, memorySource, readInternalBody, json,
  } = ctx;
    const body = await readInternalBody();
    const result = updateMemory(internalSender.id, { action: body.action, text: body.text, oldText: body.oldText }, { source: memorySource() });
    return json(res, result.ok ? 200 : result.code === "conflict" ? 409 : result.code === "over-budget" ? 413 : 400, result);
}

export async function memoryLog(ctx: MemoryCtx, res: ServerResponse): Promise<boolean> {
  const {
    internalSender, memorySource, readInternalBody, json,
  } = ctx;
    const body = await readInternalBody();
    const result = appendMemoryLog(internalSender.id, body.text, { source: memorySource() });
    return json(res, result.ok ? 200 : 400, result);
}
export async function sessionSearch(ctx: MemoryCtx, res: ServerResponse, url: URL): Promise<boolean> {
  const {
    store, connectorThread, internalCapability, json,
  } = ctx;
    const fromBotId = String(url.searchParams.get("fromBotId") ?? "");
    const from = store.bot(fromBotId);
    if (!from) return json(res, 403, { error: "unknown sender" });
    const fromThreadId = internalCapability.threadId;
    if (!connectorThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    const q = String(url.searchParams.get("q") ?? "").trim();
    // A recall by time needs no words: "what happened since yesterday"
    // is the standup question, and it has no keyword.
    const now = Date.now();
    const sinceRaw = url.searchParams.get("since");
    const untilRaw = url.searchParams.get("until");
    const since = sinceRaw ? parseSince(sinceRaw, now) : null;
    const until = untilRaw ? parseSince(untilRaw, now) : null;
    if (sinceRaw && since === null) return json(res, 400, { error: "since must be a date, or a span like 24h, 3d, today, yesterday" });
    if (untilRaw && until === null) return json(res, 400, { error: "until must be a date, or a span like 24h, 3d, today, yesterday" });
    if (!q && since === null) return json(res, 400, { error: "q or since is required" });
    const range = since !== null || until !== null
      ? { ...(since !== null ? { since } : {}), ...(until !== null ? { until } : {}) }
      : undefined;
    const rawLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 25) : 12;
    // Memory files ride along by default: the bot's own notes are as
    // much its notebook as its transcripts, and scoped the same way —
    // the caller's own bot, never another's. A recall by time alone
    // has no words to match a file with.
    const scope = url.searchParams.get("scope") ?? "all";
    if (scope !== "all" && scope !== "conversations" && scope !== "memory") {
      return json(res, 400, { error: "scope must be all, conversations, or memory" });
    }
    const memoryHits = scope === "conversations" || !q ? [] : searchMemoryFiles(from.id, q, limit);
    if (scope === "memory") return json(res, 200, { hits: [], memoryHits });
    // Own threads: the bot's main chat and tasks, and the rooms it is a
    // member of with their tasks — conversations it already saw in full.
    // Still own-bot: another bot's threads never enter this list.
    const roomByThread = new Map<string, GroupRecord>();
    for (const group of store.groups) {
      if (!group.memberIds.includes(from.id)) continue;
      roomByThread.set(group.threadId, group);
      for (const task of group.tasks ?? []) roomByThread.set(task.threadId, group);
    }
    const ownThreads = [...new Set([from.threadId, ...(from.tasks ?? []).map((task) => task.threadId), ...roomByThread.keys()])];
    // A room is the only place a recall can be a disclosure, and only a
    // private chat is one: in a 1:1 the user already owns every thread
    // the bot can reach, and a room's lines were said in the open.
    const inRoom = Boolean(store.groupByThread(fromThreadId));
    const found = q ? recallMessages(q, ownThreads, limit, range) : recentMessages(ownThreads, range ?? {}, limit);
    const hits = found.map((hit) => {
      const room = roomByThread.get(hit.threadId);
      return {
        ...hit,
        task: room
          ? (room.tasks ?? []).find((task) => task.threadId === hit.threadId)?.title
          : store.taskByThread(from.id, hit.threadId)?.title,
        ...(room ? { room: room.name } : {}),
        current: hit.threadId === fromThreadId,
        crossed: inRoom && !room && hit.threadId !== fromThreadId,
      };
    });
    if (inRoom) {
      discloseRecall(store, from, fromThreadId, hits.filter((hit) => hit.crossed).map((hit) => hit.threadId));
    }
    return json(res, 200, { hits, memoryHits });
}

// session_read: the whole message behind a session_search hit. Same
// own-bot scope — a message id from another bot's thread reads as
// missing, not as forbidden, so the id space leaks nothing.
export async function sessionRead(ctx: MemoryCtx, res: ServerResponse, url: URL): Promise<boolean> {
  const {
    store, connectorThread, internalCapability, json,
  } = ctx;
    const fromBotId = String(url.searchParams.get("fromBotId") ?? "");
    const from = store.bot(fromBotId);
    if (!from) return json(res, 403, { error: "unknown sender" });
    const fromThreadId = internalCapability.threadId;
    if (!connectorThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    const threadId = String(url.searchParams.get("threadId") ?? "").trim();
    const messageId = String(url.searchParams.get("messageId") ?? "").trim();
    if (!threadId || !messageId) return json(res, 400, { error: "threadId and messageId are required" });
    const own = threadId === from.threadId || Boolean(store.taskByThread(from.id, threadId));
    const message = own ? readMessageText(threadId, messageId) : null;
    if (!message) return json(res, 404, { error: "no such message in your conversations" });
    const readInRoom = Boolean(store.groupByThread(fromThreadId));
    const readCrossed = readInRoom && threadId !== fromThreadId;
    if (readCrossed) discloseRecall(store, from, fromThreadId, [threadId]);
    return json(res, 200, {
      ...message,
      crossed: readCrossed,
      text: message.text.length > SESSION_READ_MAX_CHARS ? `${message.text.slice(0, SESSION_READ_MAX_CHARS)}…` : message.text,
      task: store.taskByThread(from.id, threadId)?.title,
    });
}

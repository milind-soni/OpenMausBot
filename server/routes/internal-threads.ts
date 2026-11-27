import { chiefTidies } from "../chief-of-staff.ts";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import { mainThreadChoicePatch } from "../main-thread.ts";
import { reachablePeers } from "../peer-roster.ts";
import { threadTitleFrom, type BotRecord, type Store, type TaskRecord } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { closeRoomThreadAtTurnEnd } from "../room-thread-close.ts";
import { conversationLanguage, serverLine } from "../server-lines.ts";

const THREADS_PAGE = 100;

type ThreadState = "running" | "waiting-on-you" | "queued" | "idle" | "closed";

interface ThreadRow {
  threadId: string; botId: string; botName: string; title: string;
  state: ThreadState;
  unread: boolean; openedAt: number; delegationId?: string; own: boolean;
  /** Why a queued handoff hasn't started (host/queued-reason.ts). */
  waiting?: string;
  openedBy?: string;
  /** The person's sidebar no longer shows it. */
  archived?: true;
}

/** Only dispatch inside the internal capability gate: `from` and `fromThreadId` come from the caller's capability. */
export function createInternalThreadRoutes(deps: {
  store: Pick<Store, "bot" | "bots" | "tasks" | "taskByThread" | "appendMessage" | "patchTask" | "setTaskClosedBy" | "renameTask" | "patchBot" | "groupByThread" | "groupTaskByThread">;
  coordinator: Pick<Coordinator, "threadActivity" | "awaitingAnswer" | "activeDirect">;
  from: BotRecord;
  fromThreadId: string;
  ownsThread(botId: string, threadId: string): boolean;
  /** The bot's threads that may be its main thread (server/index.ts mainThreadTasks), as the person's own choice uses. */
  mainThreadTasks(botId: string): TaskRecord[];
  /** A turn that may use the lent Mac sees only owner-only conversations: a title is words too. */
  shown(threadId: string): boolean;
  threadBusy(botId: string, threadId: string): boolean;
  queuedThreadPosition(botId: string, threadId: string): number | null;
  /** `showTitle`: the caller is the receiver, so its own busy threads it may see can be named. */
  queuedReason(node: HandoffView, showTitle?: (threadId: string) => boolean): string;
  /** The caller's body, read only while its turn still holds the capability. */
  readBody(): Promise<unknown>;
}): RouteHandler {
  const { store, coordinator, from, fromThreadId } = deps;
  return async ({ res, url, path, method, json }) => {
    // list_threads: the caller's own threads plus, on reachable peers, only threads it opened; a peer's other threads are its own business.
    if (method === "GET" && path === "/api/internal/threads") {
      if (!deps.ownsThread(from.id, fromThreadId)) {
        return json(res, 403, { error: "source conversation does not belong to sender" });
      }
      const visible: { bot: BotRecord; task: TaskRecord; openedAt: number; openedBy?: string }[] = [];
      for (const task of store.tasks(from.id)) {
        if (deps.shown(task.threadId)) visible.push({ bot: from, task, openedAt: task.openedBy?.at ?? task.createdAt });
      }
      for (const peer of reachablePeers(store.bots, from)) {
        for (const task of store.tasks(peer.id)) {
          const opener = task.openedBy;
          if (!opener || !deps.shown(task.threadId)) continue;
          const mine = opener.botId === from.id;
          if (!mine && !chiefTidies(from, task, store.bot(opener.botId), peer)) continue;
          visible.push({ bot: peer, task, openedAt: opener.at, ...(mine ? {} : { openedBy: opener.name }) });
        }
      }
      visible.sort((a, b) => b.openedAt - a.openedAt);
      const asked = Number(url.searchParams.get("page"));
      const page = Number.isSafeInteger(asked) && asked > 0 ? asked : 1;
      const start = (page - 1) * THREADS_PAGE;
      const selected = visible.slice(start, start + THREADS_PAGE);
      if (selected.length === 0) return json(res, 200, { threads: [], total: visible.length, page, pageSize: THREADS_PAGE });
      const pageThreads = new Map<string, Set<string>>();
      for (const { bot, task } of selected) {
        let bots = pageThreads.get(task.threadId);
        if (!bots) { bots = new Set(); pageThreads.set(task.threadId, bots); }
        bots.add(bot.id);
      }
      const activity = coordinator.threadActivity(pageThreads);
      const threads = selected.map(({ bot, task, openedAt, openedBy }): ThreadRow => {
        const state: ThreadState = (!task.closedBy && task.activity === "waiting-on-you") || activity.awaitingAnswer.has(task.threadId) ? "waiting-on-you"
          : deps.threadBusy(bot.id, task.threadId) ? "running"
          : deps.queuedThreadPosition(bot.id, task.threadId) !== null || activity.activeDirect.has(task.threadId) ? "queued"
          : task.closedBy ? "closed" : "idle";
        const node = state === "queued" ? activity.queued.get(task.threadId)?.get(bot.id) : undefined;
        return {
          threadId: task.threadId, botId: bot.id, botName: bot.name, title: task.title,
          state, unread: task.unread === true, openedAt, delegationId: task.openedBy?.delegationId,
          own: bot.id === from.id, ...(node ? { waiting: deps.queuedReason(node, bot.id === from.id ? deps.shown : undefined), delegationId: node.id } : {}),
          ...(openedBy !== undefined ? { openedBy } : {}), ...(task.archivedAt !== undefined ? { archived: true } : {}),
        };
      });
      return json(res, 200, { threads, total: visible.length, page, pageSize: THREADS_PAGE });
    }
    // rename_thread names only the conversation the turn speaks in. A room's thread is the room's, and an automation's
    // chat keeps the name its runs find it by.
    if (method === "POST" && path === "/api/internal/thread-title") {
      if (!deps.ownsThread(from.id, fromThreadId)) {
        return json(res, 403, { error: "source conversation does not belong to sender" });
      }
      const body = await deps.readBody() as { title?: unknown } | null;
      const title = typeof body?.title === "string" ? body.title.replace(/\s+/g, " ").trim() : "";
      if (!title) return json(res, 400, { error: "rename_thread needs a title: one short line" });
      const task = store.taskByThread(from.id, fromThreadId);
      if (!task) return json(res, 404, { error: "this conversation is not one of your own threads (a room's thread keeps the room's name)" });
      if (task.routineRunId || task.title.endsWith(" · Results")) {
        return json(res, 409, { error: `#${task.title} holds an automation's results and keeps its name` });
      }
      const previous = task.title;
      const renamed = store.renameTask(from.id, fromThreadId, threadTitleFrom(title));
      if (!renamed) return json(res, 404, { error: "this conversation is not one of your own threads" });
      return json(res, 200, { renamed: true, title: renamed.title, previous });
    }
    // set_main_thread: a bot sets or clears its own main thread, as the person's "Set as main thread" does, under the same
    // rule (an open conversation, never an automation run or an archived one). Never a teammate's.
    if (method === "POST" && path === "/api/internal/main-thread") {
      if (!deps.ownsThread(from.id, fromThreadId)) {
        return json(res, 403, { error: "source conversation does not belong to sender" });
      }
      const body = await deps.readBody() as { mainThreadId?: unknown; clear?: unknown } | null;
      if (body?.clear === true) {
        store.patchBot(from.id, mainThreadChoicePatch([], null)!);
        return json(res, 200, { cleared: true });
      }
      const threadId = typeof body?.mainThreadId === "string" && body.mainThreadId.trim() ? body.mainThreadId.trim() : fromThreadId;
      const task = store.taskByThread(from.id, threadId);
      if (!task || !deps.shown(threadId)) {
        return json(res, 404, { error: "that is not one of your own threads (a room's thread or a teammate's cannot be your main thread) — call list_threads" });
      }
      const choice = mainThreadChoicePatch(deps.mainThreadTasks(from.id), threadId);
      if (!choice) {
        const why = task.routineRunId ? "it holds an automation run" : task.archivedAt !== undefined ? "it is archived" : "it is not one of your conversations that can be main";
        return json(res, 409, { error: `#${task.title} cannot be your main thread: ${why}` });
      }
      store.patchBot(from.id, choice);
      return json(res, 200, { threadId, title: task.title });
    }
    // close_thread folds a thread, never deletes it (a person's confirmed action), and never while it runs.
    const closeMatch = method === "POST" ? path.match(/^\/api\/internal\/threads\/([\w-]+)\/close$/) : null;
    if (!closeMatch) return PASS;
    if (!deps.ownsThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    const threadId = closeMatch[1]!;
    const room = threadId === fromThreadId ? store.groupByThread(threadId) : undefined;
    if (room && !room.dm) {
      const task = store.groupTaskByThread(room.id, threadId);
      if (!task || !room.memberIds.includes(from.id)) return json(res, 404, { error: "this room thread is gone, or you are no longer in its room" });
      if (task.closedAt === undefined) closeRoomThreadAtTurnEnd(threadId, from);
      return json(res, 200, { closed: true, room: true, threadId, title: task.title, ...(task.closedAt !== undefined ? { alreadyClosed: true } : {}) });
    }
    const owner = [from, ...reachablePeers(store.bots, from)].find((bot) => store.taskByThread(bot.id, threadId));
    const task = owner ? store.taskByThread(owner.id, threadId) : undefined;
    if (!owner || !task || !deps.shown(threadId)) return json(res, 404, { error: "no such thread — call list_threads for the ones you can see" });
    if (owner.id !== from.id && task.openedBy?.botId !== from.id && !chiefTidies(from, task, task.openedBy ? store.bot(task.openedBy.botId) : undefined, owner)) {
      return json(res, 403, { error: "that thread is not yours to close — only the bot that opened it, its own bot, or (for a thread a bot opened) a Chief of Staff can" });
    }
    if (threadId === fromThreadId) return json(res, 400, { error: "you cannot close the thread you are speaking in — finish your turn instead" });
    if (coordinator.awaitingAnswer(threadId)) {
      return json(res, 409, { error: `#${task.title} is waiting on the person's answer to its question — it continues once they reply there, so leave it open` });
    }
    if (deps.threadBusy(owner.id, threadId) || deps.queuedThreadPosition(owner.id, threadId) !== null || coordinator.activeDirect(threadId)) {
      return json(res, 409, { error: `#${task.title} is still running — wait for it to finish (list_threads), or the person can stop it from the app` });
    }
    if (task.closedBy) {
      return json(res, 200, { closed: true, alreadyClosed: true, threadId, title: task.title, botName: owner.name, closedBy: task.closedBy.name, archived: task.archivedAt !== undefined });
    }
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: from.id, name: from.name, color: from.color },
      tool: { name: serverLine(conversationLanguage(threadId), "server.teammates.closedBy", { bot: from.name }), ok: true },
    });
    if (task.unread) store.patchTask(owner.id, threadId, { unread: false });
    store.setTaskClosedBy(owner.id, threadId, { botId: from.id, name: from.name, at: Date.now() });
    return json(res, 200, { closed: true, threadId, title: task.title, botName: owner.name, archived: task.archivedAt !== undefined });
  };
}

import { chiefTidies } from "../chief-of-staff.ts";
import type { Coordinator } from "../coordinator.ts";
import { reachablePeers } from "../peer-roster.ts";
import type { BotRecord, Store, TaskRecord } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

type ThreadState = "running" | "waiting-on-you" | "queued" | "idle" | "closed";

interface ThreadRow {
  threadId: string; botId: string; botName: string; title: string;
  state: ThreadState;
  unread: boolean; openedAt: number; delegationId?: string; own: boolean;
  openedBy?: string;
}

/** Only dispatch inside the internal capability gate: `from` and `fromThreadId` come from the caller's capability. */
export function createInternalThreadRoutes(deps: {
  store: Pick<Store, "bot" | "bots" | "tasks" | "taskByThread" | "appendMessage" | "patchTask" | "setTaskClosedBy">;
  coordinator: Pick<Coordinator, "awaitingAnswer" | "parkedDirect" | "activeDirect">;
  from: BotRecord;
  fromThreadId: string;
  ownsThread(botId: string, threadId: string): boolean;
  /** A turn that may use the lent Mac sees only owner-only conversations: a title is words too. */
  shown(threadId: string): boolean;
  threadBusy(botId: string, threadId: string): boolean;
  queuedThreadPosition(botId: string, threadId: string): number | null;
}): RouteHandler {
  const { store, coordinator, from, fromThreadId } = deps;
  return async ({ res, path, method, json }) => {
    // list_threads: the caller's own threads plus, on reachable peers, only threads it opened; a peer's other threads are its own business.
    if (method === "GET" && path === "/api/internal/threads") {
      if (!deps.ownsThread(from.id, fromThreadId)) {
        return json(res, 403, { error: "source conversation does not belong to sender" });
      }
      const rows: ThreadRow[] = [];
      const stateOf = (bot: BotRecord, task: TaskRecord) => {
        if (task.activity === "waiting-on-you" || coordinator.awaitingAnswer(task.threadId)) return "waiting-on-you" as const;
        if (deps.threadBusy(bot.id, task.threadId)) return "running" as const;
        if (coordinator.parkedDirect(task.threadId)) return "waiting-on-you" as const;
        if (deps.queuedThreadPosition(bot.id, task.threadId) !== null) return "queued" as const;
        if (coordinator.activeDirect(task.threadId)) return "queued" as const;
        if (task.closedBy) return "closed" as const;
        return "idle" as const;
      };
      for (const task of store.tasks(from.id)) {
        if (!deps.shown(task.threadId)) continue;
        rows.push({
          threadId: task.threadId, botId: from.id, botName: from.name, title: task.title,
          state: stateOf(from, task), unread: task.unread === true, openedAt: task.openedBy?.at ?? task.createdAt,
          delegationId: task.openedBy?.delegationId, own: true,
        });
      }
      for (const peer of reachablePeers(store.bots, from)) {
        for (const task of store.tasks(peer.id)) {
          const opener = task.openedBy;
          if (!opener || !deps.shown(task.threadId)) continue;
          const mine = opener.botId === from.id;
          if (!mine && !chiefTidies(from, task, store.bot(opener.botId), peer)) continue;
          rows.push({
            threadId: task.threadId, botId: peer.id, botName: peer.name, title: task.title,
            state: stateOf(peer, task), unread: task.unread === true, openedAt: opener.at,
            delegationId: opener.delegationId, own: false,
            ...(mine ? {} : { openedBy: opener.name }),
          });
        }
      }
      rows.sort((a, b) => b.openedAt - a.openedAt);
      return json(res, 200, { threads: rows.slice(0, 100) });
    }
    // close_thread folds a thread, never deletes it (a person's confirmed action), and never while it runs.
    const closeMatch = method === "POST" ? path.match(/^\/api\/internal\/threads\/([\w-]+)\/close$/) : null;
    if (!closeMatch) return PASS;
    if (!deps.ownsThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    const threadId = closeMatch[1]!;
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
      return json(res, 200, { closed: true, alreadyClosed: true, threadId, title: task.title, botName: owner.name, closedBy: task.closedBy.name });
    }
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: from.id, name: from.name, color: from.color },
      tool: { name: `Closed by @${from.name}`, ok: true },
    });
    if (task.unread) store.patchTask(owner.id, threadId, { unread: false });
    store.setTaskClosedBy(owner.id, threadId, { botId: from.id, name: from.name, at: Date.now() });
    return json(res, 200, { closed: true, threadId, title: task.title, botName: owner.name });
  };
}

// retry_thread: a Chief resumes a teammate's broken thread (incidents).
// Body moved from the monolithic index.ts handler; the dispatch chain in
// ../internal.ts owns order.
import type { ServerResponse } from "node:http";

import { canAccessTeam, peerAllowed } from "../../peer-roster.ts";
import { queuedThreadPosition } from "../../steer-queue.ts";
import type { InternalRoutesOptions } from "../internal.ts";
import type { InternalRequestCtx } from "./types.ts";

export type RetryThreadCtx = InternalRequestCtx & {
  store: InternalRoutesOptions["store"];
  startTurn: InternalRoutesOptions["startTurn"];
  threadBusy: InternalRoutesOptions["threadBusy"];
  isUnattended: InternalRoutesOptions["isUnattended"];
};

// A Chief resumes a teammate's broken thread (server/incidents.ts): the
// same thread, its conversation and files, one more turn, with a line
// saying who asked and why. Chief-only, for a teammate it can reach,
// never a room (coordinate there) and never a thread still running.
export async function retryThread(ctx: RetryThreadCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, startTurn, threadBusy, isUnattended,
    internalCapability, internalSender, json, readInternalBody, requireActiveInternalCapability,
  } = ctx;
  const body = await readInternalBody();
  const from = internalSender;
  const fromThreadId = internalCapability.threadId;
  if (!from.chiefOfStaff || from.hidden) return json(res, 403, { error: "only a Chief of Staff can retry a teammate's thread" });
  // `toBotId`/`toThreadId`: the guard above reads bare botId/threadId as
  // the caller's own identity, the way every internal route does.
  const botId = typeof body.toBotId === "string" ? body.toBotId : "";
  const threadId = typeof body.toThreadId === "string" ? body.toThreadId : "";
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
  const target = store.bot(botId);
  if (!target || target.id === from.id) return json(res, 404, { error: "no such teammate" });
  if (target.hidden || !canAccessTeam(from, target.section) || !peerAllowed(from, target.id)) {
    return json(res, 403, { error: "that bot is not on this Chief's team \u2014 call list_bots for the ones you can reach" });
  }
  if (store.groupByThread(threadId)) return json(res, 400, { error: "that is a room thread \u2014 use coordinate_bots in the room instead" });
  const task = store.taskByThread(target.id, threadId);
  if (!task) return json(res, 404, { error: "no such thread on that bot" });
  if (threadBusy(target.id, threadId) || queuedThreadPosition(target.id, threadId) !== null) {
    return json(res, 409, { error: "that thread is still running \u2014 wait for it to settle before retrying" });
  }
  requireActiveInternalCapability();
  const unattended = isUnattended(from.id, fromThreadId);
  const text = `[Retry requested by ${from.name}, your Chief of Staff, after this thread's last run stopped.${note ? ` Note from ${from.name}: ${note}` : ""} Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]`;
  try {
    await startTurn(target.id, text, { threadId, unattended, peerAsk: { botId: from.id, name: from.name, ...(unattended ? { unattended: true } : {}) } });
  } catch (error) {
    return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
  }
  store.appendMessage(fromThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Retried ${target.name}'s thread #${task.title}`, ok: true },
    threadRef: { botId: target.id, threadId, title: task.title },
  });
  return json(res, 200, { started: true, message: `${target.name}'s thread #${task.title} is running again. Its result stays in that thread; you are not woken for it \u2014 check later with list_threads or session_search if you need to.` });
}

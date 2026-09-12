import { createHash } from "node:crypto";
import type { StudioAttention, StudioHandoff, StudioOutcome, StudioSnapshot, StudioThread } from "../shared/live-team.ts";
import { studioAttentionCounts, studioPendingCards, studioResults } from "./message-db.ts";
import { studioDelegationReceipts, studioPendingDelegations } from "./delegations.ts";
import { sectionKey, type Store } from "./store.ts";

export interface StudioRuntime {
  workspaceId: string;
  running: Array<{ id: string; sourceBotId: string; targetBotId: string; sourceThreadId: string; sourceMessageId?: string; targetThreadId: string; startedAt: number }>;
  speakers: Array<{ botId: string; threadId: string }>;
  queues: Record<string, Array<unknown>>;
  computerHelp: Array<{ botId: string; requestId: string }>;
}

/** Some drivers report a requested stop as exit_before_result. Preserve the
 * server's exact turn identity without changing provider lifecycle semantics. */
export class StudioTurnOutcomes {
  private active = new Map<string, string>();
  private stopped = new Set<string>();
  /** Track the active turn so a stop applies to its exact terminal receipt. */
  start(threadId: string, turnId: string): void {
    this.active.set(threadId, turnId);
    // Bound metadata if a driver disappears without a terminal event.
    while (this.active.size > 2000) this.active.delete(this.active.keys().next().value!);
  }
  /** Remember an explicit stop even when the provider reports a generic failure. */
  interrupt(threadId: string): void {
    const turnId = this.active.get(threadId);
    if (!turnId) return;
    this.stopped.add(`${threadId}:${turnId}`);
    while (this.stopped.size > 2000) this.stopped.delete(this.stopped.values().next().value!);
  }
  /** Consume stop metadata without misclassifying a later turn or a successful race. */
  finish(threadId: string, turnId: string, ok: boolean, stopReason?: string | null): StudioOutcome {
    const key = `${threadId}:${turnId}`;
    const requested = this.stopped.delete(key);
    if (this.active.get(threadId) === turnId) this.active.delete(threadId);
    return ok ? "completed" : requested || stopReason === "interrupted" || stopReason === "cancelled" ? "interrupted" : "failed";
  }
}

/** Validate a bounded nonnegative offset supplied by the studio client. */
function offset(query: URLSearchParams, key: string): number {
  const value = Number(query.get(key) ?? 0);
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) throw new Error(`Invalid ${key}. Use a whole number from 0 to 100000.`);
  return value;
}

/** Project metadata only. All content is opened through the existing authorized routes. */
export function buildStudioSnapshot(store: Store, runtime: StudioRuntime, query: URLSearchParams): StudioSnapshot {
  const bots = store.bots.filter((bot) => !bot.hidden);
  const visible = new Map(bots.map((bot) => [bot.id, bot]));
  const directOwners = new Map<string, string>();
  for (const bot of bots) for (const task of store.tasks(bot.id)) directOwners.set(task.threadId, bot.id);
  const groups = store.groups.filter((group) => group.memberIds.length > 0 && group.memberIds.every((id) => visible.has(id)));
  const groupThreads = new Map(groups.flatMap((group) => [...new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])].map((id) => [id, group] as const)));
  const roomIds = [...new Set(bots.map((bot) => sectionKey(bot.section)))];
  const requested = query.get("room");
  const room = requested !== null && roomIds.includes(requested) ? requested : roomIds[0] ?? "";
  const roomBots = bots.filter((bot) => sectionKey(bot.section) === room);
  const roomBotIds = new Set(roomBots.map((bot) => bot.id));
  const threadsFor = (section: string) => [
    ...[...directOwners].filter(([, id]) => sectionKey(visible.get(id)?.section) === section).map(([id]) => id),
    ...[...groupThreads].filter(([, group]) => sectionKey(group.section) === section).map(([id]) => id),
  ];
  const threads = threadsFor(room);
  const allowedThreads = new Set(threads);
  const counts = studioAttentionCounts(threads);
  const attentionBotId = query.get("attentionBotId") || undefined;
  if (attentionBotId && !visible.has(attentionBotId)) throw new Error("Invalid attentionBotId.");
  const roomHelp = runtime.computerHelp.filter((entry) => roomBotIds.has(entry.botId));
  const help = roomHelp.filter((entry) => !attentionBotId || entry.botId === attentionBotId);
  const rooms = roomIds.map((id) => ({ id, botIds: bots.filter((bot) => sectionKey(bot.section) === id).map((bot) => bot.id),
    attentionCount: studioPendingCards(threadsFor(id), 0, 1).total + runtime.computerHelp.filter((entry) => sectionKey(visible.get(entry.botId)?.section) === id && visible.has(entry.botId)).length,
  }));
  const attentionOffset = offset(query, "attentionOffset");
  const attentionThreads = attentionBotId ? threads.filter((threadId) => directOwners.get(threadId) === attentionBotId || groupThreads.get(threadId)?.memberIds.includes(attentionBotId)) : threads;
  const cards = studioPendingCards(attentionThreads, attentionOffset, 50, attentionBotId);
  const attention: StudioAttention[] = cards.items.flatMap((card) => {
    const botId = directOwners.get(card.threadId) ?? card.botId;
    if (!botId || !visible.has(botId)) return [];
    return [{ id: `${card.threadId}:${card.requestId}`, botId, threadId: card.threadId, messageId: card.messageId,
      requestId: card.requestId, at: card.at, kind: card.tool ? "approval" : "question" }];
  });
  // Help follows provider cards in the same paginated collection.
  const helpStart = Math.max(0, attentionOffset - cards.total);
  if (attention.length < 50) for (const entry of help.slice(helpStart, helpStart + 50 - attention.length)) {
    const bot = visible.get(entry.botId)!;
    attention.push({ id: `computer:${entry.botId}:${entry.requestId}`, botId: bot.id, threadId: bot.threadId,
      requestId: entry.requestId, at: 0, kind: "computer" });
  }
  const resultsOffset = offset(query, "resultsOffset");
  // Authorize current owners before pagination so stale receipts cannot consume slots.
  const resultOwners = threads.flatMap((threadId) => {
    const owner = directOwners.get(threadId);
    const botIds = new Set([...(owner ? [owner] : []), ...(groupThreads.get(threadId)?.memberIds ?? [])]);
    return [...botIds].map((botId) => ({ threadId, botId }));
  });
  const resultPage = studioResults(resultOwners, resultsOffset);
  const results = resultPage.items;
  const handoffs = new Map<string, StudioHandoff>();
  for (const receipt of studioDelegationReceipts()) {
    const sourceBotId = directOwners.get(receipt.sourceThreadId) ?? receipt.sourceBotId;
    if (!sourceBotId || !visible.has(sourceBotId) || !visible.has(receipt.toBotId) || !allowedThreads.has(receipt.sourceThreadId)) continue;
    handoffs.set(receipt.id, { id: receipt.id, sourceBotId, targetBotId: receipt.toBotId, sourceThreadId: receipt.sourceThreadId, sourceMessageId: receipt.sourceMessageId, targetThreadId: receipt.targetThreadId,
      state: receipt.status === "done" ? "completed" : receipt.status === "denied" ? "denied" : receipt.status === "dropped" ? "dropped" : "failed", at: receipt.finishedAt });
  }
  for (const item of studioPendingDelegations()) {
    if (!visible.has(item.sourceBotId) || !visible.has(item.toBotId) || !allowedThreads.has(item.sourceThreadId)) continue;
    handoffs.set(item.id, { id: item.id, sourceBotId: item.sourceBotId, targetBotId: item.toBotId, sourceThreadId: item.sourceThreadId,
      targetThreadId: item.targetThreadId, sourceMessageId: item.sourceMessageId, state: "queued", at: item.queuedAt ?? 0 });
  }
  for (const item of runtime.running) {
    if (!visible.has(item.sourceBotId) || !visible.has(item.targetBotId) || !allowedThreads.has(item.sourceThreadId)) continue;
    handoffs.set(item.id, { id: item.id, sourceBotId: item.sourceBotId, targetBotId: item.targetBotId, sourceThreadId: item.sourceThreadId, sourceMessageId: item.sourceMessageId, targetThreadId: item.targetThreadId, state: "running", at: item.startedAt });
  }
  const handoffItems = [...handoffs.values()].sort((a, b) => {
    const priority = (value: StudioHandoff) => value.state === "running" ? 0 : value.state === "queued" ? 1 : 2;
    return priority(a) - priority(b) || b.at - a.at || a.id.localeCompare(b.id);
  });
  const handoffsOffset = offset(query, "handoffsOffset");
  const stations = roomBots.map((bot) => {
    const tasks = store.tasks(bot.id);
    const threads: StudioThread[] = tasks.filter((task) => task.busy || task.activity === "waiting-on-you" || runtime.queues[task.threadId]?.length)
      .map((task) => ({ threadId: task.threadId, title: task.title, busy: Boolean(task.busy), activity: task.activity ?? "idle", queued: runtime.queues[task.threadId]?.length ?? 0 }));
    for (const speaker of runtime.speakers.filter((entry) => entry.botId === bot.id)) {
      const group = groupThreads.get(speaker.threadId);
      if (group) threads.push({ threadId: speaker.threadId, title: group.name, busy: true,
        activity: attention.some((entry) => entry.threadId === speaker.threadId && entry.botId === bot.id) ? "waiting-on-you" : "working", queued: 0 });
    }
    const attentionCount = counts.reduce((total, entry) => total + ((directOwners.get(entry.threadId) ?? entry.botId) === bot.id ? entry.count : 0), 0) + roomHelp.filter((entry) => entry.botId === bot.id).length;
    return { botId: bot.id, threads: threads.slice(0, 50), threadCount: tasks.length, attentionCount };
  });
  const payload = { workspaceId: runtime.workspaceId, room, rooms, stations,
    attention: { items: attention, total: cards.total + help.length, offset: attentionOffset },
    results: { items: results.map((item) => ({ ...item, title: store.taskByThread(item.botId, item.threadId)?.title ?? item.title })), total: resultPage.total, offset: resultsOffset },
    handoffs: { items: handoffItems.slice(handoffsOffset, handoffsOffset + 50), total: handoffItems.length, offset: handoffsOffset } };
  return { ...payload, serverTime: Date.now(), revision: createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24) };
}

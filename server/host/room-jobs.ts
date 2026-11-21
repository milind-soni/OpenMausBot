import type { AppConfig } from "../config.ts";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import { peerDeliveryReceipt, type PeerDeliveryReceipt } from "../peer-delivery.ts";
import { peerName } from "../peer-roster.ts";
import { queuedJobDetail, roomQueue, sequentialRoomNotice, type RoomLineItem } from "../room-queue.ts";
import type { GroupRecord, Store } from "../store.ts";
import type { RoomQueueEntry } from "../../shared/wire.ts";

export interface RoomRoundLine { current?: string; pending: string[] }

export interface RoomJobsDeps {
  store: Store;
  // Read lazily: index.ts builds the coordinator after this module.
  coordinator: Pick<Coordinator, "active">;
  cfg: AppConfig;
  operations: (groupId: string) => Iterable<{ threadId: string; cancelled: boolean; botIds: ReadonlySet<string>; line?: RoomRoundLine }>;
  speakerOf: (threadId: string) => string | undefined;
  laneRoomThread: (n: Pick<HandoffView, "botId" | "threadId" | "groupId">) => string | undefined;
}

export function parallelRoomJobsEnabled(cfg: AppConfig): boolean {
  return cfg.features?.parallelRoomJobs !== false;
}

const live = (n: HandoffView) => n.parentId !== undefined && (n.status === "queued" || n.status === "running");

export function createRoomJobs({ store, coordinator, cfg, operations, speakerOf, laneRoomThread }: RoomJobsDeps) {
  /** Where a member runs now outside this room, if anywhere: a turn in another room, else a busy thread of its own.
   *  The host holds a room hand-off while the member runs (bot.busy), so a turn in another room that has not reached it yet is not busy. */
  function busyElsewhere(botId: string, roomId: string): RoomQueueEntry["busyIn"] {
    if (!store.bot(botId)?.busy) return undefined;
    for (const other of store.groups) {
      if (other.id === roomId) continue;
      const turn = [...operations(other.id)].find(operation => !operation.cancelled && operation.botIds.has(botId)
        && (operation.line?.current === botId || speakerOf(operation.threadId) === botId));
      if (turn) return { groupId: other.id, threadId: turn.threadId };
      if (other.busyBotId === botId || speakerOf(other.threadId) === botId) return { groupId: other.id, threadId: other.threadId };
    }
    const task = store.tasks(botId).find(candidate => candidate.busy);
    return task ? { threadId: task.threadId } : undefined;
  }

  function roomLineOf(record: GroupRecord): RoomQueueEntry[] {
    const items: RoomLineItem[] = [];
    for (const operation of operations(record.id)) {
      if (operation.cancelled || !operation.line) continue;
      const { current, pending } = operation.line;
      if (current) items.push({ botId: current, threadId: operation.threadId, state: "running" });
      for (const botId of pending) items.push({ botId, threadId: operation.threadId, state: "queued" });
    }
    const jobs = coordinator.active().filter(n => n.groupId === record.id && live(n)).sort((a, b) => a.createdAt - b.createdAt);
    for (const n of jobs) items.push({ botId: n.botId, threadId: n.threadId, state: n.status === "running" ? "running" : "queued", assignmentId: n.id });
    const speakers = new Map<string, string>();
    for (const threadId of new Set(items.map(item => item.threadId))) {
      const speaker = speakerOf(threadId);
      if (speaker) speakers.set(threadId, speaker);
    }
    return roomQueue(items, speakers).map(entry => {
      const busyIn = entry.state === "queued" ? busyElsewhere(entry.botId, record.id) : undefined;
      return busyIn ? { ...entry, busyIn } : entry;
    });
  }

  function advanceRound(operation: { line?: RoomRoundLine }, current: string | undefined, spoken: ReadonlySet<string>): boolean {
    if (!operation.line) return false;
    operation.line = { ...(current ? { current } : {}), pending: operation.line.pending.filter(id => id !== current && !spoken.has(id)) };
    return true;
  }

  function useLanes(room: GroupRecord, roomThreadId: string, jobs: number, mode: string): boolean {
    if (mode === "notify" || !parallelRoomJobsEnabled(cfg)) return false;
    return jobs > 1 || coordinator.active().some(n => live(n) && (n.groupId === room.id ? n.threadId === roomThreadId : laneRoomThread(n) === roomThreadId));
  }

  // A job running beside its room still follows the room's shared instructions.
  function laneBulletin(n: Pick<HandoffView, "botId" | "threadId" | "groupId">): string {
    const room = store.groupByThread(laneRoomThread(n) ?? "");
    const bulletin = room?.bulletin.trim();
    return room && bulletin ? `Room bulletin of "${room.name}" (shared instructions for everyone):\n${bulletin}` : "";
  }

  function openLane(room: GroupRecord, roomThreadId: string, botId: string, sender: { id: string; name: string }, brief: string) {
    const existing = store.workThread(botId, sender.id, roomThreadId, true);
    const snippet = brief.replace(/\s+/g, " ").trim().slice(0, 48);
    const task = existing ?? store.createTask(botId, `${room.name} · ${snippet || "room job"}`, false, undefined,
      { botId: sender.id, name: sender.name, threadId: roomThreadId, kind: "work", roomLane: true, at: Date.now() },
      undefined, undefined, store.pinGroupCwd(room.id, roomThreadId) ?? undefined);
    if (!task) throw new Error("The recipient no longer exists");
    return { threadId: task.threadId, title: task.title, created: !existing };
  }

  function describeRoomJobs(room: GroupRecord, roomThreadId: string, receipts: PeerDeliveryReceipt[],
    options: { senderId: string; returns: string; lanes: boolean; awaited: boolean }): string {
    const nameOf = (botId: string) => botId === options.senderId ? "your own turn" : peerName(store.bot(botId)?.name ?? "") || "a teammate";
    const line = roomLineOf(room).filter(entry => entry.threadId === roomThreadId);
    for (const [index, receipt] of receipts.entries()) {
      const entry = line.find(candidate => candidate.assignmentId === receipt.requestId && candidate.state === "queued");
      if (!entry || receipt.outcome !== "queued") continue;
      receipts[index] = peerDeliveryReceipt({ ...receipt, detail: `${queuedJobDetail(entry, nameOf)}; ${options.returns}`,
        queue: { position: entry.position, of: entry.of, ...(entry.waitingForBotId ? { waitingFor: nameOf(entry.waitingForBotId) } : {}) } });
    }
    const parallel = options.lanes && options.awaited
      ? "These run in parallel, each in a thread of its own beside this room; each posts its result card here when it finishes, and you resume once with all of them."
      : undefined;
    const sequential = sequentialRoomNotice(line, new Set(receipts.flatMap(receipt => receipt.requestId ? [receipt.requestId] : [])), nameOf);
    return [parallel, sequential].filter(Boolean).join(" ");
  }

  return { roomLineOf, advanceRound, useLanes, laneBulletin, openLane, describeRoomJobs };
}

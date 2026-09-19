import type { RoomHandoff, RoomHandoffHooks } from "./room-handoffs.ts";
import type { Store } from "./store.ts";
import type { BotRecord, GroupRecord } from "./store/records.ts";
import type { WireBot, WireGroup } from "../shared/wire.ts";

type HandoffRef = Pick<RoomHandoff, "groupId" | "threadId" | "botId"> & Partial<Pick<RoomHandoff, "kind">>;

/** The subset of the group-turn operation the handoff run path drives. */
export interface GroupTurnOperationLike {
  cancelled: boolean;
  cancellation: AbortController;
}

type GroupTurnResult = { replyText?: string; outcome?: string; stopReason?: string | null };

interface GroupTurnOrchestrationLike {
  roomHandoffId?: string;
  resumed?: boolean;
  systemInstructions: string;
  turnInstructions?: string;
  followMentions: boolean;
  result: GroupTurnResult;
}

interface StartTurnOptions {
  threadId?: string;
  cardContinuation?: boolean;
  commsDepth?: number;
  unattended?: boolean;
  coordination?: { id: string; resumed: boolean; settle: (outcome: { ok: boolean; text: string }) => void };
  onDispatchError?: (message: string) => void;
}

export interface RoomHandoffWiringDeps {
  store: Store;
  threadBusy(botId: string, threadId: string): boolean;
  botAtThreadCapacity(botId: string): boolean;
  maxCommsDepth: number;
  groupQueues: Map<string, Promise<void>>;
  roomHandoffProblem(node: HandoffRef, parent?: HandoffRef): string | undefined;
  coordinationSystemInstructions(): string;
  coordinationTurnText(node: RoomHandoff, resumed: boolean): string;
  fullAccessForSource(botId: string, threadId: string): boolean;
  groupIsWorking(group: GroupRecord): boolean;
  publicGroupState(group: GroupRecord): WireGroup;
  wireBot(bot: BotRecord): WireBot;
  /** Zero-arg thunks: their index.ts bindings are consts initialized after this wiring runs. */
  broadcast(): (payload: Record<string, unknown>) => void;
  roomHandoffs(): { nodes: Map<string, RoomHandoff> };
  drainQueuedSends(): void;
  markTaskContextExternallyUpdated(bot: BotRecord, threadId: string): void;
  markInternalTurn(threadId: string): void;
  isUnattended(botId?: string | null, threadId?: string): boolean;
  markUnattended(botId: string, threadId: string): void;
  startTurn(botId: string, text: string, opts?: StartTurnOptions): Promise<unknown>;
  beginGroupTurnOperation(groupId: string, threadId: string, botIds?: Iterable<string>): GroupTurnOperationLike;
  finishGroupTurnOperation(groupId: string, operation: GroupTurnOperationLike): void;
  waitForChatRoomMember(operation: GroupTurnOperationLike, threadId: string, bot: BotRecord): Promise<"run" | "skip" | "stop">;
  runGroupMemberTurn(
    groupId: string,
    threadId: string,
    botId: string,
    hop: number,
    spoken?: Set<string>,
    cardContinuation?: string,
    onDispatchError?: (message: string) => void,
    isCancelled?: () => boolean,
    onProviderHandshakeStarted?: () => void,
    onProviderHandshakeSettled?: () => void,
    skillAuthoringClaim?: { claimed: boolean },
    orchestration?: GroupTurnOrchestrationLike,
    operation?: GroupTurnOperationLike,
  ): Promise<boolean>;
  groupProviderHandshakeStarted(operation: GroupTurnOperationLike): void;
  groupProviderHandshakeSettled(operation: GroupTurnOperationLike): void;
  interruptDirectThread(botId: string, threadId: string): Promise<void>;
}

export function roomHandoffHandlers(deps: RoomHandoffWiringDeps): RoomHandoffHooks {
  const {
    store, threadBusy, botAtThreadCapacity, maxCommsDepth: MAX_COMMS_DEPTH, groupQueues,
    roomHandoffProblem, coordinationSystemInstructions, coordinationTurnText, fullAccessForSource,
    groupIsWorking, publicGroupState, wireBot, drainQueuedSends, markTaskContextExternallyUpdated,
    markInternalTurn, isUnattended, markUnattended, startTurn, beginGroupTurnOperation,
    finishGroupTurnOperation, waitForChatRoomMember, runGroupMemberTurn,
    groupProviderHandshakeStarted, groupProviderHandshakeSettled, interruptDirectThread,
  } = deps;
  const roomHandoffs = deps.roomHandoffs;
  const broadcast = (payload: Record<string, unknown>) => deps.broadcast()(payload);
  return {
    validate: (node, parent) => roomHandoffProblem(node, parent) ??
      (parent && store.bot(parent.botId)?.approvePeerComms && !fullAccessForSource(parent.botId, parent.threadId) && !node.approvalGranted ? "Sender now requires peer approval; submit a new approved request" : undefined),
    // A direct follow-up is owed to one conversation, so it waits for that
    // conversation, not for the whole bot. Bot-level busy aggregates every
    // thread — including cards still waiting on the person — so one busy
    // sibling thread would otherwise starve the owed resume forever while the
    // UI keeps showing this thread working. Fresh work still queues behind a
    // busy teammate's whole bot (#1238); an owed resume only needs its own
    // thread free and a thread slot to admit it.
    busy: n => !n.groupId && n.status === "resume"
      ? threadBusy(n.botId, n.threadId) || botAtThreadCapacity(n.botId)
      : Boolean(store.bot(n.botId)?.busy || (n.groupId && store.group(n.groupId) && groupIsWorking(store.group(n.groupId)!))),
    changed: (groupIds, directThreadIds) => {
      for (const id of groupIds) {
        const group = store.group(id);
        if (group) broadcast({ kind: "group", group: publicGroupState(group) });
      }
      for (const threadId of directThreadIds) {
        const bot = store.botByThread(threadId);
        if (bot) broadcast({ kind: "bot", bot: wireBot(bot) });
      }
      // #1194: when a direct coordination's last node settles, no later
      // turn.completed arrives to release messages parked behind it — the
      // resume turn's own event lands while the source node is still
      // non-terminal. Node changes are that release signal.
      if (directThreadIds.size > 0) drainQueuedSends();
    },
    report: (child, parent) => {
      // Same-room replies already appear in this conversation.
      if (child.kind === "assignment" && child.status === "completed") return;
      const group = parent.groupId ? store.group(parent.groupId) : undefined;
      if (parent.groupId ? !group || !store.groupTaskByThread(group.id, parent.threadId) : !store.taskByThread(parent.botId, parent.threadId)) return;
      const bot = store.bot(child.botId);
      if (store.messagesFor(parent.threadId).some(m => m.roomRequest?.id === child.id && m.roomRequest.phase === "result")) return;
      const problem = roomHandoffProblem(child, parent);
      store.appendMessage(parent.threadId, {
        role: "bot", kind: "activity",
        roomRequest: { id: child.id, phase: "result" },
        from: bot ? { botId: bot.id, name: bot.name, color: bot.color } : undefined,
        tool: {
          name: problem ? `Result withheld: ${problem}`
            : child.status === "completed" ? `${bot?.name ?? "Teammate"} replied${child.groupId ? ` · ${store.group(child.groupId)?.name ?? "Room"}` : ""}`
          : `${bot?.name ?? "Teammate"} — ${child.status}: ${child.result.slice(0, 180)}`,
          ok: child.status === "completed" && !problem,
        },
        ...(child.groupId ? { comm: { groupId: child.groupId, threadId: child.threadId, withBotId: child.botId,
          withName: bot?.name ?? "Teammate", withColor: bot?.color ?? "blue" } }
          : { threadRef: { botId: child.botId, threadId: child.threadId, title: store.taskByThread(child.botId, child.threadId)?.title ?? "Teammate work" } }),
      });
      if (group) store.patchGroup(group.id, { unread: true });
      else {
        store.patchTask(parent.botId, parent.threadId, { unread: true });
        const source = store.bot(parent.botId);
        if (source) markTaskContextExternallyUpdated(source, parent.threadId);
      }
      // A work thread exists only because the pair conversation was busy with
      // another job. Its result is now in the sender's conversation, so it
      // closes itself exactly as close_thread would — folded out of the
      // sidebar, never deleted, and open again the moment anyone speaks
      // there. A finished job tidies up after itself; a failed or withheld
      // one stays in the sidebar where the person can see it. The pair
      // conversation is the standing line between two bots and never
      // auto-closes.
      const childTask = store.taskByThread(child.botId, child.threadId);
      if (!child.groupId && child.status === "completed" && !problem && !childTask?.closedBy
        && childTask?.openedBy?.kind === "work" && childTask.openedBy.botId === parent.botId) {
        store.setTaskClosedBy(child.botId, child.threadId,
          { botId: parent.botId, name: store.bot(parent.botId)?.name ?? childTask.openedBy.name, at: Date.now() });
      }
    },
    run: async (node, resumed, signal) => {
      const group = node.groupId ? store.group(node.groupId) : undefined;
      const bot = store.bot(node.botId)!;
      const parent = node.parentId ? roomHandoffs().nodes.get(node.parentId) : undefined;
      const sender = parent ? store.bot(parent.botId) : undefined;
      const result: GroupTurnResult = {};
      const turnText = coordinationTurnText(node, resumed);
      const systemInstructions = coordinationSystemInstructions();
      if (!resumed && !store.messagesFor(node.threadId).some(m => m.roomRequest?.id === node.id && m.roomRequest.phase === "request")) {
        store.appendMessage(node.threadId, { role: "bot", kind: "text",
          roomRequest: { id: node.id, phase: "request" },
          from: sender ? { botId: sender.id, name: sender.name, color: sender.color } : undefined,
          text: `@${bot.name} ${node.text}`,
        });
      }
      markInternalTurn(node.threadId);
      if (sender && parent && isUnattended(sender.id, parent.threadId)) markUnattended(bot.id, node.threadId);
      if (!group) return new Promise<{ ok: boolean; text: string }>(resolve => {
        let done = false;
        const finish = (outcome: { ok: boolean; text: string }) => {
          if (done) return;
          done = true; signal.removeEventListener("abort", abort); resolve(outcome);
        };
        const abort = () => {
          void interruptDirectThread(bot.id, node.threadId).catch(() => {});
          finish({ ok: false, text: "Coordinated work was stopped" });
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        void startTurn(bot.id, turnText, {
          threadId: node.threadId, cardContinuation: true, commsDepth: MAX_COMMS_DEPTH,
          unattended: isUnattended(bot.id, node.threadId),
          coordination: { id: node.id, resumed, settle: finish },
          onDispatchError: error => finish({ ok: false, text: error }),
        }).catch(error => finish({ ok: false, text: String(error) }));
      });
      const operation = beginGroupTurnOperation(group.id, node.threadId, [bot.id]);
      const abort = () => { operation.cancelled = true; operation.cancellation.abort(); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const run = (groupQueues.get(group.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (operation.cancelled) return;
        const problem = roomHandoffProblem(node, parent);
        if (problem) throw new Error(problem);
        const available = await waitForChatRoomMember(operation, node.threadId, bot);
        if (available !== "run") { result.outcome = "cancelled"; return; }
        await runGroupMemberTurn(group.id, node.threadId, bot.id, MAX_COMMS_DEPTH, new Set(),
          undefined, error => { result.stopReason = error; }, () => operation.cancelled,
          () => groupProviderHandshakeStarted(operation), () => groupProviderHandshakeSettled(operation),
          { claimed: true }, { roomHandoffId: node.id, resumed, systemInstructions, turnInstructions: turnText, followMentions: false, result }, operation);
      });
      const tracked = run.finally(() => {
        signal.removeEventListener("abort", abort);
        finishGroupTurnOperation(group.id, operation);
      });
      groupQueues.set(group.id, tracked.catch(() => {}));
      await tracked;
      return { ok: result.outcome === "settled", text: result.stopReason || result.replyText || result.outcome || "The addressed agent could not run" };
    },
  };
}

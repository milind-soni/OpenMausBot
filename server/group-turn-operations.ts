// The group-turn operation machinery — extracted verbatim from index.ts:
// the operation lifecycle (beginGroupTurnOperation/finishGroupTurnOperation),
// the goal-run card projection (finishGroupGoalRun/updateGroupGoalRunProgress),
// the member-availability waits (waitForGroupMemberBot/waitForChatRoomMember),
// cancellation (cancelGroupTurnOperations), the provider-handshake flags and
// activeGroupTurnForBot. updateGroupGoalRunProgress and
// groupProviderHandshakeStarted touch only imported module state, so they are
// plain exports; the rest read index.ts values and live behind
// createGroupTurnOperations(deps), which index.ts wires ahead of
// createCheckedInputs — the earliest by-value consumer of activeGroupTurnForBot
// — with thunks for every const index.ts declares after that site (broadcast,
// the cancelled-handshake marks, pendingDelegationWakes, commsBus,
// groupSpeakers, GROUP_GOAL_WAIT_MAX_MS, routines, roomHandoffs and the
// deferred-resume/queued-send drains).
import { randomUUID } from "node:crypto";
import type { GroupGoalRunCardData, GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import type { WireGroup } from "../shared/wire.ts";
import type { CommsBus } from "./comms-visibility.ts";
import type { PendingDelegationWake } from "./delegation-watch.ts";
import { discardDelegations } from "./delegations.ts";
import { groupTurnOperations } from "./group-coordination.ts";
import type { GroupTurnOperation } from "./group-turn.ts";
import { buildNotification, type Notification } from "./notify.ts";
import { redactSecretsInText } from "./redact.ts";
import type { RoomHandoffs } from "./room-handoffs.ts";
import { store } from "./runtime.ts";
import type { RoutineManager, RoutineRun } from "./routines.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";
export function updateGroupGoalRunProgress(operation: GroupTurnOperation, detail: string): void {
  const run = operation.goalRun;
  if (!run || run.finished) return;
  const safeDetail = redactSecretsInText(detail.trim()).slice(0, 500);
  const current = store.messagesFor(operation.threadId).find((message) => message.id === run.cardMessageId);
  if (current?.goalRun?.status === "working" && current.goalRun.detail === safeDetail) return;
  store.patchMessage(operation.threadId, run.cardMessageId, {
    text: `Goal in progress: ${safeDetail || redactSecretsInText(run.goal)}`,
    goalRun: {
      runId: run.runId,
      goal: redactSecretsInText(run.goal),
      status: "working",
      coordinatorBotId: run.coordinatorBotId,
      coordinatorName: redactSecretsInText(run.coordinatorName),
      turnCount: run.turnCount,
      maxTurns: run.maxTurns,
      ...(safeDetail ? { detail: safeDetail } : {}),
      startedAt: run.startedAt,
    },
  });
}

type GroupMemberBotAvailability = "ready" | "busy" | "unavailable" | "cancelled" | "timed_out";
type GroupMemberBotWaitResult = Exclude<GroupMemberBotAvailability, "busy">;

function groupMemberBotAvailability(botId: string, operation: GroupTurnOperation): GroupMemberBotAvailability {
  if (operation.cancelled || operation.cancellation.signal.aborted) return "cancelled";
  const bot = store.bot(botId);
  if (!bot || bot.hidden) return "unavailable";
  return bot.busy ? "busy" : "ready";
}

export function groupProviderHandshakeStarted(operation: GroupTurnOperation): void {
  operation.providerHandshakePending = true;
}
/** Everything the operation machinery reads from its host. The lateBound
 * family holds thunks for the values index.ts binds after the factory is
 * wired; the helpers are hoisted functions index.ts owns, safe to pass by
 * value. */
export interface GroupTurnOperationsDeps {
  lateBound: {
    broadcast(payload: Record<string, unknown>): void;
    GROUP_GOAL_WAIT_MAX_MS(): number;
    routines(): RoutineManager | null;
    pendingDelegationWakes(): Map<string, PendingDelegationWake>;
    commsBus(): CommsBus;
    groupSpeakers(): Map<string, { botId: string; name: string; color: string }>;
    cancelTeamSetupResumesForThread(threadId: string): void;
    roomHandoffs(): RoomHandoffs;
    drainQueuedChannelSends(): void;
    markCancelledProviderHandshake(threadId: string, ownerId: string): void;
    clearCancelledProviderHandshake(threadId: string, ownerId: string): void;
  };
  helpers: {
    publicGroupState(group: GroupRecord): WireGroup;
    notify(notification: Notification | null): void;
    routineSourceOwner(run: Pick<RoutineRun, "botId" | "sourceThreadId" | "resultsThreadId">): { bot: BotRecord } | null;
    routineSourceThread(run: RoutineRun): string | null;
  };
}

export function createGroupTurnOperations(deps: GroupTurnOperationsDeps) {
  const broadcast = (payload: Record<string, unknown>) => deps.lateBound.broadcast(payload);
  const GROUP_GOAL_WAIT_MAX_MS = () => deps.lateBound.GROUP_GOAL_WAIT_MAX_MS();
  const routines = () => deps.lateBound.routines();
  const pendingDelegationWakes = () => deps.lateBound.pendingDelegationWakes();
  const commsBus = () => deps.lateBound.commsBus();
  const groupSpeakers = () => deps.lateBound.groupSpeakers();
  const cancelTeamSetupResumesForThread = (threadId: string) => deps.lateBound.cancelTeamSetupResumesForThread(threadId);
  const roomHandoffs = () => deps.lateBound.roomHandoffs();
  const drainQueuedChannelSends = () => deps.lateBound.drainQueuedChannelSends();
  const { markCancelledProviderHandshake, clearCancelledProviderHandshake } = deps.lateBound;
  const { publicGroupState, notify, routineSourceOwner, routineSourceThread } = deps.helpers;
function beginGroupTurnOperation(
  groupId: string,
  threadId: string,
  botIds: Iterable<string> = [],
): GroupTurnOperation {
  const operation = {
    id: randomUUID(),
    threadId,
    botIds: new Set(botIds),
    cancelled: false,
    cancellation: new AbortController(),
    providerHandshakePending: false,
  };
  const operations = groupTurnOperations.get(groupId) ?? new Set<GroupTurnOperation>();
  operations.add(operation);
  groupTurnOperations.set(groupId, operations);
  const group = store.group(groupId);
  if (group) broadcast({ kind: "group", group: publicGroupState(group) });
  return operation;
}

function finishGroupTurnOperation(groupId: string, operation: GroupTurnOperation) {
  if (operation.goalRun && !operation.goalRun.finished) {
    finishGroupGoalRun(groupId, operation, "failed", "The team run ended before the lead reported an outcome.");
  }
  clearCancelledProviderHandshake(operation.threadId, `group:${operation.id}`);
  const operations = groupTurnOperations.get(groupId);
  operations?.delete(operation);
  if (operations?.size === 0) groupTurnOperations.delete(groupId);
  const group = store.group(groupId);
  if (group) broadcast({ kind: "group", group: publicGroupState(group) });
  // A follow-up sent while this operation was running belongs to the
  // harness, not whichever composer happened to be mounted. Hand the next
  // one to the ordinary channel runner as soon as the channel is truly idle.
  drainQueuedChannelSends();
}

function finishGroupGoalRun(
  groupId: string,
  operation: GroupTurnOperation,
  status: Exclude<GroupGoalRunStatus, "working">,
  detail: string,
): void {
  const run = operation.goalRun;
  if (!run || run.finished) return;
  run.finished = true;
  const finishedAt = Date.now();
  const safeDetail = redactSecretsInText(detail.trim()).slice(0, 500);
  const card: GroupGoalRunCardData = {
    runId: run.runId,
    goal: redactSecretsInText(run.goal),
    status,
    coordinatorBotId: run.coordinatorBotId,
    coordinatorName: redactSecretsInText(run.coordinatorName),
    turnCount: run.turnCount,
    maxTurns: run.maxTurns,
    detail: safeDetail,
    startedAt: run.startedAt,
    finishedAt,
  };
  // A calendar-triggered team goal reuses its RoutineRun id for this card.
  // Manual goals have unrelated ids, so the manager safely ignores them.
  const routineRun = routines()?.finishGoalRun(run.runId, status, safeDetail);
  if (routineRun?.status === "cancelled") {
    pendingDelegationWakes().delete(operation.threadId);
    discardDelegations(commsBus(), operation.threadId);
  }
  // Member-level turn completions are intentionally private/intermediate for
  // a team goal, so the normal direct-routine notification path never fires.
  // Notify once from the correlated terminal receipt instead.
  // A scheduled team goal that stops to ask is the one outcome a person
  // most needs to hear about — it must never be filed as a quiet completion.
  if (routineRun?.status === "waiting") {
    const coordinator = store.bot(routineRun.botId);
    if (coordinator) {
      const notificationBot = routineSourceOwner(routineRun)?.bot ?? coordinator;
      notify(buildNotification(
        "question",
        notificationBot,
        routineSourceThread(routineRun) ?? routineRun.threadId ?? operation.threadId,
        safeDetail || `${routineRun.routineName} needs your input`,
        { avatarUrl: notificationBot.avatarUrl },
      ));
    }
  }
  if (routineRun?.status === "completed") {
    const coordinator = store.bot(routineRun.botId);
    if (coordinator) {
      const notificationBot = routineSourceOwner(routineRun)?.bot ?? coordinator;
      notify(buildNotification(
        "done",
        notificationBot,
        routineSourceThread(routineRun) ?? routineRun.threadId ?? operation.threadId,
        safeDetail || routineRun.routineName,
        { avatarUrl: notificationBot.avatarUrl },
      ));
    }
  }
  const group = store.group(groupId);
  const ownsThread = group?.dm
    ? group.threadId === operation.threadId
    : Boolean(group && store.groupTaskByThread(group.id, operation.threadId));
  if (!ownsThread) return;
  const fallbackState = status === "completed"
    ? "completed"
    : status === "needs-input"
      ? "needs your input"
      : status === "limit-reached"
        ? "reached its limit"
        : status;
  store.patchMessage(operation.threadId, run.cardMessageId, {
    text: `Goal ${fallbackState}: ${card.detail || card.goal}`,
    goalRun: card,
  });
}

/** A room is patient with a member's work already in progress: a busy bot
 * is woken later, never dropped. Goal runs and ordinary chat rounds share
 * this wait; only the note they leave differs (`onWaiting` fires once, when
 * the wait actually begins). Store changes are the wake-up signal, so waiting
 * consumes neither a model turn nor a polling loop. The operation's abort
 * signal lets the room Stop button release the listener immediately without
 * touching the unrelated turn that owns bot.busy. While it waits, the bot is
 * not part of this operation: its own Stop button must keep reaching the
 * conversation it is actually in. */
async function waitForGroupMemberBot(
  bot: BotRecord,
  operation: GroupTurnOperation,
  onWaiting: (detail: string) => void,
): Promise<GroupMemberBotWaitResult> {
  operation.botIds.delete(bot.id);
  const initial = groupMemberBotAvailability(bot.id, operation);
  if (initial !== "busy") return initial;
  onWaiting(`${bot.name} is finishing another conversation.`);

  return await new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (availability: GroupMemberBotWaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(waitCap);
      unsubscribe();
      operation.cancellation.signal.removeEventListener("abort", onAbort);
      resolve(availability);
    };
    // unref'd: a parked room must never keep the process alive on its own
    const waitCap = setTimeout(() => finish("timed_out"), GROUP_GOAL_WAIT_MAX_MS());
    waitCap.unref?.();
    const check = () => {
      const availability = groupMemberBotAvailability(bot.id, operation);
      if (availability !== "busy") finish(availability);
    };
    const onAbort = () => finish("cancelled");
    unsubscribe = store.onChange((change) => {
      if (
        (change.type === "bot" && change.botId === bot.id) ||
        (change.type === "bot.deleted" && change.botId === bot.id)
      ) {
        check();
      }
    });
    operation.cancellation.signal.addEventListener("abort", onAbort, { once: true });
    // Close the read→subscribe race: the bot may have settled between the
    // initial check and listener registration.
    check();
  });
}

/** Ordinary chat rounds share the goal wait, with the room's own notes: one
 * neutral chip when the wait begins (the transcript's promise that the member
 * replies here when free), rewritten in place if the cap runs out so the
 * promise never outlives the truth. `ok` stays undefined while waiting on
 * purpose — this is neither a failure nor a finished step, and the live label
 * reads `spoken` while the chip is the newest thing in the room. Stop leaves
 * nothing extra behind: the round simply ends. */
async function waitForChatRoomMember(
  operation: GroupTurnOperation,
  threadId: string,
  bot: BotRecord,
): Promise<"run" | "skip" | "stop"> {
  const waitTool = {
    name: `${bot.name} is finishing another conversation — will reply here when free`,
    spoken: `${bot.name} is finishing another conversation`,
  };
  let waitChip: Message | undefined;
  const availability = await waitForGroupMemberBot(bot, operation, () => {
    waitChip = store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: bot.id, name: bot.name, color: bot.color },
      tool: waitTool,
    });
  });
  switch (availability) {
    case "ready":
      // The promise is kept the moment the turn starts; settle the chip so
      // the live label stops narrating a wait that is over.
      if (waitChip) store.patchMessage(threadId, waitChip.id, { tool: { ...waitTool, ok: true } });
      // Membership means the bot is part of the room operation NOW, so its
      // own Stop button reaches this turn rather than an idle 1:1 thread.
      operation.botIds.add(bot.id);
      return "run";
    case "cancelled":
      return "stop";
    case "unavailable":
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        from: { botId: bot.id, name: bot.name, color: bot.color },
        tool: { name: `${bot.name} is no longer available — skipped this round`, ok: false },
      });
      return "skip";
    case "timed_out": {
      const minutes = Math.max(1, Math.round(GROUP_GOAL_WAIT_MAX_MS() / 60_000));
      const name =
        `${bot.name} stayed busy in another conversation for ${minutes} minute${minutes === 1 ? "" : "s"} — skipped this round`;
      // The cap only fires after a wait began, so the chip exists; append
      // rather than lose the verdict if that ever stops being true.
      if (waitChip) store.patchMessage(threadId, waitChip.id, { tool: { name, ok: false } });
      else {
        store.appendMessage(threadId, {
          role: "bot",
          kind: "activity",
          from: { botId: bot.id, name: bot.name, color: bot.color },
          tool: { name, ok: false },
        });
      }
      return "skip";
    }
  }
}

function cancelGroupTurnOperations(
  groupId: string,
  threadId: string,
  outcome: { status: "stopped" | "limit-reached"; detail: string } = {
    status: "stopped",
    detail: "Stopped by you.",
  },
) {
  cancelTeamSetupResumesForThread(threadId);
  roomHandoffs().cancelRoom(groupId, threadId);
  for (const operation of groupTurnOperations.get(groupId) ?? []) {
    if (operation.threadId !== threadId) continue;
    operation.cancelled = true;
    operation.cancellation.abort();
    finishGroupGoalRun(groupId, operation, outcome.status, outcome.detail);
    if (operation.providerHandshakePending) {
      markCancelledProviderHandshake(operation.threadId, `group:${operation.id}`);
    }
  }
}

function groupProviderHandshakeSettled(operation: GroupTurnOperation): void {
  operation.providerHandshakePending = false;
  clearCancelledProviderHandshake(operation.threadId, `group:${operation.id}`);
}

function activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null {
  for (const group of store.groups) {
    for (const operation of groupTurnOperations.get(group.id) ?? []) {
      if (!operation.cancelled && operation.botIds.has(botId)) {
        return { group, threadId: operation.threadId };
      }
    }
    if (group.busyBotId !== botId) continue;
    // A detached scheduled goal deliberately leaves group.threadId pointing
    // at the task visible before the routine began. Resolve the live speaker
    // by its exact room task before falling back to legacy active-task work.
    for (const [threadId, speaker] of groupSpeakers()) {
      if (speaker.botId !== botId) continue;
      const ownsThread = group.dm
        ? group.threadId === threadId
        : Boolean(store.groupTaskByThread(group.id, threadId));
      if (ownsThread) return { group, threadId };
    }
    return { group, threadId: group.threadId };
  }
  return null;
}

  return {
    beginGroupTurnOperation,
    finishGroupTurnOperation,
    finishGroupGoalRun,
    waitForGroupMemberBot,
    waitForChatRoomMember,
    groupProviderHandshakeSettled,
    cancelGroupTurnOperations,
    activeGroupTurnForBot,
  };
}

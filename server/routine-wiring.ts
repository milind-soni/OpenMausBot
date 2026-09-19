// The routine scheduler's host wiring — the comms bus, the persisted
// delegation handoff load, and the RoutineManager construction with every
// callback it uses to reach back into the harness — extracted verbatim
// from index.ts. The lifecycle-card projection and the group-goal interrupt
// travel with the wiring that calls them. index.ts calls createRoutineWiring
// at the old commsBus declaration site and rebinds commsBus and routines
// from its result, so initialization order is unchanged.
import type { CommsBus } from "./comms-visibility.ts";
import type { Handoffs } from "./delta-context.ts";
import { _loadPending, discardDelegations, pendingThreads } from "./delegations.ts";
import type { IncidentKind } from "./incidents.ts";
import { revokeInternalCapabilitiesForThread } from "./internal-capabilities.ts";
import { buildNotification, type Notification } from "./notify.ts";
import { redactSecretsInText } from "./redact.ts";
import { registry, store } from "./runtime.ts";
import { RoutineManager, type RoutineRun, type RoutineRunOn, type RoutineRunTrigger } from "./routines.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";
import { botAtThreadCapacity, botForThread } from "./turn-admission.ts";
import { closeOpenApprovals } from "./turn-fold.ts";

/** Everything the routine wiring reads from its host. Grouped the same way
 * createStartTurn groups its deps; every member is initialized before
 * index.ts calls createRoutineWiring, so no late-bound thunks are needed. */
export interface RoutineWiringDeps {
  events: {
    broadcast(payload: Record<string, unknown>): void;
    notify(notification: Notification | null): void;
  };
  fold: {
    routineSourceOwner(run: Pick<RoutineRun, "botId" | "sourceThreadId" | "resultsThreadId">): { bot: BotRecord; group: GroupRecord | undefined; threadId: string } | null;
    routineSourceThread(run: RoutineRun): string | null;
  };
  helpers: {
    unattendedDispatchState(botId: string): "ready" | "busy" | "missing";
    roomSetupPending(group: GroupRecord): boolean;
    groupIsWorking(group: GroupRecord): boolean;
    startGroupTurn(
      groupId: string,
      text: string,
      replyTo: Message | undefined,
      sendId: string | undefined,
      channelMode: "goal",
      queueId: string | undefined,
      options: { threadId: string; goalCoordinatorBotId: string; goalRunId: string },
    ): unknown;
    cancelGroupTurnOperations(groupId: string, threadId: string, outcome?: { status: "stopped" | "limit-reached"; detail: string }): void;
    cancelDirectTurnDispatch(botId: string, expectedThreadId?: string): unknown;
    runningTurnInstance(bot: BotRecord, threadId: string, runOn?: RoutineRunOn): ReturnType<typeof registry.get>;
    handoffs: Handoffs;
    reportIncident(input: { kind: IncidentKind; bot: BotRecord; threadId: string; detail: string }): void;
  };
  state: {
    groupSpeakers: Map<string, { botId: string; name: string; color: string }>;
    delegationWatch: Map<string, { channelId?: string; toBotId: string; toBotName?: string; taskId?: string; sourceThreadId?: string; sourceBotId?: string; routineRunId?: string; startedAtMs?: number }>;
    pendingDelegationWakes: Map<string, { botId: string; targetName: string; failureReason?: string; routineRunId?: string; budgetAcquired?: boolean }>;
    publicBot(bot: NonNullable<ReturnType<typeof store.bot>>): Record<string, unknown>;
    startTurn(
      botId: string,
      text: string,
      opts?: { threadId?: string; runOn?: RoutineRunOn; automationSource?: RoutineRunTrigger; onDispatchError?: (message: string) => void },
    ): Promise<unknown>;
  };
}

export function createRoutineWiring(deps: RoutineWiringDeps) {
  const { broadcast, notify } = deps.events;
  const { routineSourceOwner, routineSourceThread } = deps.fold;
  const {
    unattendedDispatchState, roomSetupPending, groupIsWorking, startGroupTurn,
    cancelGroupTurnOperations, cancelDirectTurnDispatch, runningTurnInstance, reportIncident, handoffs,
  } = deps.helpers;
  const {
    groupSpeakers, delegationWatch, pendingDelegationWakes, publicBot, startTurn,
  } = deps.state;

function routineRunCard(run: RoutineRun): NonNullable<Message["routineRun"]> {
  const visibleSummary = run.status === "waiting" ? run.attention : run.output;
  const summary = visibleSummary ? redactSecretsInText(visibleSummary).slice(0, 2_000) : undefined;
  const error = run.error ? redactSecretsInText(run.error).slice(0, 500) : undefined;
  const card: NonNullable<Message["routineRun"]> = {
    runId: run.id,
    routineId: run.routineId,
    routineName: redactSecretsInText(run.routineName),
    scheduledFor: run.scheduledFor,
    status: run.status,
  };
  if (run.goalStatus) card.goalStatus = run.goalStatus;
  if (run.deferredAt != null && run.status === "queued") card.deferredAt = run.deferredAt;
  if (run.threadId) card.executionThreadId = run.threadId;
  if (summary) card.summary = summary;
  if (error) card.error = error;
  return card;
}

function routineRunFallbackText(card: NonNullable<Message["routineRun"]>): string {
  const goalState = card.goalStatus === "needs-input"
    ? "needs your input"
    : card.goalStatus === "blocked"
      ? "was blocked"
      : card.goalStatus === "limit-reached"
        ? "reached its limit"
        : card.goalStatus === "stopped"
          ? "was stopped"
          : card.goalStatus === "failed"
            ? "failed"
            : undefined;
  const state = goalState ?? (
    card.status === "waiting"
      ? "needs your attention"
      : card.status === "completed"
        ? "completed"
        : card.status === "failed"
          ? "failed"
          : card.status === "cancelled"
            ? "was cancelled"
            : card.status === "missed"
              ? "was missed"
              : card.status === "queued" && card.deferredAt != null
                ? "deferred: target busy"
              : card.status
  );
  return `Routine “${card.routineName}” ${state}`;
}

/** Upsert one durable lifecycle card per run. Replaying the same transition,
 * including restart recovery, patches the existing run id instead of adding
 * another chat message. */
function syncRoutineRunToSource(run: RoutineRun): string | null {
  const source = routineSourceOwner(run);
  if (!source) {
    const execution = run.threadId ? store.taskByThread(run.botId, run.threadId) : null;
    if (execution?.routineRunId === run.id) {
      store.patchTask(run.botId, execution.threadId, {
        routineRunId: undefined,
        ...(["waiting", "completed", "failed", "missed"].includes(run.status) ? { unread: true } : {}),
      });
    }
    return null;
  }
  const sourceThreadId = source.threadId;
  const card = routineRunCard(run);
  const text = routineRunFallbackText(card);
  const existing = store.messagesFor(sourceThreadId).find(
    (message) => message.kind === "routine.run" && message.routineRun?.runId === run.id,
  );
  const statusChanged = existing?.routineRun?.status !== run.status;
  if (existing) {
    store.patchMessage(sourceThreadId, existing.id, { text, routineRun: card });
  } else {
    const message: Omit<Message, "id" | "at"> = {
      role: "bot",
      kind: "routine.run",
      text,
      routineRun: card,
    };
    if (source.group) {
      message.from = { botId: source.bot.id, name: source.bot.name, color: source.bot.color };
    }
    store.appendMessage(sourceThreadId, message);
  }

  // Mark only the fresh execution, after its first running card persisted
  // and before dispatch adds any transcript. A user can later promote it by
  // sending a normal follow-up; replaying/marking the old receipt seen must
  // never hide that conversation again.
  if (run.target === "bot" && run.triggerSource !== "webhook" && run.threadId && run.threadId !== sourceThreadId) {
    const execution = store.taskByThread(run.botId, run.threadId);
    const freshExecution = execution && run.status === "running" && !execution.routineRunId &&
      store.messagesFor(run.threadId).length === 0;
    if (execution && (freshExecution || (execution.routineRunId === run.id && execution.unread))) {
      store.patchTask(run.botId, run.threadId, { routineRunId: run.id, unread: false });
    }
  }

  // Merely queueing/running is ambient progress. Attention and terminal
  // states become unread in the conversation where the user asked for them.
  if (statusChanged && ["waiting", "completed", "failed", "missed"].includes(run.status)) {
    if (source.group) store.patchGroup(source.group.id, { unread: true });
    else store.patchTask(source.bot.id, sourceThreadId, { unread: true });
  }
  return sourceThreadId;
}

async function interruptRoutineGroupGoal(
  groupId: string,
  threadId: string,
  outcome?: { status: "stopped" | "limit-reached"; detail: string },
): Promise<void> {
  const speaker = groupSpeakers.get(threadId);
  const bot = speaker ? store.bot(speaker.botId) : undefined;
  cancelGroupTurnOperations(groupId, threadId, outcome);
  revokeInternalCapabilitiesForThread(threadId);
  await (bot ? runningTurnInstance(bot, threadId) : null)
    ?.adapter.interruptTurn(threadId)
    .catch(() => {});
  closeOpenApprovals(threadId);
}

// Load queued handoffs before scheduler recovery can fail an interrupted
// run. Its failure callback can then durably drop that work immediately;
// nothing dispatches until the listener is ready below.
const commsBus: CommsBus = { store, broadcast, threadSlotFree: (botId) => !botAtThreadCapacity(botId) };
_loadPending();

const routines = new RoutineManager({
  emit: broadcast,
  hasPendingDelegations: (threadId) => pendingThreads().includes(threadId) ||
    [...delegationWatch.values()].some((watch) => watch.sourceThreadId === threadId) ||
    pendingDelegationWakes.has(threadId),
  botState: unattendedDispatchState,
  goalState: (groupId, coordinatorBotId) => {
    const group = store.group(groupId);
    const coordinator = store.bot(coordinatorBotId);
    if (
      !group ||
      group.dm ||
      roomSetupPending(group) ||
      !coordinator ||
      coordinator.hidden ||
      !group.memberIds.includes(coordinator.id)
    ) {
      return "missing";
    }
    return groupIsWorking(group) || coordinator.busy ? "busy" : "ready";
  },
  createTask: (botId, title, activate = false) => {
    const task = store.createTask(botId, title, activate);
    const bot = store.bot(botId);
    if (task && bot) broadcast({ kind: "bot", bot: publicBot(bot) });
    return task;
  },
  createGoalTask: (groupId, title) => store.createGroupTask(groupId, title, false),
  isResultsThread: (botId, threadId) => {
    const bot = store.bot(botId);
    const task = store.taskByThread(botId, threadId);
    return Boolean(bot && !bot.hidden && task && !task.routineRunId);
  },
  resolveResultsThread: (routine, forceNew) => {
    // A trusted chat source is already snapshotted as sourceThreadId on each
    // run. Keep it distinct: it can belong to a teammate or room, whereas an
    // explicit resultsThreadId must be a visible task owned by the running bot.
    if (!forceNew && routineSourceOwner(routine)) return routine.resultsThreadId;
    return store.createTask(routine.botId, `${routine.name} · Results`, false)?.threadId;
  },
  discardResultsThread: (botId, threadId) => {
    const task = store.taskByThread(botId, threadId);
    if (task && !task.busy && !task.routineRunId && store.messagesFor(threadId).length === 0) {
      store.deleteTask(botId, threadId);
      handoffs.forget(threadId);
    }
  },
  startTurn: (botId, threadId, prompt, runOn, triggerSource, onDispatchError) =>
    startTurn(botId, prompt, { threadId, runOn, automationSource: triggerSource, onDispatchError })
      .then(() => undefined),
  startGoal: async (groupId, threadId, prompt, coordinatorBotId, runId, _onDispatchError) => {
    startGroupTurn(groupId, prompt, undefined, undefined, "goal", undefined, {
      threadId,
      goalCoordinatorBotId: coordinatorBotId,
      goalRunId: runId,
    });
  },
  interruptTurn: async (botId, threadId, runOn) => {
    const bot = botForThread(botId, threadId);
    pendingDelegationWakes.delete(threadId);
    discardDelegations(commsBus, threadId);
    cancelDirectTurnDispatch(botId, threadId);
    revokeInternalCapabilitiesForThread(threadId);
    const instance = bot
      ? runningTurnInstance(bot, threadId, runOn)
      : runOn === "cloud" ? registry.instances().find((candidate) => candidate.driverKind === "boxAgent") ?? null : null;
    try {
      await instance?.adapter.interruptTurn(threadId);
    } finally {
      closeOpenApprovals(threadId);
    }
  },
  interruptGoal: interruptRoutineGroupGoal,
  onRunChanged: syncRoutineRunToSource,
  onRunFailed: (run) => {
    if (run.threadId) {
      pendingDelegationWakes.delete(run.threadId);
      discardDelegations(commsBus, run.threadId);
    }
    const bot = store.bot(run.botId);
    if (!bot) return;
    const detail = redactSecretsInText(run.error ? `${run.routineName}: ${run.error}` : run.routineName);
    reportIncident({ kind: "routine-failed", bot, threadId: run.threadId ?? bot.threadId, detail });
    const notificationBot = routineSourceOwner(run)?.bot ?? bot;
    notify(buildNotification("routine-failed", notificationBot, routineSourceThread(run) ?? run.threadId ?? bot.threadId, detail));
  },
  onRunDeferred: (run) => {
    const bot = store.bot(run.botId);
    if (!bot) return;
    const minutes = run.deferredAt != null && run.deferredNoticeAt != null
      ? Math.max(1, Math.round((run.deferredNoticeAt - run.deferredAt) / 60_000))
      : null;
    const detail = `${redactSecretsInText(run.routineName)}: target busy${minutes != null ? ` for ${minutes} minutes` : ""}`;
    const notificationBot = routineSourceOwner(run)?.bot ?? bot;
    notify(buildNotification("routine-deferred", notificationBot, routineSourceThread(run) ?? bot.threadId, detail));
  },
});


  return { commsBus, routines, syncRoutineRunToSource, interruptRoutineGroupGoal };
}

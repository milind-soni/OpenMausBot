// The routine request lifecycle -- the persisted-definition source
// resolvers, the emergency-approval downgrade stop, the scheduler host
// wiring with its crash-recovery reconciliation, the RoutineRequestService
// construction, and the routine card projection/resolution helpers --
// extracted verbatim from index.ts. The wiring cluster (Region A) sat at
// the "routines: persisted definitions" banner's original site; the
// timezone/projection cluster (Region B: ROUTINE_WEEKDAY_NAMES through
// resolveAndSendRoutine) physically sat much further down, between
// resolveAndSendTeamSetup and resolveAndSendProfile, and moves into this
// same factory because it is the same request lifecycle. Region B is pure
// declarations with no init-order coupling to anything between the two
// sites (its one Region A dependency, routineRequests, is created inside
// this body), so its original relative order is preserved by keeping it
// after Region A here. index.ts calls createRoutineLifecycle at Region A's
// original site and rebinds the names from its result;
// group-turn-operations, events-pipeline and desktop-approval are wired
// EARLIER in index.ts and consumed routineSourceOwner,
// routineSourceThread and stopBotForEmergencyApprovalDowngrade by value,
// so those call sites now pass wrapper thunks over the names returned
// here. routines and calendarCalls stay in index.ts (their later
// consumers remain there) and cross as a getter/setter pair.
import type { ServerResponse } from "node:http";
import { appendDecision } from "./decision-log.ts";
import { DATA_DIR } from "./config.ts";
import { json } from "./http.ts";
import { canReachPeer } from "./peer-roster.ts";
import { redactSecretsInText } from "./redact.ts";
import { RoutineManager, type RoutineRun } from "./routines.ts";
import { createRoutineWiring, type RoutineWiringDeps } from "./routine-wiring.ts";
import { RoutineRequestService } from "./routine-requests.ts";
import { CalendarCallManager, type CalendarCall } from "./calendar-calls.ts";
import { revokeInternalCapabilitiesForThread } from "./internal-capabilities.ts";
import { closeOpenApprovals } from "./turn-fold.ts";
import { cfg, registry, store } from "./runtime.ts";
import * as box from "./box.ts";
import type { CommsBus } from "./comms-visibility.ts";
import type { createBotViews } from "./bot-views.ts";
import type { createGroupTurnOperations } from "./group-turn-operations.ts";

/** Everything the lifecycle reads from its host. The createRoutineWiring
 * slice keeps its RoutineWiringDeps shape minus the fold this module
 * defines; routines and calendarCalls are index.ts lets, so they cross
 * through host accessors. */
export interface RoutineLifecycleDeps {
  wiring: Omit<RoutineWiringDeps, "fold">;
  helpers: {
    interruptAllDirectThreads(botId: string): Promise<void>;
    activeGroupTurnForBot: ReturnType<typeof createGroupTurnOperations>["activeGroupTurnForBot"];
    fullAccessForSource: ReturnType<typeof createBotViews>["fullAccessForSource"];
    proposalPersistence(botId: string, threadId: string): { ok: true } | { ok: false; status: number; error: string };
    deliverCalendarCall(call: CalendarCall, scheduledFor: number): void;
  };
  host: {
    routines(): RoutineManager | null;
    setRoutines(next: RoutineManager | null): void;
    setCalendarCalls(next: CalendarCallManager | null): void;
  };
}

export function createRoutineLifecycle(deps: RoutineLifecycleDeps) {
  const { broadcast, notify } = deps.wiring.events;
  const {
    unattendedDispatchState, roomSetupPending, groupIsWorking, startGroupTurn,
    cancelGroupTurnOperations, cancelDirectTurnDispatch, runningTurnInstance,
  } = deps.wiring.helpers;
  const { groupSpeakers, delegationWatch, pendingDelegationWakes, publicBot, startTurn } = deps.wiring.state;
  const {
    interruptAllDirectThreads, activeGroupTurnForBot, fullAccessForSource,
    proposalPersistence, deliverCalendarCall,
  } = deps.helpers;
  const routines = deps.host.routines;
  const setRoutines = deps.host.setRoutines;
  const setCalendarCalls = deps.host.setCalendarCalls;

// ── routines: persisted definitions → detached bot tasks ───────────────
// The scheduler owns timing and receipts; the existing harness remains the
// only owner of provider sessions, approvals, tools, computers and messages.
// The scheduler's host wiring (comms bus + RoutineManager construction)
// and the run-card projection live in ./routine-wiring.ts; these source
// resolvers stay here because the group-goal fold reads them too.
function routineSourceOwner(run: Pick<RoutineRun, "botId" | "sourceThreadId" | "resultsThreadId">) {
  if (run.resultsThreadId) {
    const bot = store.bot(run.botId);
    const task = bot && store.taskByThread(bot.id, run.resultsThreadId);
    return bot && !bot.hidden && task && !task.routineRunId
      ? { bot, group: undefined, threadId: task.threadId }
      : null;
  }
  const threadId = run.sourceThreadId?.trim();
  if (!threadId) return null;
  // Validate before messagesFor(): Store lazily opens transcript storage, so
  // reading an orphan id first would recreate a deleted conversation.
  const bot = store.bot(run.botId);
  if (!bot) return null;
  // The source is stamped from the confirmed request, never calendar input.
  // A request for a teammate runs as that teammate but reports to the bot
  // whose conversation held the card. Recheck their section before sharing
  // a result, since either bot may have moved since confirmation.
  const sourceBot = store.botByThread(threadId);
  if (sourceBot && !sourceBot.hidden && !store.taskByThread(sourceBot.id, threadId)?.routineRunId &&
    (sourceBot.id === bot.id || canReachPeer(sourceBot, bot))) {
    return { bot: sourceBot, group: undefined, threadId };
  }
  const group = store.groupByThread(threadId);
  return group?.memberIds.includes(bot.id) ? { bot, group, threadId } : null;
}

function routineSourceThread(run: RoutineRun): string | null {
  return routineSourceOwner(run)?.threadId ?? null;
}

/** Stop work that may have captured Full/Custom before a fail-closed Ask
 * compensation arrived over Electron's private channel. Cancellation flags
 * are flipped synchronously; the awaited work only drains capabilities and
 * interrupts the already-started provider process. */
async function stopBotForEmergencyApprovalDowngrade(botId: string): Promise<void> {
  const bot = store.bot(botId);
  if (!bot) return;
  for (const task of store.tasks(botId)) {
    if (task.approvalMode === "full" || task.approvalMode === "custom") {
      store.patchTask(botId, task.threadId, { approvalMode: "ask", autoApprove: false, alwaysAllow: [] });
    }
  }
  const directStop = interruptAllDirectThreads(botId);

  const routineRun = routines()?.activeBotRunForBot(bot.id);
  if (routineRun) {
    if (routineRun.threadId) revokeInternalCapabilitiesForThread(routineRun.threadId);
    cancelDirectTurnDispatch(bot.id, routineRun.threadId);
    await routines()!.cancelRun(routineRun.id);
    if (routineRun.threadId) closeOpenApprovals(routineRun.threadId);
    await directStop;
    return;
  }

  const groupTurn = activeGroupTurnForBot(bot.id);
  if (groupTurn) {
    revokeInternalCapabilitiesForThread(groupTurn.threadId);
    cancelGroupTurnOperations(groupTurn.group.id, groupTurn.threadId);
    const results = await Promise.allSettled([
      directStop,
      runningTurnInstance(bot, groupTurn.threadId)?.adapter.interruptTurn(groupTurn.threadId),
    ]);
    closeOpenApprovals(groupTurn.threadId);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    return;
  }

  await directStop;
}

// Load queued handoffs before scheduler recovery can fail an interrupted
// run. Its failure callback can then durably drop that work immediately;
// nothing dispatches until the listener is ready below.
const routineWiring = createRoutineWiring({
  events: { broadcast, notify },
  fold: { routineSourceOwner, routineSourceThread },
  helpers: {
    unattendedDispatchState, roomSetupPending, groupIsWorking, startGroupTurn,
    cancelGroupTurnOperations, cancelDirectTurnDispatch, runningTurnInstance,
  },
  state: { groupSpeakers, delegationWatch, pendingDelegationWakes, publicBot, startTurn },
});
const commsBus: CommsBus = routineWiring.commsBus;
setRoutines(routineWiring.routines);
// The scheduler receipt and room transcript live in separate durable stores.
// If the process exited between those two writes, prefer the correlated
// RoutineRun's terminal truth; an uncorrelated manual goal is simply failed
// because no in-memory orchestrator can survive a restart.
const recoveredRoutineGoalRuns = new Map(
  routines()!.listRuns().filter((run) => run.target === "room-goal").map((run) => [run.id, run]),
);
const groupGoalRecoveryAt = Date.now();
store.reconcileInterruptedGroupGoals((runId, threadId) => {
  const run = recoveredRoutineGoalRuns.get(runId);
  if (!run || run.threadId !== threadId) return null;
  const status = run.goalStatus ?? (
    run.status === "completed"
      ? "completed"
      : run.status === "cancelled"
        ? "stopped"
        : "failed"
  );
  const detail = run.output ?? run.error ?? (
    status === "completed"
      ? "The scheduled team goal completed before OpenMausBot restarted."
      : status === "stopped"
        ? "The scheduled team goal was stopped."
        : "OpenMausBot restarted before this scheduled team goal finished."
  );
  return { status, detail, finishedAt: run.finishedAt ?? groupGoalRecoveryAt };
});
setCalendarCalls(new CalendarCallManager({
  botExists: (botId) => Boolean(store.bot(botId)),
  onDue: deliverCalendarCall,
}));
const recoveryOwners = routines()!.routineRequestReceiptOwners();
if (recoveryOwners.length > 0) {
  // A normal launch has no crash-gap receipts, so it must not eagerly load
  // every historical transcript. Inspect only the distinct threads named by
  // a surviving receipt; reconciliation then removes any whose card vanished.
  const recoveryThreads = [...new Set(recoveryOwners.map((owner) => owner.threadId))];
  routines()!.reconcileRoutineRequestReceipts(
    recoveryThreads.flatMap((threadId) =>
      store.messagesFor(threadId).flatMap((message) => {
        const request = message.card?.routineRequest;
        return request && !message.card?.answered && !message.card?.dismissed
          ? [{ requestId: request.requestId, messageId: message.id, botId: request.botId, threadId: request.threadId }]
          : [];
      }),
    ),
  );
}

// Chat tools can prepare routine changes, but the harness applies them only
// after the user confirms a durable card. Keeping this beside the scheduler
// makes the card resolvable after an app restart without involving the model.
async function cloudRoutineReadiness(): Promise<{ ready: boolean; reason?: string }> {
  if (!box.boxConfigured(cfg)) {
    return {
      ready: false,
      reason: 'The Box-hosted agent needs a working Box API key. For the bot’s existing model and configured computer, including a self-hosted VPS, set run_on="maus" instead. Do not request a Box key unless the user actually wants the Box-hosted agent.',
    };
  }
  const instance = registry.instances().find((candidate) => candidate.driverKind === "boxAgent");
  if (!instance) {
    return { ready: false, reason: "The Cloud VM runner is unavailable. Restart OpenMausBot and try again." };
  }
  try {
    const snapshot = await instance.snapshot();
    return snapshot.state === "available"
      ? { ready: true }
      : { ready: false, reason: snapshot.reason || "The Cloud VM runner is not ready." };
  } catch (error) {
    return {
      ready: false,
      reason: `The Cloud VM runner could not be checked: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
const routineRequests = new RoutineRequestService({
  store,
  routines: routines()!,
  autoApply: fullAccessForSource,
  cloudReady: cloudRoutineReadiness,
  canPersist: proposalPersistence,
  // Cross-bot routines: the confirmation card can sit open indefinitely, so
  // the target is re-authorized when the user confirms, not just at proposal.
  validateTarget: (proposerBotId, target) => {
    const proposer = store.bot(proposerBotId);
    const targetBot = store.bot(target.botId);
    if (!targetBot) return `@${target.name} no longer exists, so this routine cannot be scheduled for it`;
    if (!proposer || !canReachPeer(proposer, targetBot)) {
      return `@${target.name} is no longer in this section, so this routine cannot be scheduled for it`;
    }
    return null;
  },
});

const ROUTINE_WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const routineTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const routineTimestamp = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? new Date(value).toISOString() : null;
const agentRoutine = (
  routine: ReturnType<RoutineManager["listRoutines"]>[number],
  latestRun?: RoutineRun,
) => {
  // Routines created in the calendar predate chat-card redaction and may
  // contain a credential in their instructions. The list result is handed
  // back to the model, so scrub the complete value before taking its preview.
  const safeInstructions = redactSecretsInText(routine.prompt);
  const safeName = redactSecretsInText(routine.name);
  return {
    id: routine.id,
    name: safeName,
    instructions: safeInstructions.slice(0, 2_000),
    instructionsTruncated: safeInstructions.length > 2_000,
    continuity: routine.continuity === true,
    enabled: routine.enabled,
    runOn: routine.runOn,
    durationMinutes: routine.durationMinutes,
    ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
    schedule: routine.schedule.type === "once"
      ? { type: "once" as const, at: new Date(routine.schedule.at).toISOString() }
      : routine.schedule.type === "interval"
        ? {
            type: "interval" as const,
            everyMinutes: routine.schedule.everyMinutes,
            anchorAt: new Date(routine.schedule.anchorAt).toISOString(),
            ...(routine.schedule.weekdays === undefined
              ? {}
              : { weekdays: routine.schedule.weekdays.map((day) => ROUTINE_WEEKDAY_NAMES[day]) }),
            ...(routine.schedule.window === undefined ? {} : { window: { ...routine.schedule.window } }),
            ...(routine.schedule.endsAt === undefined
              ? {}
              : { endsAt: new Date(routine.schedule.endsAt).toISOString() }),
          }
        : routine.schedule.type === "cron"
          ? { ...routine.schedule }
          : {
              type: "weekly" as const,
              time: routine.schedule.time,
              weekdays: routine.schedule.weekdays.map((day) => ROUTINE_WEEKDAY_NAMES[day]),
            },
    nextRunAt: routine.nextRunAt === null ? null : new Date(routine.nextRunAt).toISOString(),
    latestRun: latestRun
      ? {
          id: latestRun.id,
          status: latestRun.status,
          triggerSource: latestRun.triggerSource ?? (latestRun.manual ? "manual" : "schedule"),
          scheduledFor: routineTimestamp(latestRun.scheduledFor),
          startedAt: routineTimestamp(latestRun.startedAt),
          finishedAt: routineTimestamp(latestRun.finishedAt),
          attention: latestRun.attention ? redactSecretsInText(latestRun.attention).slice(0, 500) : null,
          output: latestRun.output ? redactSecretsInText(latestRun.output).slice(0, 1_000) : null,
          error: latestRun.error ? redactSecretsInText(latestRun.error).slice(0, 500) : null,
          executionThreadId: latestRun.threadId ?? null,
        }
      : null,
  };
};
function sendRoutineResolution(
  res: ServerResponse,
  result: ReturnType<RoutineRequestService["resolve"]>,
): boolean {
  if (!result.claimed) return false;
  if (result.state === "invalid") {
    json(res, result.status, { error: result.error });
    return true;
  }
  if (result.state === "already_settled") {
    json(res, 200, {
      ok: true,
      outcome: result.behavior === "allow" ? "allowed-once" : result.behavior === "deny" ? "rejected" : "unavailable",
      alreadySettled: true,
    });
    return true;
  }
  if (result.state === "denied") {
    json(res, 200, { ok: true, outcome: "rejected" });
    return true;
  }
  json(res, 200, {
    ok: true,
    outcome: "allowed-once",
    routineAction: result.action,
    resultId: result.resultId,
  });
  return true;
}
function resolveAndSendRoutine(
  res: ServerResponse,
  args: { botId: string; botName?: string; threadId: string; requestId: string; behavior: string },
): boolean {
  const card = store.messagesFor(args.threadId).find(
    (message) => message.card?.requestId === args.requestId && message.card.routineRequest,
  )?.card;
  const result = routineRequests.resolve(args);
  if (
    result.claimed &&
    (result.state === "applied" || result.state === "denied")
  ) {
    appendDecision(DATA_DIR, {
      threadId: args.threadId,
      requestId: args.requestId,
      botId: args.botId,
      botName: args.botName,
      tool: card?.tool,
      summary: card?.subtitle,
      decision: result.state === "applied" ? "user-approved" : "user-denied",
      source: "user",
    });
  }
  return sendRoutineResolution(res, result);
}

  return {
    routineSourceOwner, routineSourceThread, stopBotForEmergencyApprovalDowngrade,
    routineWiring, commsBus, routineRequests, routineTimeZone, agentRoutine,
    resolveAndSendRoutine,
  };
}

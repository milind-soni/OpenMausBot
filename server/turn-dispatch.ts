// The turn-execution helpers -- the delegation drain and expiry sweep, the
// coalesced retry hook, the queued-send drain, the direct/opened-thread
// queue entry points, and the createStartTurn wiring -- extracted verbatim
// from index.ts. index.ts calls createTurnDispatch at
// drainThreadDelegations' original site and rebinds the region's names from
// its result. delegationRetryBots moves with the module (every consumer
// moved); commsBus, approvalBus, and the followupsReady flag stay in
// index.ts and cross as thunks because index.ts binds them after this
// factory runs. The startTurn deps keep their StartTurnDeps shapes minus
// the two members this module defines (fold.retryDelegationsWaitingOn and
// fold.drains.drainQueuedSends).
import {
  drainDelegations,
  expireStaleDelegations,
  releaseDelegationsWaitingOn,
} from "./delegations.ts";
import type { createDelegationWatch } from "./delegation-watch.ts";
import type { CommsBus } from "./comms-visibility.ts";
import type { ApprovalBus } from "./peer-approval.ts";
import { promptWithReply } from "./replies.ts";
import { cfg, store, workspaceMaintenance } from "./runtime.ts";
import { createStartTurn, type StartTurnDeps } from "./start-turn.ts";
import {
  botAtThreadCapacity,
  threadBusy,
} from "./turn-admission.ts";
import {
  drainSteeredMessages,
  queuedThreadPosition,
  queueSteeredMessage,
} from "./steer-queue.ts";
import type { Message } from "./store.ts";

/** The createStartTurn host wiring, minus the fold members this module
 * owns (retryDelegationsWaitingOn and the drainQueuedSends slot). */
type TurnDispatchStartTurnDeps = Omit<StartTurnDeps, "runtime" | "fold"> & {
  fold: Omit<StartTurnDeps["fold"], "retryDelegationsWaitingOn" | "drains"> & {
    drains: Omit<StartTurnDeps["fold"]["drains"], "drainQueuedSends">;
  };
};

export interface TurnDispatchDeps {
  startTurn: TurnDispatchStartTurnDeps;
  helpers: {
    runDelegatedTurn: Parameters<typeof drainDelegations>[3];
    wakeUndispatchedDelegation: ReturnType<typeof createDelegationWatch>["wakeUndispatchedDelegation"];
    parksBehindCoordination(botId: string, threadId: string): boolean;
  };
  lateBound: {
    commsBus(): CommsBus;
    approvalBus(): ApprovalBus;
    followupsReady(): boolean;
  };
}

export function createTurnDispatch(deps: TurnDispatchDeps) {
  const {
    events, admission, dispatch, cleanup, turnMarks, localVm, computers, prompts, handoffs,
    titles, incidents,
  } = deps.startTurn;
  const { turnUsage, turnContext, personAskAt } = deps.startTurn.fold;
  const { drainConnectorResumes, drainSecretResumes, drainTeamSetupResumes, drainDelegationWakes } = deps.startTurn.fold.drains;
  const { routines, activeRoutineRunForThread } = deps.startTurn.routines;
  const { broadcast, notify, watchdog } = events;
  const {
    activeGroupTurnForBot, providerTransitionForTurn, turnSurfacePlan, turnProvider, turnInstance,
    providerFleet, providerInstancesChanging, checkpointRestoreLeases, boxLifecycleBusyBots,
    maxCommsDepth, isExternalContextMarker,
  } = admission;
  const {
    directTurnGenerationByThread, directFollowupTurns, directFollowupSettlers,
    directCoordinationSettlers, settleDirectCoordination, settleDirectFollowup,
    directTurnClaimExists, directTurnClaimIsCurrent, markDirectTurnDispatching,
    clearDirectTurnDispatch, pendingCancelledProviderHandshakes, clearCancelledProviderHandshake,
    retireProviderTurn, runningTurnEngines, DirectTurnSetupCancelled,
  } = dispatch;
  const {
    releaseTurnResources, settlingResourceOwners, autoVmClaims, releaseLocalVmThread, startScreenPoller,
    stopScreenPoller, screenPollers, turnResources, turnComputerResources,
  } = cleanup;
  const { markUnattended, clearUnattended, markInternalTurn, clearInternalTurn, delegationWakeBudget } = turnMarks;
  const {
    localVmTargetForBot, localVmLeaseFor, localVmIdleFor, localVmThreadTargets, localVmActiveThreads,
    localVmLifecycleBusy, localVmSeen, localVmOwnerBusy, localVmImageBusy, localVmModeChangeBusy,
    readyLocalVmForTurn,
  } = localVm;
  const {
    bindTurnComputer, attachTeamBox, controlIntegration, browserRuntime, browserIntegration,
    phoneIntegration, connectedAppsIntegration, agentsIntegration, vpsThreadStarted, vpsThreadEnded,
  } = computers;
  const {
    approvalModeForTurn, roomHandoffProblem, coordinationSystemInstructions,
    outstandingAssignmentsPrompt, teamComputerPrompt, inheritedTeamComputer,
    teammateReportContext, availableSkills,
  } = prompts;
  const { roomHandoffs, turnHandoffs } = handoffs;
  const { generateThreadTitle } = titles;
  const { reportIncident } = incidents;
  const { runDelegatedTurn, wakeUndispatchedDelegation, parksBehindCoordination } = deps.helpers;
  // index.ts binds these after this factory runs; every read resolves the thunk.
  const commsBus = deps.lateBound.commsBus;
  const approvalBus = deps.lateBound.approvalBus;
  const followupsReady = deps.lateBound.followupsReady;

function drainThreadDelegations(threadId: string): void {
  const routineRunId = activeRoutineRunForThread(threadId)?.id;
  drainDelegations(commsBus(), approvalBus(), threadId, runDelegatedTurn,
    (receipt) => wakeUndispatchedDelegation(receipt, routineRunId));
}

// Queued handoffs expire DELEGATION_TTL_MS after they were queued. A drain
// expires what it touches; this sweep covers a handoff nothing drains — a
// target that never settles while its source sits idle — and wakes each
// delegator the same way a drain-time failure does.
const DELEGATION_SWEEP_MS = 60 * 60 * 1000;
function expireDelegationsNow(): void {
  expireStaleDelegations(commsBus(), Date.now(), (receipt) =>
    wakeUndispatchedDelegation(receipt, activeRoutineRunForThread(receipt.sourceThreadId)?.id));
}

// Most waiting handoffs retry from a target's turn.completed event. Some
// setup, cancellation, room, watchdog, and provider-reload paths release a
// bot without that event, so every explicit idle release calls this same
// coalesced retry hook. The microtask lets the releasing state machine finish
// before another turn claims the bot.
const delegationRetryBots = new Set<string>();
function retryDelegationsWaitingOn(botId: string): void {
  if (delegationRetryBots.has(botId)) return;
  delegationRetryBots.add(botId);
  queueMicrotask(() => {
    delegationRetryBots.delete(botId);
    // Explicit idle releases (room/setup/reload/watchdog fallbacks) may not
    // publish turn.completed. They free a waiting source continuation too.
    drainDelegationWakes();
    // A bot still busy in one thread has nevertheless freed a slot: the
    // fresh-thread handoffs waiting on it can move, while the active-thread
    // ones keep waiting for it to go idle, as they always have.
    const stillBusy = store.bot(botId)?.busy === true;
    if (stillBusy && botAtThreadCapacity(botId)) return;
    const released = stillBusy
      ? releaseDelegationsWaitingOn(botId, (item) => item.targetThreadId !== undefined)
      : releaseDelegationsWaitingOn(botId);
    for (const waitingThread of released) {
      drainThreadDelegations(waitingThread);
    }
  });
}

function drainQueuedSends() {
  if (!followupsReady()) return;
  drainSteeredMessages(store, (botId, threadId, prompt, userMessage, excludeIds, unattended) =>
    // A plain attended turn — no automationSource, no comms depth: exactly
    // what typing the same words into an idle bot would run. Self-opened
    // work retains `unattended` and the message's bot-origin provenance
    // through the wait for a slot.
    // Drain just appended the held lines; userMessage keeps startTurn
    // from duplicating the last one, and excludeIds drops every drained
    // line from the transcript-replay so they are not also in `prompt`.
    new Promise<void>((resolve, reject) => {
      void startTurn(botId, prompt, {
        threadId, userMessage, excludeMessageIds: excludeIds, unattended, onTurnSettled: resolve,
      }).catch((err) => {
        store.appendMessage(threadId, {
          role: "bot", kind: "activity",
          tool: {
            name: `error: queued message could not start — ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
            ok: false,
          },
        });
        resolve();
      }).catch(reject);
    }),
    // Provider completion can precede its dispatch promise: keep the queue
    // intact until that exact handshake releases its runtime-only claim.
    (botId, threadId) => threadBusy(botId, threadId) || botAtThreadCapacity(botId) || Boolean(activeGroupTurnForBot(botId))
      || parksBehindCoordination(botId, threadId),
  );
}

/** Keep a person's words off the transcript until a direct-thread slot is
 * available. Reuse the existing cancellable, idempotent composer queue. */
async function startOrQueueDirectMessage(botId: string, threadId: string, text: string, replyTo?: Message, sendId?: string, sender?: { name: string }) {
  const capacity = botAtThreadCapacity(botId);
  if (capacity || threadBusy(botId, threadId) || parksBehindCoordination(botId, threadId)) {
    const reason = capacity ? "capacity" as const : undefined;
    const queued = queueSteeredMessage(botId, threadId, text, {
      replyToId: replyTo?.id,
      sendId,
      reason,
      prompt: promptWithReply(text, replyTo, cfg.profile?.name?.trim() || "User"),
    });
    return { ok: true as const, queued: true as const, queueId: queued.id, threadId, reason };
  }
  const message = await startTurn(botId, text, { threadId, replyTo, sendId, sender });
  return { ok: true as const, threadId, message };
}

/** How many start_thread calls one turn may make. Same spirit as the
 * create-bot ceiling above: a handful is a plan, more is a fan-out. */
const MAX_THREADS_OPENED_PER_TURN = 5;

/** A thread a bot opened on itself gets its first turn exactly the way a
 * person's message would: it runs now if the bot has a free slot, and
 * otherwise waits in the same composer queue, in line behind whatever the
 * bot already has waiting. Its provenance survives the queue: this is the
 * bot's own request, not a new human request authorizing recursive fan-out. */
async function startOrQueueOpenedThread(
  botId: string,
  threadId: string,
  text: string,
  unattended: boolean,
): Promise<{ state: "running" } | { state: "queued"; position: number } | { state: "failed"; error: string }> {
  const peerAsk = { botId, name: store.bot(botId)!.name, unattended: unattended || undefined };
  // A room turn holds the bot too (startTurn refuses a direct turn during
  // one); the drain's own block check already waits for it, so the words
  // queue here rather than bounce.
  if (botAtThreadCapacity(botId) || activeGroupTurnForBot(botId)) {
    queueSteeredMessage(botId, threadId, text, { reason: "capacity", unattended, peerAsk });
    return { state: "queued", position: queuedThreadPosition(botId, threadId) ?? 1 };
  }
  try {
    await startTurn(botId, text, { threadId, unattended, peerAsk });
    return { state: "running" };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `error: this thread could not start — ${why.slice(0, 120)}`, ok: false },
    });
    return { state: "failed", error: why };
  }
}


// ── turn dispatch (upstream ProviderCommandReactor, miniature) ──────────
const { startTurn } = createStartTurn({
  runtime: {
    store,
    cfg,
    workspaceMaintenance,
  },
  events: {
    broadcast,
    notify,
    watchdog,
  },
  admission: {
    activeGroupTurnForBot,
    providerTransitionForTurn,
    turnSurfacePlan,
    turnProvider,
    turnInstance,
    providerFleet,
    providerInstancesChanging,
    checkpointRestoreLeases,
    boxLifecycleBusyBots,
    maxCommsDepth,
    isExternalContextMarker,
  },
  dispatch: {
    directTurnGenerationByThread,
    directFollowupTurns,
    directFollowupSettlers,
    directCoordinationSettlers,
    settleDirectCoordination,
    settleDirectFollowup,
    directTurnClaimExists,
    directTurnClaimIsCurrent,
    markDirectTurnDispatching,
    clearDirectTurnDispatch,
    pendingCancelledProviderHandshakes,
    clearCancelledProviderHandshake,
    retireProviderTurn,
    runningTurnEngines,
    DirectTurnSetupCancelled,
  },
  fold: {
    turnUsage,
    turnContext,
    personAskAt,
    retryDelegationsWaitingOn,
    drains: {
      drainQueuedSends,
      drainConnectorResumes,
      drainSecretResumes,
      drainTeamSetupResumes,
      drainDelegationWakes,
    },
  },
  cleanup: {
    releaseTurnResources,
    settlingResourceOwners,
    autoVmClaims,
    releaseLocalVmThread,
    startScreenPoller,
    stopScreenPoller,
    screenPollers,
    turnResources,
    turnComputerResources,
  },
  turnMarks: {
    markUnattended,
    clearUnattended,
    markInternalTurn,
    clearInternalTurn,
    delegationWakeBudget,
  },
  routines: {
    routines,
    activeRoutineRunForThread,
  },
  localVm: {
    localVmTargetForBot,
    localVmLeaseFor,
    localVmIdleFor,
    localVmThreadTargets,
    localVmActiveThreads,
    localVmLifecycleBusy,
    localVmSeen,
    localVmOwnerBusy,
    localVmImageBusy,
    localVmModeChangeBusy,
    readyLocalVmForTurn,
  },
  computers: {
    bindTurnComputer,
    attachTeamBox,
    controlIntegration,
    browserRuntime,
    browserIntegration,
    phoneIntegration,
    connectedAppsIntegration,
    agentsIntegration,
    vpsThreadStarted,
    vpsThreadEnded,
  },
  prompts: {
    approvalModeForTurn,
    roomHandoffProblem,
    coordinationSystemInstructions,
    outstandingAssignmentsPrompt,
    teamComputerPrompt,
    inheritedTeamComputer,
    teammateReportContext,
    availableSkills,
  },
  handoffs: {
    roomHandoffs,
    turnHandoffs,
  },
  titles: {
    generateThreadTitle,
  },
  incidents: {
    reportIncident,
  },
});

  return {
    startTurn, drainThreadDelegations, expireDelegationsNow, DELEGATION_SWEEP_MS,
    retryDelegationsWaitingOn, drainQueuedSends, startOrQueueDirectMessage,
    startOrQueueOpenedThread, MAX_THREADS_OPENED_PER_TURN,
  };
}

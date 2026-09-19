// The server's client event pipeline -- the SSE route wiring with its
// session/steer-queue subscriptions, the event-fold wiring, and the
// unattended/internal turn marks the fold reads -- extracted verbatim
// from index.ts. index.ts calls createEventsPipeline at the fan-out
// comment's original site and rebinds the region's names from its result,
// so initialization order and every downstream consumer are unchanged.
// unattendedThreads, its TTL, and internalTurnThreads move with the module
// (every consumer moved); groupSpeakers is declared here but shared by
// reference with the index.ts regions that read it. The turn-dispatch
// drains the fold calls through are wired later in index.ts, so they
// arrive as thunks resolved at call time.
import { createEventFold, type EventFoldDeps } from "./event-fold.ts";
import type { createBotViews } from "./bot-views.ts";
import type { Notification } from "./notify.ts";
import { onSteeredQueueChange } from "./steer-queue.ts";
import { threadBusy } from "./turn-admission.ts";
import { createEventsRoutes, type EventsRoutesOptions } from "./routes/events.ts";

/** Everything the pipeline reads from its host. The fold state and helper
 * families keep their EventFoldDeps shapes; configForAccess crosses
 * pre-wrapped because index.ts binds configForAccess/configStatus after
 * this factory runs. */
export interface EventsPipelineDeps {
  routes: {
    browserLive: { closeForOwner(sessionId: string): void };
    sessions: {
      isLive(sessionId: string): boolean;
      revalidateEmailSessions(): void;
      onSessionRevoked(callback: (sessionId: string) => void): void;
    };
    providerAuthSessions: { revokeOwner(sessionId: string): void };
    configForAccess: EventsRoutesOptions["configForAccess"];
  };
  fanout: {
    publicBotQueuedMessages: ReturnType<typeof createBotViews>["publicBotQueuedMessages"];
  };
  bus: EventFoldDeps["bus"];
  fold: Omit<EventFoldDeps["fold"], "groupSpeakers">;
  helpers: Omit<
    EventFoldDeps["helpers"],
    | "isUnattended"
    | "isInternalTurn"
    | "clearInternalTurn"
    | "drainThreadDelegations"
    | "retryDelegationsWaitingOn"
    | "drainQueuedSends"
  >;
  lateBound: EventFoldDeps["lateBound"];
  turnDispatch: {
    drainThreadDelegations(): (threadId: string) => void;
    retryDelegationsWaitingOn(): (botId: string) => void;
    drainQueuedSends(): () => void;
  };
}

export function createEventsPipeline(deps: EventsPipelineDeps) {
  const { browserLive, sessions, providerAuthSessions } = deps.routes;
  const configForAccess = deps.routes.configForAccess;
  const { publicBotQueuedMessages } = deps.fanout;
  const bus = deps.bus;
  const {
    generatedImagesByTurn, turnTriggers, retiredProviderTurns, groupGoalCoordinatorTurns,
    directTurnGenerationByThread, directFollowupTurns, settlingResourceOwners,
  } = deps.fold;
  const {
    shouldIgnoreProviderEvent, approvalModeForTurn, routineSourceOwner, routineSourceThread,
    generatedImageTurnKey, cancelDirectTurnDispatch, settleDirectCoordination, settleDirectFollowup,
    finalizeDelegationWatch, activeRoutineRunForThread, runningTurnInstance, releaseTurnResources,
    releaseLocalVmThread, localVmLeaseFor, localVmIdleFor, hasUnboundDiscardedGroupGoalTurn,
    reportIncident, vpsThreadEnded,
    groupGoalCoordinatorTurnForEvent, removeGroupGoalCoordinatorTurn, continueComputerSelection,
    pokeScreenPoller, stopScreenPoller, finalScreenFrame, drainConnectorResumes, drainSecretResumes,
    drainTeamSetupResumes, drainDelegationWakes,
  } = deps.helpers;
  // Wired later in index.ts (turn dispatch); each call resolves the thunk so
  // the fold keeps draining through the live functions.
  const drainThreadDelegations = (threadId: string): void => deps.turnDispatch.drainThreadDelegations()(threadId);
  const retryDelegationsWaitingOn = (botId: string): void => deps.turnDispatch.retryDelegationsWaitingOn()(botId);
  const drainQueuedSends = (): void => { deps.turnDispatch.drainQueuedSends()(); };

// ── SSE fan-out to clients ─────────────────────────────────────────────
// The fan-out machinery — client set, replay buffer, heartbeat, cursor
// math, and the /api/events endpoint — lives in ./routes/events.ts. index
// keeps the wiring to its own singletons, registered in the same order the
// inline code registered it.
const eventsRoutes = createEventsRoutes({
  closeForOwner: (sessionId) => browserLive.closeForOwner(sessionId),
  revalidateEmailSessions: () => sessions.revalidateEmailSessions(),
  isLive: (sessionId) => sessions.isLive(sessionId),
  configForAccess,
});
const broadcast = eventsRoutes.broadcast;
const closeSessionStreams = eventsRoutes.closeSessionStreams;
sessions.onSessionRevoked((sessionId) => {
  providerAuthSessions.revokeOwner(sessionId);
  closeSessionStreams(sessionId);
});
onSteeredQueueChange(() => broadcast({ kind: "bot.queued", queues: publicBotQueuedMessages() }));

// ── server-side event folding (upstream's ingestion worker, miniature) ──
// The canonical stream is the source of truth; the persisted transcript
// and every client view are projections of it.
// The fold state, stall watchdog, and ingestion subscribers live in
// ./event-fold.ts, wired here in the original registration order; the
// in-flight item/request message-id maps live in ./turn-fold.ts.

/** Put a notification on the wire. Clients decide what to do with it — a
 * desktop notification now, a push to a paired phone later. */
function notify(notification: Notification | null) {
  // nested rather than spread — the frame's own `kind` names the frame,
  // exactly like {kind:"message", message} and {kind:"bot", bot}
  if (notification) broadcast({ kind: "notify", notification });
}

// Group threads: the fold needs to know WHO is talking — the turn engine
// records the active member here before dispatching its turn.
const groupSpeakers = new Map<string, { botId: string; name: string; color: string }>();

const eventFold = createEventFold({
  bus,
  events: { broadcast, notify },
  fold: {
    groupSpeakers,
    generatedImagesByTurn,
    turnTriggers,
    retiredProviderTurns,
    groupGoalCoordinatorTurns,
    directTurnGenerationByThread,
    directFollowupTurns,
    settlingResourceOwners,
  },
  helpers: {
    shouldIgnoreProviderEvent,
    isUnattended,
    isInternalTurn,
    clearInternalTurn,
    approvalModeForTurn,
    routineSourceOwner,
    routineSourceThread,
    generatedImageTurnKey,
    cancelDirectTurnDispatch,
    settleDirectCoordination,
    settleDirectFollowup,
    finalizeDelegationWatch,
    reportIncident,
    vpsThreadEnded,
    activeRoutineRunForThread,
    runningTurnInstance,
    releaseTurnResources,
    releaseLocalVmThread,
    localVmLeaseFor,
    localVmIdleFor,
    hasUnboundDiscardedGroupGoalTurn,
    groupGoalCoordinatorTurnForEvent,
    removeGroupGoalCoordinatorTurn,
    continueComputerSelection,
    pokeScreenPoller,
    stopScreenPoller,
    finalScreenFrame,
    drainThreadDelegations,
    retryDelegationsWaitingOn,
    drainQueuedSends,
    drainConnectorResumes,
    drainSecretResumes,
    drainTeamSetupResumes,
    drainDelegationWakes,
  },
  lateBound: {
    routines: deps.lateBound.routines,
    localVmThreadTargets: deps.lateBound.localVmThreadTargets,
    handoffs: deps.lateBound.handoffs,
    runningTurnEngines: deps.lateBound.runningTurnEngines,
    pendingDelegationWakes: deps.lateBound.pendingDelegationWakes,
    commsBus: deps.lateBound.commsBus,
    screenPollers: deps.lateBound.screenPollers,
    SCREEN_SETTLE_TIMEOUT_MS: deps.lateBound.SCREEN_SETTLE_TIMEOUT_MS,
  },
});
const {
  lastReply, turnUsage, turnContext, roomStallCompletions, watchdog,
  ASK_BOT_TIMEOUT_MS, GROUP_GOAL_WAIT_MAX_MS, GROUP_GOAL_MAX_WAIT_EXHAUSTIONS,
} = eventFold;
watchdog.start();
eventFold.wireEventFold();

// Bots currently working with nobody at the keyboard — a webhook turn, or a
// turn a webhook-driven bot handed to a teammate. Auto mode is a decision
// someone made for turns they were present for, so these don't inherit it:
// the guard behind auto mode is a pattern list, not a security boundary, and
// it must not stand in for a human at 3am.
//
// Keyed by conversation: typing in one thread never makes a sibling webhook
// run attended. Idle marks expire rather than clearing on
// turn.completed: bus subscribers fire in registration order, and the
// delegation drain runs AFTER the main fold — clearing there would blank the
// flag before the hop that needs to read it. A busy bot never ages out, and a
// stale mark only ever means "ask a human", so this fails closed.
const unattendedThreads = new Map<string, { botId: string; at: number }>();
const UNATTENDED_TTL_MS = 30 * 60_000;

function markUnattended(botId: string, threadId: string) {
  unattendedThreads.set(threadId, { botId, at: Date.now() });
}
function clearUnattended(threadId: string) {
  unattendedThreads.delete(threadId);
}
function isUnattended(botId?: string | null, threadId?: string): boolean {
  if (!botId) return false;
  // Legacy peer callers without a thread fail closed if any of the bot's
  // work is unattended. Capability/event callers always pass the exact id.
  if (!threadId) return [...unattendedThreads].some(([id, mark]) => mark.botId === botId && isUnattended(botId, id));
  const mark = unattendedThreads.get(threadId);
  if (!mark || mark.botId !== botId) return false;
  // A long-running turn is still unattended even if its next approval comes
  // more than 30 minutes after the previous one. Only an idle bot may age
  // out; every positive read refreshes the inactivity window.
  if (Date.now() - mark.at > UNATTENDED_TTL_MS && !threadBusy(botId, threadId) && !groupSpeakers.has(threadId)) {
    unattendedThreads.delete(threadId);
    return false;
  }
  mark.at = Date.now();
  return true;
}

// Threads whose turn in flight was started by another BOT — an ask_bot hop,
// a drained delegation. The person asked ONE bot; the fan-out behind that
// answer is that bot's work, not mail addressed to them, so its completion
// raises no badge and no banner. Anything that genuinely needs a human still
// breaks through from its own path: a card that reached a person, a takeover,
// a peer-approval — none of which run through the completion fold.
//
// Keyed by THREAD because turn.completed carries nothing else, and derived
// from commsDepth, which every peer path already threads through. Every
// dispatch rewrites the flag, so a peer turn that dies before it starts can
// never silence the person's own next turn on that thread.
const internalTurnThreads = new Set<string>();

function markInternalTurn(threadId: string) {
  internalTurnThreads.add(threadId);
}
function clearInternalTurn(threadId: string) {
  internalTurnThreads.delete(threadId);
}
function isInternalTurn(threadId: string): boolean {
  return internalTurnThreads.has(threadId);
}

  return {
    eventsRoutes, broadcast, closeSessionStreams, notify, groupSpeakers,
    lastReply, turnUsage, turnContext, roomStallCompletions, watchdog,
    ASK_BOT_TIMEOUT_MS, GROUP_GOAL_WAIT_MAX_MS, GROUP_GOAL_MAX_WAIT_EXHAUSTIONS,
    markUnattended, clearUnattended, isUnattended, markInternalTurn, clearInternalTurn,
  };
}

import { createGroupTurnOperations } from "./group-turn-operations.ts";
import { createCheckedInputs } from "./checked-inputs.ts";
import { createDesktopApproval } from "./desktop-approval.ts";
import { PhoneSecretBridge } from "./phone-secret.ts";
import { EventBus } from "./harness/bus.ts";
import { ManagedDesktopProviders } from "./managed-desktop.ts";
import * as composio from "./composio.ts";
import { DATA_DIR } from "./config.ts";
import { registry } from "./runtime.ts";
import { createPeerAgentComms } from "./peer-agent-comms.ts";
import { createTurnIntegrations } from "./turn-integrations.ts";
import { createDelegationWatch } from "./delegation-watch.ts";
import { setIncidentReportHost } from "./incident-report.ts";
import { createComputerLifecycleWiring } from "./computer-lifecycle-wiring.ts";
import { createBotViews } from "./bot-views.ts";
import { createGroupState } from "./group-state.ts";
import { createEventsPipeline } from "./events-pipeline.ts";
import { groupGoalCoordinatorTurns, hasUnboundDiscardedGroupGoalTurn, removeGroupGoalCoordinatorTurn } from "./group-coordination.ts";
import type { BrowserCleanupCoordinator } from "./browser-lifecycle-cleanup.ts";
import type { SessionRegistry } from "./sessions.ts";
import type { ProviderAuthSessions } from "./provider-auth-sessions.ts";
import type { UsageTrigger } from "./usage-ledger.ts";
import type { mergeSkills } from "./skill-library.ts";
import type { RoutineManager } from "./routines.ts";
import type { WebhookManager } from "./webhooks.ts";
import type { ProviderFleet } from "./provider-fleet.ts";
import type { createDesktopBridge } from "./desktop-bridge.ts";
import type { createTurnDispatch } from "./turn-dispatch.ts";
import type { createRoutineLifecycle } from "./routine-lifecycle.ts";
import type { createCalendarRooms } from "./calendar-rooms.ts";
import type { createTurnSecrets } from "./turn-secrets.ts";
import type { createConfigViews } from "./config-views.ts";

type DesktopBridge = ReturnType<typeof createDesktopBridge>;
type TurnDispatch = ReturnType<typeof createTurnDispatch>;
type RoutineLifecycle = ReturnType<typeof createRoutineLifecycle>;
type CalendarRooms = ReturnType<typeof createCalendarRooms>;
type TurnSecrets = ReturnType<typeof createTurnSecrets>;
type ConfigViews = ReturnType<typeof createConfigViews>;

export interface EngineWiringDeps {
  postDesktopPrivateMessage: DesktopBridge["postDesktopPrivateMessage"];
  applyDesktopMutationTokenMessage: DesktopBridge["applyDesktopMutationTokenMessage"];
  onUtilityParentMessage: DesktopBridge["onUtilityParentMessage"];
  postUtilityParentMessage: DesktopBridge["postUtilityParentMessage"];
  browserCleanup: BrowserCleanupCoordinator;
  PORT: number;
  sessions: SessionRegistry;
  providerAuthSessions: ProviderAuthSessions;
  turnTriggers: Map<string, UsageTrigger>;
  availableSkills: () => ReturnType<typeof mergeSkills>;
  routines(): RoutineManager | null;
  webhooks(): WebhookManager;
  commsBus(): RoutineLifecycle["commsBus"];
  startTurn(): TurnDispatch["startTurn"];
  drainThreadDelegations(): TurnDispatch["drainThreadDelegations"];
  retryDelegationsWaitingOn(): TurnDispatch["retryDelegationsWaitingOn"];
  drainQueuedSends(): TurnDispatch["drainQueuedSends"];
  routineSourceOwner(): RoutineLifecycle["routineSourceOwner"];
  routineSourceThread(): RoutineLifecycle["routineSourceThread"];
  stopBotForEmergencyApprovalDowngrade(): RoutineLifecycle["stopBotForEmergencyApprovalDowngrade"];
  routineWiring(): RoutineLifecycle["routineWiring"];
  roomSetupPending(): CalendarRooms["roomSetupPending"];
  resolveReplyTarget(): CalendarRooms["resolveReplyTarget"];
  phoneSecretSubmissions(): TurnSecrets["phoneSecretSubmissions"];
  configStatus(): ConfigViews["configStatus"];
  configForAccess(): ConfigViews["configForAccess"];
  providerFleet(): ProviderFleet;
  providerInstancesChanging(): ProviderFleet["providerInstancesChanging"];
  stopCompanyInstances(): ProviderFleet["stopCompanyInstances"];
  localVmImageBusy(): boolean;
  localVmModeChangeBusy(): boolean;
  localVmProvisionBusy: { get(): boolean; set(value: boolean): void };
  browserEngineInstall: { get(): Promise<void> | null; set(value: Promise<void> | null): void };
  browserEngineInstallError: { get(): string | null; set(value: string | null): void };
}

export function createEngineWiring(deps: EngineWiringDeps) {
// ── group turn operations ─────────────────────────────────────────────────
// The group-turn operation lifecycle — begin/finish, goal-run cards, member
// waits, cancellation, handshake flags, activeGroupTurnForBot — lives in
// ./group-turn-operations.ts; updateGroupGoalRunProgress and
// groupProviderHandshakeStarted are imported from it directly by
// ./group-state.ts. The factory is
// wired here because createCheckedInputs just below is the earliest
// module-level by-value consumer (activeGroupTurnForBot); every other input
// is a thunk over consts this file declares further down.
const {
  beginGroupTurnOperation, finishGroupTurnOperation, finishGroupGoalRun,
  waitForGroupMemberBot, waitForChatRoomMember, groupProviderHandshakeSettled,
  cancelGroupTurnOperations, activeGroupTurnForBot,
} = createGroupTurnOperations({
  lateBound: {
    broadcast: (payload) => broadcast(payload),
    GROUP_GOAL_WAIT_MAX_MS: () => GROUP_GOAL_WAIT_MAX_MS,
    routines: () => deps.routines(),
    pendingDelegationWakes: () => pendingDelegationWakes,
    commsBus: () => deps.commsBus(),
    groupSpeakers: () => groupSpeakers,
    cancelTeamSetupResumesForThread: (threadId) => cancelTeamSetupResumesForThread(threadId),
    roomHandoffs: () => roomHandoffs,
    drainQueuedChannelSends: () => drainQueuedChannelSends(),
    markCancelledProviderHandshake: (threadId, ownerId) => markCancelledProviderHandshake(threadId, ownerId),
    clearCancelledProviderHandshake: (threadId, ownerId) => clearCancelledProviderHandshake(threadId, ownerId),
  },
  helpers: {
    publicGroupState: (group) => publicGroupState(group),
    notify: (notification) => notify(notification),
    routineSourceOwner: (run) => deps.routineSourceOwner()(run),
    routineSourceThread: (run) => deps.routineSourceThread()(run),
  },
});
// ── checked inputs ────────────────────────────────────────────────────────
// The request validators live in ./checked-inputs.ts: the pure ones are
// imported directly, and the model-selection pair comes from this factory
// because it reads the providerInstancesChanging set — a const this file
// destructures from providerFleet far below this site, hence the thunk.
const { checkedModelSelection, checkedTaskModelSwitch } = createCheckedInputs({
  lateBound: {
    providerInstancesChanging: () => deps.providerInstancesChanging(),
  },
  helpers: {
    activeGroupTurnForBot,
  },
});

// ── desktop trusted approval ──────────────────────────────────────────────
// The Electron-only approval-mode state machine lives in ./desktop-approval.ts.
// Its sole consumer is the parentPort listener just below (the call sits in
// a callback body, so it evaluates at runtime, never at module eval); wiring
// here keeps it ahead of that listener. The thunks read consts this file
// declares later: wireBot, wireTrustedApprovalBot, broadcast.
const handleDesktopTrustedApprovalMessage = createDesktopApproval({
  lateBound: {
    wireBot: () => wireBot,
    wireTrustedApprovalBot: () => wireTrustedApprovalBot,
    broadcast: () => broadcast,
  },
  helpers: {
    postDesktopPrivateMessage: deps.postDesktopPrivateMessage,
    checkedTaskModelSwitch,
    stopBotForEmergencyApprovalDowngrade: (botId) => deps.stopBotForEmergencyApprovalDowngrade()(botId),
  },
});

const phoneSecrets = new PhoneSecretBridge(deps.postDesktopPrivateMessage);
deps.onUtilityParentMessage((event) => {
  const message = event?.data;
  try {
    if (deps.applyDesktopMutationTokenMessage(message)) return;
    if (handleDesktopTrustedApprovalMessage(message)) return;
    if (deps.browserCleanup.receive(message)) return;
    if (phoneSecrets.receive(message)) return;
    composio.applyManagedBrokerMessage(message);
  } catch (error) {
    console.error(`[desktop-sync] rejected private parent message: ${error instanceof Error ? error.message : String(error)}`);
  }
});

const bus = new EventBus();
bus.attach(registry.instances());
let companyRuntimeReady!: () => void;
const companyRuntimeStarted = new Promise<void>(resolve => { companyRuntimeReady = resolve; });
const managedDesktop = new ManagedDesktopProviders({
  registry,
  dataDirectory: DATA_DIR,
  beforeReplace: ids => deps.stopCompanyInstances()(ids),
  afterReplace: ids => {
    for (const id of deps.providerInstancesChanging()) if (managedDesktop.owns(id)) deps.providerInstancesChanging().delete(id);
    bus.attach(ids.flatMap(id => { const instance = registry.get(id); return instance ? [instance] : []; }));
    // Existing renderer config events refresh /api/instances as well, so
    // Company grants and revocations appear without reloading the window.
    broadcast({ kind: "config", ...deps.configStatus()() });
  },
});
// Only Electron owns this port. There is deliberately no HTTP equivalent or
// config patch for its organization identity, endpoint, or model capability.
deps.onUtilityParentMessage(event => {
  const message = event.data as { type?: unknown; requestId?: unknown; connection?: unknown } | undefined;
  if (message?.type !== "openmausbot:managed-desktop") return;
  const requestId = typeof message.requestId === "string" && message.requestId.length <= 100 ? message.requestId : undefined;
  void companyRuntimeStarted.then(() => managedDesktop.apply(message.connection)).then(() => {
    deps.postUtilityParentMessage({ type: "openmausbot:managed-desktop-result", requestId, ok: true });
  }, () => {
    deps.postUtilityParentMessage({ type: "openmausbot:managed-desktop-result", requestId, ok: false, error: "Company connection could not be applied. Reconnect from desktop Settings." });
  });
});

// ── peer-agent comms wiring ────────────────────────────────────────────
// The internal-capability bearer predicates, the workspace sidebar and
// group-task schemas, and the agents proxy integration live in
// ./peer-agent-comms.ts; index.ts wires the factory at the region's
// original site and rebinds the names below. The local-VM lease names
// internalCapabilityIsActive reads -- produced by the computer lifecycle
// wired further down this file -- cross as thunks resolved at call time.
const {
  authorizedInternalCapability, internalCapabilityIsActive, MAX_COMMS_DEPTH, MAX_WORKSPACE_BOTS,
  createSidebarSectionSchema, createGroupTaskRequestSchema, phoneProxyPath, AGENTS_NODE_FLAG,
  agentsIntegration,
} = createPeerAgentComms({
  helpers: { PORT: deps.PORT, },
  lateBound: {
    localVmOwnerBusy: () => localVmOwnerBusy,
    localVmLeaseFor: (target) => localVmLeaseFor(target),
    localVmThreadTargets: () => localVmThreadTargets,
  },
});


// ── provider/turn integrations ──────────────────────────────────────────
// The direct-turn dispatch registry and the per-turn provider integrations
// (browser runtime + live viewer, temporary guest browsers, phone and
// connected-apps proxies, computer control) live in ./turn-integrations.ts.
// The factory is wired ahead of createDelegationWatch — the earliest
// module-level by-value consumer (retireProviderTurn) — because these were
// hoisted declarations here; thunks cover the deps declared below. The
// install lets stay in index.ts: the install endpoint and the maintenance
// idle gate read and write them; the summary reads them through thunks.
const {
  retiredProviderTurns, pendingCancelledProviderHandshakes, generatedImagesByTurn,
  generatedImageTurnKey, purgeGeneratedImagesForThread,
  markCancelledProviderHandshake, clearCancelledProviderHandshake,
  retireProviderTurn, shouldIgnoreProviderEvent,
  directTurnClaimIsCurrent, directTurnClaimExists, markDirectTurnDispatching,
  clearDirectTurnDispatch, cancelDirectTurnDispatch,
  browserRuntime, browserLive, temporaryBrowserSessions,
  currentBrowserSession, forgetTemporaryBrowser, browserIntegration, browserEngineSummary,
  phoneIntegration, connectedAppsIntegration,
  computerControlRevision, computerControl, controlLeaseIdSchema, controlIntegration,
} = createTurnIntegrations({
  lateBound: {
    broadcast: (payload) => broadcast(payload),
    cancelTeamSetupResumesForThread: (threadId) => cancelTeamSetupResumesForThread(threadId),
    inheritedTeamComputer: (bot) => inheritedTeamComputer(bot),
    browserEngineInstall: () => deps.browserEngineInstall.get(),
    browserEngineInstallError: () => deps.browserEngineInstallError.get() ?? undefined,
  },
  helpers: {
    postDesktopPrivateMessage: deps.postDesktopPrivateMessage,
  },
  constants: {
    PORT: deps.PORT,
    AGENTS_NODE_FLAG,
    phoneProxyPath,
  },
});

class DirectTurnSetupCancelled extends Error {}
const directTurnGenerationByThread = new Map<string, string>();
// Stop revokes credentials before completion, but the receipt must retain its
// exact provider-turn owner until that completion or explicit failure
// cleanup. The direct-followup registries, the delegation watch map and the
// peer-wake machinery live in ./delegation-watch.ts, wired here at the old
// declaration site; thunks cover the consts declared further below.
const {
  directFollowupTurns, directFollowupSettlers, directCoordinationSettlers,
  settleDirectCoordination, settleDirectFollowup,
  delegationWatch, delegationWakeBudget, pendingDelegationWakes,
  activeRoutineRunForThread, wakeUndispatchedDelegation, drainDelegationWakes,
  finalizeDelegationWatch, isExternalContextMarker, markTaskContextExternallyUpdated,
} = createDelegationWatch({
  lateBound: {
    roomHandoffs: () => roomHandoffs,
    routines: () => deps.routines(),
    startTurn: (botId, text, opts) => deps.startTurn()(botId, text, opts),
    commsBus: () => deps.commsBus(),
    turnInstance: (botId, runOn, threadId) => turnInstance(botId, runOn, threadId),
  },
  helpers: {
    retireProviderTurn,
    isUnattended: (botId, threadId) => isUnattended(botId, threadId),
    activeGroupTurnForBot,
  },
});


// ── incidents: a broken run reaches the Chief of Staff ──────────────────
// The delivery path lives in ./incident-report.ts and the policy in
// ./incidents.ts; the failure sites — dispatch settlement, the stall
// watchdog, turn completion, the routine wiring — import reportIncident
// directly. Bind its host here, after the delegation watch exists;
// roomHandoffs, notify and startTurn are declared further below, so they
// cross as thunks like every other factory above.
setIncidentReportHost({
  delegationWatch,
  roomHandoffs: () => roomHandoffs,
  notify: (notification) => notify(notification),
  activeGroupTurnForBot,
  startTurn: (botId, text, opts) => deps.startTurn()(botId, text, opts),
});


// ── computer / VM lifecycle ──────────────────────────────────────────────────────────
// The computer/VM lifecycle wiring -- the createComputerLifecycle and
// createScreenPollers rebinding, the shared-computer control surface, the
// turn cleanup with bindTurnComputer and the direct-thread interruptors,
// the ask_bot waiter, the team-computer store with the send sequencer and
// the browser-cleanup profile reconciliation -- lives in
// ./computer-lifecycle-wiring.ts; index.ts wires the factory at the
// region's original site and rebinds the names below. The names this file
// declares after the site (roomHandoffs, broadcast, startTurn, the events
// pipeline's timeout constants, isUnattended, routines and the local-VM
// busy flags) cross as thunks; followupsReady is reassigned by the listen
// and shutdown handlers, so it crosses back as a { get, set } accessor.
const {
  localVmOwnerBusy, localVmLeases, localVmLifecycleBusy, localVmThreadTargets, localVmActiveThreads,
  localVmSeen, noteLocalVmSeen, activeVpsThreads, boxLifecycleBusyBots, vpsPreviewRequests,
  orphanBoxLifecycleBusyIds, computerProviderConfigTransitions,
  checkpointRestoreLeases, LOCAL_VM_IDLE_MS, LOCAL_VM_DESKTOP_WAIT_MS, localVmIdles,
  inheritedTeamComputer, teamComputerPrompt, botComputerControlKey, botComputerControlSnapshot,
  teamComputerInUse, assertTeamControlCanBeTaken, claimTeamComputerLifecycle, assertTeamComputerChangeIdle,
  teamComputersPayload, attachTeamBox, managedBoxOwners, botHasActiveTurn, providerTransitionMessage,
  providerOperationConflict, turnSurfacePlan, turnProvider, turnInstance, computerPreviewBot,
  computerPreviewSurface, selectableComputers, continueComputerSelection, runningTurnEngines,
  runningTurnInstance, providerTransitionForTurn, claimBoxInventoryRequest, claimManagedBoxMutation,
  claimBotComputerLifecycle, claimManagedVpsMutation, localVmTargetForBot, localVmLeaseFor, localVmIdleFor,
  releaseLocalVmThread, localVmInventoryPayload,
  screenPollers, SCREEN_SETTLE_TIMEOUT_MS, startScreenPoller, pokeScreenPoller, stopScreenPoller, finalScreenFrame,
  sharedComputerControl, turnCleanup, releaseTurnResources, interruptDirectThread, settlingResourceOwners,
  autoVmClaims, bindTurnComputer, parksBehindCoordination, unattendedDispatchState, interruptAllDirectThreads,
  askBotAndWait, teamComputers, sendSequencer, followupsReady,
} = createComputerLifecycleWiring({
  helpers: {
    bus, browserCleanup: deps.browserCleanup, activeGroupTurnForBot, controlIntegration, computerControl, computerControlRevision,
    currentBrowserSession, cancelDirectTurnDispatch, shouldIgnoreProviderEvent,
    DirectTurnSetupCancelled, directTurnGenerationByThread,
  },
  lateBound: {
    routines: () => deps.routines(),
    localVmImageBusy: () => deps.localVmImageBusy(),
    startTurn: (botId, text, opts) => deps.startTurn()(botId, text, opts),
  roomHandoffs: () => roomHandoffs,
    broadcast: () => broadcast,
    ASK_BOT_TIMEOUT_MS: () => ASK_BOT_TIMEOUT_MS,
    GROUP_GOAL_WAIT_MAX_MS: () => GROUP_GOAL_WAIT_MAX_MS,
    isUnattended: (botId, threadId) => isUnattended(botId, threadId),
  },
});


// ── bot wire views ──────────────────────────────────────────────────────
// The client-facing wire views and the approval-policy predicates live in
// ./bot-views.ts: wireTask/wireBot/wireTrustedApprovalBot/publicBot with
// the queued-steer snapshot, the system-prompt preview and overview
// builders, and the approvalModeForTurn/fullAccessForSource family.
// index.ts wires createBotViews at the cluster's original site —
// turnInstance, inheritedTeamComputer and teamComputerPrompt, produced by
// createComputerLifecycle above, arrive by value; connectorThread,
// roomHandoffs, routines and webhooks, declared after this site, arrive as
// thunks. activeCoordinationForThread is module state there, bound to
// roomHandoffs.activeDirect at its original assignment site below.
const {
  wireTask, wireBot, wireTrustedApprovalBot, previewSystemPrompt, botOverview,
  approvalModeForTurn, fullAccessForSource, peerReviewRequired, delegatedFullAccess,
  grantDelegatedFullAccess, roomTurnApprovalMode, storedAvatarExists, publicBot,
  publicBotQueuedMessages,
} = createBotViews({
  lateBound: {
    connectorThread: (botId, threadId) => connectorThread(botId, threadId),
    roomHandoffs: () => roomHandoffs,
    routines: () => deps.routines(),
    webhooks: () => deps.webhooks(),
  },
  helpers: { turnInstance, inheritedTeamComputer, teamComputerPrompt },
});

// ── group coordination ─────────────────────────────────────────────────
// The group state cluster -- channel CRUD, the deferred-resume queues,
// Local VM turn prep, the room/goal turn engine, the room-handoff registry
// with the store change fold, and the message pages -- lives in
// ./group-state.ts; index.ts wires the factory at the region's original
// site and rebinds its names below. The helpers crossed by value from the
// factories wired above; the lateBound slice reads names this file declares
// further down (events pipeline, turn dispatch, provider fleet) plus the
// calendar-room helpers from ./calendar-rooms.ts, all resolved at call time.
const {
  groupGoalCoordinatorTurnForEvent, channelTaskBlocked, roomHandoffProblem,
  coordinationSystemInstructions,
  createChannel, updateChannel, outstandingAssignmentsPrompt,
  pendingTeamSetupResumes, teamSetupResumeGenerations, cancelTeamSetupResumesForThread,
  dispatchTeamSetupResume, drainTeamSetupResumes,
  connectorThread, connectorMessage, maybeResumeConnectors, drainConnectorResumes,
  secretMessage, resumeSecretCard, drainSecretResumes,
  localVmPayload, readyLocalVmForTurn, existingPerBotLocalVmCount, perBotLocalVmCountForModeChange,
  teammateReportContext, roomPostBudgets, startGroupTurn, drainQueuedChannelSends,
  roomHandoffs, publicGroupState, groupWithThread,
  DEFAULT_PAGE, pageSize, messagePage, messageWindow,
} = createGroupState({
  helpers: {
    bus, MAX_COMMS_DEPTH, DirectTurnSetupCancelled,
    retireProviderTurn, shouldIgnoreProviderEvent, markCancelledProviderHandshake,
    clearCancelledProviderHandshake, pendingCancelledProviderHandshakes,
    providerTransitionForTurn, turnInstance, boxLifecycleBusyBots,
    localVmLeaseFor, localVmIdleFor, localVmTargetForBot, localVmThreadTargets,
    localVmActiveThreads, localVmOwnerBusy, localVmLifecycleBusy,
    LOCAL_VM_IDLE_MS, LOCAL_VM_DESKTOP_WAIT_MS, noteLocalVmSeen, releaseLocalVmThread,
    attachTeamBox, inheritedTeamComputer, teamComputerPrompt,
    controlIntegration, browserIntegration, phoneIntegration, connectedAppsIntegration, agentsIntegration,
    runningTurnEngines,
    beginGroupTurnOperation, finishGroupTurnOperation, finishGroupGoalRun,
    waitForGroupMemberBot, waitForChatRoomMember, groupProviderHandshakeSettled, activeGroupTurnForBot,
    releaseTurnResources, interruptDirectThread, startScreenPoller,
    roomTurnApprovalMode, fullAccessForSource, wireBot, publicBotQueuedMessages,
    availableSkills: deps.availableSkills, bindTurnComputer, markTaskContextExternallyUpdated,
  },
  lateBound: {
    broadcast: (payload) => broadcast(payload),
    watchdog: () => watchdog,
    roomStallCompletions: () => roomStallCompletions,
    groupSpeakers: () => groupSpeakers,
    markInternalTurn: (threadId) => markInternalTurn(threadId),
    isUnattended: (botId, threadId) => isUnattended(botId, threadId),
    markUnattended: (botId, threadId) => markUnattended(botId, threadId),
    GROUP_GOAL_WAIT_MAX_MS: () => GROUP_GOAL_WAIT_MAX_MS,
    GROUP_GOAL_MAX_WAIT_EXHAUSTIONS: () => GROUP_GOAL_MAX_WAIT_EXHAUSTIONS,
    providerFleet: () => deps.providerFleet(),
    providerInstancesChanging: () => deps.providerInstancesChanging(),
    drainQueuedSends: () => deps.drainQueuedSends()(),
    retryDelegationsWaitingOn: (botId) => deps.retryDelegationsWaitingOn()(botId),
    startTurn: (botId, text, opts) => deps.startTurn()(botId, text, opts),
    followupsReady: () => followupsReady.get(),
    localVmImageBusy: () => deps.localVmImageBusy(),
    localVmModeChangeBusy: () => deps.localVmModeChangeBusy(),
    setLocalVmProvisionBusy: (value) => { deps.localVmProvisionBusy.set(value); },
    roomSetupPending: (group) => deps.roomSetupPending()(group),
    resolveReplyTarget: (threadId, value) => deps.resolveReplyTarget()(threadId, value),
    routines: () => deps.routines(),
    routineWiring: () => deps.routineWiring(),
    phoneSecretSubmissions: () => deps.phoneSecretSubmissions(),
  },
});


// ── SSE fan-out to clients ────────────────────────────────────────────────────────────────────
// The fan-out wiring, the event fold wiring, and the unattended/internal
// turn marks live in ./events-pipeline.ts; index.ts wires the factory at
// the region's original site and rebinds its names below. The turn-dispatch
// drains arrive as thunks because turn dispatch is wired further down.
const {
  eventsRoutes, broadcast, closeSessionStreams, notify, groupSpeakers,
  lastReply, turnUsage, turnContext, roomStallCompletions, watchdog,
  ASK_BOT_TIMEOUT_MS, GROUP_GOAL_WAIT_MAX_MS, GROUP_GOAL_MAX_WAIT_EXHAUSTIONS,
  markUnattended, clearUnattended, isUnattended, markInternalTurn, clearInternalTurn,
} = createEventsPipeline({
  routes: {
    browserLive,
    sessions: deps.sessions,
    providerAuthSessions: deps.providerAuthSessions,
    configForAccess: (status, admin) => deps.configForAccess()(status as ReturnType<ConfigViews["configStatus"]>, admin),
  },
  fanout: { publicBotQueuedMessages },
  bus,
  fold: {
    generatedImagesByTurn, turnTriggers: deps.turnTriggers, retiredProviderTurns, groupGoalCoordinatorTurns,
    directTurnGenerationByThread, directFollowupTurns, settlingResourceOwners,
  },
  helpers: {
    shouldIgnoreProviderEvent,
    approvalModeForTurn,
    routineSourceOwner: (run) => deps.routineSourceOwner()(run),
    routineSourceThread: (run) => deps.routineSourceThread()(run),
    generatedImageTurnKey,
    cancelDirectTurnDispatch,
    settleDirectCoordination,
    settleDirectFollowup,
    finalizeDelegationWatch,
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
    drainConnectorResumes,
    drainSecretResumes,
    drainTeamSetupResumes,
    drainDelegationWakes,
  },
  lateBound: {
    routines: () => deps.routines(),
    localVmThreadTargets: () => localVmThreadTargets,
    activeVpsThreads: () => activeVpsThreads,
    runningTurnEngines: () => runningTurnEngines,
    pendingDelegationWakes: () => pendingDelegationWakes,
    commsBus: () => deps.commsBus(),
    screenPollers: () => screenPollers,
    SCREEN_SETTLE_TIMEOUT_MS: () => SCREEN_SETTLE_TIMEOUT_MS,
  },
  turnDispatch: {
    drainThreadDelegations: () => deps.drainThreadDelegations(),
    retryDelegationsWaitingOn: () => deps.retryDelegationsWaitingOn(),
    drainQueuedSends: () => deps.drainQueuedSends(),
  },
});
  return {
  ASK_BOT_TIMEOUT_MS,
  DEFAULT_PAGE,
  DirectTurnSetupCancelled,
  LOCAL_VM_IDLE_MS,
  MAX_COMMS_DEPTH,
  MAX_WORKSPACE_BOTS,
  activeGroupTurnForBot,
  activeRoutineRunForThread,
  activeVpsThreads,
  agentsIntegration,
  approvalModeForTurn,
  askBotAndWait,
  assertTeamComputerChangeIdle,
  assertTeamControlCanBeTaken,
  attachTeamBox,
  authorizedInternalCapability,
  autoVmClaims,
  bindTurnComputer,
  botComputerControlKey,
  botComputerControlSnapshot,
  botHasActiveTurn,
  botOverview,
  boxLifecycleBusyBots,
  broadcast,
  browserEngineSummary,
  browserIntegration,
  browserLive,
  browserRuntime,
  bus,
  cancelDirectTurnDispatch,
  cancelGroupTurnOperations,
  cancelTeamSetupResumesForThread,
  channelTaskBlocked,
  checkedModelSelection,
  checkedTaskModelSwitch,
  checkpointRestoreLeases,
  claimBotComputerLifecycle,
  claimBoxInventoryRequest,
  claimManagedBoxMutation,
  claimManagedVpsMutation,
  claimTeamComputerLifecycle,
  clearCancelledProviderHandshake,
  clearDirectTurnDispatch,
  clearInternalTurn,
  clearUnattended,
  closeSessionStreams,
  companyRuntimeReady,
  computerControl,
  computerControlRevision,
  computerPreviewBot,
  computerPreviewSurface,
  computerProviderConfigTransitions,
  connectedAppsIntegration,
  connectorMessage,
  connectorThread,
  controlIntegration,
  controlLeaseIdSchema,
  coordinationSystemInstructions,
  createChannel,
  createGroupTaskRequestSchema,
  createSidebarSectionSchema,
  currentBrowserSession,
  delegatedFullAccess,
  delegationWakeBudget,
  delegationWatch,
  directCoordinationSettlers,
  directFollowupSettlers,
  directFollowupTurns,
  directTurnClaimExists,
  directTurnClaimIsCurrent,
  directTurnGenerationByThread,
  dispatchTeamSetupResume,
  drainConnectorResumes,
  drainDelegationWakes,
  drainQueuedChannelSends,
  drainSecretResumes,
  drainTeamSetupResumes,
  eventsRoutes,
  existingPerBotLocalVmCount,
  finalizeDelegationWatch,
  followupsReady,
  forgetTemporaryBrowser,
  fullAccessForSource,
  grantDelegatedFullAccess,
  groupSpeakers,
  groupWithThread,
  inheritedTeamComputer,
  internalCapabilityIsActive,
  interruptAllDirectThreads,
  interruptDirectThread,
  isExternalContextMarker,
  isUnattended,
  lastReply,
  localVmActiveThreads,
  localVmIdleFor,
  localVmIdles,
  localVmInventoryPayload,
  localVmLeaseFor,
  localVmLeases,
  localVmLifecycleBusy,
  localVmOwnerBusy,
  localVmPayload,
  localVmSeen,
  localVmTargetForBot,
  localVmThreadTargets,
  managedBoxOwners,
  managedDesktop,
  markDirectTurnDispatching,
  markInternalTurn,
  markUnattended,
  maybeResumeConnectors,
  messagePage,
  messageWindow,
  noteLocalVmSeen,
  notify,
  orphanBoxLifecycleBusyIds,
  outstandingAssignmentsPrompt,
  pageSize,
  parksBehindCoordination,
  peerReviewRequired,
  pendingCancelledProviderHandshakes,
  pendingDelegationWakes,
  pendingTeamSetupResumes,
  perBotLocalVmCountForModeChange,
  phoneIntegration,
  phoneSecrets,
  previewSystemPrompt,
  providerOperationConflict,
  providerTransitionForTurn,
  providerTransitionMessage,
  publicBot,
  publicBotQueuedMessages,
  publicGroupState,
  purgeGeneratedImagesForThread,
  readyLocalVmForTurn,
  releaseLocalVmThread,
  releaseTurnResources,
  resumeSecretCard,
  retireProviderTurn,
  roomHandoffProblem,
  roomHandoffs,
  roomPostBudgets,
  runningTurnEngines,
  runningTurnInstance,
  secretMessage,
  selectableComputers,
  sendSequencer,
  settleDirectCoordination,
  settleDirectFollowup,
  settlingResourceOwners,
  sharedComputerControl,
  startGroupTurn,
  screenPollers,
  startScreenPoller,
  stopScreenPoller,
  storedAvatarExists,
  teamComputerInUse,
  teamComputerPrompt,
  teamComputers,
  teamComputersPayload,
  teamSetupResumeGenerations,
  teammateReportContext,
  temporaryBrowserSessions,
  turnCleanup,
  turnContext,
  turnInstance,
  turnProvider,
  turnSurfacePlan,
  turnUsage,
  unattendedDispatchState,
  updateChannel,
  vpsPreviewRequests,
  wakeUndispatchedDelegation,
  watchdog,
  wireBot,
  wireTask,
  };
}

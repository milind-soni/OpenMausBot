import { createRunDelegatedTurn, createTurnDispatch } from "./turn-dispatch.ts";
import { createRoutineLifecycle } from "./routine-lifecycle.ts";
import { createBotLifecycle } from "./bot-lifecycle.ts";
import { createTeamSetupLifecycle } from "./team-setup-lifecycle.ts";
import { createCalendarRooms } from "./calendar-rooms.ts";
import { createSkillLifecycle } from "./skill-lifecycle.ts";
import { createTurnSecrets } from "./turn-secrets.ts";
import { createConfigViews } from "./config-views.ts";
import { groupIsWorking } from "./group-coordination.ts";
import { store } from "./runtime.ts";
import type { BrowserCleanupCoordinator } from "./browser-lifecycle-cleanup.ts";
import type { CalendarCallManager } from "./calendar-calls.ts";
import type { RoutineManager } from "./routines.ts";
import type { WebhookManager } from "./webhooks.ts";
import type { ProviderFleet } from "./provider-fleet.ts";
import type { mergeSkills } from "./skill-library.ts";
import type { createEngineWiring } from "./engine-wiring.ts";

type EngineWiring = ReturnType<typeof createEngineWiring>;

export interface WorkflowWiringDeps {
  isUnattended: EngineWiring["isUnattended"];
  delegationWatch: EngineWiring["delegationWatch"];
  activeRoutineRunForThread: EngineWiring["activeRoutineRunForThread"];
  finalizeDelegationWatch: EngineWiring["finalizeDelegationWatch"];
  broadcast: EngineWiring["broadcast"];
  notify: EngineWiring["notify"];
  watchdog: EngineWiring["watchdog"];
  activeGroupTurnForBot: EngineWiring["activeGroupTurnForBot"];
  providerTransitionForTurn: EngineWiring["providerTransitionForTurn"];
  turnSurfacePlan: EngineWiring["turnSurfacePlan"];
  turnProvider: EngineWiring["turnProvider"];
  turnInstance: EngineWiring["turnInstance"];
  checkpointRestoreLeases: EngineWiring["checkpointRestoreLeases"];
  boxLifecycleBusyBots: EngineWiring["boxLifecycleBusyBots"];
  MAX_COMMS_DEPTH: EngineWiring["MAX_COMMS_DEPTH"];
  isExternalContextMarker: EngineWiring["isExternalContextMarker"];
  directTurnGenerationByThread: EngineWiring["directTurnGenerationByThread"];
  directFollowupTurns: EngineWiring["directFollowupTurns"];
  directFollowupSettlers: EngineWiring["directFollowupSettlers"];
  directCoordinationSettlers: EngineWiring["directCoordinationSettlers"];
  settleDirectCoordination: EngineWiring["settleDirectCoordination"];
  settleDirectFollowup: EngineWiring["settleDirectFollowup"];
  directTurnClaimExists: EngineWiring["directTurnClaimExists"];
  directTurnClaimIsCurrent: EngineWiring["directTurnClaimIsCurrent"];
  markDirectTurnDispatching: EngineWiring["markDirectTurnDispatching"];
  clearDirectTurnDispatch: EngineWiring["clearDirectTurnDispatch"];
  pendingCancelledProviderHandshakes: EngineWiring["pendingCancelledProviderHandshakes"];
  clearCancelledProviderHandshake: EngineWiring["clearCancelledProviderHandshake"];
  retireProviderTurn: EngineWiring["retireProviderTurn"];
  runningTurnEngines: EngineWiring["runningTurnEngines"];
  DirectTurnSetupCancelled: EngineWiring["DirectTurnSetupCancelled"];
  turnUsage: EngineWiring["turnUsage"];
  turnContext: EngineWiring["turnContext"];
  personAskAt: Map<string, number>;
  drainConnectorResumes: EngineWiring["drainConnectorResumes"];
  drainSecretResumes: EngineWiring["drainSecretResumes"];
  drainTeamSetupResumes: EngineWiring["drainTeamSetupResumes"];
  drainDelegationWakes: EngineWiring["drainDelegationWakes"];
  releaseTurnResources: EngineWiring["releaseTurnResources"];
  settlingResourceOwners: EngineWiring["settlingResourceOwners"];
  autoVmClaims: EngineWiring["autoVmClaims"];
  releaseLocalVmThread: EngineWiring["releaseLocalVmThread"];
  startScreenPoller: EngineWiring["startScreenPoller"];
  stopScreenPoller: EngineWiring["stopScreenPoller"];
  screenPollers: EngineWiring["screenPollers"];
  markUnattended: EngineWiring["markUnattended"];
  clearUnattended: EngineWiring["clearUnattended"];
  markInternalTurn: EngineWiring["markInternalTurn"];
  clearInternalTurn: EngineWiring["clearInternalTurn"];
  delegationWakeBudget: EngineWiring["delegationWakeBudget"];
  localVmTargetForBot: EngineWiring["localVmTargetForBot"];
  localVmLeaseFor: EngineWiring["localVmLeaseFor"];
  localVmIdleFor: EngineWiring["localVmIdleFor"];
  localVmThreadTargets: EngineWiring["localVmThreadTargets"];
  localVmActiveThreads: EngineWiring["localVmActiveThreads"];
  localVmLifecycleBusy: EngineWiring["localVmLifecycleBusy"];
  localVmSeen: EngineWiring["localVmSeen"];
  localVmOwnerBusy: EngineWiring["localVmOwnerBusy"];
  readyLocalVmForTurn: EngineWiring["readyLocalVmForTurn"];
  bindTurnComputer: EngineWiring["bindTurnComputer"];
  attachTeamBox: EngineWiring["attachTeamBox"];
  controlIntegration: EngineWiring["controlIntegration"];
  browserRuntime: EngineWiring["browserRuntime"];
  browserIntegration: EngineWiring["browserIntegration"];
  phoneIntegration: EngineWiring["phoneIntegration"];
  connectedAppsIntegration: EngineWiring["connectedAppsIntegration"];
  agentsIntegration: EngineWiring["agentsIntegration"];
  activeVpsThreads: EngineWiring["activeVpsThreads"];
  approvalModeForTurn: EngineWiring["approvalModeForTurn"];
  roomHandoffProblem: EngineWiring["roomHandoffProblem"];
  coordinationSystemInstructions: EngineWiring["coordinationSystemInstructions"];
  outstandingAssignmentsPrompt: EngineWiring["outstandingAssignmentsPrompt"];
  teamComputerPrompt: EngineWiring["teamComputerPrompt"];
  inheritedTeamComputer: EngineWiring["inheritedTeamComputer"];
  teammateReportContext: EngineWiring["teammateReportContext"];
  availableSkills: () => ReturnType<typeof mergeSkills>;
  roomHandoffs: EngineWiring["roomHandoffs"];
  wakeUndispatchedDelegation: EngineWiring["wakeUndispatchedDelegation"];
  parksBehindCoordination: EngineWiring["parksBehindCoordination"];
  followupsReady: EngineWiring["followupsReady"];
  unattendedDispatchState: EngineWiring["unattendedDispatchState"];
  startGroupTurn: EngineWiring["startGroupTurn"];
  cancelGroupTurnOperations: EngineWiring["cancelGroupTurnOperations"];
  cancelDirectTurnDispatch: EngineWiring["cancelDirectTurnDispatch"];
  runningTurnInstance: EngineWiring["runningTurnInstance"];
  groupSpeakers: EngineWiring["groupSpeakers"];
  pendingDelegationWakes: EngineWiring["pendingDelegationWakes"];
  publicBot: EngineWiring["publicBot"];
  interruptAllDirectThreads: EngineWiring["interruptAllDirectThreads"];
  fullAccessForSource: EngineWiring["fullAccessForSource"];
  computerProviderConfigTransitions: EngineWiring["computerProviderConfigTransitions"];
  claimBotComputerLifecycle: EngineWiring["claimBotComputerLifecycle"];
  managedBoxOwners: EngineWiring["managedBoxOwners"];
  localVmLeases: EngineWiring["localVmLeases"];
  localVmIdles: EngineWiring["localVmIdles"];
  computerControl: EngineWiring["computerControl"];
  computerControlRevision: EngineWiring["computerControlRevision"];
  purgeGeneratedImagesForThread: EngineWiring["purgeGeneratedImagesForThread"];
  lastReply: EngineWiring["lastReply"];
  browserCleanup: BrowserCleanupCoordinator;
  browserLive: EngineWiring["browserLive"];
  forgetTemporaryBrowser: EngineWiring["forgetTemporaryBrowser"];
  pendingTeamSetupResumes: EngineWiring["pendingTeamSetupResumes"];
  cancelTeamSetupResumesForThread: EngineWiring["cancelTeamSetupResumesForThread"];
  assertTeamComputerChangeIdle: EngineWiring["assertTeamComputerChangeIdle"];
  connectorThread: EngineWiring["connectorThread"];
  checkedModelSelection: EngineWiring["checkedModelSelection"];
  wireBot: EngineWiring["wireBot"];
  teamSetupResumeGenerations: EngineWiring["teamSetupResumeGenerations"];
  dispatchTeamSetupResume: EngineWiring["dispatchTeamSetupResume"];
  MAX_WORKSPACE_BOTS: EngineWiring["MAX_WORKSPACE_BOTS"];
  secretMessage: EngineWiring["secretMessage"];
  resumeSecretCard: EngineWiring["resumeSecretCard"];
  phoneSecrets: EngineWiring["phoneSecrets"];
  managedDesktop: EngineWiring["managedDesktop"];
  browserEngineSummary: EngineWiring["browserEngineSummary"];
  localVmImageBusy(): boolean;
  localVmModeChangeBusy(): boolean;
  webhooks(): WebhookManager;
  providerFleet(): ProviderFleet;
  providerInstancesChanging(): ProviderFleet["providerInstancesChanging"];
  routines: { get(): RoutineManager | null; set(value: RoutineManager | null): void };
  calendarCalls: { get(): CalendarCallManager | null; set(value: CalendarCallManager | null): void };
}

export function createWorkflowWiring(deps: WorkflowWiringDeps) {
const runDelegatedTurn = createRunDelegatedTurn({
  helpers: { store, isUnattended: deps.isUnattended, delegationWatch: deps.delegationWatch, activeRoutineRunForThread: deps.activeRoutineRunForThread, finalizeDelegationWatch: deps.finalizeDelegationWatch },
  lateBound: { startTurn: (botId, text, opts) => startTurn(botId, text, opts) },
});

// ── turn dispatch (delegations, queued sends, direct turns) ───────────────────────────────────
// drainThreadDelegations, the delegation sweep and retry hooks, the queued
// send drain, the startOrQueue* entry points, and the createStartTurn
// wiring live in ./turn-dispatch.ts; index.ts wires the factory at the
// region's original site and rebinds its names below. commsBus,
// approvalBus, and followupsReady cross as thunks because index.ts binds
// them after this factory runs.
const {
  startTurn, drainThreadDelegations, expireDelegationsNow, DELEGATION_SWEEP_MS,
  retryDelegationsWaitingOn, drainQueuedSends, startOrQueueDirectMessage,
  startOrQueueOpenedThread, MAX_THREADS_OPENED_PER_TURN,
} = createTurnDispatch({
  startTurn: {
    events: { broadcast: deps.broadcast, notify: deps.notify, watchdog: deps.watchdog },
    admission: {
      activeGroupTurnForBot: deps.activeGroupTurnForBot,
      providerTransitionForTurn: deps.providerTransitionForTurn,
      turnSurfacePlan: deps.turnSurfacePlan,
      turnProvider: deps.turnProvider,
      turnInstance: deps.turnInstance,
      providerFleet: () => deps.providerFleet(),
      providerInstancesChanging: () => deps.providerInstancesChanging(),
      checkpointRestoreLeases: deps.checkpointRestoreLeases,
      boxLifecycleBusyBots: deps.boxLifecycleBusyBots,
      maxCommsDepth: deps.MAX_COMMS_DEPTH,
      isExternalContextMarker: deps.isExternalContextMarker,
    },
    dispatch: {
      directTurnGenerationByThread: deps.directTurnGenerationByThread,
      directFollowupTurns: deps.directFollowupTurns,
      directFollowupSettlers: deps.directFollowupSettlers,
      directCoordinationSettlers: deps.directCoordinationSettlers,
      settleDirectCoordination: deps.settleDirectCoordination,
      settleDirectFollowup: deps.settleDirectFollowup,
      directTurnClaimExists: deps.directTurnClaimExists,
      directTurnClaimIsCurrent: deps.directTurnClaimIsCurrent,
      markDirectTurnDispatching: deps.markDirectTurnDispatching,
      clearDirectTurnDispatch: deps.clearDirectTurnDispatch,
      pendingCancelledProviderHandshakes: deps.pendingCancelledProviderHandshakes,
      clearCancelledProviderHandshake: deps.clearCancelledProviderHandshake,
      retireProviderTurn: deps.retireProviderTurn,
      runningTurnEngines: deps.runningTurnEngines,
      DirectTurnSetupCancelled: deps.DirectTurnSetupCancelled,
    },
    fold: {
      turnUsage: deps.turnUsage,
      turnContext: deps.turnContext,
      personAskAt: deps.personAskAt,
      drains: {
        drainConnectorResumes: deps.drainConnectorResumes,
        drainSecretResumes: deps.drainSecretResumes,
        drainTeamSetupResumes: deps.drainTeamSetupResumes,
        drainDelegationWakes: deps.drainDelegationWakes,
      },
    },
    cleanup: {
      releaseTurnResources: deps.releaseTurnResources,
      settlingResourceOwners: deps.settlingResourceOwners,
      autoVmClaims: deps.autoVmClaims,
      releaseLocalVmThread: deps.releaseLocalVmThread,
      startScreenPoller: deps.startScreenPoller,
      stopScreenPoller: deps.stopScreenPoller,
      screenPollers: deps.screenPollers,
    },
    turnMarks: {
      markUnattended: deps.markUnattended,
      clearUnattended: deps.clearUnattended,
      markInternalTurn: deps.markInternalTurn,
      clearInternalTurn: deps.clearInternalTurn,
      delegationWakeBudget: deps.delegationWakeBudget,
    },
    routines: {
      routines: () => deps.routines.get(),
      activeRoutineRunForThread: deps.activeRoutineRunForThread,
    },
    localVm: {
      localVmTargetForBot: deps.localVmTargetForBot,
      localVmLeaseFor: deps.localVmLeaseFor,
      localVmIdleFor: deps.localVmIdleFor,
      localVmThreadTargets: deps.localVmThreadTargets,
      localVmActiveThreads: deps.localVmActiveThreads,
      localVmLifecycleBusy: deps.localVmLifecycleBusy,
      localVmSeen: deps.localVmSeen,
      localVmOwnerBusy: deps.localVmOwnerBusy,
      localVmImageBusy: () => deps.localVmImageBusy(),
      localVmModeChangeBusy: () => deps.localVmModeChangeBusy(),
      readyLocalVmForTurn: deps.readyLocalVmForTurn,
    },
    computers: {
      bindTurnComputer: deps.bindTurnComputer,
      attachTeamBox: deps.attachTeamBox,
      controlIntegration: deps.controlIntegration,
      browserRuntime: deps.browserRuntime,
      browserIntegration: deps.browserIntegration,
      phoneIntegration: deps.phoneIntegration,
      connectedAppsIntegration: deps.connectedAppsIntegration,
      agentsIntegration: deps.agentsIntegration,
      activeVpsThreads: deps.activeVpsThreads,
    },
    prompts: {
      approvalModeForTurn: deps.approvalModeForTurn,
      roomHandoffProblem: deps.roomHandoffProblem,
      coordinationSystemInstructions: deps.coordinationSystemInstructions,
      outstandingAssignmentsPrompt: deps.outstandingAssignmentsPrompt,
      teamComputerPrompt: deps.teamComputerPrompt,
      inheritedTeamComputer: deps.inheritedTeamComputer,
      teammateReportContext: deps.teammateReportContext,
      availableSkills: deps.availableSkills,
    },
    handoffs: {
      roomHandoffs: deps.roomHandoffs,
    },
  },
  helpers: {
    runDelegatedTurn,
    wakeUndispatchedDelegation: deps.wakeUndispatchedDelegation,
    parksBehindCoordination: deps.parksBehindCoordination,
  },
  lateBound: {
    commsBus: () => commsBus,
    approvalBus: () => approvalBus,
    followupsReady: () => deps.followupsReady.get(),
  },
});


// ── routines: persisted definitions → detached bot tasks ───────────────
// The scheduler's host wiring, its crash-recovery reconciliation, and the
// routine request lifecycle (source resolvers, emergency downgrade stop,
// request service, card projection/resolution) live in
// ./routine-lifecycle.ts; index.ts wires it here at the cluster's original
// site. The factories wired earlier above (group-turn-operations,
// events-pipeline, desktop-approval) take wrapper thunks over the source
// resolvers and the downgrade stop this factory returns.
const {
  routineSourceOwner, routineSourceThread, stopBotForEmergencyApprovalDowngrade,
  routineWiring, commsBus, routineRequests, routineTimeZone, agentRoutine,
  resolveAndSendRoutine,
} = createRoutineLifecycle({
  wiring: {
    events: { broadcast: deps.broadcast, notify: deps.notify },
    helpers: {
      unattendedDispatchState: deps.unattendedDispatchState, roomSetupPending: (group) => roomSetupPending(group), groupIsWorking, startGroupTurn: deps.startGroupTurn,
      cancelGroupTurnOperations: deps.cancelGroupTurnOperations, cancelDirectTurnDispatch: deps.cancelDirectTurnDispatch, runningTurnInstance: deps.runningTurnInstance,
    },
    state: { groupSpeakers: deps.groupSpeakers, delegationWatch: deps.delegationWatch, pendingDelegationWakes: deps.pendingDelegationWakes, publicBot: deps.publicBot, startTurn },
  },
  helpers: {
    interruptAllDirectThreads: deps.interruptAllDirectThreads, activeGroupTurnForBot: deps.activeGroupTurnForBot, fullAccessForSource: deps.fullAccessForSource,
    proposalPersistence: (botId, threadId) => proposalPersistence(botId, threadId),
    deliverCalendarCall: (call, scheduledFor) => deliverCalendarCall(call, scheduledFor),
  },
  host: {
    routines: () => deps.routines.get(),
    setRoutines: (next) => deps.routines.set(next),
    setCalendarCalls: (next) => deps.calendarCalls.set(next),
  },
});
const { deleteBotWithLifecycle } = createBotLifecycle({
  computer: {
    computerProviderConfigTransitions: deps.computerProviderConfigTransitions, boxLifecycleBusyBots: deps.boxLifecycleBusyBots, claimBotComputerLifecycle: deps.claimBotComputerLifecycle, managedBoxOwners: deps.managedBoxOwners,
    localVmOwnerBusy: deps.localVmOwnerBusy, localVmLeases: deps.localVmLeases, localVmLeaseFor: deps.localVmLeaseFor, localVmActiveThreads: deps.localVmActiveThreads, localVmLifecycleBusy: deps.localVmLifecycleBusy,
    localVmSeen: deps.localVmSeen, localVmIdles: deps.localVmIdles, activeVpsThreads: deps.activeVpsThreads, computerControl: deps.computerControl, computerControlRevision: deps.computerControlRevision,
  },
  helpers: {
    activeGroupTurnForBot: deps.activeGroupTurnForBot, interruptAllDirectThreads: deps.interruptAllDirectThreads, purgeGeneratedImagesForThread: deps.purgeGeneratedImagesForThread,
    settleDirectFollowup: deps.settleDirectFollowup, directTurnGenerationByThread: deps.directTurnGenerationByThread, stopScreenPoller: deps.stopScreenPoller, lastReply: deps.lastReply,
    browserCleanup: deps.browserCleanup, browserLive: deps.browserLive, forgetTemporaryBrowser: deps.forgetTemporaryBrowser, commsBus,
    pendingTeamSetupResumes: deps.pendingTeamSetupResumes, cancelTeamSetupResumesForThread: deps.cancelTeamSetupResumesForThread,
  },
  lateBound: {
    routines: () => deps.routines.get(),
    calendarCalls: () => deps.calendarCalls.get(),
    localVmModeChangeBusy: () => deps.localVmModeChangeBusy(),
    webhooks: () => deps.webhooks(),
    claimPhoneSecretBotDeletion: (botId) => claimPhoneSecretBotDeletion(botId),
  },
});

// ── team setup / profile request cards ──────────────────────────────────
// The ProfileRequestService and TeamSetupRequestService wiring with their
// card resolution/send helpers (including resolveAndSendProfile, which
// physically sat just before the WebhookManager wiring) live in
// ./team-setup-lifecycle.ts; index.ts wires it at profileRequests'
// original site. deleteBotWithLifecycle lives in ./bot-lifecycle.ts, wired
// above this cluster, and crosses by value.
const { profileRequests, teamSetupTeams, teamSetupRequests, resolveAndSendTeamSetup, resolveAndSendProfile } = createTeamSetupLifecycle({
  helpers: {
    fullAccessForSource: deps.fullAccessForSource, proposalPersistence: (botId, threadId) => proposalPersistence(botId, threadId), assertTeamComputerChangeIdle: deps.assertTeamComputerChangeIdle, connectorThread: deps.connectorThread,
    activeGroupTurnForBot: deps.activeGroupTurnForBot, checkedModelSelection: deps.checkedModelSelection, wireBot: deps.wireBot, teamSetupResumeGenerations: deps.teamSetupResumeGenerations,
    dispatchTeamSetupResume: deps.dispatchTeamSetupResume, broadcast: deps.broadcast, deleteBotWithLifecycle,
  },
  lateBound: { routines: () => deps.routines.get() },
  limits: { maxWorkspaceBots: deps.MAX_WORKSPACE_BOTS },
});

// ── config hot-reload ─────────────────────────────────────────────────
// The calendar-rooms cluster -- the room-handoff tick, the approval bus,
// calendar-call room provisioning and delivery, room setup/reply/post
// policy -- lives in ./calendar-rooms.ts; index.ts wires the factory at the
// region's original site so the interval starts at the same point in module
// evaluation order. roomSetupPending, resolveReplyTarget and
// deliverCalendarCall are consumed by factories wired earlier in this file,
// which pass wrapper thunks over the names returned here.
const {
  ROOM_POST_MAX_CHARS, approvalBus, ensureCalendarCallRoom, deliverCalendarCall,
  roomSetupPending, resolveReplyTarget, lastHumanRoomMessageAt, roomPostEligibility,
} = createCalendarRooms({
  helpers: { roomHandoffs: deps.roomHandoffs, broadcast: deps.broadcast, notify: deps.notify, fullAccessForSource: deps.fullAccessForSource, startGroupTurn: deps.startGroupTurn },
  lateBound: { calendarCalls: () => deps.calendarCalls.get() },
});


const {
  proposalPersistence, skillProposalPersistence, stagedSkillListing,
  stagedSkillCleanupsForThread, rejectDeletedThreadSkillStages, appendSkillRequestCard,
  resolveSkillRequest, sendSkillResolution,
} = createSkillLifecycle({
  helpers: { connectorThread: deps.connectorThread, fullAccessForSource: deps.fullAccessForSource },
});

// The phone-secret provisioning helpers live in ./turn-secrets.ts: the
// submission registry, the bot-deletion mutation claim, the desktop handoff
// prompt, the submission key, the card state read, and provideSecretFromPhone.
// Wired at their original site, after phoneSecrets and the deferred-resumes
// card helpers exist; every caller is a route below.
const {
  phoneSecretSubmissionKey, currentSecretState, provideSecretFromPhone,
  phoneSecretSubmissions, claimPhoneSecretBotDeletion, credentialDesktopHandoff,
} = createTurnSecrets({
  connectorThread: deps.connectorThread, secretMessage: deps.secretMessage, resumeSecretCard: deps.resumeSecretCard, phoneSecrets: deps.phoneSecrets,
});

// The config/instance settings views live in ./config-views.ts:
// configStatus and its admin/member projection, the MCP server view and
// persist, and describeInstances; the CLI pre-save probe arrives via the
// config-views import above. Wired at the helpers' original site, after
// managedDesktop and browserEngineSummary exist; the events
// configForAccess thunk above and the routes below read these consts
// only at request time.
const {
  configStatus, configForAccess, mcpServerResponse, mcpServerBody, persistMcpServers, describeInstances,
} = createConfigViews({ managedDesktop: deps.managedDesktop, browserEngineSummary: deps.browserEngineSummary });
  return {
  DELEGATION_SWEEP_MS,
  MAX_THREADS_OPENED_PER_TURN,
  ROOM_POST_MAX_CHARS,
  agentRoutine,
  appendSkillRequestCard,
  approvalBus,
  commsBus,
  configForAccess,
  configStatus,
  credentialDesktopHandoff,
  currentSecretState,
  deleteBotWithLifecycle,
  describeInstances,
  drainQueuedSends,
  drainThreadDelegations,
  ensureCalendarCallRoom,
  expireDelegationsNow,
  lastHumanRoomMessageAt,
  mcpServerBody,
  mcpServerResponse,
  persistMcpServers,
  phoneSecretSubmissionKey,
  phoneSecretSubmissions,
  profileRequests,
  proposalPersistence,
  provideSecretFromPhone,
  rejectDeletedThreadSkillStages,
  resolveAndSendProfile,
  resolveAndSendRoutine,
  resolveAndSendTeamSetup,
  resolveReplyTarget,
  resolveSkillRequest,
  retryDelegationsWaitingOn,
  roomPostEligibility,
  roomSetupPending,
  routineRequests,
  routineSourceOwner,
  routineSourceThread,
  routineTimeZone,
  routineWiring,
  sendSkillResolution,
  skillProposalPersistence,
  stagedSkillCleanupsForThread,
  stagedSkillListing,
  startOrQueueDirectMessage,
  startOrQueueOpenedThread,
  startTurn,
  stopBotForEmergencyApprovalDowngrade,
  teamSetupRequests,
  teamSetupTeams,
  };
}

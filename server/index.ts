// OpenMausBot server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { createServer } from "node:http";
import { join } from "node:path";

import { SharedComputers } from "./shared-computers.ts";

import { BrowserCleanupCoordinator } from "./browser-lifecycle-cleanup.ts";
import { createDesktopBridge } from "./desktop-bridge.ts";
import * as composio from "./composio.ts";
import {
  instanceConfigs,
  loadConfig,
  saveConfig,
  sharedComputersEnabled,
  DATA_DIR,
} from "./config.ts";
import { resetPathCache } from "./env-path.ts";
import type { UsageTrigger } from "./usage-ledger.ts";
import type { RequestAuth } from "./request-auth.ts";


import { EventBus } from "./harness/bus.ts";
import { ManagedDesktopProviders } from "./managed-desktop.ts";
import { titleFromLlm } from "./store.ts";

import { createBotLifecycle } from "./bot-lifecycle.ts";
import { createCalendarRooms } from "./calendar-rooms.ts";
import { createComputerLifecycleWiring } from "./computer-lifecycle-wiring.ts";
import { createPeerAgentComms } from "./peer-agent-comms.ts";
import { createEventsPipeline } from "./events-pipeline.ts";
import { runBootSequence } from "./boot-sequence.ts";
import { createGroupState } from "./group-state.ts";
import { createRoutineLifecycle } from "./routine-lifecycle.ts";
import { createSkillLifecycle } from "./skill-lifecycle.ts";
import { createTeamSetupLifecycle } from "./team-setup-lifecycle.ts";
import { createRunDelegatedTurn, createTurnDispatch } from "./turn-dispatch.ts";
import { RoutineManager } from "./routines.ts";
import { CalendarCallManager } from "./calendar-calls.ts";
import {
  browserEngineEncryptionKey,
  clearBrowserSessionState,
  browserEngineStatus,
  browserSessionId,
} from "./browser-engine.ts";



import type { WebhookIngress } from "./webhook-ingress.ts";
import { WebhookManager } from "./webhooks.ts";
import { loadBundledSkills, loadUserSkills, mergeSkills } from "./skill-library.ts";
import { createDelegationWatch } from "./delegation-watch.ts";
import { createTurnIntegrations } from "./turn-integrations.ts";
import {
  groupGoalCoordinatorTurns,
  groupIsWorking,
  hasUnboundDiscardedGroupGoalTurn,
  removeGroupGoalCoordinatorTurn,
} from "./group-coordination.ts";
import { createBotViews } from "./bot-views.ts";
import { createCheckedInputs } from "./checked-inputs.ts";
import { createDesktopApproval } from "./desktop-approval.ts";
import { createGroupTurnOperations } from "./group-turn-operations.ts";
import { createConfigViews } from "./config-views.ts";
import { createTurnSecrets } from "./turn-secrets.ts";
import {
  hostedWorkspaceConfiguration,
  hostedWorkspaceConfigured,
  type WorkspaceAccess,
} from "./enterprise.ts";
import { isWorkspaceBackupSessionControl } from "./workspace-backup-http.ts";
import { createRouteHandlers } from "./route-wiring.ts";
import { createRequestHandler } from "./request-handler.ts";
import { createServeStatic, json } from "./http.ts";
import {
  revokeAllInternalCapabilities,
  revokeInternalCapabilitiesForThread,
} from "./internal-capabilities.ts";
import { closeOpenApprovals } from "./turn-fold.ts";
import {
  cfg,
  ENVIRONMENT_ID,
  registry,
  store,
  workspaceMaintenance,
  workspaceRestore,
} from "./runtime.ts";
import {
  botForThread,
  directTurnBots,
  threadBusy,
  turnComputerResources,
  turnResourceOwners,
} from "./turn-admission.ts";
import { createProviderFleet } from "./provider-fleet.ts";
import { createCustomDomainVerifier, customDomainIpv4, normalizeCustomDomain } from "./custom-domain.ts";
import { allowedScopes, createEmailSignIn, parseAllowList } from "./account-signin.ts";
import { ProviderAuthSessions } from "./provider-auth-sessions.ts";
import {
  requestOrigin,
  resolveRequestAuth,
  parseCookies,
  serializeSessionCookie,
  sessionCookieName,
} from "./request-auth.ts";
import { cookieMaxAgeSeconds, SessionRegistry } from "./sessions.ts";
import { loadBrand } from "./brand.ts";
import { PhoneSecretBridge } from "./phone-secret.ts";

const PORT = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
const WEBHOOK_PORT = Number(process.env.OMB_WEBHOOK_PORT || PORT + 1);
const STATIC_DIR = process.env.OMB_STATIC_DIR || null;

function signInAllowList() {
  const current = loadConfig().signIn;
  return { admins: parseAllowList(current?.admins?.join(",")), members: parseAllowList(current?.members?.join(",")) };
}
const sessions = new SessionRegistry({
  file: join(DATA_DIR, "sessions.json"),
  emailScopesSnapshot: () => {
    const membership = signInAllowList();
    return (email) => allowedScopes(email, membership);
  },
  portalMembership: hostedWorkspaceConfiguration()?.portalMembership === true,
});
const sharedComputers = new SharedComputers(id => sessions.isLive(id));
const SESSION_COOKIE = sessionCookieName(PORT, ENVIRONMENT_ID);
const HOSTED_WORKSPACE = hostedWorkspaceConfigured();
let workspaceAccess: WorkspaceAccess | null = null;
const DESKTOP_MANAGED = process.env.OMB_DESKTOP_PARENT === "1";
// Empty is deliberately a deny-all bootstrap state. Only Electron's private
// utility-process port can replace it with the per-launch owner capability.
let desktopMutationToken: string | undefined = DESKTOP_MANAGED ? "" : undefined;
let companionMutationToken: string | undefined = DESKTOP_MANAGED ? "" : undefined;
// Where remote clients reach this server (a proxy's public address); pairing URLs use it.
const FALLBACK_PUBLIC_URL = process.env.OMB_PUBLIC_URL?.trim().replace(/\/+$/, "") || null;
const customDomainVerifier = createCustomDomainVerifier({ environmentId: ENVIRONMENT_ID });
// "Sign in with your email" on /pair: the allow-list is read per call so a
// Settings change or an env bootstrap applies without a restart.
const emailSignIn = createEmailSignIn({
  allow: signInAllowList,
});
function savedCustomDomain(): string | null {
  if (DESKTOP_MANAGED || !cfg.customDomain) return null;
  try { return normalizeCustomDomain(cfg.customDomain); }
  catch { return null; }
}
function publicUrl(): string | null { return savedCustomDomain() ?? FALLBACK_PUBLIC_URL; }
function customDomainStatus() {
  return {
    customDomain: savedCustomDomain(), publicUrl: publicUrl(), fallbackUrl: FALLBACK_PUBLIC_URL,
    supported: !DESKTOP_MANAGED, appPort: PORT, webhookPort: WEBHOOK_PORT,
    serverIpv4: DESKTOP_MANAGED ? null : customDomainIpv4(),
  };
}
// Who asked for the next turn on a thread, noted where a message comes in
// and read by the usage ledger when the turn settles. The last note stands
// until the next message: a resumed connector or a drained queued send
// still belongs to the person who wrote, and routine or peer turns are
// told apart before this is consulted.
const turnTriggers = new Map<string, UsageTrigger>();
/** Who a user message is from, when that is someone other than the desktop
 * owner. Loopback is the owner by design, so it stays unstamped and reads as
 * the profile name; a paired or signed-in session names the person, by
 * account email where there is one and otherwise by the device label they
 * chose while pairing. */
function messageSender(auth: RequestAuth): { name: string } | undefined {
  if (auth.kind !== "session") return undefined;
  const name = (auth.session.email ?? auth.session.label ?? "").trim();
  return name ? { name } : undefined;
}

function noteTurnTrigger(threadId: string, auth: RequestAuth): void {
  turnTriggers.set(
    threadId,
    auth.kind === "session"
      ? { kind: "user", ...(auth.session.email ? { email: auth.session.email } : {}), label: auth.session.label }
      : { kind: "owner" },
  );
}
const providerAuthSessions = new ProviderAuthSessions();
const bundledSkills = loadBundledSkills();
const availableSkills = () => mergeSkills(bundledSkills, loadUserSkills(join(DATA_DIR, "skills")));

const {
  postDesktopPrivateMessage,
  applyDesktopMutationTokenMessage,
  onUtilityParentMessage,
  postUtilityParentMessage,
} = createDesktopBridge({
  desktopMutationToken: { get: () => desktopMutationToken, set: (value) => { desktopMutationToken = value; } },
  companionMutationToken: { get: () => companionMutationToken, set: (value) => { companionMutationToken = value; } },
});
// Browser data of a deleted bot or profile: the engine's saved session
// state, cleared here on every host (the desktop no longer owns a browser).
// The coordinator keeps its durable journal and replay; this is its outbox.
const browserCleanup: BrowserCleanupCoordinator = new BrowserCleanupCoordinator({
  file: join(DATA_DIR, "browser-cleanups.json"),
  send: (request) => {
    const status = browserEngineStatus();
    // Guest sessions are throwaway and never saved, so only the bot's own
    // session and shared profile sessions have state to clear.
    const sessions = request.type === "openmausbot:browser-bot-deleted" && request.botId
      ? [browserSessionId(request.botId, "")]
      : request.partitionId
        ? [browserSessionId("", request.partitionId)]
        : [];
    // Failed erasure leaves the committed intent pending for retry; it must
    // never acknowledge that saved state was removed when it was not.
    const work = status.kind === "ready" && sessions.length
      ? Promise.all(sessions.map(async (session) => {
          const ok = await clearBrowserSessionState(status.binaryPath, session, { encryptionKey: browserEngineEncryptionKey() });
          if (!ok) console.warn(`browser cleanup: could not clear saved state for session ${session}; restart OpenMausBot to retry this profile's cleanup. Do not use state clear --all: it erases other profiles too.`);
          return ok;
        }))
      : Promise.resolve([true]);
    void work.then((results) => results.every(Boolean), (error) => {
      console.warn("browser cleanup: could not clear saved session state", error);
      return false;
    }).then((ok) => {
      browserCleanup.receive({ type: "openmausbot:browser-lifecycle-result", requestId: request.requestId, ok });
    }).catch((error) => {
      console.warn("browser cleanup: could not acknowledge cleanup", error);
    });
    return true;
  },
});
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
    routines: () => routines,
    pendingDelegationWakes: () => pendingDelegationWakes,
    commsBus: () => commsBus,
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
    routineSourceOwner: (run) => routineSourceOwner(run),
    routineSourceThread: (run) => routineSourceThread(run),
  },
});
// ── checked inputs ────────────────────────────────────────────────────────
// The request validators live in ./checked-inputs.ts: the pure ones are
// imported directly, and the model-selection pair comes from this factory
// because it reads the providerInstancesChanging set — a const this file
// destructures from providerFleet far below this site, hence the thunk.
const { checkedModelSelection, checkedTaskModelSwitch } = createCheckedInputs({
  lateBound: {
    providerInstancesChanging: () => providerInstancesChanging,
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
    postDesktopPrivateMessage,
    checkedTaskModelSwitch,
    stopBotForEmergencyApprovalDowngrade: (botId) => stopBotForEmergencyApprovalDowngrade(botId),
  },
});

const phoneSecrets = new PhoneSecretBridge(postDesktopPrivateMessage);
onUtilityParentMessage((event) => {
  const message = event?.data;
  try {
    if (applyDesktopMutationTokenMessage(message)) return;
    if (handleDesktopTrustedApprovalMessage(message)) return;
    if (browserCleanup.receive(message)) return;
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
  beforeReplace: ids => stopCompanyInstances(ids),
  afterReplace: ids => {
    for (const id of providerInstancesChanging) if (managedDesktop.owns(id)) providerInstancesChanging.delete(id);
    bus.attach(ids.flatMap(id => { const instance = registry.get(id); return instance ? [instance] : []; }));
    // Existing renderer config events refresh /api/instances as well, so
    // Company grants and revocations appear without reloading the window.
    broadcast({ kind: "config", ...configStatus() });
  },
});
// Only Electron owns this port. There is deliberately no HTTP equivalent or
// config patch for its organization identity, endpoint, or model capability.
onUtilityParentMessage(event => {
  const message = event.data as { type?: unknown; requestId?: unknown; connection?: unknown } | undefined;
  if (message?.type !== "openmausbot:managed-desktop") return;
  const requestId = typeof message.requestId === "string" && message.requestId.length <= 100 ? message.requestId : undefined;
  void companyRuntimeStarted.then(() => managedDesktop.apply(message.connection)).then(() => {
    postUtilityParentMessage({ type: "openmausbot:managed-desktop-result", requestId, ok: true });
  }, () => {
    postUtilityParentMessage({ type: "openmausbot:managed-desktop-result", requestId, ok: false, error: "Company connection could not be applied. Reconnect from desktop Settings." });
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
  helpers: { PORT },
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
// install lets stay in this file: the install endpoint and the maintenance
// idle gate read and write them; the summary reads them through thunks.
let browserEngineInstall: Promise<void> | null = null;
let browserEngineInstallError: string | null = null;
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
    browserEngineInstall: () => browserEngineInstall,
    browserEngineInstallError: () => browserEngineInstallError ?? undefined,
  },
  helpers: {
    postDesktopPrivateMessage,
  },
  constants: {
    PORT,
    AGENTS_NODE_FLAG,
    phoneProxyPath,
  },
});
export { browserEngineSummary };

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
  reportIncident, handoffs, isContextMessage,
} = createDelegationWatch({
  lateBound: {
    roomHandoffs: () => roomHandoffs,
    routines: () => routines,
    startTurn: (botId, text, opts) => startTurn(botId, text, opts),
    commsBus: () => commsBus,
  },
  helpers: {
    retireProviderTurn,
    isUnattended: (botId, threadId) => isUnattended(botId, threadId),
    activeGroupTurnForBot,
    turnInstance: (bot, runOn, threadId) => turnInstance(bot, runOn, threadId),
    notify: (notification) => notify(notification),
  },
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
  localVmSeen, noteLocalVmSeen, activeVpsThreads, vpsThreadStarted, vpsThreadEnded, boxLifecycleBusyBots, vpsPreviewRequests,
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
    turnResources,
  screenPollers, SCREEN_SETTLE_TIMEOUT_MS, startScreenPoller, pokeScreenPoller, stopScreenPoller, finalScreenFrame,
  sharedComputerControl, turnCleanup, releaseTurnResources, interruptDirectThread, settlingResourceOwners,
  autoVmClaims, bindTurnComputer, parksBehindCoordination, unattendedDispatchState, interruptAllDirectThreads,
  askBotAndWait, teamComputers, sendSequencer, followupsReady,
} = createComputerLifecycleWiring({
  helpers: {
    bus, browserCleanup, activeGroupTurnForBot, controlIntegration, computerControl, computerControlRevision,
    currentBrowserSession, cancelDirectTurnDispatch, shouldIgnoreProviderEvent,
    DirectTurnSetupCancelled, directTurnGenerationByThread,
  },
  lateBound: {
    routines: () => routines,
    localVmImageBusy: () => localVmImageBusy,
    startTurn: (botId, text, opts) => startTurn(botId, text, opts),
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
    routines: () => routines,
    webhooks: () => webhooks,
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
    availableSkills, generateThreadTitle, bindTurnComputer, markTaskContextExternallyUpdated,
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
    providerFleet: () => providerFleet,
    providerInstancesChanging: () => providerInstancesChanging,
    drainQueuedSends: () => drainQueuedSends(),
    retryDelegationsWaitingOn: (botId) => retryDelegationsWaitingOn(botId),
    startTurn: (botId, text, opts) => startTurn(botId, text, opts),
    followupsReady: () => followupsReady.get(),
    localVmImageBusy: () => localVmImageBusy,
    localVmModeChangeBusy: () => localVmModeChangeBusy,
    setLocalVmProvisionBusy: (value) => { localVmProvisionBusy = value; },
    roomSetupPending: (group) => roomSetupPending(group),
    resolveReplyTarget: (threadId, value) => resolveReplyTarget(threadId, value),
    routines: () => routines,
    routineWiring: () => routineWiring,
    phoneSecretSubmissions: () => phoneSecretSubmissions,
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
    sessions,
    providerAuthSessions,
    configForAccess: (status, admin) => configForAccess(status as ReturnType<typeof configStatus>, admin),
  },
  fanout: { publicBotQueuedMessages },
  bus,
  fold: {
    generatedImagesByTurn, turnTriggers, retiredProviderTurns, groupGoalCoordinatorTurns,
    directTurnGenerationByThread, directFollowupTurns, settlingResourceOwners,
  },
  helpers: {
    shouldIgnoreProviderEvent,
    approvalModeForTurn,
    routineSourceOwner: (run) => routineSourceOwner(run),
    routineSourceThread: (run) => routineSourceThread(run),
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
    drainConnectorResumes,
    drainSecretResumes,
    drainTeamSetupResumes,
    drainDelegationWakes,
  },
  lateBound: {
    routines: () => routines,
    localVmThreadTargets: () => localVmThreadTargets,
    handoffs: () => handoffs,
    runningTurnEngines: () => runningTurnEngines,
    pendingDelegationWakes: () => pendingDelegationWakes,
    commsBus: () => commsBus,
    screenPollers: () => screenPollers,
    SCREEN_SETTLE_TIMEOUT_MS: () => SCREEN_SETTLE_TIMEOUT_MS,
  },
  turnDispatch: {
    drainThreadDelegations: () => drainThreadDelegations,
    retryDelegationsWaitingOn: () => retryDelegationsWaitingOn,
    drainQueuedSends: () => drainQueuedSends,
  },
});

// When the person last wrote into each thread with a turn in flight — but
// only for turns THEY started. post_to_room's ceiling counts the bot posts
// nobody has answered, and "answered" used to mean a person writing in the
// room alone. A person driving one bot from its own conversation ("tell
// #planning we shipped", then two more) was refused the third post and
// told to go and ask the user — who had just asked. The person who wrote
// into the bot's thread is attending that post as surely as one writing
// in the room, so the ceiling reads this too. A scheduled or webhook turn,
// a peer hop, or a resumed card records nothing here: the user message
// such a turn finds in its thread may be hours old and its author gone.
const personAskAt = new Map<string, number>();
let routines: RoutineManager | null = null;
let calendarCalls: CalendarCallManager | null = null;
let localVmImageBusy = false;
let localVmProvisionBusy = false;
let localVmModeChangeBusy = false;
/** How long the computer-control gate lets a lazy claim land before it
 * answers held. A free, ready VM claims in the time of one container
 * inspect; only a claim queued behind another holder outlives this. */
const LAZY_VM_CLAIM_GRACE_MS = 5_000;

const runDelegatedTurn = createRunDelegatedTurn({
  helpers: { store, isUnattended, delegationWatch, activeRoutineRunForThread, finalizeDelegationWatch },
  lateBound: { startTurn: (botId, text, opts) => startTurn(botId, text, opts) },
});

async function generateThreadTitle(
  provider: { generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string> },
  text: string,
): Promise<string | null> {
  const prompt = [
    "Name the conversation that begins with the message below.",
    "Reply with only a short title: 3 to 6 words, plain text, no quotes, no trailing period.",
    "Message:",
    text.trim().slice(0, 1_500),
  ].join("\n");
  const expiry = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // the race caps the wait; the signal aborts the provider call itself,
    // which every generateText driver that can honor it does
    const reply = await Promise.race([
      provider.generateText!(prompt, { signal: expiry.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expiry.abort();
          reject(new Error("thread title timed out"));
        }, 10_000);
      }),
    ]);
    return titleFromLlm(reply);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
    events: { broadcast, notify, watchdog },
    admission: {
      activeGroupTurnForBot,
      providerTransitionForTurn,
      turnSurfacePlan,
      turnProvider,
      turnInstance,
      providerFleet: () => providerFleet,
      providerInstancesChanging: () => providerInstancesChanging,
      checkpointRestoreLeases,
      boxLifecycleBusyBots,
      maxCommsDepth: MAX_COMMS_DEPTH,
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
      drains: {
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
      routines: () => routines,
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
      localVmImageBusy: () => localVmImageBusy,
      localVmModeChangeBusy: () => localVmModeChangeBusy,
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
      turnHandoffs: handoffs,
    },
    titles: {
      generateThreadTitle,
    },
    incidents: {
      reportIncident,
    },
  },
  helpers: {
    runDelegatedTurn,
    wakeUndispatchedDelegation,
    parksBehindCoordination,
  },
  lateBound: {
    commsBus: () => commsBus,
    approvalBus: () => approvalBus,
    followupsReady: () => followupsReady.get(),
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
    events: { broadcast, notify },
    helpers: {
      unattendedDispatchState, roomSetupPending: (group) => roomSetupPending(group), groupIsWorking, startGroupTurn,
      cancelGroupTurnOperations, cancelDirectTurnDispatch, runningTurnInstance,
      reportIncident,
      handoffs,
    },
    state: { groupSpeakers, delegationWatch, pendingDelegationWakes, publicBot, startTurn },
  },
  helpers: {
    interruptAllDirectThreads, activeGroupTurnForBot, fullAccessForSource,
    proposalPersistence: (botId, threadId) => proposalPersistence(botId, threadId),
    deliverCalendarCall: (call, scheduledFor) => deliverCalendarCall(call, scheduledFor),
  },
  host: {
    routines: () => routines,
    setRoutines: (next) => { routines = next; },
    setCalendarCalls: (next) => { calendarCalls = next; },
  },
});
const { deleteBotWithLifecycle } = createBotLifecycle({
  computer: {
    computerProviderConfigTransitions, boxLifecycleBusyBots, claimBotComputerLifecycle, managedBoxOwners,
    localVmOwnerBusy, localVmLeases, localVmLeaseFor, localVmActiveThreads, localVmLifecycleBusy,
    localVmSeen, localVmIdles, activeVpsThreads, computerControl, computerControlRevision,
  },
  helpers: {
    activeGroupTurnForBot, interruptAllDirectThreads, purgeGeneratedImagesForThread,
    settleDirectFollowup, directTurnGenerationByThread, stopScreenPoller, lastReply,
    browserCleanup, browserLive, forgetTemporaryBrowser, commsBus,
    pendingTeamSetupResumes, cancelTeamSetupResumesForThread,
  },
  lateBound: {
    routines: () => routines,
    calendarCalls: () => calendarCalls,
    localVmModeChangeBusy: () => localVmModeChangeBusy,
    webhooks: () => webhooks,
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
    fullAccessForSource, proposalPersistence: (botId, threadId) => proposalPersistence(botId, threadId), assertTeamComputerChangeIdle, connectorThread,
    activeGroupTurnForBot, checkedModelSelection, wireBot, teamSetupResumeGenerations,
    dispatchTeamSetupResume, broadcast, deleteBotWithLifecycle,
  },
  lateBound: { routines: () => routines },
  limits: { maxWorkspaceBots: MAX_WORKSPACE_BOTS },
});

const webhooks = new WebhookManager({
  emit: broadcast,
  botState: unattendedDispatchState,
  enqueue: (input) => routines!.enqueueWebhook(input),
  findRun: (webhookId, deliveryId) => routines!.webhookRunReceipt(webhookId, deliveryId),
  cancelQueued: (webhookId, message) => routines!.cancelQueuedWebhook(webhookId, message),
  pendingRuns: (webhookId) => routines!.activeWebhookRunCount(webhookId),
});

let webhookIngress: WebhookIngress | null = null;
let webhookIngressError: string | null = null;

const webhookIngressStatus = () => ({
  available: Boolean(webhookIngress),
  baseUrl: webhookIngress?.baseUrl ?? `http://127.0.0.1:${WEBHOOK_PORT}`,
  ...(webhookIngressError ? { error: webhookIngressError } : {}),
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
  helpers: { roomHandoffs, broadcast, notify, fullAccessForSource, startGroupTurn },
  lateBound: { calendarCalls: () => calendarCalls },
});


const {
  proposalPersistence, skillProposalPersistence, stagedSkillListing,
  stagedSkillCleanupsForThread, rejectDeletedThreadSkillStages, appendSkillRequestCard,
  resolveSkillRequest, sendSkillResolution,
} = createSkillLifecycle({
  helpers: { connectorThread, fullAccessForSource },
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
  connectorThread, secretMessage, resumeSecretCard, phoneSecrets,
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
} = createConfigViews({ managedDesktop, browserEngineSummary });

/** Set once graceful shutdown begins: quitting disposes Company instances
 * without writing "connection changed" cards or failing routine runs. */
let companyShutdown = false;
// Config writes rebuild the whole provider registry. Keep the read-modify-write
// and reload sequence single-flight so two settings requests cannot drop one
// another's changes or dispose a fleet while another reload is creating it.
let providerConfigBusy = false;
const providerFleet = createProviderFleet({
  store,
  cfg,
  registry,
  bus,
  sessions: providerAuthSessions,
  watchdog,
  routines: () => routines,
  desktop: managedDesktop,
  turns: turnCleanup,
  companyShutdown: () => companyShutdown,
  admission: { threadBusy, botForThread, turnResourceOwners, directTurnGenerationByThread, directTurnBots },
  cleanup: {
    stopScreenPoller, releaseLocalVmThread, closeOpenApprovals, revokeInternalCapabilitiesForThread,
    revokeAllInternalCapabilities, runningTurnInstance, settleDirectFollowup, finalizeDelegationWatch,
    cancelGroupTurnOperations, cancelDirectTurnDispatch,
  },
  speakers: { groupSpeakers },
  vps: { vpsThreadEnded },
  persistence: { saveConfig, instanceConfigs, resetPathCache },
  drains: { drainQueuedSends, drainConnectorResumes, drainSecretResumes, drainTeamSetupResumes, retryDelegationsWaitingOn },
});
const { stopCompanyInstances, persistProviderInstance, reloadProviders, providerInstancesChanging } = providerFleet;

// ── HTTP plumbing ─────────────────────────────────────────────────────
/** The built UI, when this process serves it (OMB_STATIC_DIR: set by the
 * desktop app and by the container image). Public by design: it is the same
 * bundle anyone can download, holds no secrets, and a remote browser must be
 * able to load /pair before it has a session. Returns false when there is
 * nothing to serve so the caller can answer 404. */
const serveStatic = createServeStatic(STATIC_DIR);

// Loopback-only enforcement: the harness runs on 127.0.0.1 but accepts
// requests from any loopback connection and any web page that DNS-rebinds
// onto it. Reject non-loopback Hosts outright (defeats rebinding) and
// origins outside loopback (blocks remote-web CSRF).

const {
  workspaceBackupRoutes, routinesRoutes, internalRoutes, handleCalendarCalls, handleMessages,
  handleInstances, handleMcp, handleUsage, handleConfig, handleTts,
  handleConnectors, handleWebhooks, handleTeams, handleBots, handleBotManagement,
  handleBotThreadOps, handleBotTasks, handleBotProfile, handleBotMemory, handlePreAuth,
  handleAuthSession, handleWorkspaceComms, handleComputers, handleBotCards, handleBotComputer,
  handleSystem, handleBrowserLive, handleFleet,
} = createRouteHandlers({
  DATA_DIR,
  PORT,
  SESSION_COOKIE,
  DESKTOP_MANAGED,
  HOSTED_WORKSPACE,
  STATIC_DIR,
  MAX_WORKSPACE_BOTS,
  MAX_COMMS_DEPTH,
  ASK_BOT_TIMEOUT_MS,
  MAX_THREADS_OPENED_PER_TURN,
  ROOM_POST_MAX_CHARS,
  LAZY_VM_CLAIM_GRACE_MS,
  handoffs,
  LOCAL_VM_IDLE_MS,
  sessions,
  store,
  cfg,
  registry,
  workspaceRestore,
  workspaceMaintenance,
  sharedComputers,
  sharedComputerControl,
  providerFleet,
  providerAuthSessions,
  persistProviderInstance,
  reloadProviders,
  providerInstancesChanging,
  personAskAt,
  directTurnGenerationByThread,
  webhooks,
  emailSignIn,
  customDomainVerifier,
  serveStatic,
  publicUrl,
  customDomainStatus,
  webhookIngressStatus,
  noteTurnTrigger,
  messageSender,
  browserCleanup,
  groupIsWorking,
  threadBusy,
  routines: () => routines,
  calendarCalls: () => calendarCalls,
  desktopMutationToken: () => desktopMutationToken,
  companionMutationToken: () => companionMutationToken,
  workspaceAccess: () => workspaceAccess,
  providerConfigBusy: { get: () => providerConfigBusy, set: (value) => { providerConfigBusy = value; } },
  localVmImageBusy: { get: () => localVmImageBusy, set: (value) => { localVmImageBusy = value; } },
  localVmModeChangeBusy: { get: () => localVmModeChangeBusy, set: (value) => { localVmModeChangeBusy = value; } },
  localVmProvisionBusy: { get: () => localVmProvisionBusy, set: (value) => { localVmProvisionBusy = value; } },
  browserEngineInstall: { get: () => browserEngineInstall, set: (value) => { browserEngineInstall = value; } },
  browserEngineInstallError: { get: () => browserEngineInstallError, set: (value) => { browserEngineInstallError = value; } },
  computerControl,
  browserRuntime,
  browserLive,
  browserIntegration,
  currentBrowserSession,
  controlLeaseIdSchema,
  forgetTemporaryBrowser,
  cancelDirectTurnDispatch,
  localVmLifecycleBusy,
  localVmActiveThreads,
  boxLifecycleBusyBots,
  vpsPreviewRequests,
  orphanBoxLifecycleBusyIds,
  computerProviderConfigTransitions,
  checkpointRestoreLeases,
  teamComputerInUse,
  botHasActiveTurn,
  botComputerControlSnapshot,
  inheritedTeamComputer,
  computerPreviewBot,
  computerPreviewSurface,
  botComputerControlKey,
  selectableComputers,
  localVmOwnerBusy,
  localVmLeaseFor,
  localVmIdleFor,
  localVmTargetForBot,
  localVmInventoryPayload,
  teamComputers,
  teamComputersPayload,
  managedBoxOwners,
  claimTeamComputerLifecycle,
  claimBotComputerLifecycle,
  claimBoxInventoryRequest,
  claimManagedBoxMutation,
  claimManagedVpsMutation,
  assertTeamControlCanBeTaken,
  assertTeamComputerChangeIdle,
  providerOperationConflict,
  providerTransitionMessage,
  activeVpsThreads,
  autoVmClaims,
  interruptAllDirectThreads,
  interruptDirectThread,
  runningTurnInstance,
  askBotAndWait,
  sendSequencer,
  activeGroupTurnForBot,
  cancelGroupTurnOperations,
  broadcast,
  notify,
  groupSpeakers,
  lastReply,
  watchdog,
  clearUnattended,
  isUnattended,
  createChannel,
  updateChannel,
  channelTaskBlocked,
  roomHandoffProblem,
  publicGroupState,
  groupWithThread,
  roomHandoffs,
  DEFAULT_PAGE,
  pageSize,
  messagePage,
  messageWindow,
  startGroupTurn,
  drainQueuedChannelSends,
  cancelTeamSetupResumesForThread,
  resolveReplyTarget,
  lastHumanRoomMessageAt,
  roomPostEligibility,
  maybeResumeConnectors,
  connectorThread,
  connectorMessage,
  secretMessage,
  resumeSecretCard,
  localVmPayload,
  existingPerBotLocalVmCount,
  perBotLocalVmCountForModeChange,
  roomPostBudgets,
  approvalBus,
  ensureCalendarCallRoom,
  commsBus,
  routineRequests,
  routineTimeZone,
  agentRoutine,
  resolveAndSendRoutine,
  delegationWatch,
  activeRoutineRunForThread,
  settleDirectFollowup,
  drainDelegationWakes,
  appendSkillRequestCard,
  proposalPersistence,
  skillProposalPersistence,
  stagedSkillListing,
  stagedSkillCleanupsForThread,
  rejectDeletedThreadSkillStages,
  resolveSkillRequest,
  sendSkillResolution,
  phoneSecretSubmissions,
  phoneSecretSubmissionKey,
  currentSecretState,
  provideSecretFromPhone,
  credentialDesktopHandoff,
  wireBot,
  wireTask,
  publicBot,
  publicBotQueuedMessages,
  storedAvatarExists,
  previewSystemPrompt,
  botOverview,
  delegatedFullAccess,
  fullAccessForSource,
  grantDelegatedFullAccess,
  peerReviewRequired,
  checkedModelSelection,
  checkedTaskModelSwitch,
  configStatus,
  configForAccess,
  mcpServerResponse,
  mcpServerBody,
  persistMcpServers,
  describeInstances,
  authorizedInternalCapability,
  internalCapabilityIsActive,
  createSidebarSectionSchema,
  createGroupTaskRequestSchema,
  startTurn,
  startOrQueueDirectMessage,
  startOrQueueOpenedThread,
  drainQueuedSends,
  profileRequests,
  teamSetupTeams,
  teamSetupRequests,
  resolveAndSendTeamSetup,
  resolveAndSendProfile,
  deleteBotWithLifecycle,
  drainConnectorResumes,
  drainSecretResumes,
  drainTeamSetupResumes,
});


const handleRequest = createRequestHandler({
  PORT,
  resolveRequestAuth,
  sessions,
  SESSION_COOKIE,
  desktopMutationToken: () => desktopMutationToken,
  companionMutationToken: () => companionMutationToken,
  sharedComputersEnabled,
  cfg,
  parseCookies,
  HOSTED_WORKSPACE,
  requestOrigin,
  serializeSessionCookie,
  cookieMaxAgeSeconds,
  json,
  loadBrand,
  workspaceAccess: () => workspaceAccess,
  teamComputers,
  workspaceBackupRoutes,
  workspaceMaintenance,
  isWorkspaceBackupSessionControl,
  eventsRoutes,
  routinesRoutes,
  internalRoutes,
  handleCalendarCalls,
  handleMessages,
  handleInstances,
  handleMcp,
  handleUsage,
  handleConfig,
  handleTts,
  handleConnectors,
  handleWebhooks,
  handleTeams,
  handleBots,
  handleBotManagement,
  handleBotThreadOps,
  handleBotTasks,
  handleBotProfile,
  handleBotMemory,
  handlePreAuth,
  handleAuthSession,
  handleWorkspaceComms,
  handleComputers,
  handleBotCards,
  handleBotComputer,
  handleSystem,
  handleBrowserLive,
  handleFleet,
});

const server = createServer(handleRequest);

await runBootSequence({
  server,
  handleRequest,
  calendarCalls: () => calendarCalls,
  routines: () => routines,
  webhookIngress: { get: () => webhookIngress, set: (value) => { webhookIngress = value; } },
  webhookIngressError: { get: () => webhookIngressError, set: (value) => { webhookIngressError = value; } },
  webhooks,
  WEBHOOK_PORT,
  workspaceAccess: { get: () => workspaceAccess, set: (value) => { workspaceAccess = value; } },
  companyShutdown: { get: () => companyShutdown, set: (value) => { companyShutdown = value; } },
  sessions,
  SESSION_COOKIE,
  closeSessionStreams,
  PORT,
  companyRuntimeReady,
  followupsReady,
  drainQueuedSends,
  drainQueuedChannelSends,
  commsBus,
  drainThreadDelegations,
  expireDelegationsNow,
  DELEGATION_SWEEP_MS,
  sharedComputers,
  sharedComputerControl,
  browserLive,
  localVmIdles,
  noteLocalVmSeen,
  localVmIdleFor,
  watchdog,
  managedDesktop,
  temporaryBrowserSessions,
  forgetTemporaryBrowser,
  browserRuntime,
  roomHandoffs,
  isContextMessage,
});

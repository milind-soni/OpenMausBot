// OpenMausBot server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";

import { SharedComputers } from "./shared-computers.ts";

import { BrowserCleanupCoordinator } from "./browser-lifecycle-cleanup.ts";
import { createDesktopBridge } from "./desktop-bridge.ts";
import { flushDecisionLog } from "./decision-log.ts";
import {
  cleanupStaleAttachmentPartials,
} from "./attachments.ts";
import * as composio from "./composio.ts";
import {
  containerComputerStatus,
  containerRuntimeStatus,
  SHARED_LOCAL_VM_TARGET,
} from "./container-computer.ts";
import {
  instanceConfigs,
  loadConfig,
  localVmMode,
  threadEventLogRetentionDays,
  saveConfig,
  sharedComputersEnabled,
  builtInBrowserEnabled,
  DATA_DIR,
} from "./config.ts";
import { sweepThreadEventLogs, type ThreadLogRetentionCandidate } from "./thread-retention.ts";
import { resetPathCache } from "./env-path.ts";
import {
  flushUsageLedger,
  type UsageTrigger,
} from "./usage-ledger.ts";
import type { RequestAuth } from "./request-auth.ts";
import { fleetAvailable, fleetRequest, fleetSocketPath } from "./fleet-client.ts";
import { entitled } from "./enterprise.ts";


import { closeMessageDb, chatFollowups, settleChatFollowups } from "./message-db.ts";
import {
  discardDelegations,
  drainDelegations,
  pendingThreads,
} from "./delegations.ts";
import {
  restoreSteeredMessages,
} from "./steer-queue.ts";
import { restoreChannelMessages } from "./channel-queue.ts";
import { EventBus } from "./harness/bus.ts";
import { ManagedDesktopProviders } from "./managed-desktop.ts";
import { withPeerProvenance } from "./peer-provenance.ts";
import {
  titleFromLlm,
  type Message,
} from "./store.ts";
import { recordHanded } from "./delta-context.ts";
import { flushAllMemoryJournals } from "./memory-journal.ts";
import { discoverExistingPerBotLocalVms, shouldArmLocalVmIdle } from "./local-vm-inventory.ts";

import * as vps from "./vps-computer.ts";
import { createBotLifecycle } from "./bot-lifecycle.ts";
import { createCalendarRooms } from "./calendar-rooms.ts";
import { createComputerLifecycleWiring } from "./computer-lifecycle-wiring.ts";
import { createPeerAgentComms } from "./peer-agent-comms.ts";
import { createEventsPipeline } from "./events-pipeline.ts";
import { createGroupState } from "./group-state.ts";
import { createRoutineLifecycle } from "./routine-lifecycle.ts";
import { createSkillLifecycle } from "./skill-lifecycle.ts";
import { createTeamSetupLifecycle } from "./team-setup-lifecycle.ts";
import { createTurnDispatch } from "./turn-dispatch.ts";
import { RoutineManager } from "./routines.ts";
import { CalendarCallManager } from "./calendar-calls.ts";
import {
  browserEngineEncryptionKey,
  clearBrowserSessionState,
  browserEngineStatus,
  browserSessionId,
} from "./browser-engine.ts";



import { flushAllProfileHistory } from "./profile-versions.ts";
import { listenWebhookIngress, type WebhookIngress } from "./webhook-ingress.ts";
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
import { createGracefulShutdown } from "./graceful-shutdown.ts";
import {
  createWorkspaceAccess,
  describeEdition,
  hostedWorkspaceConfiguration,
  hostedWorkspaceConfigured,
  loadEnterpriseLayer,
  type WorkspaceAccess,
} from "./enterprise.ts";
import { serverVersion } from "./environment.ts";
import { createWorkspaceBackupRoutes, isWorkspaceBackupSessionControl } from "./workspace-backup-http.ts";
import { json, readBody } from "./http.ts";
import { createInternalRoutes } from "./routes/internal.ts";
import { createRoutinesRoutes } from "./routes/routines.ts";
import { createCalendarCallRoutes } from "./routes/calendar-calls.ts";
import { createInstanceRoutes } from "./routes/instances.ts";
import { createMcpRoutes } from "./routes/mcp.ts";
import { createTtsRoutes } from "./routes/tts.ts";
import { createConnectorRoutes } from "./routes/connectors.ts";
import { createWebhookRoutes } from "./routes/webhooks.ts";
import { createMessageRoutes } from "./routes/messages.ts";
import { createTeamRoutes } from "./routes/teams.ts";
import { createBotRoutes } from "./routes/bots.ts";
import { createBotManagementRoutes } from "./routes/bot-management.ts";
import { createBotThreadOpsRoutes } from "./routes/bot-thread-ops.ts";
import { createBotTasksRoutes } from "./routes/bot-tasks.ts";
import { createBotProfileRoutes } from "./routes/bot-profile.ts";
import { createBotMemoryRoutes } from "./routes/bot-memory.ts";
import { createPreAuthRoutes } from "./routes/pre-auth.ts";
import { createAuthSessionRoutes } from "./routes/auth-session.ts";
import { createBotCardsRoutes } from "./routes/bot-cards.ts";
import { createBotComputerRoutes } from "./routes/bot-computer.ts";
import { createWorkspaceCommsRoutes } from "./routes/workspace-comms.ts";
import { createComputersRoutes } from "./routes/computers.ts";
import { createSystemRoutes } from "./routes/system.ts";
import { createUsageRoutes } from "./routes/usage.ts";
import { createConfigRoutes } from "./routes/config.ts";
import type { RouteContext } from "./routes/http.ts";
import {
  computerSelectionTurns,
  revokeAllInternalCapabilities,
  revokeInternalCapabilitiesForThread,
} from "./internal-capabilities.ts";
import { closeOpenApprovals } from "./turn-fold.ts";
import {
  cfg,
  ENVIRONMENT_ID,
  registry,
  releaseDataDirLeaseAtExit,
  store,
  workspaceMaintenance,
  workspaceRestore,
} from "./runtime.ts";
import {
  botForThread,
  claimTurnResource,
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
import { describeBrand, loadBrand } from "./brand.ts";
import {
  PhoneSecretBridge,
  PhoneSecretSubmissionRegistry,
} from "./phone-secret.ts";

const PORT = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
const WEBHOOK_PORT = Number(process.env.OMB_WEBHOOK_PORT || PORT + 1);
// Behind a proxy or tunnel, the base URL senders should use (docs/self-hosting.md).
const WEBHOOK_PUBLIC_URL = process.env.OMB_WEBHOOK_PUBLIC_URL || undefined;
const STATIC_DIR = process.env.OMB_STATIC_DIR || null;
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

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
    // Cleanup may only run the engine OpenMausBot itself configured or
    // downloaded. A binary the ambient PATH turned up — on a dev machine, a
    // global wrapper that shadows the harness PATH and rewrites the session
    // key — is not that engine: a close through it can fail and wedge the
    // journal on retries. Without a managed engine no daemon could still
    // autosave the session, so the erase below can acknowledge directly.
    const status = browserEngineStatus({ managedOnly: true });
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
    localVmProvisionBusy: () => localVmProvisionBusy,
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

// A running VM may have survived an app/server restart. Start its idle
// backstop even if nobody opens Settings or begins a turn this session. The
// bot's current destination is intentionally ignored: moving a bot to Cloud,
// Browser, This computer, Auto, or Off does not delete its old Local VM.
void (async () => {
  if (localVmMode(cfg) !== "per-bot") {
    const status = await containerComputerStatus(undefined, undefined, SHARED_LOCAL_VM_TARGET).catch(() => null);
    noteLocalVmSeen(SHARED_LOCAL_VM_TARGET, status);
    if (shouldArmLocalVmIdle(status)) localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
    return;
  }
  const runtime = await containerRuntimeStatus().catch(() => null);
  if (!runtime?.runtime || !runtime.daemonUp) return;
  const existing = await discoverExistingPerBotLocalVms(store.bots, runtime.runtime).catch(() => []);
  const statuses = await Promise.all(existing.map(({ target }) =>
    containerComputerStatus(undefined, undefined, target).catch(() => null),
  ));
  existing.forEach(({ target }, index) => {
    noteLocalVmSeen(target, statuses[index]);
    if (shouldArmLocalVmIdle(statuses[index])) localVmIdleFor(target).touch();
  });
})().catch(() => {
  // Startup inspection is a backstop, not a reason to keep the app offline.
  // The Settings inventory remains available for a later explicit retry.
});


// Drain queued delegations for a source thread after its turn settles.
// Run as a separate subscriber so the drain logic stays out of the main
// fold (which has its own switch/case noise) and its approval + startTurn
// calls never have to share locals with the fold's state machine.
/** How a drained delegation becomes a real turn on the target. Shared by
 * the settle-time drain and the boot-time drain of what a previous process
 * left queued. */
const runDelegatedTurn: Parameters<typeof drainDelegations>[3] = (toBotId, rawText, commsDepth, sourceThreadId, channel, taskId, sourceBotId, openedThreadId) => {
    // startTurn REJECTS on an ordinary condition — busy target, deleted bot,
    // unavailable provider. Unhandled, that rejection is fatal to the
    // harness (Node's default), which in the packaged app kills the server
    // child. Every delegation failure has to land as a chip instead.
    // A fresh-thread handoff runs in the thread the opener created — the
    // drain already dropped it if that thread is gone — never in whatever
    // the person is looking at.
    const targetThreadId = openedThreadId ?? store.bot(toBotId)?.threadId;
    const target = store.bot(toBotId);
    const opener = store.bot(sourceBotId);
    const unattended = isUnattended(sourceBotId, sourceThreadId);
    // The inbound line is another bot's words whichever way it arrived: an
    // opened thread's first line carries the shared provenance note, a
    // classic handoff the "[Delegated by @X" prefix from the drain. Both
    // record the author structurally (peerAsk) as well as in the text, so
    // a renderer never has to take the line for the person's own message.
    const peerAsk: Message["peerAsk"] | undefined = opener
      ? { botId: opener.id, name: opener.name, unattended: unattended || undefined }
      : undefined;
    const text = openedThreadId && opener
      ? withPeerProvenance(rawText, { botName: opener.name, delivery: "start_thread", unattended })
      : rawText;
    if (targetThreadId) {
      delegationWatch.set(targetThreadId, {
        channelId: channel?.id,
        toBotId,
        toBotName: target?.name,
        taskId,
        sourceThreadId,
        sourceBotId,
        routineRunId: activeRoutineRunForThread(sourceThreadId)?.id,
        startedAtMs: Date.now(),
      });
    }
    let failureReported = false;
    const reportStartFailure = (error: unknown) => {
      if (failureReported) return;
      failureReported = true;
      const bot = store.bot(toBotId);
      const why = error instanceof Error ? error.message : String(error);
      if (targetThreadId) {
        const finalized = finalizeDelegationWatch(
          targetThreadId,
          false,
          "",
          `Delegated turn could not start — ${why.slice(0, 120)}`,
        );
        if (finalized) return;
      }
      const source = store.botByThread(sourceThreadId);
      if (!source) return;
      store.appendMessage(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `error: delegation to @${bot?.name ?? toBotId} could not start — ${why.slice(0, 120)}`, ok: false },
      });
    };
    return startTurn(toBotId, text, {
      threadId: targetThreadId,
      commsDepth,
      unattended,
      peerAsk,
      // startTurn schedules provider/integration setup after marking the bot
      // busy. Those asynchronous setup failures do not emit turn.completed,
      // so clear the watch and report them through this callback too.
      onDispatchError: reportStartFailure,
    }).then(() => undefined).catch((err) => {
      reportStartFailure(err);
    });
};

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

// Webhook definitions are independent from calendar schedules, but every
// delivery joins the same RoutineManager queue. That keeps unattended work
// ordered behind a busy MAUS and gives webhook runs the same durable receipts.
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
try {
  webhookIngress = await listenWebhookIngress(webhooks, {
    port: WEBHOOK_PORT, publicBaseUrl: WEBHOOK_PUBLIC_URL,
    claimRequest: () => workspaceMaintenance.request(),
  });
  const advertised = WEBHOOK_PUBLIC_URL ? ` (advertised as ${webhookIngress.baseUrl})` : "";
  console.log(`openmausbot webhook receiver on http://${webhookIngress.host}:${webhookIngress.port}${advertised}`);
} catch (error) {
  webhookIngressError = error instanceof Error ? error.message : String(error);
  console.error(`openmausbot webhook receiver unavailable: ${webhookIngressError}`);
}

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

const phoneSecretSubmissions = new PhoneSecretSubmissionRegistry();

function claimPhoneSecretBotDeletion(botId: string): (() => void) | null {
  const scopes = [
    { botId },
    ...store.groups
      .filter((group) => group.memberIds.includes(botId))
      .map((group) => ({ groupId: group.id })),
  ];
  const releases: Array<() => void> = [];
  for (const scope of scopes) {
    const release = phoneSecretSubmissions.claimMutation(scope);
    if (!release) {
      for (const undo of releases.reverse()) undo();
      return null;
    }
    releases.push(release);
  }
  return () => {
    for (const release of releases.reverse()) release();
  };
}

function credentialDesktopHandoff(label: string): string {
  return `Securely provide the ${label} from OpenMausBot on your phone or computer. It is never added to chat.`;
}

// The phone-secret provisioning helpers live in ./turn-secrets.ts: the
// submission key, the card state read, and provideSecretFromPhone. Wired
// at their original site, after phoneSecrets, phoneSecretSubmissions and
// the deferred-resumes card helpers exist; every caller is a route below.
const { phoneSecretSubmissionKey, currentSecretState, provideSecretFromPhone } = createTurnSecrets({
  connectorThread, secretMessage, resumeSecretCard, phoneSecrets, phoneSecretSubmissions,
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
function serveStatic(res: ServerResponse, path: string): boolean {
  if (!STATIC_DIR) return false;
  const safe = path === "/" ? "/index.html" : path.replace(/\.\./g, "");
  const file = join(STATIC_DIR, safe);
  try {
    const data = readFileSync(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
    return true;
  } catch {
    // SPA fallback
    try {
      const data = readFileSync(join(STATIC_DIR, "index.html"));
      res.writeHead(200, { "content-type": "text/html" });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
}

// Loopback-only enforcement: the harness runs on 127.0.0.1 but accepts
// requests from any loopback connection and any web page that DNS-rebinds
// onto it. Reject non-loopback Hosts outright (defeats rebinding) and
// origins outside loopback (blocks remote-web CSRF).

const workspaceBackupRoutes = createWorkspaceBackupRoutes({
  dataDir: DATA_DIR,
  appVersion: serverVersion(),
  readBody,
  restored: workspaceRestore,
  status: () => ({ busy: workspaceMaintenance.active, pendingRestore: workspaceMaintenance.pendingRestore }),
  authorized: (req, original) => {
    const current = resolveRequestAuth(req, {
      sessions, cookieName: SESSION_COOKIE, streamPath: "/api/events",
      url: new URL(req.url ?? "/", `http://localhost:${PORT}`),
      loopbackMutationToken: desktopMutationToken, companionMutationToken,
    }).auth;
    return Boolean(current?.scopes.includes("admin") && current.kind === original.kind &&
      (current.kind !== "session" || (original.kind === "session" && current.session.id === original.session.id)));
  },
  exclusive: (work, keepLocked) => workspaceMaintenance.run(async () => {
    // Recheck inside the exclusive gate: the restore body can arrive slowly
    // while another client assigns a computer after the initial route check.
    if (keepLocked && teamComputers.list().some(computer => computer.section !== null)) {
      throw Object.assign(new Error("Unassign team computers before restoring this workspace"), { status: 409 });
    }
    return work();
  }, {
    idle: () => !providerFleet.providerFleetReloading && !providerAuthSessions.active && !browserEngineInstall &&
      !routines?.isTicking && !calendarCalls?.isTicking &&
      !localVmImageBusy && !localVmProvisionBusy && !localVmModeChangeBusy &&
      !localVmLifecycleBusy.size && !boxLifecycleBusyBots.size && !vpsPreviewRequests.size && !orphanBoxLifecycleBusyIds.size &&
      !computerProviderConfigTransitions.size && !checkpointRestoreLeases.size &&
      teamComputers.list().every(computer => !teamComputerInUse(computer)) &&
      store.bots.every((bot) => !botHasActiveTurn(bot.id) && !routines?.activeRunForBot(bot.id) && !botComputerControlSnapshot(bot.id).held) &&
      store.groups.every((group) => !groupIsWorking(group)),
    pause: () => { routines?.stop(); calendarCalls?.stop(); watchdog.stop(); },
    resume: () => { routines?.start(); calendarCalls?.start(); watchdog.start(); },
    flush: async () => {
      await Promise.all([flushAllProfileHistory(), flushAllMemoryJournals(), flushUsageLedger(DATA_DIR), flushDecisionLog(DATA_DIR)]);
      // With writers gated and work idle, release our WAL connection for the
      // consistent snapshot. Store reopens it lazily after maintenance.
      closeMessageDb();
    },
  }, keepLocked),
});

const routinesRoutes = createRoutinesRoutes({ routines: () => routines! });

// The /api/internal family: everything a spawned proxy reaches over
// localhost with its per-turn capability (see ./routes/internal.ts).
const internalRoutes = createInternalRoutes({
  store, cfg, registry, sharedComputers, computerControl, browserRuntime, commsBus, approvalBus,
  roomHandoffs, routineRequests, profileRequests, teamSetupRequests, routines: () => routines,
  computerSelectionTurns, delegationWatch, turnComputerResources, autoVmClaims, personAskAt, roomPostBudgets,
  ASK_BOT_TIMEOUT_MS, MAX_COMMS_DEPTH, MAX_THREADS_OPENED_PER_TURN, MAX_WORKSPACE_BOTS, ROOM_POST_MAX_CHARS, LAZY_VM_CLAIM_GRACE_MS,
  askBotAndWait, agentRoutine, appendSkillRequestCard, botComputerControlSnapshot, startOrQueueOpenedThread, startTurn,
  selectableComputers, computerPreviewSurface, browserIntegration, currentBrowserSession, createChannel, updateChannel,
  activeGroupTurnForBot, activeRoutineRunForThread, credentialDesktopHandoff, lastHumanRoomMessageAt,
  maybeResumeConnectors, notify, proposalPersistence, skillProposalPersistence, roomHandoffProblem,
  roomPostEligibility, routineTimeZone, stagedSkillListing, teamSetupTeams, threadBusy,
  authorizedInternalCapability, internalCapabilityIsActive, claimTurnResource, connectorThread,
  delegatedFullAccess, fullAccessForSource, grantDelegatedFullAccess, isUnattended, peerReviewRequired,
});

// Route groups extracted from handleRequest's dispatch chain below; wired
// here, after the index.ts-local collaborators they close over exist.
const handleCalendarCalls = createCalendarCallRoutes({
  calendarCalls: () => calendarCalls!,
  ensureCalendarCallRoom,
  publicGroupState,
});
const handleMessages = createMessageRoutes({
  pageSize,
  DEFAULT_PAGE,
  messagePage,
  messageWindow,
  wireBot,
  wireTask,
  publicBotQueuedMessages,
  publicGroupState,
  botComputerControlSnapshot,
});
const handleInstances = createInstanceRoutes({
  providerConfigBusy: { get: () => providerConfigBusy, set: (value) => { providerConfigBusy = value; } },
  providerAuthSessions,
  sessions,
  describeInstances,
  configStatus,
  broadcast,
  persistProviderInstance,
  providerInstancesChanging,
  activeGroupTurnForBot,
});
const handleMcp = createMcpRoutes({ sessions, mcpServerResponse, mcpServerBody, persistMcpServers });
const handleUsage = createUsageRoutes();
const handleConfig = createConfigRoutes({
  providerConfigBusy: { get: () => providerConfigBusy, set: (value) => { providerConfigBusy = value; } },
  localVmModeChangeBusy: { get: () => localVmModeChangeBusy, set: (value) => { localVmModeChangeBusy = value; } },
  localVmImageBusy: () => localVmImageBusy,
  computerProviderConfigTransitions,
  localVmActiveThreads,
  localVmLifecycleBusy,
  perBotLocalVmCountForModeChange,
  managedBoxOwners,
  providerOperationConflict,
  configStatus,
  configForAccess,
  sessions,
  broadcast,
  browserRuntime,
  browserLive,
  browserCleanup,
  sharedComputers,
  sharedComputerControl,
  reloadProviders,
  drainQueuedSends,
  drainDelegationWakes,
  drainConnectorResumes,
  drainSecretResumes,
  drainTeamSetupResumes,
});
const handleTts = createTtsRoutes();
const handleConnectors = createConnectorRoutes();
const handleWebhooks = createWebhookRoutes({ webhooks, webhookIngressStatus });
const handleTeams = createTeamRoutes({
  createChannel,
  publicGroupState,
  publicBot,
  messagePage,
  broadcast,
  routines: () => routines,
});
const handleBots = createBotRoutes({
  routines: () => routines,
  broadcast,
  publicGroupState,
  wireBot,
  updateChannel,
  channelTaskBlocked,
  phoneSecretSubmissions,
  createGroupTaskRequestSchema,
  createSidebarSectionSchema,
  groupWithThread,
  groupSpeakers,
  lastReply,
  sendSequencer,
  noteTurnTrigger,
  messageSender,
  resolveReplyTarget,
  stagedSkillCleanupsForThread,
  rejectDeletedThreadSkillStages,
  cancelTeamSetupResumesForThread,
  DESKTOP_MANAGED,
  startGroupTurn,
  drainQueuedChannelSends,
  runningTurnInstance,
  cancelGroupTurnOperations,
  assertTeamComputerChangeIdle,
  teamComputers,
});
const handleBotManagement = createBotManagementRoutes({
  routines: () => routines,
  broadcast,
  wireBot,
  storedAvatarExists,
  checkedModelSelection,
  activeGroupTurnForBot,
  cancelGroupTurnOperations,
  sessions,
  DESKTOP_MANAGED,
  MAX_WORKSPACE_BOTS,
  interruptAllDirectThreads,
  runningTurnInstance,
  assertTeamComputerChangeIdle,
  activeVpsThreads,
  browserRuntime,
  browserLive,
  currentBrowserSession,
  forgetTemporaryBrowser,
  deleteBotWithLifecycle,
});
const handleBotThreadOps = createBotThreadOpsRoutes({
  routines: () => routines,
  DESKTOP_MANAGED,
  noteTurnTrigger,
  messageSender,
  sendSequencer,
  resolveReplyTarget,
  clearUnattended,
  drainQueuedSends,
  startOrQueueDirectMessage,
  phoneSecretSubmissions,
  startTurn,
  resolveAndSendTeamSetup,
  resolveAndSendRoutine,
  resolveAndSendProfile,
  resolveSkillRequest,
  sendSkillResolution,
  approvalBus,
  handoffs,
  interruptDirectThread,
  cancelDirectTurnDispatch,
  activeGroupTurnForBot,
  cancelGroupTurnOperations,
  runningTurnInstance,
});
const handleBotTasks = createBotTasksRoutes({
  routines: () => routines,
  broadcast,
  wireBot,
  wireTask,
  DESKTOP_MANAGED,
  phoneSecretSubmissions,
  checkedModelSelection,
  checkedTaskModelSwitch,
  stagedSkillCleanupsForThread,
  rejectDeletedThreadSkillStages,
  roomHandoffs,
  handoffs,
  cancelTeamSetupResumesForThread,
  settleDirectFollowup,
  directTurnGenerationByThread,
});
const handleBotProfile = createBotProfileRoutes({
  broadcast,
  wireBot,
  previewSystemPrompt,
  botOverview,
  stagedSkillListing,
});
const handleBotMemory = createBotMemoryRoutes({
  checkpointRestoreLeases,
});
const handlePreAuth = createPreAuthRoutes({
  sessions,
  emailSignIn,
  customDomainVerifier,
  SESSION_COOKIE,
  DESKTOP_MANAGED,
  HOSTED_WORKSPACE,
  serveStatic,
  workspaceAccess: () => workspaceAccess,
});
const handleAuthSession = createAuthSessionRoutes({
  sessions,
  SESSION_COOKIE,
  DESKTOP_MANAGED,
  publicUrl,
  customDomainStatus,
  customDomainVerifier,
});
const handleWorkspaceComms = createWorkspaceCommsRoutes({
  sessions,
  sharedComputers,
  sharedComputerControl,
  MAX_COMMS_DEPTH,
  delegationWatch,
});
const handleComputers = createComputersRoutes({
  routines: () => routines,
  sessions,
  interruptAllDirectThreads,
  cancelDirectTurnDispatch,
  activeGroupTurnForBot,
  cancelGroupTurnOperations,
  runningTurnInstance,
  teamComputers,
  teamComputersPayload,
  computerControl,
  controlLeaseIdSchema,
  computerProviderConfigTransitions,
  providerTransitionMessage,
  boxLifecycleBusyBots,
  assertTeamControlCanBeTaken,
  botHasActiveTurn,
  botComputerControlSnapshot,
  claimTeamComputerLifecycle,
  claimBotComputerLifecycle,
  teamComputerInUse,
  managedBoxOwners,
  claimBoxInventoryRequest,
  claimManagedBoxMutation,
  claimManagedVpsMutation,
  localVmOwnerBusy,
  localVmLeaseFor,
  localVmIdleFor,
  localVmTargetForBot,
  localVmInventoryPayload,
  localVmLifecycleBusy,
  localVmActiveThreads,
  LOCAL_VM_IDLE_MS,
  computerPreviewBot,
  computerPreviewSurface,
  localVmPayload,
  existingPerBotLocalVmCount,
  localVmImageBusy: { get: () => localVmImageBusy, set: (value) => { localVmImageBusy = value; } },
  localVmModeChangeBusy: () => localVmModeChangeBusy,
  localVmProvisionBusy: { get: () => localVmProvisionBusy, set: (value) => { localVmProvisionBusy = value; } },
});
const handleBotCards = createBotCardsRoutes({
  phoneSecretSubmissions,
  phoneSecretSubmissionKey,
  currentSecretState,
  provideSecretFromPhone,
  secretMessage,
  resumeSecretCard,
  connectorMessage,
  maybeResumeConnectors,
});
const handleBotComputer = createBotComputerRoutes({
  inheritedTeamComputer,
  computerPreviewBot,
  computerPreviewSurface,
  botComputerControlKey,
  botComputerControlSnapshot,
  assertTeamControlCanBeTaken,
  claimTeamComputerLifecycle,
  claimBotComputerLifecycle,
  botHasActiveTurn,
  providerTransitionMessage,
  computerProviderConfigTransitions,
  boxLifecycleBusyBots,
  vpsPreviewRequests,
  activeVpsThreads,
  computerControl,
  controlLeaseIdSchema,
});
const handleSystem = createSystemRoutes({
  STATIC_DIR,
  browserEngineInstall: { get: () => browserEngineInstall, set: (value) => { browserEngineInstall = value; } },
  browserEngineInstallError: { get: () => browserEngineInstallError, set: (value) => { browserEngineInstallError = value; } },
  broadcast,
  configStatus,
});


const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  } catch {
    return json(res, 400, { error: "invalid request URL" });
  }
  const path = url.pathname;
  const method = req.method ?? "GET";
  let releaseWorkspaceRequest: (() => void) | undefined;
  try {
    if (await handlePreAuth(req, res, { method, path, url })) return;
    const gate = resolveRequestAuth(req, {
      sessions,
      cookieName: SESSION_COOKIE,
      streamPath: "/api/events",
      url,
      loopbackMutationToken: desktopMutationToken,
      companionMutationToken,
      features: { sharedComputers: sharedComputersEnabled(cfg) },
    });
    // The browser's cookie carries the term it was set with, and the
    // session's term slides on use (sessions.ts `renew`), so re-issue the
    // cookie on every cookie-authenticated request. One small header; and
    // unlike "send once per renewal" it survives a lost response and a
    // restart. Later handlers that clear the cookie (logout, self-revoke)
    // overwrite this header, which is the order we want.
    if (gate.auth?.kind === "session" && gate.auth.via === "cookie") {
      const presented = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
      if (presented) {
        const secure = HOSTED_WORKSPACE || requestOrigin(req)?.startsWith("https://") === true;
        res.setHeader("set-cookie", serializeSessionCookie(SESSION_COOKIE, presented, { secure, maxAgeSeconds: cookieMaxAgeSeconds(gate.auth.session) }));
      }
    }
    // Reachability probe, public: the phone races it across a server's
    // addresses before it has a session, and the tunnel verifier polls it.
    // A stranger learns only the app name; pid (the desktop boot probe keys
    // on it) and the static flag stay behind the gate below.
    if (method === "GET" && path === "/api/health" && !gate.auth) {
      return json(res, 200, { app: "openmausbot" });
    }
    // The brand is public too: the sign-in page must carry the deployment's
    // name and icon before anyone has a session, and it holds nothing secret.
    if (method === "GET" && path === "/api/brand" && !gate.auth) {
      return json(res, 200, loadBrand());
    }
    if (!gate.auth) return json(res, gate.status, { error: gate.error });
    const auth = gate.auth;
    /** per-request values shared by the route modules extracted below */
    const rctx: RouteContext = { method, path, url, auth };
    if (HOSTED_WORKSPACE && auth.kind === "session") {
      const failure = workspaceAccess
        ? await workspaceAccess.authorize(req, auth)
        : { status: 503, error: "Workspace sign-in is unavailable." };
      if (failure) return json(res, failure.status, { error: failure.error });
    }

    if (method === "POST" && path === "/api/workspace-backup/restore" && teamComputers.list().some(computer => computer.section !== null)) {
      return json(res, 409, { error: "Unassign team computers before restoring a workspace; restored team names must not gain access to existing desktops" });
    }
    if (await workspaceBackupRoutes(req, res, path, auth)) return;
    // Count ordinary requests until their asynchronous handler returns, not
    // merely until the browser disconnects. A cancelled upload can still write.
    if (path.startsWith("/api/") && path !== "/api/events" && path !== "/api/health" && !path.startsWith("/api/shared-computers/") && !isWorkspaceBackupSessionControl(method, path)) {
      releaseWorkspaceRequest = workspaceMaintenance.request();
    }

    if (await handleAuthSession(req, res, rctx)) return;
    if (await handleWorkspaceComms(req, res, rctx)) return;
    // ── internal peer-agent comms (localhost + bot capability only) ───
    // The agents-proxy (spawned inside a bot's agent process) calls these to
    // discover peers and hand a message to one. Not part of the public API.
    if (await internalRoutes(req, res, path, method, url)) return;

    // ── routines calendar ────────────────────────────────────────────────
    if (await routinesRoutes(req, res, path, method, url)) return;

    // ── scheduled room sessions ────────────────────────────────────────
    if (await handleCalendarCalls(req, res, rctx)) return;

    // ── independent webhook triggers ────────────────────────────────────
    // Management stays on the app-only server. Actual deliveries land on a
    // second, webhook-only loopback listener so Funnel or a future hosted
    // relay never has to expose the rest of OpenMausBot's control surface.
    if (await handleWebhooks(req, res, rctx)) return;

    // ── events stream ──
    // Owner-only (default-deny in request-auth). Never mix login frames into
    // the general events feed, which is also visible to client-only devices.
    const liveBrowserMatch = /^\/api\/bots\/([\w-]+)\/browser\/(live|action)$/.exec(path);
    if (liveBrowserMatch) {
      res.setHeader("cache-control", "no-store");
      const bot = store.bot(liveBrowserMatch[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (!builtInBrowserEnabled(cfg) || bot.browser === false) {
        return json(res, 409, { error: "Enable this bot's browser in its profile first." });
      }
      const browser = await browserIntegration(bot.id, bot.browserProfile);
      if (!browser) return json(res, 503, { error: "Install the browser engine first." });
      // Browser discovery may have awaited while the portal became unavailable
      // and closed this owner's streams. Do not open a late replacement on
      // the earlier authorization; once registered, exact-owner close covers it.
      if (HOSTED_WORKSPACE && auth.kind === "session") {
        const failure = workspaceAccess
          ? await workspaceAccess.authorize(req, auth)
          : { status: 503, error: "Workspace sign-in is unavailable." };
        if (failure) return json(res, failure.status, { error: failure.error });
      }
      const owner = auth.kind === "session" ? auth.session.id : "local-owner";
      const isCurrent = () => {
        const current = store.bot(bot.id);
        return !!current && current.browser !== false && builtInBrowserEnabled(cfg)
          && currentBrowserSession(current.id, current.browserProfile) === browser.session
          && (auth.kind !== "session" || sessions.isLive(auth.session.id));
      };
      if (method === "GET" && liveBrowserMatch[2] === "live") {
        req.socket.setTimeout(0);
        return await browserLive.open({ botId: bot.id, session: browser.session, spec: browser.spec, owner, isCurrent, res });
      }
      if (method === "POST" && liveBrowserMatch[2] === "action") {
        const body = await readBody(req, 32_768);
        if (!isCurrent()) return json(res, 409, { error: "This browser session changed. Reopen the browser panel." });
        if (typeof body?.viewerId !== "string") return json(res, 400, { error: "A live browser connection is required." });
        if (body.type === "restart" && store.bots.some((candidate) => candidate.busy &&
            currentBrowserSession(candidate.id, candidate.browserProfile) === browser.session)) {
          return json(res, 409, { error: "Stop every bot using this profile before restarting its browser." });
        }
        return json(res, 200, await browserLive.action({ viewerId: body.viewerId, botId: bot.id, owner, body }));
      }
      return json(res, 405, { error: "method not allowed" });
    }
    if (eventsRoutes.handle(req, res, path, method, url, auth)) return;

    // ── bots ──
    // Paired sessions are authenticated above. The companion marker may
    // only narrow behavior (including its capability-free local dev proxy);
    // it never grants authority or replaces the existing request gate.
    if (await handleMessages(req, res, rctx)) return;

    if (await handleTeams(req, res, rctx)) return;
    if (await handleBots(req, res, rctx)) return;
    if (await handleBotManagement(req, res, rctx)) return;

    if (await handleBotProfile(req, res, rctx)) return;

    if (await handleBotMemory(req, res, rctx)) return;

    if (await handleBotThreadOps(req, res, rctx)) return;

    if (await handleBotTasks(req, res, rctx)) return;

    if (await handleComputers(req, res, rctx)) return;

    if (await handleSystem(req, res, rctx)) return;

    // ── the fleet: client workspaces on this server, through the root agent ──
    // Admin scope by default plus the `admin` entitlement; the socket's own
    // permissions decide whether this workspace may drive the agent at all.
    const fleetRoute = /^\/api\/fleet(?:\/(workspaces(?:\/([a-z0-9-]+)(?:\/(users|suspend|resume))?)?|upgrade))?$/.exec(path);
    if (fleetRoute) {
      if (!entitled("admin")) return json(res, 403, { error: "Workspaces need an enterprise licence with the admin feature." });
      const socket = fleetSocketPath();
      if (!fleetAvailable(socket)) return json(res, 404, { error: "No fleet agent on this server. Run `openmausbot fleet init --domain … --operator <this user>` as root." });
      const [, resource, slug, sub] = fleetRoute;
      let forward: { method: string; path: string; body?: unknown } | null = null;
      if (method === "GET" && !resource) forward = { method: "GET", path: "/workspaces" };
      else if (method === "POST" && resource === "workspaces") forward = { method: "POST", path: "/workspaces", body: await readBody(req, 256 * 1024) };
      else if (method === "POST" && resource === "upgrade") forward = { method: "POST", path: "/upgrade" };
      else if (slug && method === "POST" && (sub === "users" || sub === "suspend" || sub === "resume")) forward = { method: "POST", path: `/workspaces/${slug}/${sub}`, ...(sub === "users" ? { body: await readBody(req, 8192) } : {}) };
      else if (slug && method === "DELETE" && !sub) forward = { method: "DELETE", path: `/workspaces/${slug}`, body: await readBody(req, 8192) };
      if (!forward) return json(res, 405, { error: "no such fleet operation" });
      res.setHeader("cache-control", "no-store");
      try {
        const reply = await fleetRequest(socket, forward.method, forward.path, forward.body);
        return json(res, reply.status, reply.body ?? {});
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (await handleUsage(req, res, rctx)) return;

    if (await handleInstances(req, res, rctx)) return;

    if (await handleMcp(req, res, rctx)) return;

    if (await handleConfig(req, res, rctx)) return;

    if (await handleTts(req, res, rctx)) return;

    if (await handleConnectors(req, res, rctx)) return;

    if (await handleBotCards(req, res, rctx)) return;

    if (await handleBotComputer(req, res, rctx)) return;

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    const status = (e as any)?.status ?? 500;
    return json(res, status, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    releaseWorkspaceRequest?.();
  }
};

const server = createServer(handleRequest);

calendarCalls!.start();

// Resolve the edition before accepting requests so /api/edition is never a guess.
console.log(describeEdition(await loadEnterpriseLayer()));
workspaceAccess = createWorkspaceAccess({ sessions, cookieName: SESSION_COOKIE, closeSessionStreams });
// Ten-second cadence plus the bridge's five-second backchannel deadline bounds
// stale portal access on quiet event/browser streams to fifteen seconds.
const workspaceAccessTimer = workspaceAccess ? setInterval(() => {
  void workspaceAccess!.revalidate().catch((error) => console.warn("workspace access revalidation failed", error));
}, 10_000) : null;
workspaceAccessTimer?.unref();
console.log(describeBrand(loadBrand()));

// Reclaim upload partials a previous run crashed out of, and warm the
// attachment quota cache off the same scan. This used to happen implicitly on
// every reservation, which is exactly what made uploads quadratic in
// directory size; do the initial sweep before accepting requests.
// ponytail: once per boot, not periodic. A partial orphaned while this
// process is up survives until the next restart — add a timer only if that
// shows up as real quota pressure.
try {
  const reclaimedPartials = cleanupStaleAttachmentPartials();
  if (reclaimedPartials > 0) console.log(`reclaimed ${reclaimedPartials} abandoned upload partial(s)`);
} catch (error) {
  console.warn(`attachments: startup partial cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
}

// #1280: retention for per-thread event logs. Off unless configured, and
// even then it only removes log files — transcripts, thread records, and
// workspace state stay untouched. A thread qualifies only when its newest
// close or archive stamp is older than the window and it is not busy,
// unread, or carrying an open direct handoff.
const THREAD_LOG_RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;

function sweepThreadEventLogsNow(): void {
  const retentionDays = threadEventLogRetentionDays(cfg);
  if (retentionDays === null) return;
  const candidates: ThreadLogRetentionCandidate[] = store.bots.flatMap((bot) =>
    (bot.tasks ?? []).map((task) => ({
      threadId: task.threadId,
      closedAt: task.closedBy?.at ?? null,
      archivedAt: task.archivedAt ?? null,
      unread: task.unread === true,
      busy: threadBusy(bot.id, task.threadId),
      openDirectHandoff: roomHandoffs.activeDirect(task.threadId),
    })));
  const swept = sweepThreadEventLogs(candidates, retentionDays);
  if (swept > 0) console.log(`[retention] removed event logs for ${swept} idle thread(s) past ${retentionDays} day(s)`);
}

try {
  sweepThreadEventLogsNow();
} catch (error) {
  console.warn(`thread event log retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
}
// A days-scale window needs no tighter cadence; unref so the timer never
// holds the process open.
setInterval(sweepThreadEventLogsNow, THREAD_LOG_RETENTION_SWEEP_MS).unref();

// A dispatch claim is deliberately committed before transcript/provider work.
// If we died after that point, its outcome is unknown: recover the user's words
// and a review notice, never hand them to a model for a second execution.
for (const row of chatFollowups()) {
  if (row.status !== "dispatching" && row.status !== "interrupted") continue;
  const owned = row.kind === "bot"
    ? Boolean(store.taskByThread(row.ownerId, row.threadId))
    : Boolean(store.groupByThread(row.threadId)?.id === row.ownerId);
  if (!owned) { settleChatFollowups([row.id], "cancelled"); continue; }
  settleChatFollowups([row.id], "interrupted");
  const messages = store.messagesFor(row.threadId);
  const recovered = messages.find((message) => message.queueId === row.id && message.role === "user") ?? store.appendMessage(row.threadId, {
    role: "user", kind: "text", text: row.payload.text, replyToId: row.payload.replyToId,
    sendId: row.payload.sendId, queueId: row.id,
    ...(row.kind === "channel" ? { channelMode: row.payload.mode, via: row.payload.via } : {}),
  });
  // Nor as a message a resumed session has not seen: count it as handed.
  const recoveredTask = row.kind === "bot" ? store.taskByThread(row.ownerId, row.threadId) : undefined;
  const order = store.activePath(row.threadId).filter(isContextMessage).map((m) => m.id);
  for (const [instanceId, state] of Object.entries(recoveredTask?.handedMessages ?? {})) {
    if (state.session !== undefined) store.setHandedMessages(row.ownerId, row.threadId, instanceId, recordHanded(state, order, [recovered.id]));
  }
  if (!messages.some((message) => message.queueId === row.id && message.kind === "activity")) {
    store.appendMessage(row.threadId, {
      role: "bot", kind: "activity", queueId: row.id,
      tool: { name: "Queued follow-up interrupted by restart or restore — it may have already run. Review the result before sending it again.", ok: false },
    });
  }
  // The FULL-sync retirement also flushes both transcript writes. Retrying
  // this sendId now finds the canonical message, without a permanent journal scan.
  settleChatFollowups([row.id], null);
}
restoreSteeredMessages();
restoreChannelMessages();

server.listen(PORT, "127.0.0.1", () => {
  companyRuntimeReady();
  console.log(`openmausbot server on http://127.0.0.1:${PORT}`);
  followupsReady.set(true);
  drainQueuedSends();
  drainQueuedChannelSends();
  // Startup work uses the same turn dispatcher and local tool endpoint as
  // ordinary chat. Start only once every registry is initialized and the
  // endpoint is listening; earlier dispatch can hit uninitialized bindings.
  routines!.start();
  const leftover = pendingThreads();
  if (leftover.length) console.log(`delegations: ${leftover.length} thread(s) with queued handoffs from a previous run — draining`);
  for (const threadId of leftover) {
    const run = routines!.runForThread(threadId);
    // A person can reuse a completed run's task for unrelated work. Only
    // discard the old run's handoffs, not a later user's persisted queue.
    const reused = run?.finishedAt !== undefined && store.botByThread(threadId) &&
      store.activePath(threadId).some((message) => message.role === "user" && message.at > run.finishedAt!);
    if (run && !["running", "waiting"].includes(run.status) && !reused) discardDelegations(commsBus, threadId);
    else drainThreadDelegations(threadId);
  }
  // After the boot drain, not before it: that drain already expires stale
  // leftovers, and a sweep ahead of it would wake delegators of stopped
  // routine runs whose handoffs the loop above discards instead.
  setInterval(expireDelegationsNow, DELEGATION_SWEEP_MS).unref();
});

// A second listener for `openmausbot serve --tunnel` (server/tunnel.ts): the
// connector gateway on this machine forwards public traffic to this IPC path.
// Nothing changes about the loopback bind above. Requests arriving here have
// no peer address, which request-auth treats as "through a proxy": a session
// is required, never loopback trust, whatever headers the request carries.
const TUNNEL_SOCKET = process.env.OMB_TUNNEL_SOCKET?.trim() || null;
let tunnelListener: ReturnType<typeof createServer> | null = null;
if (TUNNEL_SOCKET) {
  if (process.platform !== "win32") rmSync(TUNNEL_SOCKET, { force: true });
  tunnelListener = createServer(handleRequest);
  tunnelListener.listen(TUNNEL_SOCKET, () => {
    console.log(`openmausbot tunnel listener on ${TUNNEL_SOCKET}`);
  });
}

const gracefulShutdown = createGracefulShutdown({
  cleanup: [
    () => {
      followupsReady.set(false);
      companyShutdown = true;
      if (workspaceAccessTimer) clearInterval(workspaceAccessTimer);
      // Child MCP processes and the HTTP listener can remain alive while the
      // asynchronous shutdown jobs drain. Invalidate their turn bearers before
      // any cleanup function reaches an await.
      revokeAllInternalCapabilities();
      sharedComputers.close();
      sharedComputerControl.close();
      browserLive.closeAll();
      for (const idle of localVmIdles.values()) idle.cancel();
      vps.closeAllVpsDesktopTunnels();
      watchdog.stop();
      routines?.stop();
      calendarCalls?.stop();
      webhookIngress?.server.close();
      tunnelListener?.close();
    },
    async () => { await managedDesktop.close(); await registry.disposeAll(); },
    async () => {
      await Promise.all([...temporaryBrowserSessions.keys()].map((botId) => forgetTemporaryBrowser(botId)));
      await browserRuntime.closeAll();
    },
    () => flushAllProfileHistory(),
    () => flushAllMemoryJournals(),
    () => flushUsageLedger(DATA_DIR),
    () => flushDecisionLog(DATA_DIR),
  ],
  // Cleanup jobs run concurrently. Release only after they settle (or reach
  // the shutdown deadline), immediately before the process exits, so no new
  // server can overlap with a still-mutating old one.
  exit: (code) => {
    try { sessions.close(); }
    catch {
      // An uncleared marker makes saved account sessions require sign-in on
      // the next boot; never label failed persistence a clean shutdown.
      console.error("Session persistence failed during shutdown; account sign-in will be required again.");
      code = 1;
    }
    closeMessageDb();
    releaseDataDirLeaseAtExit();
    process.exit(code);
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, gracefulShutdown);
}

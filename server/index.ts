// OpenMausBot server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { createServer } from "node:http";
import { join } from "node:path";

import { SharedComputers } from "./shared-computers.ts";

import { BrowserCleanupCoordinator } from "./browser-lifecycle-cleanup.ts";
import { createDesktopBridge } from "./desktop-bridge.ts";
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


import { runBootSequence } from "./boot-sequence.ts";
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
import { groupIsWorking } from "./group-coordination.ts";
import {
  hostedWorkspaceConfiguration,
  hostedWorkspaceConfigured,
  type WorkspaceAccess,
} from "./enterprise.ts";
import { isWorkspaceBackupSessionControl } from "./workspace-backup-http.ts";
import { createRouteHandlers } from "./route-wiring.ts";
import { createEngineWiring } from "./engine-wiring.ts";
import { titleFromLlm } from "./store.ts";
import { createWorkflowWiring } from "./workflow-wiring.ts";
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
let browserEngineInstall: Promise<void> | null = null;
let browserEngineInstallError: string | null = null;
const {
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
  handoffs,
  reportIncident,
  isContextMessage,
  vpsThreadStarted,
  vpsThreadEnded,
  screenPollers,
  secretMessage,
  selectableComputers,
  sendSequencer,
  settleDirectCoordination,
  settleDirectFollowup,
  settlingResourceOwners,
  sharedComputerControl,
  startGroupTurn,
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
} = createEngineWiring({
  postDesktopPrivateMessage,
  applyDesktopMutationTokenMessage,
  onUtilityParentMessage,
  postUtilityParentMessage,
  browserCleanup,
  PORT,
  sessions,
  providerAuthSessions,
  turnTriggers,
  availableSkills,
  routines: () => routines,
  commsBus: () => commsBus,
  routineSourceOwner: () => routineSourceOwner,
  routineSourceThread: () => routineSourceThread,
  stopBotForEmergencyApprovalDowngrade: () => stopBotForEmergencyApprovalDowngrade,
  stopCompanyInstances: () => stopCompanyInstances,
  configStatus: () => configStatus,
  providerInstancesChanging: () => providerInstancesChanging,
  providerFleet: () => providerFleet,
  startTurn: () => startTurn,
  drainQueuedSends: () => drainQueuedSends,
  retryDelegationsWaitingOn: () => retryDelegationsWaitingOn,
  drainThreadDelegations: () => drainThreadDelegations,
  localVmImageBusy: () => localVmImageBusy,
  localVmModeChangeBusy: () => localVmModeChangeBusy,
  localVmProvisionBusy: { get: () => localVmProvisionBusy, set: (value) => { localVmProvisionBusy = value; } },
  roomSetupPending: () => roomSetupPending,
  resolveReplyTarget: () => resolveReplyTarget,
  routineWiring: () => routineWiring,
  phoneSecretSubmissions: () => phoneSecretSubmissions,
  configForAccess: () => configForAccess,
  webhooks: () => webhooks,
  generateThreadTitle: () => generateThreadTitle,
  browserEngineInstall: { get: () => browserEngineInstall, set: (value) => { browserEngineInstall = value; } },
  browserEngineInstallError: { get: () => browserEngineInstallError, set: (value) => { browserEngineInstallError = value; } },
});
export { browserEngineSummary };

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

const {
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
} = createWorkflowWiring({
  isUnattended,
  delegationWatch,
  activeRoutineRunForThread,
  finalizeDelegationWatch,
  broadcast,
  notify,
  watchdog,
  activeGroupTurnForBot,
  providerTransitionForTurn,
  turnSurfacePlan,
  turnProvider,
  turnInstance,
  checkpointRestoreLeases,
  boxLifecycleBusyBots,
  MAX_COMMS_DEPTH,
  isExternalContextMarker,
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
  turnUsage,
  turnContext,
  personAskAt,
  drainConnectorResumes,
  drainSecretResumes,
  drainTeamSetupResumes,
  drainDelegationWakes,
  releaseTurnResources,
  settlingResourceOwners,
  autoVmClaims,
  releaseLocalVmThread,
  startScreenPoller,
  stopScreenPoller,
  screenPollers,
  vpsThreadStarted,
  vpsThreadEnded,
  turnHandoffs: handoffs,
  reportIncident,
  generateThreadTitle: () => generateThreadTitle,
  markUnattended,
  clearUnattended,
  markInternalTurn,
  clearInternalTurn,
  delegationWakeBudget,
  localVmTargetForBot,
  localVmLeaseFor,
  localVmIdleFor,
  localVmThreadTargets,
  localVmActiveThreads,
  localVmLifecycleBusy,
  localVmSeen,
  localVmOwnerBusy,
  readyLocalVmForTurn,
  bindTurnComputer,
  attachTeamBox,
  controlIntegration,
  browserRuntime,
  browserIntegration,
  phoneIntegration,
  connectedAppsIntegration,
  agentsIntegration,
  activeVpsThreads,
  approvalModeForTurn,
  roomHandoffProblem,
  coordinationSystemInstructions,
  outstandingAssignmentsPrompt,
  teamComputerPrompt,
  inheritedTeamComputer,
  teammateReportContext,
  availableSkills,
  roomHandoffs,
  wakeUndispatchedDelegation,
  parksBehindCoordination,
  followupsReady,
  unattendedDispatchState,
  startGroupTurn,
  cancelGroupTurnOperations,
  cancelDirectTurnDispatch,
  runningTurnInstance,
  groupSpeakers,
  pendingDelegationWakes,
  publicBot,
  interruptAllDirectThreads,
  fullAccessForSource,
  computerProviderConfigTransitions,
  claimBotComputerLifecycle,
  managedBoxOwners,
  localVmLeases,
  localVmIdles,
  computerControl,
  computerControlRevision,
  purgeGeneratedImagesForThread,
  lastReply,
  browserCleanup,
  browserLive,
  forgetTemporaryBrowser,
  pendingTeamSetupResumes,
  cancelTeamSetupResumesForThread,
  assertTeamComputerChangeIdle,
  connectorThread,
  checkedModelSelection,
  wireBot,
  teamSetupResumeGenerations,
  dispatchTeamSetupResume,
  MAX_WORKSPACE_BOTS,
  secretMessage,
  resumeSecretCard,
  phoneSecrets,
  managedDesktop,
  browserEngineSummary,
  localVmImageBusy: () => localVmImageBusy,
  localVmModeChangeBusy: () => localVmModeChangeBusy,
  webhooks: () => webhooks,
  providerFleet: () => providerFleet,
  providerInstancesChanging: () => providerInstancesChanging,
  routines: { get: () => routines, set: (value) => { routines = value; } },
  calendarCalls: { get: () => calendarCalls, set: (value) => { calendarCalls = value; } },
});

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

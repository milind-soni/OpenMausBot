// OpenMausBot server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { rm as removeDirectory } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";

import { z } from "zod";
import { SharedComputers, sharedComputerRegistration } from "./shared-computers.ts";
import { SharedComputerControl } from "./shared-computer-control.ts";
import { RoomHandoffs } from "./room-handoffs.ts";
import { botAvatarUrlFromStoredPath } from "../shared/bot-avatar.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import { CLOUD_COMPUTER_BUSY_ERROR } from "../shared/computer-contention.ts";
import {
  approvalModeFor,
  supportsApprovalMode,
  isApprovalMode,
  type ApprovalMode,
} from "../shared/approval-mode.ts";
import { escapeAttribute } from "../shared/attachments.ts";
import { credentialResumeOutcome, credentialIsConfigured, isCredentialTargetId } from "../shared/credential-request.ts";

import {
  BrowserCleanupCoordinator,
  requireBrowserCleanupAcknowledged,
  type BrowserCleanupWireRequest,
} from "./browser-lifecycle-cleanup.ts";
import * as checkpoints from "./checkpoints.ts";
import { appendDecision, flushDecisionLog } from "./decision-log.ts";
import { validateBotCwd } from "./bot-cwd.ts";
import {
  cleanupStaleAttachmentPartials,
  deleteAttachment,
  saveImage,
} from "./attachments.ts";
import {
  avatarGenerationRequestSchema,
  avatarGenerationStateMatches,
  generateAvatarImage,
  snapshotAvatarGenerationState,
} from "./avatar-image.ts";
import { parseBotProfilePatch } from "./bot-profile.ts";
import * as box from "./box.ts";
import { computerBackendFor } from "./computer-backend.ts";
import { TeamComputers, teamComputerAssignment, teamComputerCreate, teamComputerOwner } from "./team-computers.ts";
import type { WireGroup } from "../shared/wire.ts";
import { boxCreateRecoverySnapshot } from "./box-create-idempotency.ts";
import { boxDeletionSnapshot } from "./box-delete-journal.ts";
import { cloudBackendChangeError } from "./cloud-backend.ts";
import * as composio from "./composio.ts";
import {
  canAccessTeam,
  canReachPeer,
} from "./peer-roster.ts";
import {
  containerComputerAction,
  containerComputerExists,
  containerComputerScreenshot,
  containerComputerStatus,
  containerRuntimeStatus,
  perBotLocalVmTarget,
  SHARED_LOCAL_VM_TARGET,
  setupCommands,
  type LocalVmTarget,
} from "./container-computer.ts";
import {
  instanceConfigs,
  loadConfig,
  localVmMaxInstances,
  localVmMode,
  threadEventLogRetentionDays,
  saveConfig,
  sharedComputersEnabled,
  builtInBrowserEnabled,
  vpsSshAlias,
  DATA_DIR,
  EVENTS_DIR,
  NATIVE_DIR,
  roomHandoffLimits,
} from "./config.ts";
import { sweepThreadEventLogs, type ThreadLogRetentionCandidate } from "./thread-retention.ts";
import { resetPathCache } from "./env-path.ts";
import {
  flushUsageLedger,
  type UsageTrigger,
} from "./usage-ledger.ts";
import type { RequestAuth } from "./request-auth.ts";
import { assertWithinBudget } from "./spend.ts";
import { fleetAvailable, fleetRequest, fleetSocketPath } from "./fleet-client.ts";
import { entitled } from "./enterprise.ts";
import { HOSTED_CONTRACT_HEADER, HOSTED_CONTRACT_METADATA, HOSTED_CONTRACT_VERSION } from "./hosted-contract.ts";
import type { Notification } from "./notify.ts";
import type { ModelSelection, RuntimeEvent, SteerOutcome } from "./contracts.ts";
import {
  MAX_MCP_SERVERS,
  mcpServerNameError,
} from "./mcp-registry.ts";

import type { CommsBus } from "./comms-visibility.ts";
import { closeMessageDb, chatFollowups, cancelledChatFollowup, settleChatFollowups } from "./message-db.ts";
import { promptWithReply } from "./replies.ts";
import {
  discardDelegations,
  drainDelegations,
  expireStaleDelegations,
  pendingDelegationSnapshot,
  pendingThreads,
  releaseDelegationsWaitingOn,
} from "./delegations.ts";
import {
  cancelSteeredMessage,
  drainSteeredMessages,
  holdSteeredQueue,
  onSteeredQueueChange,
  queuedSteeredMessage,
  queuedThreadPosition,
  queueSteeredMessage,
  restoreHeldSteeredQueue,
  restoreSteeredMessages,
  settleHeldSteeredQueue,
} from "./steer-queue.ts";
import { restoreChannelMessages } from "./channel-queue.ts";
import { acceptedSendMatch, parseSendId, sendFingerprint, SendSequencer } from "./send-idempotency.ts";
import { EventBus } from "./harness/bus.ts";
import { ManagedDesktopProviders } from "./managed-desktop.ts";
import { cancelPeerApprovalsFor, dismissStalePeerCards, resolvePeerComms, type ApprovalBus } from "./peer-approval.ts";
import { withPeerProvenance } from "./peer-provenance.ts";
import {
  isProjectEmoji,
  sectionKey,
  titleFromLlm,
  type BotRecord,
  type GroupDefaultResponder,
  type GroupRecord,
  type Message,
} from "./store.ts";
import { extractTurnImages } from "./turn-images.ts";
import { recordHanded } from "./delta-context.ts";
import type { TurnOwner } from "./turn-resources.ts";
import { isMemoryTopicName } from "./workspace.ts";
import { readMemoryTopic } from "./workspace.ts";
import { MEMORY_INDEX, MemoryStoreError, memoryCapacity, memoryOverview, openMemoryLocation, readMemoryDoc } from "./memory-store.ts";
import {
  flushAllMemoryJournals,
  flushMemoryJournal,
  journalMemoryDelete,
  journalMemoryWrite,
  readMemoryJournal,
  revertMemoryChange,
  type MemoryJournalEntry,
} from "./memory-journal.ts";
import {
  readSectionContext,
  readSections,
  sectionContextKey,
  sectionContextLabel,
  writeSectionContext,
  SECTION_CONTEXT_MAX_BYTES,
} from "./section-context.ts";
import {
  applyStagedSkillWrite,
  getStagedSkillWrite,
  installSkill,
  listSkills,
  listStagedSkillWrites,
  readSkillFile,
  rejectStagedSkillWrite,
  removeSkill,
  setSkillEnabled,
} from "./skills.ts";
import { fetchSkillFromSource } from "./skill-fetch.ts";
import type { SkillRequestCardData } from "../shared/skill-request.ts";
import { readSoulDrift, soulFile, writeSoulMirror } from "./bot-folder.ts";
import { discoverExistingPerBotLocalVms, shouldArmLocalVmIdle } from "./local-vm-inventory.ts";
import { redactSecretsInText } from "./redact.ts";
import * as vps from "./vps-computer.ts";
import { createRoutineWiring } from "./routine-wiring.ts";
import { RoutineManager, type RoutineRun } from "./routines.ts";
import { CalendarCallManager, type CalendarCall } from "./calendar-calls.ts";
import {
  browserEngineEncryptionKey,
  clearBrowserSessionState,
  ensureChrome,
  installAgentBrowserBinary,
  resolveAgentBrowserBinary,
  browserEngineStatus,
  browserSessionId,
} from "./browser-engine.ts";
import { RoutineRequestService } from "./routine-requests.ts";
import { ProfileRequestService } from "./profile-requests.ts";
import { TeamSetupError, TeamSetupRequestService } from "./team-setup-requests.ts";
import type { TeamSetupRequest } from "../shared/team-setup.ts";
import { profileRevision, profileSnapshot } from "./profile-revision.ts";
import { flushAllProfileHistory, flushProfileHistory, readHistory, recordProfileChange } from "./profile-versions.ts";
import { readThreadEvents } from "./thread-events.ts";
import { listenWebhookIngress, type WebhookIngress } from "./webhook-ingress.ts";
import { WebhookManager } from "./webhooks.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { loadBundledSkills, loadUserSkills, mergeSkills } from "./skill-library.ts";
import { parseSurface } from "./surface.ts";
import { createDeferredResumes } from "./deferred-resumes.ts";
import { createDelegationWatch } from "./delegation-watch.ts";
import { createTurnIntegrations } from "./turn-integrations.ts";
import {
  addGroupGoalCoordinatorTurn,
  createGroupCoordination,
  GROUP_GOAL_COORDINATOR_GUARD_MS,
  groupGoalCoordinatorTurns,
  groupIsWorking,
  groupQueues,
  hasUnboundDiscardedGroupGoalTurn,
  removeGroupGoalCoordinatorTurn,
} from "./group-coordination.ts";
import { createBotViews, setActiveCoordinationForThread } from "./bot-views.ts";
import {
  checkedGroupResponder,
  checkedMemberIds,
  createCheckedInputs,
} from "./checked-inputs.ts";
import { createDesktopApproval } from "./desktop-approval.ts";
import { createScreenPollers } from "./screen-pollers.ts";
import { createComputerLifecycle, type RemoteComputerProvider } from "./computer-lifecycle.ts";
import { createGroupTurn } from "./group-turn.ts";
import {
  createGroupTurnOperations,
  groupProviderHandshakeStarted,
  updateGroupGoalRunProgress,
} from "./group-turn-operations.ts";
import { createConfigViews } from "./config-views.ts";
import { createLocalVmTurnPrep } from "./local-vm-turn-prep.ts";
import { createTurnSecrets } from "./turn-secrets.ts";
import { createGracefulShutdown } from "./graceful-shutdown.ts";
import {
  createWorkspaceAccess,
  describeEdition,
  editionStatus,
  hostedWorkspaceConfiguration,
  hostedWorkspaceConfigured,
  loadEnterpriseLayer,
  type WorkspaceAccess,
} from "./enterprise.ts";
import { environmentDescriptor, serverVersion } from "./environment.ts";
import { createWorkspaceBackupRoutes, isWorkspaceBackupSessionControl } from "./workspace-backup-http.ts";
import { json, readBody } from "./http.ts";
import { createEventsRoutes } from "./routes/events.ts";
import { createRoutinesRoutes } from "./routes/routines.ts";
import { createInternalRoutes, type AskBotOutcome, type InternalCapability } from "./routes/internal.ts";
import { createCalendarCallRoutes } from "./routes/calendar-calls.ts";
import { createInstanceRoutes } from "./routes/instances.ts";
import { createMcpRoutes } from "./routes/mcp.ts";
import { createTtsRoutes } from "./routes/tts.ts";
import { createConnectorRoutes } from "./routes/connectors.ts";
import { createWebhookRoutes } from "./routes/webhooks.ts";
import { createMessageRoutes, createRequirePinnedClientThread } from "./routes/messages.ts";
import { createTeamRoutes } from "./routes/teams.ts";
import { createBotRoutes } from "./routes/bots.ts";
import { createUsageRoutes } from "./routes/usage.ts";
import { createConfigRoutes } from "./routes/config.ts";
import type { RouteContext } from "./routes/http.ts";
import {
  activeInternalGenerationByThread,
  beginInternalCapabilityGeneration,
  computerSelectionTurns,
  internalCapabilities,
  mintInternalCapability,
  revokeAllInternalCapabilities,
  revokeInternalCapabilitiesForThread,
} from "./internal-capabilities.ts";
import { answerRequest, closeOpenApprovals, requestBehavior } from "./turn-fold.ts";
import {
  cfg,
  defaultSelection,
  ENVIRONMENT_ID,
  registry,
  releaseDataDirLeaseAtExit,
  store,
  teamComputerTurns,
  workspaceMaintenance,
  workspaceRestore,
} from "./runtime.ts";
import {
  botAtThreadCapacity,
  botForThread,
  claimTurnResource,
  directTurnBots,
  directTurnDispatchClaims,
  hasDirectDispatch,
  requestedTaskBot,
  threadBusy,
  turnComputerResources,
  turnResourceOwners,
  turnResources,
} from "./turn-admission.ts";
import { createProviderFleet } from "./provider-fleet.ts";
import { roomHandoffHandlers } from "./room-handoff-wiring.ts";
import { createTurnCleanup } from "./turn-cleanup.ts";
import { createEventFold } from "./event-fold.ts";
import { createStartTurn } from "./start-turn.ts";
import { createCustomDomainVerifier, customDomainIpv4, normalizeCustomDomain } from "./custom-domain.ts";
import { allowedScopes, createEmailSignIn, parseAllowList } from "./account-signin.ts";
import { ProviderAuthSessions } from "./provider-auth-sessions.ts";
import {
  clearSessionCookie,
  clientBotPatchViolation,
  isLoopbackHost,
  isProxied,
  labelFromUserAgent,
  requestOrigin,
  requestSource,
  resolveRequestAuth,
  parseCookies,
  serializeSessionCookie,
  sessionCookieName,
} from "./request-auth.ts";
import { cookieMaxAgeSeconds, formatPairingCode, SessionRegistry, type Scope } from "./sessions.ts";
import { describeBrand, loadBrand } from "./brand.ts";
import {
  PHONE_SECRET_PROTOCOL_VERSION,
  PhoneSecretBridge,
  PhoneSecretSubmissionRegistry,
} from "./phone-secret.ts";
import { computerFreeText, computerStillBusyText, computerWaitEndedText, computerWaitingText, type ComputerHolder } from "./computer-wait.ts";

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
let customDomainRevision = 0;
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

// Electron's utility-process parent port is private to the desktop main
// process. It lets a slow first-time managed Composio registration arrive
// after first paint without putting the credential in the renderer or
// restarting the embedded server. Plain Node/dev launches have no parentPort.
type UtilityParentPort = {
  on(event: "message", listener: (event: { data?: object }) => void): void;
  postMessage(message: object): void;
};
// SAFETY: Electron's utility-process runtime is the only environment that
// supplies parentPort; plain Node intentionally leaves it absent.
const utilityParentPort = (process as NodeJS.Process & { parentPort?: UtilityParentPort }).parentPort;
type DesktopPrivateMessage = BrowserCleanupWireRequest | {
  type: "openmausbot:browser-control";
  botId: string;
  held: true;
} | {
  type: "openmausbot:phone-secret-save";
  requestId: string;
  target: string;
  value: string;
} | {
  type: "approval-trusted-mode-result" | "approval-trusted-mode-commit-result";
  requestId: string;
  ok: boolean;
  bot?: ReturnType<typeof wireBot>;
  error?: string;
} | {
  type: "approval-trusted-mode-confirm-result";
  requestId: string;
  ok: boolean;
  error?: string;
} | {
  type: "approval-trusted-mode-activate-result" | "approval-trusted-mode-finalize-result";
  requestId: string;
  ok: boolean;
  error?: string;
};
function postDesktopPrivateMessage(message: DesktopPrivateMessage): boolean {
  if (!utilityParentPort) return false;
  try {
    utilityParentPort.postMessage(message);
    return true;
  } catch (error) {
    console.error(`[desktop-sync] could not send private parent message: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
function applyDesktopMutationTokenMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const message = raw as Record<string, unknown>;
  if (message.type !== "openmausbot:desktop-mutation-token") return false;
  if (typeof message.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(message.token)) {
    throw new Error("invalid desktop mutation capability");
  }
  desktopMutationToken = message.token;
  if (typeof message.companionToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(message.companionToken)) {
    companionMutationToken = message.companionToken;
  }
  return true;
}
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
// groupProviderHandshakeStarted are imported from it directly. The factory is
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
    publicGroupState,
    notify,
    routineSourceOwner,
    routineSourceThread,
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
    stopBotForEmergencyApprovalDowngrade,
  },
});

const phoneSecrets = new PhoneSecretBridge(postDesktopPrivateMessage);
utilityParentPort?.on("message", (event) => {
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
utilityParentPort?.on("message", event => {
  const message = event.data as { type?: unknown; requestId?: unknown; connection?: unknown } | undefined;
  if (message?.type !== "openmausbot:managed-desktop") return;
  const requestId = typeof message.requestId === "string" && message.requestId.length <= 100 ? message.requestId : undefined;
  void companyRuntimeStarted.then(() => managedDesktop.apply(message.connection)).then(() => {
    utilityParentPort.postMessage({ type: "openmausbot:managed-desktop-result", requestId, ok: true });
  }, () => {
    utilityParentPort.postMessage({ type: "openmausbot:managed-desktop-result", requestId, ok: false, error: "Company connection could not be applied. Reconnect from desktop Settings." });
  });
});

// ── peer-agent comms wiring ────────────────────────────────────────────
// The capability store, generation registries, and the mint/revoke helpers
// live in ./internal-capabilities.ts. The bearer predicates stay here:
// internalCapabilityIsActive also reads the team-computer turn table and
// the local VM lease pool, which remain index-local.

/** Resolve a high-entropy bearer to its immutable server-side claims.
 * Constant-time comparisons keep the check independent of matching prefix
 * length; only capabilities for currently active turns are retained. */
function authorizedInternalCapability(header: string | string[] | undefined): InternalCapability | null {
  const got = Buffer.from(Array.isArray(header) ? "" : (header ?? ""));
  for (const [token, capability] of internalCapabilities) {
    if (!internalCapabilityIsActive(capability)) {
      internalCapabilities.delete(token);
      continue;
    }
    const expected = Buffer.from(`Bearer ${token}`);
    if (got.length === expected.length && timingSafeEqual(got, expected)) return capability;
  }
  return null;
}

function internalCapabilityIsActive(capability: InternalCapability): boolean {
  const switching = computerSelectionTurns.get(capability.threadId);
  if ((capability.kind === "computer" || capability.kind === "browser") &&
      switching?.generation === capability.generation && switching.selected) return false;
  if (capability.teamComputerId) {
    const pinned = teamComputerTurns.get(capability.threadId);
    if (pinned?.computerId !== capability.teamComputerId || pinned.owner.generation !== capability.generation ||
        pinned.botId !== capability.botId) return false;
  }
  if (capability.localVmTarget) {
    const owner = localVmLeaseFor(capability.localVmTarget).current(localVmOwnerBusy);
    if (localVmThreadTargets.get(capability.threadId) !== capability.localVmTarget ||
        owner?.threadId !== capability.threadId || owner.botId !== capability.botId) return false;
  }
  return (
    capability.orphanExpiresAt > Date.now() &&
    activeInternalGenerationByThread.get(capability.threadId) === capability.generation
  );
}
// Cap message chains: depth 0 = a user-initiated turn (may ask a peer);
// a peer invoked via ask_bot runs at depth 1 and gets NO agents tool, so
// A→B is allowed but B→C (and A→B→A loops) never start.
const MAX_COMMS_DEPTH = 1;
const MAX_WORKSPACE_BOTS = 100;
const createSidebarSectionSchema = z.object({
  name: z.string(),
  botIds: z.array(z.string().regex(/^[\w-]+$/)).max(MAX_WORKSPACE_BOTS).default([]),
}).strict();
const createGroupTaskRequestSchema = z.object({ title: z.string().optional() });
const phoneSecretEnvelopeSchema = z.object({
  version: z.literal(PHONE_SECRET_PROTOCOL_VERSION),
  threadId: z.string().regex(/^[\w-]{1,128}$/),
  keyId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  deviceId: z.string().regex(/^[\w-]{1,128}$/),
  target: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
  requestKey: z.string().regex(/^[\w-]{1,128}$/),
  encapsulatedKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{23,5483}$/),
}).strict();
// Resolved from the server root — see server/proxy-paths.ts. This descending
// path happened to survive bundling, but it goes through the same anchor so
// there is exactly one way proxies are located.
const agentsProxyPath = SPAWNED_PROXIES.agents;
const phoneProxyPath = SPAWNED_PROXIES.phone;
// in the packaged app process.execPath is Electron — run the proxy as node
const AGENTS_NODE_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

function agentsIntegration(
  botId: string,
  threadId: string,
  depth: number,
  skillAuthoring: boolean,
  generation: string,
  roomHandoffId?: string,
  roomCoordination = false,
  ownThreadCreation = false,
) {
  const token = mintInternalCapability({
    botId,
    threadId,
    generation,
    depth,
    kind: "agents",
    skillAuthoring,
    createdBots: 0,
    openedThreads: 0,
    roomHandoffId,
    roomCoordination,
    ownThreadCreation,
  });
  return {
    command: process.execPath,
    args: [agentsProxyPath],
    env: {
      ...AGENTS_NODE_FLAG,
      OMB_HARNESS_URL: `http://127.0.0.1:${PORT}`,
      OMB_BOT_ID: botId,
      OMB_THREAD_ID: threadId,
      OMB_COMMS_TOKEN: token,
      OMB_TURN_DEPTH: String(depth),
      OMB_TURN_GENERATION: generation,
      OMB_ROOM_TURN: roomCoordination ? "1" : "0",
      OMB_OWN_THREAD_CREATION: ownThreadCreation ? "1" : "0",
      OMB_SKILL_AUTHORING_ENABLED: skillAuthoring ? "1" : "0",
      // The shared-computer tools are advertised only while the workspace
      // gate is on; the routes behind them refuse regardless.
      OMB_SHARED_COMPUTERS_ENABLED: sharedComputersEnabled(cfg) ? "1" : "0",
    },
  };
}


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
// ── computer / VM lifecycle ──────────────────────────────────────────────────────────
// The computer/VM lifecycle cluster lives in ./computer-lifecycle.ts: the
// local-VM lease/idle/thread registries, the Box/VPS provider busy-sets and
// claim lanes, team-computer control accounting, and the surface/provider
// resolution a turn or route asks for. It is wired here because the
// screen-pollers factory just below is the earliest module-level by-value
// consumer (botComputerControlSnapshot); thunks cover the consts this file
// declares after this site.
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
} = createComputerLifecycle({
  lateBound: {
    routines: () => routines,
    computerControl: () => computerControl,
    teamComputers: () => teamComputers,
    autoVmClaims: () => autoVmClaims,
    localVmImageBusy: () => localVmImageBusy,
    startTurn: (botId, text, opts) => startTurn(botId, text, opts),
  },
  helpers: {
    bindTurnComputer, controlIntegration, activeGroupTurnForBot,
  },
  state: {
    directTurnGenerationByThread,
  },
});
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
    isUnattended,
    activeGroupTurnForBot,
    turnInstance,
    notify,
  },
});

// The live-screen pollers live in ./screen-pollers.ts. Their functions were
// hoisted declarations here — usable from module start — so the factory is
// wired before the first consumer (turnCleanup below) with thunks for the
// consts declared after this site.
const {
  screenPollers, SCREEN_SETTLE_TIMEOUT_MS,
  startScreenPoller, pokeScreenPoller, stopScreenPoller, finalScreenFrame,
} = createScreenPollers({
  lateBound: {
    broadcast: () => broadcast,
    computerControlRevision: () => computerControlRevision,
  },
  helpers: {
    currentBrowserSession,
    botComputerControlSnapshot,
  },
});
const sharedComputerControl = new SharedComputerControl(turnResources, () => store.bots.some(bot => botComputerControlSnapshot(bot.id).held));
const turnCleanup = createTurnCleanup({
  store,
  turnResources,
  turnResourceOwners,
  turnComputerResources,
  teamComputerTurns,
  directTurnGenerationByThread,
  stopScreenPoller,
  roomHandoffs: () => roomHandoffs,
  botForThread,
  cancelDirectTurnDispatch,
  revokeInternalCapabilitiesForThread,
  runningTurnInstance,
  closeOpenApprovals,
});
const { releaseTurnResources, interruptDirectThread, settlingResourceOwners, autoVmClaims } = turnCleanup;

async function bindTurnComputer(owner: TurnOwner, resource: string, exclusive = false): Promise<void> {
  const active = () => activeInternalGenerationByThread.get(owner.threadId) === owner.generation &&
    turnResourceOwners.get(owner.threadId)?.generation === owner.generation;
  let waitingMessage: Message | undefined;
  // Who holds the desktop, as the chip and the give-up error name them: a
  // bot running a titled thread, or a room. Read once, when the wait begins.
  let holder: ComputerHolder | undefined;
  const deadline = Date.now() + GROUP_GOAL_WAIT_MAX_MS;
  try {
    while (true) {
      if (!active()) throw new DirectTurnSetupCancelled("Computer wait cancelled");
      if (!exclusive || claimTurnResource(owner, resource)) break;
      if (!waitingMessage) {
        const blocker = turnResources.blocker(resource, owner);
        const holderBot = blocker && store.botByThread(blocker.threadId);
        const holderTask = holderBot && blocker && store.taskByThread(holderBot.id, blocker.threadId);
        const holderRoom = !holderBot && blocker ? store.groupByThread(blocker.threadId) : null;
        holder = holderBot
          ? { name: holderBot.name, ...(holderTask?.title ? { task: holderTask.title } : {}) }
          : holderRoom ? { name: holderRoom.name } : undefined;
        waitingMessage = store.appendMessage(owner.threadId, {
          role: "bot", kind: "activity",
          tool: { name: computerWaitingText(holder) },
          ...(holderBot && holderTask ? { threadRef: { botId: holderBot.id, threadId: holderTask.threadId, title: holderTask.title } } : {}),
        });
      }
      if (Date.now() >= deadline) throw new Error(computerStillBusyText(holder, GROUP_GOAL_WAIT_MAX_MS));
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  } finally {
    if (waitingMessage) store.patchMessage(owner.threadId, waitingMessage.id, {
      tool: { name: active() && turnResources.owns(resource, owner) ? computerFreeText() : computerWaitEndedText(), ok: true },
    });
  }
  turnResourceOwners.set(owner.threadId, owner);
  turnComputerResources.set(owner.threadId, { owner, resource });
}

/** Opt-in direct-chat parking (#1194): when this bot's person chose to queue
 * messages behind running work, a message that arrives while delegated
 * assignments are still out waits in the steer queue — room-style parking —
 * instead of steering the conversation immediately. */
function parksBehindCoordination(botId: string, threadId: string): boolean {
  if (!roomHandoffs.activeDirect(threadId)) return false;
  return (store.projectBotForTask(botId, threadId) ?? store.bot(botId))?.parkDirectMessages === true;
}

/** Routine and webhook dispatch shares startTurn's admission preconditions
 * instead of waiting for whole-bot idleness: a free thread slot and no
 * active group turn. A group turn blocks scheduled starts the same way it
 * blocks every other turn kind; it does not consume a capacity slot. */
function unattendedDispatchState(botId: string): "ready" | "busy" | "missing" {
  const bot = store.bot(botId);
  return !bot ? "missing" : botAtThreadCapacity(botId) || activeGroupTurnForBot(botId) ? "busy" : "ready";
}

async function interruptAllDirectThreads(botId: string): Promise<void> {
  const threads = store.tasks(botId).filter((task) => task.busy || directTurnDispatchClaims.has(task.threadId) || roomHandoffs.activeDirect(task.threadId));
  // Revoke every sibling before yielding to any provider teardown.
  for (const task of threads) {
    cancelDirectTurnDispatch(botId, task.threadId);
    revokeInternalCapabilitiesForThread(task.threadId);
  }
  await Promise.all(threads.map((task) => interruptDirectThread(botId, task.threadId)));
}

/** Run a turn on `targetBotId` and resolve with its assistant text — the
 * synchronous half of ask_bot. Subscribes to the bus, folds assistant_text
 * for that thread, resolves on turn.completed (or a 4-min ceiling). */
function askBotAndWait(targetBotId: string, message: string, depth: number, fromBotId?: string, fromThreadId?: string, targetThreadId?: string): Promise<AskBotOutcome> {
  const target = store.bot(targetBotId);
  if (!target) return Promise.resolve({ status: "error", text: "(no such bot)" });
  const threadId = targetThreadId ?? target.threadId;
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (out: AskBotOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(out);
    };
    const unsub = bus.subscribe((e: RuntimeEvent) => {
      // A cancelled provider may flush text/completion after its replacement
      // has started on the same thread. Retired turn ids must never satisfy a
      // newer ask_bot waiter with the old partial reply.
      if (shouldIgnoreProviderEvent(e)) return;
      if (e.threadId !== threadId) return;
      if (e.type === "item.completed" && e.itemType === "assistant_text") {
        text += (text ? "\n" : "") + e.text;
      } else if (e.type === "turn.completed") {
        if (e.ok) finish({ status: "reply", text: text || "(the bot finished without a text reply)" });
        else finish({ status: "failed", text, stopReason: e.stopReason ?? null });
      }
    });
    // Timing out does NOT stop the peer's turn — the caller decides whether
    // the still-running work becomes a delegation claim ticket instead.
    const timer = setTimeout(() => finish({ status: "timeout", text }), ASK_BOT_TIMEOUT_MS);
    // The asker's identity rides on the stored line as well as in the note
    // prefixed to it: the wording is for the model reading this turn, the
    // field is for anything that reads the transcript later.
    const asker = fromBotId ? store.bot(fromBotId) : undefined;
    const unattended = isUnattended(fromBotId, fromThreadId);
    startTurn(targetBotId, message, {
      threadId,
      commsDepth: depth + 1,
      unattended,
      peerAsk: asker
        ? unattended
          ? { botId: asker.id, name: asker.name, unattended: true }
          : { botId: asker.id, name: asker.name }
        : undefined,
      onDispatchError: (reason) => finish({ status: "error", text: `(couldn't start that bot: ${reason})` }),
    }).catch((err) =>
      finish({ status: "error", text: `(couldn't start that bot: ${err instanceof Error ? err.message : String(err)})` }),
    );
  });
}
// The checked-input validators live in ./checked-inputs.ts: the pure ones
// (checkedExportSkillNames, collectExportSkills, checkedGroupResponder,
// checkedMemberIds) are imported directly, while checkedModelSelection and
// checkedTaskModelSwitch come from the createCheckedInputs factory wired near
// the top of this file — they read the providerInstancesChanging set this
// file destructures from providerFleet far below. askBotAndWait stays here:
// it orchestrates turns over the module bus and the late-bound startTurn.
const teamComputers = new TeamComputers(join(DATA_DIR, "team-computers.json"), ENVIRONMENT_ID);
let followupsReady = false;
const sendSequencer = new SendSequencer();
// A committed profile cleanup means both its config deletion and bot-reference
// cleanup were intended to be durable. Reconcile stale secondary references
// before Electron can ACK and remove the journal: a crash between those writes
// in an older build must not let id reuse attach a bot to somebody else's new
// account. Prepared entries remain untouched because their deletion is
// ambiguous and must never authorize either mutation or a wipe.
let browserCleanupReferencesReconciled = true;
try {
  const committedProfileIds = new Set(browserCleanup.committedProfileIds());
  for (const bot of store.bots) {
    if (bot.browserProfile && committedProfileIds.has(bot.browserProfile)) {
      store.patchBot(bot.id, { browserProfile: undefined });
    }
  }
} catch (error) {
  browserCleanupReferencesReconciled = false;
  console.error(
    `browser cleanup: could not reconcile committed profile references: ${error instanceof Error ? error.message : String(error)}`,
  );
}
// Replay only after the secondary write above is durable. If reconciliation
// failed, leave the committed journal in place and profile reuse blocked.
if (browserCleanupReferencesReconciled) browserCleanup.startPending();

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
// The group-coordination registry and coordination copy/policy helpers
// live in ./group-coordination.ts: the groupTurnOperations and
// groupGoalCoordinatorTurns maps, groupQueues and groupIsWorking are
// module state there; the helpers that read host state come from
// createGroupCoordination, wired at this, the registry's original site —
// after createTurnIntegrations supplies retireProviderTurn by value and
// before createGroupTurn, the room-handoff handlers and the event fold
// consume its results — with roomHandoffs, declared just below, arriving
// as a thunk.
const {
  groupGoalCoordinatorTurnForEvent, channelTaskBlocked, roomHandoffProblem,
  coordinationSystemInstructions, coordinationTurnText,
} = createGroupCoordination({
  lateBound: { roomHandoffs: () => roomHandoffs },
  helpers: { retireProviderTurn, roomSetupPending },
});

// The public and Chief room tools use the same synchronous validation and write.
// Keep authorization at each ingress; no internal caller gains public admin scope.
function createChannel(value: unknown): GroupRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("channel must be a JSON object"), { status: 400 });
  }
  const body = value as Record<string, unknown>;

  const roster = checkedMemberIds(body.memberIds);
  if (!roster.ok) throw Object.assign(new Error(roster.error), { status: 400 });
  const { memberIds } = roster;
  if (body.name !== undefined && typeof body.name !== "string") {
    throw Object.assign(new Error("channel name must be a string"), { status: 400 });
  }
  const name = body.name?.trim() || `${store.bot(memberIds[0])!.name} & co.`;
  if (name.length > 100) throw Object.assign(new Error("channel name must be at most 100 characters"), { status: 400 });
  let section: string | undefined;
  if (body.section !== undefined && body.section !== null) {
    if (typeof body.section !== "string") throw Object.assign(new Error("context must be a string"), { status: 400 });
    section = body.section.trim() || undefined;
    if (section && section.length > 60) {
      throw Object.assign(new Error("context must be at most 60 characters"), { status: 400 });
    }
  }
  let setup:
    | { bulletin: string; defaultResponder: GroupDefaultResponder; completed: true }
    | undefined;
  if (body.setup !== undefined) {
    if (!body.setup || typeof body.setup !== "object" || Array.isArray(body.setup)) {
      throw Object.assign(new Error("setup must be an object"), { status: 400 });
    }
    const requested = body.setup as { bulletin?: unknown; defaultResponder?: unknown };
    if (typeof requested.bulletin !== "string") {
      throw Object.assign(new Error("setup.bulletin must be a string"), { status: 400 });
    }
    if (requested.bulletin.length > 12_000) {
      throw Object.assign(new Error("setup.bulletin must be at most 12000 characters"), { status: 400 });
    }
    const responder = checkedGroupResponder(requested.defaultResponder, memberIds);
    if (!responder) throw Object.assign(new Error("invalid setup.defaultResponder"), { status: 400 });
    setup = { bulletin: requested.bulletin, defaultResponder: responder, completed: true };
  }
  return store.createGroup(name, memberIds, false, section, setup);
}

function updateChannel(groupId: string, value: unknown): GroupRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("body must be a JSON object"), { status: 400 });
  }
  const body = value as Record<string, unknown>;

  const existing = store.group(groupId);
  if (!existing) throw Object.assign(new Error("no such room"), { status: 404 });
  if (body.memberIds !== undefined && phoneSecretSubmissions.hasGroup(existing.id)) {
    throw Object.assign(new Error("this channel is securely saving a credential — try again when it finishes"), { status: 409 });
  }
  if (
    channelTaskBlocked(existing) &&
    (body.memberIds !== undefined || body.defaultResponder !== undefined || body.bulletin !== undefined)
  ) {
    throw Object.assign(new Error("this channel is working or waiting on you — finish that turn first"), { status: 409 });
  }
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string") throw Object.assign(new Error("room name must be a string"), { status: 400 });
    const name = body.name.trim();
    if (!name) throw Object.assign(new Error("room name must not be empty"), { status: 400 });
    if (name.length > 100) throw Object.assign(new Error("room name must be at most 100 characters"), { status: 400 });
    patch.name = name;
  }
  if (body.bulletin !== undefined) {
    if (typeof body.bulletin !== "string") throw Object.assign(new Error("bulletin must be a string"), { status: 400 });
    if (body.bulletin.length > 12_000) {
      throw Object.assign(new Error("bulletin must be at most 12000 characters"), { status: 400 });
    }
    patch.bulletin = body.bulletin;
  }
  if (body.unread !== undefined) {
    if (typeof body.unread !== "boolean") throw Object.assign(new Error("unread must be true or false"), { status: 400 });
    patch.unread = body.unread;
  }
  if (body.memberIds !== undefined) {
    // A DM is the pair it was opened for; only real rooms have a roster.
    if (existing.dm) throw Object.assign(new Error("direct-message channels cannot change members"), { status: 400 });
    const roster = checkedMemberIds(body.memberIds);
    if (!roster.ok) throw Object.assign(new Error(roster.error.replace("channel", "room")), { status: 400 });
    const removedGoalLead = routines!.listRoutines().some(
      (routine) =>
        routine.enabled &&
        routine.target === "room-goal" &&
        routine.groupId === existing.id &&
        !roster.memberIds.includes(routine.botId),
    ) || routines!.listRuns().some(
      (run) =>
        run.target === "room-goal" &&
        run.groupId === existing.id &&
        ["queued", "running", "waiting"].includes(run.status) &&
        !roster.memberIds.includes(run.botId),
    );
    if (removedGoalLead) {
      throw Object.assign(new Error("pause or reassign this room's team-goal routine before removing its lead"), { status: 409 });
    }
    patch.memberIds = roster.memberIds;
  }
  if (body.defaultResponder !== undefined) {
    const memberIds = (patch.memberIds as string[] | undefined) ?? existing.memberIds;
    const responder = checkedGroupResponder(body.defaultResponder, memberIds);
    if (!responder) throw Object.assign(new Error("invalid default responder"), { status: 400 });
    patch.defaultResponder = responder;
  }
  if (body.cwd !== undefined) {
    if (existing.dm) throw Object.assign(new Error("direct-message channels cannot have a working folder"), { status: 400 });
    if (existing.pinnedCwd !== undefined) {
      throw Object.assign(new Error("the room's working folder is fixed after its first turn"), { status: 409 });
    }
    const checked = validateBotCwd(body.cwd);
    if (!checked.ok) throw Object.assign(new Error(checked.error), { status: 400 });
    patch.cwd = checked.cwd ?? undefined;
  }
  // one pinned message per room; null/"" clears. The id is not
  // validated against the transcript here — a pin whose message was
  // edited away or deleted simply resolves to nothing in the UI.
  if (body.pinnedMessageId !== undefined) {
    if (body.pinnedMessageId === null || body.pinnedMessageId === "") patch.pinnedMessageId = undefined;
    else if (typeof body.pinnedMessageId === "string" && /^[\w-]+$/.test(body.pinnedMessageId)) {
      patch.pinnedMessageId = body.pinnedMessageId;
    } else throw Object.assign(new Error("pinnedMessageId must be a message id"), { status: 400 });
  }
  // same contract as a bot's sidebar section: null/"" clears, 60 chars max
  if (body.section !== undefined) {
    if (body.section === null) patch.section = undefined;
    else if (typeof body.section !== "string") throw Object.assign(new Error("section must be a string"), { status: 400 });
    else {
      const trimmed = body.section.trim();
      if (!trimmed) patch.section = undefined;
      else if (trimmed.length > 60) throw Object.assign(new Error("section must be at most 60 characters"), { status: 400 });
      else patch.section = trimmed;
    }
  }
  const group = store.patchGroup(groupId, patch);
  if (!group) throw Object.assign(new Error("no such room"), { status: 404 });
  return group;
}

/** A person may steer a conversation whose teammates are still working: the
 * new turn starts now and the assignments stay attached. Tell that turn what
 * is still out — a model told nothing assumes its fan-out died and sends the
 * same work again, or reports it as lost. */
function outstandingAssignmentsPrompt(threadId: string): string {
  const pending = roomHandoffs.outstandingDirect(threadId);
  if (!pending.length) return "";
  const listed = pending.map(node => ({
    requestId: node.id,
    bot: store.bot(node.botId)?.name ?? "Teammate",
    assignment: node.text.slice(0, 1_000),
    status: node.status === "queued" ? "waiting for that teammate to be free" : "working on it now",
  }));
  return ` Assignments you already sent are still outstanding, and nothing in this conversation cancelled them: ${JSON.stringify(listed)}. Do not send them again, do not poll or wait for them, and do not tell the user they were lost. Each result returns to this conversation on its own and resumes you then. Answer the message above with that work still in flight.`;
}

// ── deferred resumes ───────────────────────────────────────────────────
// The three pending-resume queues that re-dispatch a blocked turn once the
// card it paused for settles — team-setup decisions, inline connector cards
// and secret/credential cards — live in ./deferred-resumes.ts. It is wired
// here because createGroupTurn just below is the earliest module-level
// by-value consumer of its drains; runGroupMemberTurn and startTurn are
// wrapper thunks over consts this file declares after this site.
const {
  pendingTeamSetupResumes, teamSetupResumeGenerations,
  cancelTeamSetupResumesForThread, dispatchTeamSetupResume, drainTeamSetupResumes,
  connectorThread, connectorMessage, maybeResumeConnectors, drainConnectorResumes,
  secretMessage, resumeSecretCard, drainSecretResumes,
} = createDeferredResumes({
  lateBound: {
    runGroupMemberTurn: (groupId, threadId, botId, hop, spoken, cardContinuation, onDispatchError, isCancelled, onProviderHandshakeStarted, onProviderHandshakeSettled) =>
      runGroupMemberTurn(groupId, threadId, botId, hop, spoken, cardContinuation, onDispatchError, isCancelled, onProviderHandshakeStarted, onProviderHandshakeSettled),
    startTurn: (botId, text, opts) => startTurn(botId, text, opts),
  },
  helpers: {
    activeGroupTurnForBot,
    beginGroupTurnOperation, finishGroupTurnOperation,
    groupProviderHandshakeStarted, groupProviderHandshakeSettled,
  },
  state: { groupQueues },
});

// ── local VM turn prep ───────────────────────────────────────────────────────────────────────
// The Local VM turn-prep helpers live in ./local-vm-turn-prep.ts: the
// payload view, the recreate-if-idle-removed readiness walk, and the
// per-bot instance counts. Wired here because createGroupTurn just below
// is the earliest module-level by-value consumer of readyLocalVmForTurn;
// broadcast and the mutable localVmProvisionBusy flag arrive as thunks
// over consts this file declares after this site.
const {
  localVmPayload, readyLocalVmForTurn, existingPerBotLocalVmCount, perBotLocalVmCountForModeChange,
} = createLocalVmTurnPrep({
  lateBound: {
    broadcast: (payload) => broadcast(payload),
    setLocalVmProvisionBusy: (value) => { localVmProvisionBusy = value; },
  },
  lifecycle: {
    localVmLifecycleBusy, LOCAL_VM_IDLE_MS, LOCAL_VM_DESKTOP_WAIT_MS, localVmIdleFor, noteLocalVmSeen,
  },
});
// ── group turn engine ───────────────────────────────────────────────────────────────
// The room/goal turn engine lives in ./group-turn.ts. It is wired here
// because roomHandoffs (just below) is the earliest module-level consumer
// of runGroupMemberTurn; thunks read consts declared later in this file.
const {
  runGroupMemberTurn, teammateReportContext, roomPostBudgets, startGroupTurn, drainQueuedChannelSends,
} = createGroupTurn({
  events: {
    bus, watchdog: () => watchdog, roomStallCompletions: () => roomStallCompletions,
    shouldIgnoreProviderEvent, retireProviderTurn, markCancelledProviderHandshake,
    clearCancelledProviderHandshake, pendingCancelledProviderHandshakes,
    runningTurnEngines: () => runningTurnEngines, DirectTurnSetupCancelled,
  },
  admission: {
    providerFleet: () => providerFleet, providerInstancesChanging: () => providerInstancesChanging,
    providerTransitionForTurn, turnInstance, boxLifecycleBusyBots: () => boxLifecycleBusyBots,
    roomTurnApprovalMode, MAX_COMMS_DEPTH,
  },
  handoffs: { roomHandoffs: () => roomHandoffs, roomHandoffProblem },
  rooms: { groupQueues, groupSpeakers: () => groupSpeakers, groupIsWorking, roomSetupPending, resolveReplyTarget },
  operations: {
    beginGroupTurnOperation, finishGroupTurnOperation, finishGroupGoalRun, updateGroupGoalRunProgress,
    waitForGroupMemberBot, waitForChatRoomMember, groupProviderHandshakeStarted, groupProviderHandshakeSettled,
    hasUnboundDiscardedGroupGoalTurn,
  },
  goalFold: {
    groupGoalCoordinatorTurns, addGroupGoalCoordinatorTurn, removeGroupGoalCoordinatorTurn,
    GROUP_GOAL_COORDINATOR_GUARD_MS, GROUP_GOAL_WAIT_MAX_MS: () => GROUP_GOAL_WAIT_MAX_MS,
    GROUP_GOAL_MAX_WAIT_EXHAUSTIONS: () => GROUP_GOAL_MAX_WAIT_EXHAUSTIONS,
  },
  cleanup: {
    releaseTurnResources, releaseLocalVmThread, startScreenPoller, retryDelegationsWaitingOn,
    drains: { drainQueuedSends, drainConnectorResumes, drainSecretResumes, drainTeamSetupResumes },
  },
  localVm: {
    localVmLeaseFor, localVmIdleFor, localVmThreadTargets: () => localVmThreadTargets,
    localVmActiveThreads: () => localVmActiveThreads, localVmLifecycleBusy: () => localVmLifecycleBusy,
    localVmOwnerBusy: () => localVmOwnerBusy, localVmImageBusy: () => localVmImageBusy,
    localVmModeChangeBusy: () => localVmModeChangeBusy, readyLocalVmForTurn,
    localVmTargetForBot,
  },
  computers: {
    bindTurnComputer, attachTeamBox, controlIntegration, browserIntegration, phoneIntegration,
    connectedAppsIntegration, agentsIntegration, inheritedTeamComputer, teamComputerPrompt,
  },
  prompts: { availableSkills, generateThreadTitle },
  queue: { followupsReady: () => followupsReady },
});

const roomHandoffs: RoomHandoffs = new RoomHandoffs(join(DATA_DIR, "room-handoffs.json"), roomHandoffHandlers({
  store,
  threadBusy,
  botAtThreadCapacity,
  maxCommsDepth: MAX_COMMS_DEPTH,
  groupQueues,
  roomHandoffProblem,
  coordinationSystemInstructions,
  coordinationTurnText,
  fullAccessForSource,
  groupIsWorking,
  publicGroupState,
  wireBot,
  broadcast: () => broadcast,
  roomHandoffs: () => roomHandoffs,
  drainQueuedSends,
  markTaskContextExternallyUpdated,
  markInternalTurn,
  isUnattended,
  markUnattended,
  startTurn: (botId, text, opts) => startTurn(botId, text, opts),
  beginGroupTurnOperation,
  finishGroupTurnOperation,
  waitForChatRoomMember,
  runGroupMemberTurn,
  groupProviderHandshakeStarted,
  groupProviderHandshakeSettled,
  interruptDirectThread,
}), Date.now, roomHandoffLimits(cfg));
setActiveCoordinationForThread(threadId => roomHandoffs.activeDirect(threadId));
function publicGroupState(group: GroupRecord): WireGroup {
  return { ...group, working: groupIsWorking(group) || [...roomHandoffs.nodes.values()].some(n => n.groupId === group.id && !["completed", "failed", "cancelled"].includes(n.status)) };
}

const groupWithThread = (group: GroupRecord) => ({
  ...publicGroupState(group),
  messages: store.messagesFor(group.threadId),
  activeLeafId: store.activeLeaf(group.threadId),
  ...(group.dm ? {} : { tasks: store.groupTasks(group.id) }),
});

// The store tells us what it wrote; this is the ONE place that turns those
// into SSE frames. No mutation path can persist without emitting — the
// property holds by construction, not by every call site remembering to
// broadcast. Bot frames are the slim wire shape (no transcript); the few
// endpoints whose callers need the transcript (task create/switch, imports)
// still send their richer payload on top.
store.onChange((change) => {
  switch (change.type) {
    case "sections":
      broadcast({ kind: "sections", sections: store.sections });
      break;
    case "message":
      broadcast({ kind: "message", threadId: change.threadId, message: change.message });
      break;
    case "message.patch":
      broadcast({ kind: "message.patch", threadId: change.threadId, message: change.message });
      break;
    case "thread":
      broadcast({ kind: "thread", threadId: change.threadId, activeLeafId: change.activeLeafId });
      break;
    case "thread.deleted":
      routines?.forgetRoutineRequestReceiptsForThread(change.threadId);
      // A deleted destination must not strand an approval in an internal
      // task. Keep each run's snapshot and expose its execution as fallback.
      for (const run of routines?.listRuns() ?? []) {
        if (run.resultsThreadId === change.threadId || run.sourceThreadId === change.threadId) {
          routineWiring.syncRoutineRunToSource(run);
        }
      }
      broadcast({ kind: "bot.queued", queues: publicBotQueuedMessages() });
      break;
    case "bot": {
      const bot = store.bot(change.botId);
      if (bot) broadcast({ kind: "bot", bot: wireBot(bot) });
      break;
    }
    case "bot.deleted":
      broadcast({ kind: "bot.deleted", botId: change.botId });
      break;
    case "group": {
      const group = store.group(change.groupId);
      if (group) broadcast({ kind: "group", group: publicGroupState(group) });
      break;
    }
    case "group.deleted":
      broadcast({ kind: "group.deleted", groupId: change.groupId });
      break;
  }
});

// ── message pages ──────────────────────────────────────────────────────
// GET /api/bots hands back every bot with its entire transcript, which is
// the right answer over loopback and the wrong one over a phone network:
// a long-running bot's thread is megabytes, and a turn-end desktop capture
// is a base64 PNG sitting inline in it.
//
// `?messages=n` opts into a slim shape — the last n messages, with screen
// captures reduced to a flag and fetched one at a time from the image
// endpoint. Omitting the parameter returns exactly what it always did.
const MESSAGE_PAGE_MAX = 200;
const DEFAULT_PAGE = 50;

/** undefined = absent, null = present but unusable (the caller answers 400). */
function pageSize(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 0) return null;
  return Math.min(size, MESSAGE_PAGE_MAX);
}

/** A screen message without its pixels. The client fetches those from
 * `/api/threads/:threadId/messages/:id/image` when it actually shows one. */
function slimMessage(message: Message): Message | Record<string, unknown> {
  if (message.kind !== "screen" || !message.png) return message;
  const { png: _png, mime: _mime, ...rest } = message;
  return { ...rest, hasImage: true };
}

/** `limit === undefined` is the original, unpaginated shape. A bounded,
 * cursor-less request (the common case: startup hydrate, a fresh
 * scrollback view) goes through messagesTail(), which can read just the
 * newest rows from SQLite instead of hydrating the whole transcript first.
 * Paging further back with `before` still needs the full, cached array to
 * seek to an arbitrary point in history. */
function messagePage(threadId: string, limit: number | undefined, before?: string | null) {
  if (limit === undefined) {
    return { messages: store.messagesFor(threadId), activeLeafId: store.activeLeaf(threadId) };
  }
  if (!before) {
    const tail = store.messagesTail(threadId, limit);
    return { messages: tail.messages.map(slimMessage), hasMore: tail.hasMore, activeLeafId: tail.activeLeafId };
  }
  const all = store.messagesFor(threadId);
  const end = all.findIndex((msg) => msg.id === before);
  const stop = end === -1 ? all.length : end;
  const start = Math.max(0, stop - limit);
  return {
    messages: all.slice(start, stop).map(slimMessage),
    hasMore: start > 0,
    activeLeafId: store.activeLeaf(threadId),
  };
}

/** A bounded page centred on a known message, used when a search result is
 * opened on a client that only hydrated the newest part of the transcript. */
function messageWindow(threadId: string, messageId: string, limit: number) {
  const all = store.messagesFor(threadId);
  const index = all.findIndex((message) => message.id === messageId);
  if (index < 0) return null;
  const before = Math.floor((limit - 1) / 2);
  const start = Math.max(0, Math.min(index - before, all.length - limit));
  const stop = Math.min(all.length, start + limit);
  return { messages: all.slice(start, stop).map(slimMessage), hasMore: start > 0 };
}

// ── SSE fan-out to clients ─────────────────────────────────────────────
// The fan-out machinery — client set, replay buffer, heartbeat, cursor
// math, and the /api/events endpoint — lives in ./routes/events.ts. index
// keeps the wiring to its own singletons, registered in the same order the
// inline code registered it.
const eventsRoutes = createEventsRoutes({
  closeForOwner: (sessionId) => browserLive.closeForOwner(sessionId),
  revalidateEmailSessions: () => sessions.revalidateEmailSessions(),
  isLive: (sessionId) => sessions.isLive(sessionId),
  configForAccess: (status, admin) => configForAccess(status as ReturnType<typeof configStatus>, admin),
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
    routines: () => routines,
    localVmThreadTargets: () => localVmThreadTargets,
    handoffs: () => handoffs,
    runningTurnEngines: () => runningTurnEngines,
    pendingDelegationWakes: () => pendingDelegationWakes,
    commsBus: () => commsBus,
    screenPollers: () => screenPollers,
    SCREEN_SETTLE_TIMEOUT_MS: () => SCREEN_SETTLE_TIMEOUT_MS,
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

function drainThreadDelegations(threadId: string): void {
  const routineRunId = activeRoutineRunForThread(threadId)?.id;
  drainDelegations(commsBus, approvalBus, threadId, runDelegatedTurn,
    (receipt) => wakeUndispatchedDelegation(receipt, routineRunId));
}

// Queued handoffs expire DELEGATION_TTL_MS after they were queued. A drain
// expires what it touches; this sweep covers a handoff nothing drains — a
// target that never settles while its source sits idle — and wakes each
// delegator the same way a drain-time failure does.
const DELEGATION_SWEEP_MS = 60 * 60 * 1000;
function expireDelegationsNow(): void {
  expireStaleDelegations(commsBus, Date.now(), (receipt) =>
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
  if (!followupsReady) return;
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


/** A short title for a fresh thread, from the provider's cheap one-shot
 * (generateText — Haiku on Claude, the chat completion endpoint's text
 * path on OpenAI-compatible engines). Null whenever that call cannot run,
 * runs long, or answers with something that is not a plain short title;
 * the caller keeps the snippet it already applied. */
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
});

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

  const routineRun = routines?.activeBotRunForBot(bot.id);
  if (routineRun) {
    if (routineRun.threadId) revokeInternalCapabilitiesForThread(routineRun.threadId);
    cancelDirectTurnDispatch(bot.id, routineRun.threadId);
    await routines!.cancelRun(routineRun.id);
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
    reportIncident,
    handoffs,
  },
  state: { groupSpeakers, delegationWatch, pendingDelegationWakes, publicBot, startTurn },
});
const commsBus: CommsBus = routineWiring.commsBus;
routines = routineWiring.routines;
// The scheduler receipt and room transcript live in separate durable stores.
// If the process exited between those two writes, prefer the correlated
// RoutineRun's terminal truth; an uncorrelated manual goal is simply failed
// because no in-memory orchestrator can survive a restart.
const recoveredRoutineGoalRuns = new Map(
  routines.listRuns().filter((run) => run.target === "room-goal").map((run) => [run.id, run]),
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
calendarCalls = new CalendarCallManager({
  botExists: (botId) => Boolean(store.bot(botId)),
  onDue: deliverCalendarCall,
});
const recoveryOwners = routines.routineRequestReceiptOwners();
if (recoveryOwners.length > 0) {
  // A normal launch has no crash-gap receipts, so it must not eagerly load
  // every historical transcript. Inspect only the distinct threads named by
  // a surviving receipt; reconciliation then removes any whose card vanished.
  const recoveryThreads = [...new Set(recoveryOwners.map((owner) => owner.threadId))];
  routines.reconcileRoutineRequestReceipts(
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
      reason: `The Box-hosted agent needs a working Box API key. For the bot’s existing model and configured computer, including a self-hosted VPS, set run_on="maus" instead. Do not request a Box key unless the user actually wants the Box-hosted agent.`,
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
  routines,
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
async function deleteBotWithLifecycle(botId: string, revalidate: () => void = () => {}, setupRequest?: TeamSetupRequest) {
  const deletionResponse = (status: number, body: { error?: string; ok?: boolean }) => ({ status, body });
      revalidate();
      const bot = store.bot(botId);
      if (!bot) return deletionResponse( 404, { error: "no such bot" });
      if (computerProviderConfigTransitions.size > 0) {
        return deletionResponse( 409, { error: "computer provider settings are being updated — wait before deleting this bot" });
      }
      if (localVmModeChangeBusy) {
        return deletionResponse(409, { error: "Local VM settings are being updated — wait before deleting this bot" });
      }
      if (boxLifecycleBusyBots.has(bot.id)) {
        return deletionResponse( 409, { error: "wait for this bot's cloud computer action to finish before deleting the bot" });
      }
      const activeRoutine = routines!.activeRunForBot(bot.id);
      if (activeRoutine) {
        return deletionResponse( 409, {
          error: "stop this bot's active routine before deleting the bot",
        });
      }
      const activeGroup = activeGroupTurnForBot(bot.id);
      if (activeGroup) {
        return deletionResponse( 409, {
          error: `stop this bot's work in channel ${activeGroup.group.name} before deleting the bot`,
        });
      }
      // A direct turn that has already claimed the bot can provision a Box in
      // its background setup. Do not let deletion race that work while a Box
      // account is configured; the person can stop the turn and retry.
      if ((box.boxConfigured(cfg) || vpsSshAlias(cfg)) && (bot.busy || hasDirectDispatch(bot.id))) {
        return deletionResponse( 409, { error: "stop this bot's work before checking and deleting its cloud computer" });
      }
      const botBoxRecovery = boxCreateRecoverySnapshot().filter((entry) => entry.botId === bot.id);
      const botBoxDeletions = boxDeletionSnapshot().filter((entry) => entry.ownerBotId === bot.id);
      if (botBoxRecovery.some((entry) => !entry.resolved)) {
        return deletionResponse( 409, {
          error: "finish reconciling this bot's pending cloud computer creation before deleting it — check ascii.dev, then retry Box setup",
        });
      }
      // Bot deletion awaits VM/browser/provider cleanup. Claim the bot and
      // every channel it belongs to before that first await so a phone save
      // cannot begin halfway through teardown (or vice versa). The computer
      // lifecycle claim is synchronous too, so either both claims are held or
      // neither survives this request.
      const releaseComputerLifecycle = claimBotComputerLifecycle(bot.id);
      const releasePhoneSecretMutation = claimPhoneSecretBotDeletion(bot.id);
      if (!releasePhoneSecretMutation) {
        releaseComputerLifecycle();
        return deletionResponse( 409, { error: "this bot or one of its channels is securely saving a credential" });
      }
      let claimedLocalVmTarget: LocalVmTarget | null = null;
      try {
        let localVmCleanup: { target: LocalVmTarget; removeContainer: boolean } | null = null;
        if (localVmMode(cfg) === "per-bot") {
          const target = perBotLocalVmTarget(bot.id);
          if (localVmActiveThreads.has(target.key) || localVmLifecycleBusy.has(target.key)) {
            return deletionResponse( 409, { error: "stop this bot's Local VM turn or setup action before deleting the bot" });
          }
          if (localVmLeaseFor(target).current(localVmOwnerBusy)) {
            return deletionResponse(409, { error: "stop this bot's Local VM turn before deleting the bot" });
          }
          // Hold the target from preflight through deletion. A simultaneous
          // mode change or lifecycle route must not recreate the container
          // after we checked it and before its bot owner disappears.
          localVmLifecycleBusy.add(target.key);
          claimedLocalVmTarget = target;
          const vm = await containerComputerStatus(undefined, undefined, target);
          if (!vm.daemonUp && existsSync(target.workspaceDir)) {
            return deletionResponse( 409, {
              error: "start the container runtime so OpenMausBot can remove this bot's Local VM while deleting it",
            });
          }
          if (vm.container !== "missing" && !vm.managed) {
            return deletionResponse(409, {
              error: `The container named ${vm.container_name} was not created by OpenMausBot. Remove it manually before deleting this bot`,
            });
          }
          localVmCleanup = {
            target,
            removeContainer: vm.container !== "missing",
          };
        }

        // Preflight every provider before deleting any resource. Cleanup can
        // still fail mid-flight across independent providers, but a missing
        // credential or offline daemon should not cause avoidable partial work.
        const vpsInventory = await vps.listManagedVpsComputers(cfg, managedBoxOwners());
        if (vpsInventory.configured && !vpsInventory.available) {
          return deletionResponse( 503, {
            error: `${vpsInventory.problem ?? "VPS computer inventory is unavailable"}. The bot was kept so its computer can be retried safely`,
          });
        }
        const ownedVpsComputers = vpsInventory.instances.filter((instance) => instance.ownerBotId === bot.id);

        if ((botBoxRecovery.length > 0 || botBoxDeletions.length > 0) && !box.boxConfigured(cfg)) {
          return deletionResponse(409, {
            error: "Reconnect the Box account that owns this bot's remembered cloud computer, then retry deletion",
          });
        }
        const cloudInventory = await box.listManagedBoxes(cfg, managedBoxOwners());
        if (cloudInventory.configured && !cloudInventory.available) {
          return deletionResponse( 503, {
            error: `${cloudInventory.problem ?? "cloud computer inventory is unavailable"}. The bot was kept so its computer can be retried safely`,
          });
        }
        const ownedBoxComputers = cloudInventory.instances.filter((instance) => instance.ownerBotId === bot.id);

        // Revalidate a reviewed Chief-of-Staff request and establish the
        // browser cleanup intent before the first irreversible provider
        // mutation. A stale review or damaged journal therefore leaves every
        // computer intact. Cross-provider rollback is impossible, so every
        // subsequent operation is exact and retry-safe.
        revalidate();
        const browserCleanupRequest = browserCleanup.prepare("bot", bot.id);
        try {
          // Provider-owned computers are durable, billable resources. Remove
          // each exact, freshly revalidated identity before making its bot
          // owner disappear. Shared team computers use a different owner id
          // and are intentionally absent from these lists.
          for (const instance of ownedBoxComputers) {
            const removed = await box.deleteManagedBox(cfg, managedBoxOwners(), instance.boxId, instance.name);
            if (removed.pending) {
              throw Object.assign(
                new Error("The cloud computer deletion has started but is still finishing. The bot was kept; retry in a moment"),
                { status: 409 },
              );
            }
          }
          for (const instance of ownedVpsComputers) {
            await vps.removeManagedVpsComputer(cfg, managedBoxOwners(), instance.name, instance.name);
          }
          if (localVmCleanup) {
            if (localVmCleanup.removeContainer) {
              await containerComputerAction("remove", undefined, undefined, localVmCleanup.target);
            }
            // Unlike the standalone "Delete VM" action, deleting the bot is
            // a complete erasure: its now-ownerless desktop files and browser
            // session must not remain hidden on disk or block the event loop.
            await removeDirectory(localVmCleanup.target.workspaceDir, { recursive: true, force: true });
            localVmSeen.delete(localVmCleanup.target.key);
            localVmIdles.get(localVmCleanup.target.key)?.cancel();
            localVmIdles.delete(localVmCleanup.target.key);
            localVmLeases.forget(localVmCleanup.target.key);
          }
          // a running turn dies with its bot
          // Invalidate every bot-callable bearer before the first asynchronous
          // teardown step. A request that already passed its initial header
          // check is revalidated after its body arrives and must fail closed.
          for (const entry of pendingTeamSetupResumes.values()) {
            if (entry.request.botId === bot.id) cancelTeamSetupResumesForThread(entry.request.threadId);
          }
          for (const task of store.tasks(bot.id)) {
            cancelTeamSetupResumesForThread(task.threadId);
            revokeInternalCapabilitiesForThread(task.threadId);
          }
          await interruptAllDirectThreads(bot.id);
          // Deletion removes the thread before a late turn.completed can fold
          // staged provider images into a message, so dispose them here.
          for (const task of store.tasks(bot.id)) {
            purgeGeneratedImagesForThread(task.threadId);
            settleDirectFollowup(directTurnGenerationByThread.get(task.threadId));
            directTurnGenerationByThread.delete(task.threadId);
            directTurnBots.delete(task.threadId);
          }
          stopScreenPoller(bot.id);
          activeVpsThreads.delete(bot.id);
          lastReply.delete(bot.threadId);
          // a peer approval naming this bot can never be meaningfully answered
          // now, and its caller would otherwise wait out the 15-minute timeout
          cancelPeerApprovalsFor(bot.id);
          discardDelegations(commsBus, bot.threadId);
          computerControl.forget(bot.id);
          computerControlRevision.delete(bot.id);
          const target = perBotLocalVmTarget(bot.id);
          localVmIdles.get(target.key)?.cancel();
          localVmIdles.delete(target.key);
          // Provider and local-computer teardown above can await for an
          // arbitrary amount of time. A reviewed Chief deletion is bound to
          // the exact target profile it presented; re-check that receipt at
          // the final durable mutation boundary so a concurrent profile edit
          // cannot be erased under a stale approval.
          revalidate();
          store.deleteBot(bot.id, setupRequest);
          // Removing schedules is not a security revocation. Keep them intact
          // if the bot/receipt write fails, so a failed deletion is retryable.
          routines!.disableForBot(bot.id);
          webhooks.disableForBot(bot.id);
          calendarCalls!.removeBot(bot.id);
          browserLive.closeForBot(bot.id);
          await forgetTemporaryBrowser(bot.id);
        } catch (error) {
          if (browserCleanupRequest) {
            // Store removal is already durable once the in-memory owner is
            // gone. A later cleanup error must retain its browser erasure
            // intent for retry instead of aborting a completed deletion.
            if (store.bot(bot.id)) browserCleanup.abort(browserCleanupRequest);
            else browserCleanup.commit(browserCleanupRequest);
          }
          throw error;
        }
        if (browserCleanupRequest) {
          const committedCleanup = browserCleanup.commit(browserCleanupRequest);
          const acknowledged = await browserCleanup.ensure(committedCleanup);
          requireBrowserCleanupAcknowledged(acknowledged, `Browser data for ${bot.name}`);
        }
        return deletionResponse( 200, { ok: true });
      } finally {
        if (claimedLocalVmTarget) localVmLifecycleBusy.delete(claimedLocalVmTarget.key);
        releaseComputerLifecycle();
        releasePhoneSecretMutation();
      }
}

const profileRequests = new ProfileRequestService({
  store,
  autoApply: fullAccessForSource,
  canPersist: proposalPersistence,
  // A Chief may change a section peer; anyone else only itself. Re-checked at confirm.
  validateTarget: (proposerBotId, targetBotId) => {
    const proposer = store.bot(proposerBotId);
    const target = store.bot(targetBotId);
    if (!target) return "that bot no longer exists";
    if (!proposer?.chiefOfStaff) return "only a section's Chief of Staff can change another bot's profile";
    if (!canReachPeer(proposer, target)) return "that bot is not in a team this Chief is allowed to manage";
    return null;
  },
});
const teamSetupTeams = () => [...new Set(["", ...readSections(), ...store.bots.map((bot) => sectionKey(bot.section)), ...store.groups.map((group) => sectionKey(group.section))])];
const teamSetupRequests = new TeamSetupRequestService({
  store, teams: teamSetupTeams, canAccessTeam, canPersist: proposalPersistence, maxBots: MAX_WORKSPACE_BOTS,
  autoApply: fullAccessForSource,
  validateChange: (before, fields) => assertTeamComputerChangeIdle(before, { ...before, ...fields }),
  ownsThread: (botId, threadId) => Boolean(connectorThread(botId, threadId)),
  targetBusy: (botId, sourceThreadId) => {
    if (!sourceThreadId) return Boolean(store.bot(botId)?.busy || hasDirectDispatch(botId) || activeGroupTurnForBot(botId) || routines?.activeRunForBot(botId));
    const group = activeGroupTurnForBot(botId);
    const run = routines?.activeRunForBot(botId);
    return store.tasks(botId).some(task => task.threadId !== sourceThreadId && threadBusy(botId, task.threadId)) ||
      [...directTurnDispatchClaims].some(([threadId, claim]) => threadId !== sourceThreadId && claim.botId === botId) ||
      Boolean(group && group.threadId !== sourceThreadId) || Boolean(run && run.threadId !== sourceThreadId);
  },
  validateModel: (selection, current) => {
    const checked = checkedModelSelection(selection, undefined, true);
    if (!checked.ok) return checked.error;
    if (current?.approvalGrant) return "Wait for the approval-level confirmation before changing this bot's model";
    if (current) {
      const mode = approvalModeFor(current);
      const driver = registry.cliTarget(selection.instanceId)?.driverKind;
      if (!supportsApprovalMode(driver, mode) || ((mode === "full" || mode === "custom") && driver !== registry.cliTarget(current.modelSelection.instanceId)?.driverKind)) {
        return `@${current.name}'s existing permissions are incompatible with that provider. Change its permissions in bot settings, then propose the model change again.`;
      }
    }
    return null;
  },
  deleteBot: async (botId, revalidate, request) => {
    const result = await deleteBotWithLifecycle(botId, revalidate, request);
    if (result.status >= 400) throw new TeamSetupError(result.body.error ?? "The bot could not be deleted", result.status);
  },
});

async function resolveAndSendTeamSetup(res: ServerResponse, args: { botId: string; threadId: string; requestId: string; behavior: string }, ownerReview: boolean): Promise<boolean> {
  const card = store.messagesFor(args.threadId).find((item) => item.card?.requestId === args.requestId && item.card.teamSetupRequest)?.card;
  if (!card) return false;
  if (args.behavior === "allow" && !ownerReview) { json(res, 403, { error: "Approve team setup or deletion from the desktop app or a paired owner device. In a local browser, wait until every bot is idle." }); return true; }
  if (args.behavior === "allow" && !card.answered && !card.dismissed) {
    // Confirmed Chief setup can move bots without the ordinary PATCH route.
    // Keep that atomic Store operation behind the same shared-machine fence.
    for (const operation of card.teamSetupRequest!.operations) {
      const before = store.bot(operation.botId);
      if (before && operation.action === "update") assertTeamComputerChangeIdle(before, { ...before, ...operation.fields });
    }
  }
  const resumeGeneration = teamSetupResumeGenerations.get(args.threadId) ?? 0;
  const resolved = await teamSetupRequests.resolve(args);
  if (!resolved) return false;
  if (!resolved.duplicate) {
    appendDecision(DATA_DIR, { threadId: args.threadId, requestId: args.requestId, botId: args.botId, tool: card.tool,
      summary: card.subtitle, decision: resolved.result.state === "applied" ? "user-approved" : "user-denied", source: "user" });
  }
  const current = store.messagesFor(args.threadId).find((item) => item.id === resolved.messageId);
  if (current?.card?.teamSetupRequest?.result && !current.card.teamSetupRequest.resumed) {
    store.patchMessage(args.threadId, current.id, { card: { ...current.card, teamSetupRequest: { ...current.card.teamSetupRequest, resumed: true } } });
    dispatchTeamSetupResume({ request: resolved.request, messageId: resolved.messageId, generation: resumeGeneration });
  }
  json(res, 200, { ok: true, outcome: resolved.result.state === "applied" ? "allowed-once" : "rejected", result: resolved.result, alreadySettled: resolved.duplicate });
  return true;
}
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
function resolveAndSendProfile(
  res: ServerResponse,
  args: { botId: string; botName?: string; threadId: string; requestId: string; behavior: string },
): boolean {
  const card = store.messagesFor(args.threadId).find(
    (message) => message.card?.requestId === args.requestId && message.card.profileRequest,
  )?.card;
  if (!card) return false;
  const result = profileRequests.resolve(args);
  if (!result.claimed) return false;
  if (result.state === "applied" || result.state === "denied") {
    appendDecision(DATA_DIR, {
      threadId: args.threadId, requestId: args.requestId, botId: args.botId, botName: args.botName,
      tool: "update_profile", summary: card.subtitle,
      decision: result.state === "applied" ? "user-approved" : "user-denied", source: "user",
    });
  }
  if (result.state === "applied") {
    const target = store.bot(result.targetBotId);
    if (target) broadcast({ kind: "bot", bot: wireBot(target) });
    json(res, 200, {
      ok: true, outcome: "allowed-once", profileFields: result.fields,
      ...(result.settlementPending ? { settlementPending: true, message: result.message } : {}),
    });
    return true;
  }
  if (result.state === "invalid") { json(res, result.status, { error: result.error }); return true; }
  if (result.state === "already_settled") {
    json(res, 200, { ok: true, outcome: result.behavior === "allow" ? "allowed-once" : "rejected", alreadySettled: true });
    return true;
  }
  json(res, 200, { ok: true, outcome: "rejected" });
  return true;
}

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
const roomHandoffTimer = setInterval(() => {
  try { roomHandoffs.tick(); } catch (error) { console.error("room handoffs:", error); }
}, 250);
roomHandoffTimer.unref();
/** Long enough for a real update, short enough that a room stays readable. */
const ROOM_POST_MAX_CHARS = 4_000;

// approval bus: peer-approval.ts only needs to push cards and broadcast
// them — its pending map lives in the module so the two respond endpoints
// can call resolvePeerComms without holding a reference back to here.
const approvalBus: ApprovalBus = { store, broadcast, notify, autoApply: fullAccessForSource };

// Approvals live only in memory, so any peer card still open on disk is one
// whose resolver died with the previous process. Left alone it can never be
// answered, and the composer stays disabled behind it — settle them at boot.
{
  const stale = dismissStalePeerCards(approvalBus);
  if (stale) console.log(`peer approvals: dismissed ${stale} card(s) left by a previous run`);
}

function sameCalendarRoster(group: GroupRecord, botIds: readonly string[]): boolean {
  if (group.dm || group.memberIds.length !== botIds.length) return false;
  const wanted = new Set(botIds);
  return group.memberIds.every((id) => wanted.has(id));
}

function ensureCalendarCallRoom(call: CalendarCall): GroupRecord {
  const linked = call.roomId ? store.group(call.roomId) : undefined;
  let group = linked && sameCalendarRoster(linked, call.botIds) && !roomSetupPending(linked)
    ? linked
    : undefined;
  group ??= store.createGroup(call.name, call.botIds, false, undefined, {
    bulletin: "",
    defaultResponder: { kind: "everyone" },
    completed: true,
  });
  if (call.roomId !== group.id) calendarCalls!.linkRoom(call.id, group.id);
  return group;
}

function deliverCalendarCall(call: CalendarCall, scheduledFor: number): void {
  // A one-bot calendar entry remains a reminder that opens that bot's chat.
  // Multi-bot entries are rooms and begin with the shared event prompt.
  if (call.botIds.length < 2) return;
  const group = ensureCalendarCallRoom(call);
  const text = [
    `@everyone ${call.description.trim() || call.name}`,
    ...call.attachments.map((attachment) =>
      `<${attachment.kind === "image" ? "attached-image" : "attached-file"} path="${escapeAttribute(attachment.path)}" name="${escapeAttribute(attachment.name)}" />`
    ),
  ].join("\n\n");
  const sendId = `calendar_${call.id}_${scheduledFor}`;
  const threadIds = new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]);
  const messages = [...threadIds].flatMap((threadId) => store.messagesFor(threadId));
  if (messages.some((message) => message.sendId === sendId)) return;
  startGroupTurn(group.id, text, undefined, sendId);
}

function roomSetupPending(group: GroupRecord): boolean {
  const hasMarker =
    Object.prototype.hasOwnProperty.call(group, "setupCompletedAt") ||
    Object.prototype.hasOwnProperty.call(group, "setupSkippedAt");
  return (
    !group.dm &&
    hasMarker &&
    group.setupCompletedAt == null &&
    group.setupSkippedAt == null &&
    store.messagesFor(group.threadId).length === 0
  );
}

function resolveReplyTarget(threadId: string, value: unknown): Message | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw Object.assign(new Error("replyToId must be a message id"), { status: 400 });
  const target = store.messagesFor(threadId).find((message) => message.id === value);
  if (!target || target.kind !== "text" || !target.text?.trim()) {
    throw Object.assign(new Error("the message being replied to is no longer available"), { status: 404 });
  }
  return target;
}

/** When a person last wrote into the room's current conversation, if one
 * ever has. The posting budget's ceiling counts only the bot posts nobody
 * has answered since, so this is read fresh on every attempt rather than
 * remembered — the room's transcript is already the record of who spoke
 * last, and a second copy of it could only ever disagree.
 *
 * Only a person puts a user-role message in a room: the composer, or a
 * calendar call they scheduled. No bot tool has that ingress — post_to_room
 * appends role "bot", which is the rule this whole surface turns on. The
 * one door a bot's shell could reach on a headless server, the HTTP API
 * with no session behind it, stamps what it lets in (Message.via), and a
 * line so stamped does not count here — so a bot cannot re-arm the ceiling
 * it just spent. */
function lastHumanRoomMessageAt(group: GroupRecord): number | undefined {
  const messages = store.messagesFor(group.threadId);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user" && message.kind === "text" && !message.via) return message.at;
  }
  return undefined;
}

/** Whether `bot` may write into `group` from outside a turn there, and the
 * exact refusal when it may not.
 *
 * Room membership is the one place the app's section boundary does not
 * reach: list_bots, ask_bot, delegate_bot and create_bot are all scoped to
 * the sender's section, but a person is free to put bots from two sections
 * in one room. A tool that pushed text into such a room would therefore be
 * the first way one section speaks to another with nobody in the loop, so
 * this refuses it outright rather than trying to judge when that is
 * harmless. The cost is real — a genuinely cross-section room cannot be
 * posted into from outside — and it is the cheaper mistake: the person can
 * still relay, and the boundary keeps meaning exactly one thing.
 *
 * Membership is read from the record here and never from a tool argument;
 * the argument only names which room to look up. */
function roomPostEligibility(
  bot: BotRecord,
  group: GroupRecord,
): { ok: true } | { ok: false; status: number; error: string } {
  if (group.dm) {
    return {
      ok: false,
      status: 400,
      error: "that is a one-to-one bot channel, not a room — use ask_bot or delegate_bot to reach a single bot",
    };
  }
  if (!group.memberIds.includes(bot.id)) {
    return { ok: false, status: 403, error: "you are not a member of that room" };
  }
  const outsider = group.memberIds
    .map((id) => store.bot(id))
    .find((member) => member && !canAccessTeam(bot, member.section));
  if (outsider) {
    return {
      ok: false,
      status: 403,
      error: `that room includes @${outsider.name}, who is outside your section — tell the user what you wanted to post there instead`,
    };
  }
  // A room whose setup the person has not finished has never been opened
  // for business, and its first message decides whether setup still counts
  // as pending. A bot must not be the one to settle that.
  if (roomSetupPending(group)) {
    return { ok: false, status: 409, error: "that room is still being set up — it cannot receive messages yet" };
  }
  return { ok: true };
}

function proposalPersistence(botId: string, threadId: string) {
  if (!store.bot(botId)) {
    return { ok: false as const, status: 403, error: "unknown sender" };
  }
  if (!connectorThread(botId, threadId)) {
    return { ok: false as const, status: 403, error: "source conversation does not belong to sender" };
  }
  if (fullAccessForSource(botId, threadId)) return { ok: true as const };
  // Only cards on the visible branch can be acted on from the composer.
  // Abandoned branches must not permanently consume the proposal quota.
  // Routine and profile proposals share one budget per bot per thread, so
  // one thread cannot pile up 8 of each.
  const openRequests = store.activePath(threadId).filter(
    (message) =>
      (message.card?.routineRequest?.botId === botId || message.card?.profileRequest?.botId === botId || message.card?.teamSetupRequest?.botId === botId) &&
      !message.card.answered &&
      !message.card.dismissed,
  ).length;
  return openRequests >= 8
    ? { ok: false as const, status: 429, error: "confirm or cancel an existing proposal first" }
    : { ok: true as const };
}

function skillProposalPersistence(botId: string, threadId: string) {
  if (!store.bot(botId)) {
    return { ok: false as const, status: 403, error: "unknown sender" };
  }
  if (!connectorThread(botId, threadId)) {
    return { ok: false as const, status: 403, error: "source conversation does not belong to sender" };
  }
  if (fullAccessForSource(botId, threadId)) return { ok: true as const };
  const openRequests = store.activePath(threadId).filter(
    (message) =>
      message.card?.skillRequest?.botId === botId &&
      !message.card.answered &&
      !message.card.dismissed,
  ).length;
  return openRequests >= 8
    ? { ok: false as const, status: 429, error: "confirm or cancel an existing learned-skill card first" }
    : { ok: true as const };
}

/** Listing endpoints expose lifecycle metadata, never the staged instructions
 * themselves. The exact review copy lives only on the durable approval card. */
function stagedSkillListing(staged: ReturnType<typeof listStagedSkillWrites>[number]) {
  const { files: _files, baseSha256: _baseSha256, baseAppliedStageId: _baseAppliedStageId, ...listing } = staged;
  return listing;
}

/** Capture proposal cleanup before a transcript is deleted. Staged writes
 * are bot-scoped and live outside the thread, so deleting the only card
 * without this would reserve its name for up to 30 days with no decision UI.
 * Ownership comes from the server-authored sender, never the card payload. */
function stagedSkillCleanupsForThread(threadId: string): Array<{ botId: string; stagedId: string }> {
  const directOwner = store.botByThread(threadId)?.id;
  const seen = new Set<string>();
  const cleanups: Array<{ botId: string; stagedId: string }> = [];
  for (const message of store.messagesFor(threadId)) {
    const request = message.card?.skillRequest;
    const botId = message.from?.botId ?? directOwner;
    if (!request || !botId) continue;
    const key = `${botId}:${request.stagedId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleanups.push({ botId, stagedId: request.stagedId });
  }
  return cleanups;
}

function rejectDeletedThreadSkillStages(cleanups: Array<{ botId: string; stagedId: string }>): void {
  for (const cleanup of cleanups) rejectStagedSkillWrite(cleanup.botId, cleanup.stagedId);
}

function skillCardCopy(staged: { action: "create" | "update"; name: string; gist: string; warnings: string[] }): {
  title: string;
  subtitle: string;
  tool: string;
} {
  const warnings = staged.warnings.length ? `\n\nWarnings:\n- ${staged.warnings.join("\n- ")}` : "";
  return {
    title: staged.action === "create"
      ? `Enable skill "${staged.name}"?`
      : `Update skill "${staged.name}"?`,
    subtitle: `${staged.gist || staged.name}\n\nAdds one line to the prompt index; the body is read only when used.${warnings}`,
    tool: "stage_skill",
  };
}

function appendSkillRequestCard(args: {
  botId: string;
  threadId: string;
  applied?: boolean;
  staged: {
    id: string;
    action: "create" | "update";
    name: string;
    gist: string;
    source: string;
    files: Array<{ path: string; content: string }>;
    sha256: string;
    warnings: string[];
  };
}): { requestId: string; summary: string } {
  const requestId = randomUUID();
  const copy = skillCardCopy(args.staged);
  const payload: SkillRequestCardData = {
    version: 1,
    requestId,
    botId: args.botId,
    threadId: args.threadId,
    stagedId: args.staged.id,
    action: args.staged.action,
    name: args.staged.name,
    gist: args.staged.gist,
    source: args.staged.source,
    preview: args.staged.files.find((file) => file.path === "SKILL.md")?.content ?? "",
    sha256: args.staged.sha256,
    warnings: args.staged.warnings,
    createdAt: Date.now(),
  };
  const from = store.bot(args.botId);
  store.appendMessage(args.threadId, {
    role: "bot",
    kind: "options",
    from: from ? { botId: from.id, name: from.name, color: from.color } : undefined,
    card: {
      title: copy.title,
      subtitle: copy.subtitle,
      options: args.applied ? [] : [args.staged.action === "create" ? "Enable" : "Update", "Deny"],
      ...(args.applied ? { answered: "allow", title: `Skill "${args.staged.name}" ${args.staged.action === "create" ? "enabled" : "updated"}` } : {}),
      requestId,
      tool: copy.tool,
      skillRequest: payload,
    },
  });
  return {
    requestId,
    summary: `${copy.title} ${args.staged.gist}`.trim(),
  };
}

function resolveSkillRequest(args: {
  botId: string;
  botName?: string;
  threadId: string;
  requestId: string;
  behavior: "allow" | "deny" | "answer";
  reviewedSha256?: string;
}):
  | { claimed: false }
  | { claimed: true; status: number; error: string }
  | { claimed: true; outcome: "allowed-once" | "rejected"; alreadySettled?: true } {
  const message = store.messagesFor(args.threadId).find(
    (candidate) => candidate.card?.requestId === args.requestId && candidate.card.skillRequest,
  );
  const card = message?.card;
  const request = card?.skillRequest;
  if (!request || !card || !message) return { claimed: false };
  if (request.botId !== args.botId) {
    return { claimed: true, status: 403, error: "this skill request belongs to a different bot" };
  }
  if (card.answered || card.dismissed) {
    // Settlement is durable before cleanup. Retry cleanup for either outcome
    // so a disk failure cannot leave a denied name permanently reserved.
    const cleanup = rejectStagedSkillWrite(args.botId, request.stagedId);
    if ("applied" in cleanup && cleanup.applied && card.answered !== "allow") {
      store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "allow", dismissed: false, held: undefined },
      });
      return { claimed: true, outcome: "allowed-once", alreadySettled: true };
    }
    return { claimed: true, outcome: card.answered === "allow" ? "allowed-once" : "rejected", alreadySettled: true };
  }
  if (args.behavior !== "allow") {
    const rejected = rejectStagedSkillWrite(args.botId, request.stagedId);
    if ("error" in rejected && rejected.error !== "no such staged skill") {
      return { claimed: true, status: 409, error: rejected.error };
    }
    if ("applied" in rejected) {
      store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "allow", dismissed: false, held: undefined },
      });
      appendDecision(DATA_DIR, {
        threadId: args.threadId,
        requestId: args.requestId,
        botId: args.botId,
        botName: args.botName,
        tool: card.tool,
        summary: card.subtitle,
        decision: "user-approved",
        source: "user",
      });
      return { claimed: true, outcome: "allowed-once" };
    }
    store.patchMessage(args.threadId, message.id, {
      card: { ...card, answered: "deny", dismissed: true, held: undefined },
    });
    appendDecision(DATA_DIR, {
      threadId: args.threadId,
      requestId: args.requestId,
      botId: args.botId,
      botName: args.botName,
      tool: card.tool,
      summary: card.subtitle,
      decision: "user-denied",
      source: "user",
    });
    return { claimed: true, outcome: "rejected" };
  }
  if (typeof request.preview !== "string" || typeof request.sha256 !== "string") {
    return {
      claimed: true,
      status: 409,
      error: "this proposal was created by an older build — deny it and ask the bot to create it again",
    };
  }
  if (args.reviewedSha256 !== request.sha256) {
    return {
      claimed: true,
      status: 409,
      error: "reviewedSha256 must match the skill shown on the approval card",
    };
  }
  const previewSha256 = createHash("sha256").update(request.preview).digest("hex");
  if (previewSha256 !== request.sha256) {
    return { claimed: true, status: 422, error: "the skill preview changed after review — deny and recreate it" };
  }
  const staged = getStagedSkillWrite(args.botId, request.stagedId);
  if (!staged) {
    // A later proposal may have pruned this already-applied replay record.
    // The protected manifest still binds the stage id and reviewed hash, so
    // the old card can be settled without asking the model to recreate it.
    const replayed = applyStagedSkillWrite(args.botId, request.stagedId, {
      expectedSha256: request.sha256,
    });
    if (
      "error" in replayed ||
      replayed.name !== request.name ||
      replayed.source !== request.source
    ) {
      return {
        claimed: true,
        status: 422,
        error: "the staged skill no longer matches this approval card",
      };
    }
    const patched = store.patchMessage(args.threadId, message.id, {
      card: { ...card, answered: "allow", held: undefined },
    });
    if (!patched) {
      return { claimed: true, status: 409, error: "the learned-skill approval card is no longer available" };
    }
    appendDecision(DATA_DIR, {
      threadId: args.threadId,
      requestId: args.requestId,
      botId: args.botId,
      botName: args.botName,
      tool: card.tool,
      summary: card.subtitle,
      decision: "user-approved",
      source: "user",
    });
    return { claimed: true, outcome: "allowed-once" };
  }
  if (
    request.requestId !== args.requestId ||
    request.threadId !== args.threadId ||
    staged.action !== request.action ||
    staged.name !== request.name ||
    staged.source !== request.source ||
    staged.sha256 !== request.sha256
  ) {
    return { claimed: true, status: 422, error: "the staged skill no longer matches this approval card" };
  }
  const applied = applyStagedSkillWrite(args.botId, request.stagedId, {
    expectedSha256: request.sha256,
    onApplied: () => {
      const patched = store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "allow", held: undefined },
      });
      if (!patched) throw new Error("the learned-skill approval card is no longer available");
    },
  });
  if ("error" in applied) {
    store.patchMessage(args.threadId, message.id, {
      card: { ...card, held: applied.error },
    });
    return { claimed: true, status: 422, error: applied.error };
  }
  appendDecision(DATA_DIR, {
    threadId: args.threadId,
    requestId: args.requestId,
    botId: args.botId,
    botName: args.botName,
    tool: card.tool,
    summary: card.subtitle,
    decision: "user-approved",
    source: "user",
  });
  return { claimed: true, outcome: "allowed-once" };
}

function sendSkillResolution(
  res: ServerResponse,
  result: ReturnType<typeof resolveSkillRequest>,
): boolean {
  if (!result.claimed) return false;
  if ("error" in result) {
    json(res, result.status, { error: result.error });
    return true;
  }
  json(res, 200, { ok: true, outcome: result.outcome, alreadySettled: result.alreadySettled });
  return true;
}

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

/** A store refusal is a client error with a status of its own (400 path,
 * 409 conflict, 413 too large); a 409 also carries what is on disk now so
 * the editor can show the bot's version instead of guessing. Anything else
 * is a real failure and goes to the handler's catch-all. */
function replyMemoryError(res: ServerResponse, error: unknown) {
  if (!(error instanceof MemoryStoreError)) throw error;
  if (error.code === "conflict") {
    return json(res, error.status, { error: error.message, code: error.code, currentHash: error.currentHash, current: error.current });
  }
  return json(res, error.status, { error: error.message, code: error.code });
}

/** The journal row as the panel shows it: the full prior text stays on
 * the server (a revert needs it there, the list does not), and the thread
 * id becomes the chat title people recognise. */
function journalEntryForClient(botId: string, entry: MemoryJournalEntry) {
  const { before: _before, ...visible } = entry;
  const threadTitle = entry.threadId ? store.taskByThread(botId, entry.threadId)?.title : undefined;
  return threadTitle ? { ...visible, threadTitle } : visible;
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

const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  } catch {
    return json(res, 400, { error: "invalid request URL" });
  }
  const path = url.pathname;
  const method = req.method ?? "GET";
  /** scratch for route matches, shared by every `path.match` below */
  let m: RegExpMatchArray | null = null;
  let releaseWorkspaceRequest: (() => void) | undefined;
  try {
    // Unlike the legacy reachability probe, this attests the running
    // server's portal-membership capability, including live entitlement.
    if (method === "GET" && path === "/api/health/hosted") {
      res.setHeader("cache-control", "no-store");
      const hosted = hostedWorkspaceConfiguration();
      if (!hosted?.portalMembership || !workspaceAccess || !entitled("admin")) {
        return json(res, 503, { error: "Hosted workspace readiness is unavailable." });
      }
      res.setHeader(HOSTED_CONTRACT_HEADER, String(HOSTED_CONTRACT_VERSION));
      return json(res, 200, { ok: true, service: "openmausbot", membershipAuthority: "portal", workspace: hosted.workspace, ...HOSTED_CONTRACT_METADATA });
    }
    // Hosted workspaces have one sign-in authority. A missing optional layer
    // must not accidentally reactivate legacy email/QR credential minting.
    if (HOSTED_WORKSPACE) {
      if (method === "POST" && ["/api/auth/pair", "/api/pair", "/api/auth/pairing", "/api/auth/email/start", "/api/auth/email/verify"].includes(path)) {
        return json(res, 403, { error: "Sign in through the workspace portal." });
      }
      if (workspaceAccess) {
        if (await workspaceAccess.handlePublic(req, res, url)) return;
      } else if (path.startsWith("/api/auth/hosted/") || path === "/pair" || (path === "/" && (!isLoopbackHost(req.headers.host) || isProxied(req)))) {
        return json(res, 503, { error: "Workspace sign-in is unavailable." });
      }
    }
    // ── who is asking (server/request-auth.ts) ──────────────────────────
    // Two public routes come first: what this server is, and turning a pairing
    // code into a session. Everything else needs the loopback owner or a
    // paired session with the right scope.
    if (method === "GET" && !path.startsWith("/api/") && !path.startsWith("/.well-known/") && serveStatic(res, path)) return;
    if (method === "GET" && path === "/.well-known/openmausbot/environment") {
      return json(res, 200, environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED, emailSignIn: !HOSTED_WORKSPACE && emailSignIn.enabled(), sharedComputers: sharedComputersEnabled(cfg) }));
    }
    const domainCheck = /^\/\.well-known\/openmausbot\/domain-check\/([a-f0-9]{64})$/.exec(path);
    if (method === "GET" && domainCheck) {
      res.setHeader("cache-control", "no-store");
      const challenge = customDomainVerifier.challenge(domainCheck[1]);
      return json(res, challenge ? 200 : 404, challenge ?? { error: "No active domain check." });
    }
    // Sign in with an emailed code (server/account-signin.ts). Public like
    // /api/auth/pair, JSON-only for the same reason, and counted against the
    // same per-source lockout so a code cannot be guessed.
    if (method === "POST" && (path === "/api/auth/email/start" || path === "/api/auth/email/verify")) {
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
        return json(res, 415, { error: "send the sign-in request as JSON (content-type: application/json)" });
      }
      if (!emailSignIn.enabled()) return json(res, 404, { error: "email sign-in is not set up on this server; use a pairing code" });
      const source = requestSource(req);
      const allowed = sessions.attemptAllowed(source);
      if (!allowed.ok) return json(res, 429, { error: `too many failed sign-in attempts from your address; try again in ${Math.ceil(allowed.retryAfterMs / 1000)}s` });
      const body = await readBody(req);
      const email = typeof body?.email === "string" ? body.email : "";
      if (path === "/api/auth/email/start") {
        const started = await emailSignIn.start(email);
        if (!started.ok) {
          if (started.status === 403) sessions.noteFailure(source);
          return json(res, started.status, { error: started.error });
        }
        return json(res, 200, { ok: true });
      }
      const code = typeof body?.code === "string" ? body.code : "";
      const label = typeof body?.label === "string" ? body.label : "";
      const verified = await emailSignIn.verify(email, code);
      if (!verified.ok) {
        if (verified.status === 401 || verified.status === 403) sessions.noteFailure(source);
        console.warn(`email sign-in refused from ${source}: ${verified.error}`);
        return json(res, verified.status, { error: verified.error });
      }
      sessions.clearFailures(source);
      const issued = sessions.issue({ label: label.trim() || labelFromUserAgent(req.headers["user-agent"]), scopes: verified.scopes, userId: verified.userId, email: verified.email });
      const environment = environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED, emailSignIn: true, sharedComputers: sharedComputersEnabled(cfg) });
      const secure = requestOrigin(req)?.startsWith("https://") === true;
      res.setHeader("set-cookie", serializeSessionCookie(SESSION_COOKIE, issued.token, { secure, maxAgeSeconds: cookieMaxAgeSeconds(issued.session) }));
      return json(res, 200, { session: issued.session, environment });
    }
    if (method === "POST" && path === "/api/auth/pair") {
      // JSON only: a cross-site HTML form cannot send this content type
      // without a preflight, so a stray unused code cannot be planted as a
      // session in someone else's browser.
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
        return json(res, 415, { error: "send the pairing code as JSON (content-type: application/json)" });
      }
      const body = await readBody(req);
      const code = typeof body?.code === "string" ? body.code : "";
      const wantsCookie = body?.cookie === true;
      const label = typeof body?.label === "string" ? body.label : "";
      const attemptId = typeof body?.attemptId === "string" ? body.attemptId : undefined;
      const result = sessions.exchange({ code, label, attemptId, source: requestSource(req), fallbackLabel: labelFromUserAgent(req.headers["user-agent"]) });
      if (!result.ok) {
        console.warn(`pairing refused from ${requestSource(req)}: ${result.error}`);
        return json(res, result.status, { error: result.error });
      }
      const environment = environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED, emailSignIn: emailSignIn.enabled(), sharedComputers: sharedComputersEnabled(cfg) });
      if (wantsCookie) {
        const secure = requestOrigin(req)?.startsWith("https://") === true;
        res.setHeader("set-cookie", serializeSessionCookie(SESSION_COOKIE, result.token, { secure, maxAgeSeconds: cookieMaxAgeSeconds(result.session) }));
        return json(res, 200, { session: result.session, environment });
      }
      return json(res, 200, { token: result.token, session: result.session, environment });
    }
    // The route the iOS and Android companion apps already POST to. Until now
    // only the desktop's companion sidecar answered it, so a self-hosted
    // server had nothing for a native phone to pair against: the app could
    // reach the server and pass its health probe, then ask for a credential
    // the server could not issue. Same window, same lockout and the same
    // single-use exchange as /api/auth/pair above; only the request and
    // response shapes differ, because the apps were written against the
    // sidecar. Public and unauthenticated for the same reason
    // /api/auth/pair is: redeeming a one-time credential IS the sign-in.
    if (method === "POST" && path === "/api/pair") {
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
        return json(res, 415, { error: "send the pairing credential as JSON (content-type: application/json)" });
      }
      const body = await readBody(req);
      const credential = typeof body?.credential === "string" ? body.credential : typeof body?.code === "string" ? body.code : "";
      const label = typeof body?.deviceName === "string" ? body.deviceName : "";
      const attemptId = typeof body?.pairRequestId === "string" ? body.pairRequestId : undefined;
      const paired = sessions.exchange({ code: credential, label, attemptId, source: requestSource(req), fallbackLabel: labelFromUserAgent(req.headers["user-agent"]) });
      if (!paired.ok) {
        console.warn(`pairing refused from ${requestSource(req)}: ${paired.error}`);
        return json(res, paired.status, { error: paired.error });
      }
      // The shape the companion apps decode (android/core Models.kt,
      // PairResponseSerializer): token, device and serverName are required;
      // hosts and endpoints are advisory and deliberately omitted, because a
      // harness has no sidecar endpoints to advertise.
      return json(res, 200, {
        token: paired.token,
        device: {
          id: paired.session.id,
          name: paired.session.label,
          createdAt: paired.session.createdAt,
          lastSeenAt: paired.session.lastSeenAt,
        },
        serverName: environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED }).label,
      });
    }
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

    // ── sessions: who am I, tickets, pairing and revocation ─────────────
    if (method === "GET" && path === "/api/auth/session") {
      return json(
        res,
        200,
        auth.kind === "loopback"
          ? { kind: "loopback", scopes: auth.scopes, environmentId: ENVIRONMENT_ID }
          : {
              kind: "session",
              id: auth.session.id,
              label: auth.session.label,
              scopes: auth.scopes,
              expiresAt: auth.session.expiresAt,
              via: auth.via,
              environmentId: ENVIRONMENT_ID,
              // the account behind the session, when it came from a sign-in
              ...(auth.session.email ? { email: auth.session.email } : {}),
            },
      );
    }
    if (method === "POST" && path === "/api/auth/stream-ticket") {
      if (auth.kind === "loopback") return json(res, 200, { ticket: null, reason: "loopback needs no ticket" });
      return json(res, 200, sessions.issueStreamTicket(auth.session.id));
    }
    if (method === "POST" && path === "/api/auth/logout") {
      if (auth.kind === "session") sessions.revoke(auth.session.id);
      res.setHeader("set-cookie", clearSessionCookie(SESSION_COOKIE));
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/auth/pairing") {
      const body = await readBody(req);
      // Authentication happened before the request body was read. A session
      // can be revoked while a slow client is still sending that body, so do
      // not let the captured authorization mint a replacement session.
      if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
        return json(res, 401, { error: "Your session ended. Sign in again before creating a pairing code." });
      }
      const requested: unknown = body?.scopes;
      const scopes = Array.isArray(requested) ? requested.filter((v): v is Scope => v === "admin" || v === "client") : undefined;
      const opened = sessions.openPairing({ label: typeof body?.label === "string" ? body.label : undefined, scopes });
      const origin = requestOrigin(req);
      const base = publicUrl() ?? (auth.kind === "session" && origin ? origin : null);
      const code = formatPairingCode(opened.code);
      // Two links for one window. `url` opens the web app and is what a
      // browser and the iOS app already read. `inviteUrl` is the custom
      // scheme the native companion scanners accept; it carries the
      // credential encoding because those scanners cannot take a typed code.
      const serverName = environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED }).label;
      const invite = base
        ? `openmausbot://pair?address=${encodeURIComponent(base)}&token=${encodeURIComponent(opened.credential)}&name=${encodeURIComponent(serverName)}`
        : null;
      return json(res, 200, {
        id: opened.id,
        code,
        credential: opened.credential,
        expiresAt: opened.expiresAt,
        url: base ? `${base}/pair#code=${code}` : null,
        inviteUrl: invite,
        serverName,
        hint: base
          ? null
          : "this server has no public address to put in a link: set OMB_PUBLIC_URL, or open /pair on the address you use and type the code",
      });
    }
    if (method === "GET" && path === "/api/auth/pairing") return json(res, 200, { pairings: sessions.openPairings(), publicUrl: publicUrl() });
    // Admin-only via request-auth's default deny. Connecting a domain only
    // changes future pairing links; DNS, proxy setup, webhooks and all existing
    // sessions remain untouched. The tunnel/deployment URL is kept as fallback.
    if (path === "/api/settings/custom-domain") {
      res.setHeader("cache-control", "no-store");
      if (method === "GET") return json(res, 200, customDomainStatus());
      if (method === "POST" || method === "DELETE") {
        if (DESKTOP_MANAGED) return json(res, 409, { error: "Custom domains are configured on a self-hosted OpenMausBot server, not the desktop companion." });
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
          return json(res, 415, { error: "content-type must be application/json" });
        }
        if (method === "DELETE") {
          saveConfig({ customDomain: "" });
          cfg.customDomain = "";
          customDomainRevision++;
          return json(res, 200, customDomainStatus());
        }
        const body = await readBody(req, 4096);
        if (typeof body?.domain !== "string") return json(res, 400, { error: "Enter your domain name." });
        const revision = customDomainRevision;
        const verified = await customDomainVerifier.verify(body.domain);
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          return json(res, 401, { error: "Your session ended. Sign in again before connecting a domain." });
        }
        if (revision !== customDomainRevision) return json(res, 409, { error: "Domain settings changed during verification. Try again." });
        saveConfig({ customDomain: verified.origin });
        cfg.customDomain = verified.origin;
        customDomainRevision++;
        return json(res, 200, customDomainStatus());
      }
    }
    m = path.match(/^\/api\/auth\/pairing\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const cancelled = sessions.cancelPairing(m[1]);
      return json(res, cancelled ? 200 : 404, cancelled ? { ok: true } : { error: "no such pairing code" });
    }
    if (method === "POST" && path === "/api/desktop/shared-computer-control" && sharedComputersEnabled(cfg)) {
      if (auth.kind !== "loopback") return json(res, 403, { error: "Local desktop only" });
      const body = await readBody(req, 1024);
      if (!sharedComputersEnabled(cfg)) return json(res, 404, { error: `no route: ${method} ${path}` });
      if (!z.string().uuid().safeParse(body?.id).success || !["acquire", "release"].includes(body?.action)) return json(res, 400, { error: "Invalid computer lease" });
      if (body.action === "release") sharedComputerControl.release(body.id);
      else sharedComputerControl.acquire(body.id);
      return json(res, 200, { ok: true });
    }
    // A paired desktop registers only its own outbound connector. A second,
    // main-process-only secret binds poll/results to that exact desktop.
    // With features.sharedComputers off the whole family falls through to the
    // generic "no route" 404, so a probe cannot tell a disabled feature from
    // a build that never had one.
    if (method === "POST" && path.startsWith("/api/shared-computers/") && sharedComputersEnabled(cfg)) {
      if (auth.kind !== "session") return json(res, 403, { error: "Pair this desktop first" });
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
      const body = await readBody(req, 4_000_000);
      if (!sharedComputersEnabled(cfg)) return json(res, 404, { error: `no route: ${method} ${path}` });
      if (!sessions.isLive(auth.session.id)) return json(res, 401, { error: "Session ended" });
      const secret = String(req.headers["x-omb-computer-secret"] ?? "");
      if (path === "/api/shared-computers/connect") {
        const parsed = sharedComputerRegistration.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Invalid computer registration" });
        const registration = parsed.data;
        if (registration.environmentId !== ENVIRONMENT_ID) return json(res, 409, { error: "Workspace identity changed. Pair again before sharing this computer." });
        sharedComputers.register(registration, auth.session.id, secret);
        return json(res, 200, { ok: true });
      }
      const route = /^\/api\/shared-computers\/([\w-]+)\/(poll|lease|result|disconnect)$/.exec(path);
      if (!route) return json(res, 404, { error: "not found" });
      const [, id, action] = route;
      if (action === "poll") return json(res, 200, { job: await sharedComputers.poll(id, auth.session.id, secret) });
      if (action === "lease") return json(res, 200, { active: sharedComputers.liveJob(id, auth.session.id, secret, String(body?.jobId)) });
      if (action === "result") sharedComputers.complete(id, auth.session.id, secret, String(body?.jobId), body?.result);
      if (action === "disconnect") sharedComputers.disconnect(id, auth.session.id, secret);
      return json(res, 200, { ok: true });
    }
    if (method === "GET" && path === "/api/auth/sessions") {
      return json(res, 200, { sessions: sessions.list(), current: auth.kind === "session" ? auth.session.id : null });
    }
    m = path.match(/^\/api\/auth\/sessions\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const revoked = sessions.revoke(m[1]);
      if (auth.kind === "session" && auth.session.id === m[1]) res.setHeader("set-cookie", clearSessionCookie(SESSION_COOKIE));
      return json(res, revoked ? 200 : 404, revoked ? { ok: true } : { error: "no such session" });
    }
    // Isolated integration fixtures cannot invoke an MCP tool before their
    // fake provider exits, so they mint an exact synthetic turn capability
    // through a per-process high-entropy test key. The route does not exist
    // unless the launcher explicitly sets that key; production builds never
    // set it.
    if (method === "POST" && path === "/api/testing/internal-capability") {
      const expected = process.env.OMB_TEST_INTERNAL_CAPABILITY_KEY ?? "";
      const actual = Array.isArray(req.headers["x-openmausbot-test-capability"])
        ? ""
        : String(req.headers["x-openmausbot-test-capability"] ?? "");
      const expectedBytes = Buffer.from(expected);
      const actualBytes = Buffer.from(actual);
      if (
        !expected ||
        actualBytes.length !== expectedBytes.length ||
        !timingSafeEqual(actualBytes, expectedBytes)
      ) return json(res, 404, { error: "not found" });
      const parsed = z.object({
        botId: z.string().regex(/^[\w-]{1,128}$/),
        threadId: z.string().regex(/^[\w-]{1,128}$/),
        kind: z.enum(["agents", "connectors", "computer"]).default("agents"),
        depth: z.number().int().min(0).max(MAX_COMMS_DEPTH).default(0),
        skillAuthoring: z.boolean().default(false),
      }).strict().safeParse(await readBody(req));
      if (!parsed.success || !store.bot(parsed.data.botId)) {
        return json(res, 400, { error: "invalid test capability" });
      }
      const generation = beginInternalCapabilityGeneration(parsed.data.threadId);
      const token = mintInternalCapability({
        ...parsed.data,
        generation,
        createdBots: 0,
        openedThreads: 0,
      });
      return json(res, 201, { token });
    }
    // ── internal peer-agent comms (localhost + bot capability only) ───
    // The agents-proxy (spawned inside a bot's agent process) calls these to
    // discover peers and hand a message to one. Not part of the public API.
    if (await internalRoutes(req, res, path, method, url)) return;

    // Live Team Map metadata. Prompts and replies never leave their
    // transcripts: this projection carries only ids, status relationships,
    // optional delegation labels, and timestamps.
    if (method === "GET" && path === "/api/team-map") {
      const visible = new Set(store.bots.filter((bot) => !bot.hidden).map((bot) => bot.id));
      const collaborations = store.groups
        .filter(
          (group) =>
            group.dm === true &&
            group.memberIds.length === 2 &&
            group.memberIds.every((botId) => visible.has(botId)),
        )
        .map((group) => ({
          groupId: group.id,
          botIds: [group.memberIds[0], group.memberIds[1]] as [string, string],
          lastAt: store.messagesFor(group.threadId).at(-1)?.at ?? group.createdAt,
        }))
        .sort((a, b) => b.lastAt - a.lastAt);
      const queued = pendingDelegationSnapshot().flatMap((item) => {
        if (!visible.has(item.sourceBotId) || !visible.has(item.toBotId)) return [];
        return [{ sourceBotId: item.sourceBotId, targetBotId: item.toBotId, reason: item.reason }];
      });
      const running = [...delegationWatch.entries()].flatMap(([threadId, watch]) => {
        if (!visible.has(watch.toBotId)) return [];
        const channel = watch.channelId ? store.group(watch.channelId) : undefined;
        const sourceBotId = watch.sourceBotId ??
          channel?.memberIds.find((botId) => botId !== watch.toBotId);
        if (!sourceBotId || !visible.has(sourceBotId)) return [];
        return [{ sourceBotId, targetBotId: watch.toBotId, threadId, groupId: channel?.id }];
      });
      return json(res, 200, { collaborations, queued, running });
    }

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
    const requirePinnedClientThread = createRequirePinnedClientThread(auth, req);
    if (await handleMessages(req, res, rctx)) return;

    if (await handleTeams(req, res, rctx)) return;
    if (await handleBots(req, res, rctx)) return;
    if (method === "POST" && path === "/api/bots") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "bot must be a JSON object" });
      }
      if (body.requireAvailableModel !== undefined && typeof body.requireAvailableModel !== "boolean") {
        return json(res, 400, { error: "requireAvailableModel must be true or false" });
      }
      if (body.requireAvailableModel === true && body.modelSelection === undefined) {
        return json(res, 400, { error: "requireAvailableModel requires modelSelection" });
      }
      const profileInput = Object.fromEntries(
        ["name", "title", "description"]
          .filter((key) => body[key] !== undefined)
          .map((key) => [key, body[key]]),
      );
      const profile = parseBotProfilePatch(profileInput, true);
      if (!profile.ok) return json(res, 400, { error: profile.error });
      let section: string | undefined;
      if (body.section !== undefined && body.section !== null) {
        if (typeof body.section !== "string") return json(res, 400, { error: "section must be a string" });
        section = body.section.trim() || undefined;
        if (section && section.length > 60) {
          return json(res, 400, { error: "section must be at most 60 characters" });
        }
      }
      let selection: ModelSelection;
      if (body.modelSelection === undefined) {
        selection = await defaultSelection();
      } else {
        const checked = checkedModelSelection(body.modelSelection, undefined, body.requireAvailableModel === true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        selection = checked.selection;
      }
      // Keep the capacity check immediately beside the synchronous write.
      // Awaiting provider discovery before this point cannot race the cap.
      if (store.bots.length >= MAX_WORKSPACE_BOTS) {
        return json(res, 409, { error: `this workspace is limited to ${MAX_WORKSPACE_BOTS} bots` });
      }
      const bot = store.createBot({ ...profile.patch, section, modelSelection: selection });
      return json(res, 201, {
        bot: {
          ...wireBot(bot),
          messages: store.messagesFor(bot.threadId),
          activeLeafId: store.activeLeaf(bot.threadId),
        },
      });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/avatar\/generate$/);
    if (m && method === "POST") {
      const existing = store.bot(m[1]);
      if (!existing) return json(res, 404, { error: "no such bot" });
      // Generation is slow and both desktop and companion clients may edit or
      // delete this bot while it is in flight. Snapshot the two fields this
      // request owns before the first await so a late result cannot win.
      const initialAvatar = snapshotAvatarGenerationState(existing);
      const parsed = avatarGenerationRequestSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: `prompt must be at most 400 characters` });
      }
      const generated = await generateAvatarImage(cfg, existing, parsed.data.prompt);
      const current = store.bot(existing.id);
      if (!current) return json(res, 404, { error: "no such bot" });
      if (!avatarGenerationStateMatches(initialAvatar, current)) {
        return json(res, 409, { error: "avatar changed while generation was in progress" });
      }
      const saved = saveImage(generated.bytes, generated.mime);
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw Object.assign(new Error("Could not store the generated avatar"), { status: 500 });
      const avatarCrop = initialAvatar.avatarCrop && initialAvatar.avatarCrop !== "mascot"
        ? initialAvatar.avatarCrop
        : "circle";
      const bot = store.patchBot(current.id, { avatarUrl, avatarCrop });
      if (!bot) {
        // There are no awaits between the refreshed lookup and this patch, but
        // keep the attachment invariant explicit if the store ever changes.
        deleteAttachment(saved.path);
        return json(res, 404, { error: "no such bot" });
      }
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 201, { avatarUrl, bot: visible });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/profile$/);
    if (m && method === "PATCH") {
      const parsed = parseBotProfilePatch(await readBody(req), true);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      if (parsed.patch.avatarUrl && !storedAvatarExists(parsed.patch.avatarUrl)) {
        return json(res, 400, { error: "avatarUrl must reference an existing stored image" });
      }
      const existingBot = store.bot(m[1]);
      const beforeProfile = existingBot ? profileSnapshot(existingBot) : undefined;
      const bot = store.patchBotProfile(m[1], parsed.patch);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (beforeProfile) recordProfileChange(bot.id, "user", "api", beforeProfile, profileSnapshot(bot));
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/model$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const unsupported = Object.keys(body).find(
          (key) => key !== "instanceId" && key !== "model" && key !== "effort" && key !== "variant",
        );
        if (unsupported) return json(res, 400, { error: `unsupported model field: ${unsupported}` });
      }
      const existing = store.bot(m[1]);
      if (!existing) return json(res, 404, { error: "no such bot" });
      requirePinnedClientThread(existing.id, undefined);
      const selected = requestedTaskBot(existing.id, undefined);
      if (existing.approvalGrant) {
        return json(res, 409, { error: "wait for the approval-level change to finish before changing models" });
      }
      const checked = checkedModelSelection(
        body,
        { selection: selected.modelSelection, busy: threadBusy(selected.id, selected.threadId) },
        true,
      );
      if (!checked.ok) return json(res, checked.status, { error: checked.error });
      if (activeGroupTurnForBot(existing.id)) {
        const groupChecked = checkedModelSelection(checked.selection, { selection: existing.modelSelection, busy: true });
        if (!groupChecked.ok) return json(res, groupChecked.status, { error: groupChecked.error });
      }
      if ([existing, selected].some((owner) => {
        const mode = approvalModeFor(owner);
        return (mode === "full" || mode === "custom") &&
          (!supportsApprovalMode(registry.cliTarget(checked.selection.instanceId)?.driverKind, mode) ||
            registry.cliTarget(checked.selection.instanceId)?.driverKind !== registry.cliTarget(owner.modelSelection.instanceId)?.driverKind);
      })) {
        return json(res, 400, {
          error: "Changing providers with elevated permissions requires choosing Ask first",
        });
      }
      // patchBot persists first and emits the canonical bot change, which the
      // store listener above turns into the slim wire-format SSE broadcast.
      const bot = store.patchBot(existing.id, { modelSelection: checked.selection });
      if (!bot) return json(res, 404, { error: "no such bot" });
      store.patchTask(bot.id, selected.threadId, { modelSelection: checked.selection });
      return json(res, 200, { bot: wireBot(bot) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/read$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const current = requestedTaskBot(m[1], body?.threadId);
      store.patchTask(current.id, current.threadId, { unread: false });
      const bot = store.bot(current.id)!;
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/always-allow$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const allowKey = typeof body.allowKey === "string" ? body.allowKey : "";
      const bot = requestedTaskBot(m[1], body.threadId);
      if (!allowKey) return json(res, 400, { error: "allowKey required" });
      const pending = store.messagesFor(bot.threadId).some((message) =>
        message.card?.requestId &&
        !message.card.answered &&
        message.card.dismissed !== true &&
        message.card.allowKey === allowKey
      );
      if (!pending) {
        return json(res, 409, { error: "that grant is not on a pending approval for this bot" });
      }
      store.patchTask(bot.id, bot.threadId, {
        alwaysAllow: [...new Set([...(bot.alwaysAllow ?? []), allowKey])].slice(0, 200),
      });
      const live = directTurnBots.get(bot.threadId);
      if (live) live.alwaysAllow = [...new Set([...(live.alwaysAllow ?? []), allowKey])].slice(0, 200);
      const updated = store.bot(bot.id)!;
      const visible = wireBot(updated);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      if (auth.kind === "session" && !auth.scopes.includes("admin")) {
        const field = clientBotPatchViolation(body);
        if (field) return json(res, 403, { error: `forbidden: this session may change how a bot looks, not "${field}" (needs the admin scope)` });
      }
      const existingBot = store.bot(m[1]);
      const selectedTask = existingBot ? requestedTaskBot(existingBot.id, undefined) : null;
      const beforeProfile = existingBot ? profileSnapshot(existingBot) : undefined;
      if (body.requireAvailableModel !== undefined && typeof body.requireAvailableModel !== "boolean") {
        return json(res, 400, { error: "requireAvailableModel must be true or false" });
      }
      const beforeBrowserProfile = existingBot?.browserProfile;
      const beforeBrowserEnabled = existingBot?.browser;
      // Neither Codex (free-form string field) nor Grok (lazy, logs-only)
      // rejects an unknown effort level at their own boundary — this is the
      // only real gate, so it stays. But it fires only when the target
      // instance actually resolves. An instance that isn't there declares no
      // levels, and rejecting against that empty list would 400 the *whole*
      // request: this is the app's general-purpose bot endpoint, and
      // duplicateBot re-sends the source bot's entire modelSelection beside
      // its name, title and description, so a source engine that happens to
      // be offline would cost the copy all of them. Letting it through is
      // safe — startTurn refuses to run a turn on an unavailable instance
      // anyway, so an unverifiable level never reaches a CLI.
      const rawSelection = (body as Record<string, unknown>).modelSelection;
      if (rawSelection !== undefined) requirePinnedClientThread(m[1], undefined);
      if (
        existingBot?.approvalGrant &&
        (rawSelection !== undefined || body.approvalMode !== undefined || body.autoApprove !== undefined)
      ) {
        return json(res, 409, { error: "wait for the approval-level change to finish before changing this setting" });
      }
      if (body.requireAvailableModel === true && rawSelection === undefined) {
        return json(res, 400, { error: "requireAvailableModel requires modelSelection" });
      }
      let normalizedSelection: ModelSelection | undefined;
      if (rawSelection !== undefined) {
        const checked = checkedModelSelection(
          rawSelection,
          selectedTask ? { selection: selectedTask.modelSelection, busy: threadBusy(selectedTask.id, selectedTask.threadId) } : undefined,
          body.requireAvailableModel === true,
        );
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        normalizedSelection = checked.selection;
        if (existingBot && activeGroupTurnForBot(existingBot.id)) {
          const groupChecked = checkedModelSelection(normalizedSelection, { selection: existingBot.modelSelection, busy: true });
          if (!groupChecked.ok) return json(res, groupChecked.status, { error: groupChecked.error });
        }
      }
      // Persona/profile fields reach prompts and paired clients. Both this
      // broad desktop endpoint and the paired-safe profile endpoint pass
      // through the same validation and clear-value normalization.
      const profile = parseBotProfilePatch(body);
      if (!profile.ok) return json(res, 400, { error: profile.error });
      if (profile.patch.avatarUrl && !storedAvatarExists(profile.patch.avatarUrl)) {
        return json(res, 400, { error: "avatarUrl must reference an existing stored image" });
      }
      const patch: Record<string, unknown> = {};
      Object.assign(patch, profile.patch);
      let section: string | undefined | null;
      if (body.section !== undefined) {
        if (body.section === null) section = null;
        else if (typeof body.section !== "string") return json(res, 400, { error: "section must be a string" });
        else {
          const trimmed = body.section.trim();
          if (!trimmed) section = null;
          else if (trimmed.length > 60) return json(res, 400, { error: "section must be at most 60 characters" });
          else section = trimmed;
        }
      }
      for (const key of ["unread", "cloudBackend", "color", "mascotExpression", "mascotBody", "pinned", "hidden"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      const computerSpecified = Object.prototype.hasOwnProperty.call(body, "computer");
      let requestedComputer = existingBot?.computer;
      if (computerSpecified) {
        if (body.computer === null) {
          // Auto is represented by an absent durable field. JSON needs a
          // concrete clear value, so clients send null at the PATCH boundary.
          requestedComputer = undefined;
          patch.computer = undefined;
        } else if (
          typeof body.computer === "string" &&
          ["cloud", "vm", "local", "browser", "off"].includes(body.computer)
        ) {
          requestedComputer = body.computer;
          patch.computer = body.computer;
        } else {
          return json(res, 400, { error: "computer must be null (Auto), cloud, vm, local, browser, or off" });
        }
      }
      if (normalizedSelection) patch.modelSelection = normalizedSelection;
      // one pinned message per thread; null/"" clears. The id is not
      // validated against the transcript here — a pin whose message was
      // edited to another branch or deleted simply resolves to nothing.
      if (body.pinnedMessageId !== undefined) {
        if (body.pinnedMessageId === null || body.pinnedMessageId === "") patch.pinnedMessageId = undefined;
        else if (typeof body.pinnedMessageId === "string" && /^[\w-]+$/.test(body.pinnedMessageId)) {
          patch.pinnedMessageId = body.pinnedMessageId;
        } else return json(res, 400, { error: "pinnedMessageId must be a message id" });
      }
      if (section !== undefined) patch.section = section ?? undefined;
      if (body.chiefOfStaff === false) patch.chiefOfStaff = false;
      // per-bot gate on the workspace's connected apps (Composio)
      if (body.composio !== undefined) {
        if (typeof body.composio !== "boolean") return json(res, 400, { error: "composio must be true or false" });
        patch.composio = body.composio;
      }
      // Queue this bot's direct messages behind outstanding delegated work
      // instead of steering the conversation immediately (#1194).
      if (body.parkDirectMessages !== undefined) {
        if (typeof body.parkDirectMessages !== "boolean") return json(res, 400, { error: "parkDirectMessages must be true or false" });
        patch.parkDirectMessages = body.parkDirectMessages;
      }
      // Per-bot selection of app-wide MCP servers. Omitted keeps the current
      // selection; null restores all enabled servers; [] explicitly mounts none.
      let requestedMcpServers = existingBot?.mcpServers;
      if (body.mcpServers !== undefined) {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          return json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
        }
        if (body.mcpServers === null) {
          requestedMcpServers = undefined;
        } else if (!Array.isArray(body.mcpServers) || body.mcpServers.some((t: unknown) => typeof t !== "string" || mcpServerNameError(t) !== null)) {
          return json(res, 400, { error: "mcpServers must be a list of server names, or null" });
        } else {
          requestedMcpServers = [...new Set(body.mcpServers as string[])];
          if (requestedMcpServers.length > MAX_MCP_SERVERS) {
            return json(res, 400, { error: `Select at most ${MAX_MCP_SERVERS} MCP servers.` });
          }
        }
        patch.mcpServers = requestedMcpServers;
      }
      // per-bot gate on the app's built-in browser
      if (body.browser !== undefined) {
        if (typeof body.browser !== "boolean") return json(res, 400, { error: "browser must be true or false" });
        if (existingBot?.busy && body.browser !== (existingBot.browser !== false)) {
          return json(res, 409, { error: "stop this bot's turn before changing its browser access" });
        }
        patch.browser = body.browser;
      }
      // which named browser session this bot uses; null/"" = its own
      if (body.browserProfile !== undefined) {
        const requestedProfile = body.browserProfile === null || body.browserProfile === ""
          ? undefined
          : body.browserProfile;
        if (existingBot?.busy && requestedProfile !== existingBot.browserProfile) {
          return json(res, 409, { error: "stop this bot's turn before changing its browser profile" });
        }
        if (existingBot && requestedProfile !== existingBot.browserProfile &&
            browserRuntime.heldBy(currentBrowserSession(existingBot.id, existingBot.browserProfile))) {
          return json(res, 409, { error: "Release browser control before changing its profile." });
        }
        if (requestedProfile === undefined) patch.browserProfile = undefined;
        else if (
          typeof requestedProfile === "string" &&
          (requestedProfile === "guest" || (cfg.browserProfiles ?? []).some((profile) => profile.id === requestedProfile))
        ) {
          patch.browserProfile = requestedProfile;
        } else return json(res, 400, { error: "browserProfile must name an existing browser profile" });
      }
      if (body.cloudBackend !== undefined && !["box", "vps"].includes(String(body.cloudBackend))) {
        return json(res, 400, { error: "cloudBackend must be box or vps" });
      }
      if (body.autoStartVps !== undefined) {
        if (typeof body.autoStartVps !== "boolean") return json(res, 400, { error: "autoStartVps must be true or false" });
        patch.autoStartVps = body.autoStartVps;
      }
      if (body.chiefOfStaff !== undefined && typeof body.chiefOfStaff !== "boolean") {
        return json(res, 400, { error: "chiefOfStaff must be true or false" });
      }
      if (body.cloudBackend !== undefined) {
        const backendError = cloudBackendChangeError(Boolean(existingBot?.busy), activeVpsThreads.has(m[1]));
        if (backendError) return json(res, 409, { error: backendError });
      }
      if (body.cwd !== undefined) {
        const checked = validateBotCwd(body.cwd);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        patch.cwd = checked.cwd ?? undefined;
      }
      if (body.hidden === true && existingBot?.chiefOfStaff && body.chiefOfStaff !== false) {
        return json(res, 400, { error: "choose another Chief of Staff before hiding this bot" });
      }
      // the permission fields decide what runs unattended, so they are
      // type-checked rather than copied through: a string alwaysAllow would
      // still answer .includes() — with substring matches, not tool names
      if (body.autoApprove !== undefined) {
        if (typeof body.autoApprove !== "boolean") return json(res, 400, { error: "autoApprove must be true or false" });
      }
      let requestedApprovalMode: ApprovalMode;
      if (body.approvalMode !== undefined) {
        if (!isApprovalMode(body.approvalMode)) {
          return json(res, 400, {
            error: "approvalMode must be ask, auto, full, or custom",
          });
        }
        requestedApprovalMode = body.approvalMode;
      } else if (body.autoApprove !== undefined) {
        // Compatibility for desktop/mobile builds that predate the four-level
        // selector. Their boolean can choose only safe Auto or Ask; it can
        // never silently create Full access.
        requestedApprovalMode = body.autoApprove ? "auto" : "ask";
      } else {
        requestedApprovalMode = approvalModeFor(existingBot ?? {});
      }
      const currentApprovalMode = approvalModeFor(existingBot ?? {});
      const approvalChangeRequested = body.approvalMode !== undefined || body.autoApprove !== undefined;
      if (existingBot?.busy && approvalChangeRequested && requestedApprovalMode !== currentApprovalMode) {
        return json(res, 409, {
          error: "stop this bot's turn before changing its approval level",
        });
      }
      if (body.approvalMode !== undefined || body.autoApprove !== undefined) {
        patch.approvalMode = requestedApprovalMode;
        // Keep the old wire field truthful for older paired apps. It means
        // specifically safe Auto, not "some mode that approves things".
        patch.autoApprove = requestedApprovalMode === "auto";
      }
      const targetSelection = normalizedSelection ?? existingBot?.modelSelection;
      if (normalizedSelection && selectedTask) {
        const mode = approvalModeFor(selectedTask);
        if ((mode === "full" || mode === "custom") &&
          (!supportsApprovalMode(registry.cliTarget(normalizedSelection.instanceId)?.driverKind, mode) ||
            registry.cliTarget(normalizedSelection.instanceId)?.driverKind !== registry.cliTarget(selectedTask.modelSelection.instanceId)?.driverKind)) {
          return json(res, 400, { error: "Choose Ask for the selected thread before changing providers with elevated permissions" });
        }
      }
      if (
        (requestedApprovalMode === "full" || requestedApprovalMode === "custom") &&
        (body.approvalMode !== undefined || normalizedSelection !== undefined) &&
        (!targetSelection || !supportsApprovalMode(registry.cliTarget(targetSelection.instanceId)?.driverKind, requestedApprovalMode) ||
          (existingBot && normalizedSelection && registry.cliTarget(normalizedSelection.instanceId)?.driverKind !== registry.cliTarget(existingBot.modelSelection.instanceId)?.driverKind))
      ) {
        return json(res, 400, {
          error: "This provider does not support the selected approval level, or changing providers requires choosing Ask first",
        });
      }
      const requiresPrivateApprovalTransition =
        ((requestedApprovalMode === "full" || requestedApprovalMode === "custom") &&
          currentApprovalMode !== requestedApprovalMode) ||
        (currentApprovalMode === "custom" && requestedApprovalMode !== "custom");
      if (requiresPrivateApprovalTransition) {
        return json(res, 403, {
          error: "This approval-level change can only be made from the packaged desktop app",
        });
      }
      // "Auto on this Mac" hands a bot the user's real session, so the grant
      // must prove a human saw the warning. The desktop dialog is the only
      // caller that sends acknowledgeLocalAuto; without it a PATCH that would
      // create the combination — a bot curling the loopback API from a tool
      // call, a script, a stale client — is refused. The renderer dialog
      // alone is not a boundary; this check is.
      const wantsComputer = computerSpecified ? requestedComputer : existingBot?.computer;
      const wantsAuto = requestedApprovalMode === "auto";
      const alreadyGranted =
        existingBot?.computer === "local" && approvalModeFor(existingBot) === "auto";
      if (wantsComputer === "local" && wantsAuto === true && !alreadyGranted && body.acknowledgeLocalAuto !== true) {
        return json(res, 400, {
          error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)",
        });
      }
      if (body.approvePeerComms !== undefined) {
        if (typeof body.approvePeerComms !== "boolean") {
          return json(res, 400, { error: "approvePeerComms must be true or false" });
        }
        patch.approvePeerComms = body.approvePeerComms;
      }
      // Who this bot may contact. null clears the list back to "everyone
      // visible in my section"; an array — including an empty one — is the
      // explicit wiring, so a bot can be given exactly one correspondent.
      //
      // Narrowing is free, widening is not. The bot this field constrains
      // can reach this endpoint: resolveRequestAuth hands admin+client to
      // any loopback caller, so a bot holding Bash is one curl from
      // deleting its own leash — the same adversary the acknowledgeLocalAuto
      // block above is written against, and the exact bot the allow-list
      // exists to contain. So cutting reach needs nothing (an operator, a
      // script, even the bot itself may only ever make it smaller), while
      // clearing the list or adding an id needs the proof of a human the
      // desktop dialog sends and a tool call cannot forge.
      if (body.peers !== undefined) {
        let nextPeers: string[] | undefined;
        if (body.peers === null) nextPeers = undefined;
        else if (
          !Array.isArray(body.peers) ||
          body.peers.some((peerId: unknown) => typeof peerId !== "string")
        ) {
          return json(res, 400, { error: "peers must be a list of bot ids, or null for every bot in this section" });
        } else {
          nextPeers = [...new Set<string>(body.peers)].slice(0, MAX_WORKSPACE_BOTS);
        }
        // A bot with no list is already at its widest, so the first list it
        // is ever given can only narrow it.
        const currentPeers = existingBot?.peers;
        const widensReach =
          Array.isArray(currentPeers) &&
          (nextPeers === undefined || nextPeers.some((peerId) => !currentPeers.includes(peerId)));
        if (widensReach && body.acknowledgePeerScope !== true) {
          return json(res, 400, {
            error: "Widening a bot's allowed peers requires confirming it first (acknowledgePeerScope)",
          });
        }
        patch.peers = nextPeers;
      }
      if (body.managedSections !== undefined) {
        const parsed = z.array(z.string().trim().max(60)).max(100).safeParse(body.managedSections);
        if (!parsed.success) return json(res, 400, { error: "managedSections must be a list of up to 100 team names (60 characters each)" });
        const sections = [...new Set(parsed.data)];
        const newSections = sections.filter(section => !(existingBot?.managedSections ?? []).includes(section));
        if (newSections.some(section => section !== "" && !store.sections.includes(section))) {
          return json(res, 400, { error: "Create the named team before giving a Chief access to it" });
        }
        if (sections.length && !(body.chiefOfStaff === true || (existingBot?.chiefOfStaff && body.chiefOfStaff !== false))) {
          return json(res, 400, { error: "Only a Chief of Staff can be given access to additional teams" });
        }
        if (newSections.length && body.acknowledgePeerScope !== true) {
          return json(res, 400, { error: "Confirm which additional teams this Chief may work with (acknowledgePeerScope)" });
        }
        patch.managedSections = sections;
      }
      // Removing the role revokes its grants, rather than leaving dormant
      // authority to return if this bot is elected Chief again later.
      if (body.chiefOfStaff === false) patch.managedSections = [];
      if (body.alwaysAllow !== undefined) {
        if (!Array.isArray(body.alwaysAllow) || body.alwaysAllow.some((t: unknown) => typeof t !== "string")) {
          return json(res, 400, { error: "alwaysAllow must be a list of tool keys" });
        }
        patch.alwaysAllow = [...new Set(body.alwaysAllow as string[])].slice(0, 200);
      }
      // What "the proof of a human" above actually rests on. In the packaged
      // desktop it is real: every mutation here already carried the owner
      // capability a tool call cannot forge. Outside it — `pnpm dev`, the
      // CLI, the Docker stack — loopback is the owner by design, so the
      // acknowledgement flag and the settings that loosen a bot's leash
      // (a wider peer list, the peer-approval gate switched off, a section
      // move that changes who is in reach, a standing always-allow grant)
      // are one curl away from the bot they constrain. What such a request
      // does NOT have is a paired session or a browser origin; and the one
      // moment a bot's shell can send it is while a turn is running. So an
      // originless, session-less loopback caller may loosen a bot only
      // while every bot is idle — and is logged when it does — while the
      // served UI (a browser, with its origin) and a paired device keep
      // working mid-turn as before. A bar, not a wall: the wall is the
      // desktop capability or a paired session, which is what the refusal
      // points at.
      const loosened: string[] = [];
      if (Array.isArray(patch.managedSections) && patch.managedSections.some(section => !(existingBot?.managedSections ?? []).includes(section))) {
        loosened.push("managedSections");
      }
      // A shell can forge an Origin header. New cross-team authority may
      // come from local scripts only when all bots are idle; paired owners
      // and the packaged desktop's private capability can grant it mid-turn.
      if (loosened.includes("managedSections") && auth.kind === "loopback" && !DESKTOP_MANAGED && store.bots.some(bot => bot.busy)) {
        return json(res, 409, { error: "Stop running bots before granting access to another team, or use the desktop app or a paired owner session." });
      }
      if (body.peers !== undefined && Array.isArray(existingBot?.peers)) {
        const nextPeers = patch.peers;
        if (nextPeers === undefined || (Array.isArray(nextPeers) && nextPeers.some((peerId) => !existingBot.peers!.includes(peerId)))) {
          loosened.push("peers");
        }
      }
      if (body.approvePeerComms === false && existingBot?.approvePeerComms === true) loosened.push("approvePeerComms");
      if (section !== undefined && sectionKey(existingBot?.section) !== sectionKey(section)) loosened.push("section");
      if (Array.isArray(patch.alwaysAllow) && patch.alwaysAllow.some((key) => !(existingBot?.alwaysAllow ?? []).includes(key))) {
        loosened.push("alwaysAllow");
      }
      if (body.mcpServers !== undefined && Array.isArray(existingBot?.mcpServers) &&
          (requestedMcpServers === undefined || requestedMcpServers.some((name) => !existingBot.mcpServers!.includes(name)))) {
        loosened.push("mcpServers");
      }
      const browserOrigin = typeof req.headers.origin === "string" && req.headers.origin.trim() !== "";
      if (loosened.length && auth.kind === "loopback" && !DESKTOP_MANAGED && !browserOrigin) {
        if (store.bots.some((candidate) => candidate.busy)) {
          return json(res, 409, {
            error: "A bot is working right now, so this change has to come from the desktop app or a paired device. Try again once every bot is idle.",
          });
        }
        console.warn(`bot ${m[1]}: ${loosened.join(", ")} loosened by ${requestSource(req)} through the local API with no paired session`);
      }
      if (existingBot?.computer === "local" && computerSpecified && requestedComputer !== "local") {
        await interruptAllDirectThreads(existingBot.id);
        const routine = routines!.activeBotRunForBot(existingBot.id);
        if (routine) await routines!.cancelRun(routine.id);
        const groupTurn = activeGroupTurnForBot(existingBot.id);
        if (groupTurn) {
          cancelGroupTurnOperations(groupTurn.group.id, groupTurn.threadId);
          revokeInternalCapabilitiesForThread(groupTurn.threadId);
          await runningTurnInstance(existingBot, groupTurn.threadId)?.adapter.interruptTurn(groupTurn.threadId).catch(() => {});
          closeOpenApprovals(groupTurn.threadId);
        }
      }
      const chiefMovedSections =
        Boolean(existingBot?.chiefOfStaff) &&
        body.chiefOfStaff !== false &&
        section !== undefined &&
        sectionKey(existingBot?.section) !== sectionKey(section);
      let bot: BotRecord | null;
      const freshBrowserBot = store.bot(m[1]);
      // Custom servers are process configuration: a running turn cannot
      // unmount them. Recheck after any awaited runtime revocation above.
      if (body.mcpServers !== undefined) {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          return json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
        }
        if (Array.isArray(freshBrowserBot?.mcpServers) &&
            (requestedMcpServers === undefined || requestedMcpServers.some((name) => !freshBrowserBot.mcpServers!.includes(name))) &&
            auth.kind === "loopback" && !DESKTOP_MANAGED && !browserOrigin && store.bots.some((candidate) => candidate.busy)) {
          return json(res, 409, { error: "A bot is working right now, so this change has to come from the desktop app or a paired device. Try again once every bot is idle." });
        }
        if (freshBrowserBot &&
            JSON.stringify(requestedMcpServers?.toSorted()) !== JSON.stringify(freshBrowserBot.mcpServers?.toSorted()) &&
            (freshBrowserBot.busy || activeGroupTurnForBot(freshBrowserBot.id))) {
          return json(res, 409, { error: "Stop this bot's turns before changing its MCP servers." });
        }
      }
      if (normalizedSelection && selectedTask) {
        const current = store.projectBotForTask(selectedTask.id, selectedTask.threadId);
        if (!current) return json(res, 404, { error: "no such task" });
        const checked = checkedModelSelection(normalizedSelection, { selection: current.modelSelection, busy: threadBusy(current.id, current.threadId) });
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        if (freshBrowserBot && activeGroupTurnForBot(freshBrowserBot.id)) {
          const groupChecked = checkedModelSelection(normalizedSelection, { selection: freshBrowserBot.modelSelection, busy: true });
          if (!groupChecked.ok) return json(res, groupChecked.status, { error: groupChecked.error });
        }
      }
      if (freshBrowserBot && body.browserProfile !== undefined &&
          patch.browserProfile !== freshBrowserBot.browserProfile &&
          (freshBrowserBot.busy || browserRuntime.heldBy(currentBrowserSession(freshBrowserBot.id, freshBrowserBot.browserProfile)))) {
        return json(res, 409, { error: "Stop the bot and release browser control before changing its profile." });
      }
      if (profile.patch.soul !== undefined) {
        if (freshBrowserBot) assertTeamComputerChangeIdle(freshBrowserBot, { ...freshBrowserBot, ...patch } as BotRecord);
        // A mixed settings request must not turn a runtime revocation into
        // a persist-first edit. Apply runtime fields with their existing
        // fail-closed semantics; atomically commit only the profile fields.
        const runtimePatch = { ...patch };
        for (const field of Object.keys(profile.patch)) delete runtimePatch[field];
        if (Object.keys(runtimePatch).length) store.patchBot(m[1], runtimePatch);
        bot = store.patchBotProfile(m[1], profile.patch);
      } else {
        if (freshBrowserBot) assertTeamComputerChangeIdle(freshBrowserBot, { ...freshBrowserBot, ...patch } as BotRecord);
        bot = store.patchBot(m[1], patch);
      }
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (normalizedSelection && selectedTask) store.patchTask(bot.id, selectedTask.threadId, { modelSelection: normalizedSelection });
      if (existingBot && (bot.browserProfile !== beforeBrowserProfile || bot.browser !== beforeBrowserEnabled)) {
        browserLive.closeForBot(bot.id);
        if (beforeBrowserProfile === "guest" && (bot.browserProfile !== "guest" || bot.browser === false)) {
          void forgetTemporaryBrowser(bot.id).catch((error) => console.warn("temporary browser cleanup failed", error));
        }
      }
      const chiefChanges =
        body.chiefOfStaff === true || chiefMovedSections
          ? store.setChiefOfStaff(bot.id)
          : [];
      if (chiefChanges === null) return json(res, 404, { error: "no such bot" });
      if (beforeProfile) {
        const now = store.bot(bot.id)!;
        recordProfileChange(bot.id, "user", "api", beforeProfile, profileSnapshot(now));
      }
      return json(res, 200, { bot: wireBot(store.bot(bot.id)!) });
    }

    if (method === "POST" && path === "/api/local-computer/interrupt") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await Promise.allSettled(
        store.bots
          .filter((bot) => bot.computer === "local")
          .map(async (bot) => {
            await interruptAllDirectThreads(bot.id);
            const routineRun = routines!.activeBotRunForBot(bot.id);
            if (routineRun) {
              cancelDirectTurnDispatch(bot.id, routineRun.threadId);
              if (routineRun.threadId) {
                revokeInternalCapabilitiesForThread(routineRun.threadId);
              }
              await routines!.cancelRun(routineRun.id);
            }
            const groupTurn = activeGroupTurnForBot(bot.id);
            if (groupTurn) {
              cancelGroupTurnOperations(groupTurn.group.id, groupTurn.threadId);
              revokeInternalCapabilitiesForThread(groupTurn.threadId);
              await runningTurnInstance(bot, groupTurn.threadId)?.adapter.interruptTurn(groupTurn.threadId).catch(() => {});
              closeOpenApprovals(groupTurn.threadId);
            }
          }),
      );
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const result = await deleteBotWithLifecycle(m[1]);
      return json(res, result.status, result.body);
    }

    // ── bot skills: imported Agent Skills (SKILL.md) ────────────────────
    // Import lands DISABLED; the UI shows SKILL.md + scan warnings and a
    // person enables after reading. See server/skills.ts for the policy.
    m = path.match(/^\/api\/bots\/([\w-]+)\/skills$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      return json(res, 200, {
        skills: listSkills(m[1]),
        staged: listStagedSkillWrites(m[1]).map(stagedSkillListing),
      });
    }
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ source: z.string().min(1).max(2000) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "source must be a GitHub URL or owner/repo" });
      const fetched = await fetchSkillFromSource(parsed.data.source);
      if ("error" in fetched) return json(res, 422, { error: fetched.error });
      const results = fetched.skills.map((skill) => installSkill(m![1]!, skill.source, skill.files));
      const installed = results.filter((entry): entry is Exclude<typeof entry, { error: string }> => !("error" in entry));
      const errors = results.flatMap((entry) => ("error" in entry ? [entry.error] : []));
      if (!installed.length) return json(res, 422, { error: errors.join("; ") || "nothing importable found" });
      return json(res, 201, { installed, errors });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/skills\/([a-z0-9-]+)$/);
    if (m && method === "GET") {
      const text = readSkillFile(m[1]!, m[2]!);
      if (text === null) return json(res, 404, { error: "no such skill" });
      return json(res, 200, { text });
    }
    if (m && method === "PATCH") {
      const parsed = z.object({ enabled: z.boolean() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "enabled must be true or false" });
      const result = setSkillEnabled(m[1]!, m[2]!, parsed.data.enabled);
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { skill: result });
    }
    if (m && method === "DELETE") {
      const result = removeSkill(m[1]!, m[2]!);
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { ok: true });
    }

    // ── section context: a user-owned team brief ────────────────────────
    // Bots receive this in their system context, but no agent tool can write
    // it. That keeps one bot from silently changing every teammate's future
    // turns. The section query parameter is required even for General (""),
    // so a malformed client cannot accidentally read or replace that brief.
    if (path === "/api/section-context" && (method === "GET" || method === "PUT")) {
      if (!url.searchParams.has("section")) return json(res, 400, { error: "section is required" });
      const requested = url.searchParams.get("section") ?? "";
      const section = sectionContextKey(requested);
      if (section.length > 60) return json(res, 400, { error: "section must be at most 60 characters" });
      const exists =
        section === "" ||
        store.sections.includes(section) ||
        store.bots.some((bot) => !bot.hidden && sectionKey(bot.section) === section) ||
        store.groups.some((group) => sectionKey(group.section) === section);
      if (!exists) return json(res, 404, { error: "no such team" });

      if (method === "GET") {
        const context = readSectionContext(section);
        return json(res, 200, {
          section,
          label: sectionContextLabel(section),
          text: context?.text ?? "",
          updatedAt: context?.updatedAt ?? null,
          maxBytes: SECTION_CONTEXT_MAX_BYTES,
        });
      }

      const parsed = z.object({ text: z.string() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be a string" });
      if (Buffer.byteLength(parsed.data.text, "utf8") > SECTION_CONTEXT_MAX_BYTES) {
        return json(res, 400, { error: `section context is capped at ${SECTION_CONTEXT_MAX_BYTES / 1000}KB` });
      }
      const context = writeSectionContext(section, parsed.data.text);
      return json(res, 200, {
        ok: true,
        section,
        label: sectionContextLabel(section),
        text: context?.text ?? "",
        updatedAt: context?.updatedAt ?? null,
        maxBytes: SECTION_CONTEXT_MAX_BYTES,
      });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/soul$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const soul = bot.soul ?? "";
      const drift = readSoulDrift(bot.id, soul, bot.soulHash ?? "");
      return json(res, 200, {
        soul,
        revision: profileRevision(bot),
        bytes: Buffer.byteLength(soul, "utf8"),
        limit: BOT_PROFILE_LIMITS.soul,
        file: soulFile(bot.id),
        drift: drift.drift,
        ...(drift.drift ? { fileText: drift.fileText } : {}),
      });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/soul\/apply-file$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (body?.expectedRevision !== profileRevision(bot)) {
        return json(res, 409, { error: "This bot's profile changed; reload and look again" });
      }
      const drift = readSoulDrift(bot.id, bot.soul ?? "", bot.soulHash ?? "");
      if (!drift.drift) return json(res, 409, { error: "SOUL.md matches the record; nothing to apply" });
      if (typeof body?.fileText !== "string" || body.fileText !== drift.fileText) {
        return json(res, 409, { error: "SOUL.md changed since you read it; reload and look again" });
      }
      // The file is user input like any other: same cap, same error copy.
      const parsed = parseBotProfilePatch({ soul: drift.fileText });
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      // store.bot() returns the live record and setSoul mutates it in place,
      // so the snapshot must be taken before the call — after, `bot` and
      // `updated` are the same object and the diff would always be empty.
      const beforeProfile = profileSnapshot(bot);
      const updated = store.setSoul(bot.id, parsed.patch.soul ?? "");
      if (!updated) return json(res, 404, { error: "no such bot" });
      recordProfileChange(bot.id, "file", "ui", beforeProfile, profileSnapshot(updated));
      const visible = wireBot(updated);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/soul\/discard-file$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (body?.expectedRevision !== profileRevision(bot)) {
        return json(res, 409, { error: "This bot's profile changed; reload and look again" });
      }
      const drift = readSoulDrift(bot.id, bot.soul ?? "", bot.soulHash ?? "");
      if (!drift.drift || typeof body?.fileText !== "string" || body.fileText !== drift.fileText) {
        return json(res, 409, { error: "SOUL.md changed since you read it; reload and look again" });
      }
      writeSoulMirror(bot.id, bot.soul ?? "");
      const updated = store.patchBot(bot.id, { soulDrift: false }) ?? bot;
      const visible = wireBot(updated);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/system-prompt$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, previewSystemPrompt(bot));
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/overview$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, await botOverview(bot));
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/history$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      // Writes queue in profile-versions.ts and land asynchronously; a client
      // reading history right after causing a change must see its own row.
      await flushProfileHistory(m[1]);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      // A soul row's full before/after can be the entire standing
      // instructions (up to 24,000 bytes) — fine for a rollback, which
      // reads the file server-side, but not for a client that only asked
      // to see what changed. Strip the bodies (keep the byte-count
      // summary) unless the caller explicitly wants them.
      const full = url.searchParams.get("full") === "1";
      const rows = readHistory(m[1], limit).map((row) => {
        if (full || row.field !== "soul") return row;
        const rest: typeof row = { ...row };
        delete rest.before;
        delete rest.after;
        return rest;
      });
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { rows, revision: profileRevision(bot) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/history\/rollback$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      // Same flush as the GET route: the row this rollback targets may have
      // been recorded moments ago and not yet reached disk.
      await flushProfileHistory(m[1]);
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (body?.expectedRevision !== profileRevision(bot)) {
        return json(res, 409, { error: "This bot's profile changed; reload history before undoing" });
      }
      const row = typeof body?.id === "string"
        ? readHistory(bot.id, Number.MAX_SAFE_INTEGER).find((r) => r.id === body.id && r.field === "soul")
        : undefined;
      if (!row || row.field !== "soul" || typeof row.before !== "string") {
        return json(res, 400, { error: "rollback is available for SOUL.md entries only" });
      }
      if (!row.canRestore) {
        return json(res, 400, { error: row.restoreUnavailableReason });
      }
      const parsed = parseBotProfilePatch({ soul: row.before });
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      const before = profileSnapshot(bot);
      const updated = store.setSoul(bot.id, parsed.patch.soul ?? "");
      if (!updated) return json(res, 404, { error: "no such bot" });
      recordProfileChange(bot.id, "user", "rollback", before, profileSnapshot(updated));
      const visible = wireBot(updated);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }

    // ── bot memory: MEMORY.md + memory/ topic and log files ──────────────
    // The files already belong to the person (plain markdown in the bot's
    // workspace). server/memory-store.ts decides which paths can be reached
    // and refuses a save whose expectedHash no longer matches the file;
    // server/memory-journal.ts records every change made here so it can be
    // read back and reverted. Reads never create the workspace — a bot that
    // has not run yet simply has nothing to show. Admin scope by default
    // (request-auth.ts), like the profile routes above.
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      try {
        const overview = memoryOverview(m[1]);
        // `text` and `truncated` ride along one release for clients of the
        // old whole-file shape; the panel reads the file through /memory/file
        return json(res, 200, { ...overview, text: readMemoryDoc(m[1], MEMORY_INDEX).text, truncated: overview.index.truncated });
      } catch (error) {
        return replyMemoryError(res, error);
      }
    }
    if (m && method === "PUT") {
      // The pre-panel whole-file write, kept one release: no hash check, so
      // it can still overwrite a note the bot just wrote — journaled as the
      // person's so at least the journal can undo it.
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ text: z.string() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be a string" });
      try {
        const { doc } = journalMemoryWrite(m[1], MEMORY_INDEX, parsed.data.text, { actor: "person", via: "api" });
        return json(res, 200, { ok: true, hash: doc.hash, truncated: memoryCapacity(doc.text).truncated });
      } catch (error) {
        // the old route answered 400 for an oversized body; keep that for
        // its callers while the new route says 413
        if (error instanceof MemoryStoreError && error.code === "too-large") return json(res, 400, { error: error.message });
        return replyMemoryError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/file$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      try {
        return json(res, 200, readMemoryDoc(m[1], url.searchParams.get("path") ?? MEMORY_INDEX));
      } catch (error) {
        return replyMemoryError(res, error);
      }
    }
    if (m && method === "PUT") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z
        .object({ path: z.string().default(MEMORY_INDEX), text: z.string(), expectedHash: z.string().optional() })
        .safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be a string; path and expectedHash are optional strings" });
      try {
        const { doc, entry } = journalMemoryWrite(m[1], parsed.data.path, parsed.data.text, {
          actor: "person",
          via: "ui",
          expectedHash: parsed.data.expectedHash,
        });
        return json(res, 200, { ok: true, ...doc, entry: entry ? journalEntryForClient(m[1], entry) : null, overview: memoryOverview(m[1]) });
      } catch (error) {
        return replyMemoryError(res, error);
      }
    }
    if (m && method === "DELETE") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const file = url.searchParams.get("path") ?? "";
      try {
        const entry = journalMemoryDelete(m[1], file, { actor: "person", via: "ui" });
        return json(res, 200, { ok: true, path: file, entry: entry ? journalEntryForClient(m[1], entry) : null, overview: memoryOverview(m[1]) });
      } catch (error) {
        return replyMemoryError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/journal$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      // the row a save queued a moment ago may not have reached disk yet
      await flushMemoryJournal(m[1]);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      const botId = m[1];
      return json(res, 200, { entries: readMemoryJournal(botId, limit).map((entry) => journalEntryForClient(botId, entry)) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/journal\/([\w-]+)\/revert$/);
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      await flushMemoryJournal(m[1]);
      const result = revertMemoryChange(m[1], m[2]);
      if (!result.ok) return json(res, result.status, { error: result.error });
      return json(res, 200, { ok: true, ...result.doc, entry: result.entry ? journalEntryForClient(m[1], result.entry) : null, overview: memoryOverview(m[1]) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/open$/);
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ target: z.enum(["obsidian", "folder"]) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "target must be obsidian or folder" });
      // The folder is on this machine's disk; opening it only makes sense
      // from this machine. A paired phone or a remote browser gets the path
      // to open by hand instead.
      const workspacePath = memoryOverview(m[1]).workspacePath;
      if (auth.kind !== "loopback") {
        return json(res, 403, { error: `This only works on the computer running OpenMausBot. The memory folder there is ${workspacePath}`, workspacePath });
      }
      const opened = await openMemoryLocation(m[1], parsed.data.target);
      if (!opened.ok) return json(res, 500, { error: opened.error, workspacePath: opened.workspacePath });
      return json(res, 200, opened);
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/topics\/([^/]+)$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      // Decode before validating: a UI-sent name arrives percent-encoded
      // ("my notes.md" → "my%20notes.md"), and an encoded traversal
      // ("..%2F..") must be judged by what it decodes TO, not slip through
      // as an opaque token. The name gate then rejects anything that is not
      // a single plain-markdown path segment.
      let name: string;
      try {
        name = decodeURIComponent(m[2]);
      } catch {
        return json(res, 400, { error: "invalid topic name" });
      }
      if (!isMemoryTopicName(name)) return json(res, 400, { error: "invalid topic name" });
      const text = readMemoryTopic(m[1], name);
      if (text === null) return json(res, 404, { error: "no such topic file" });
      return json(res, 200, { name, text });
    }

    // ── workspace checkpoints: per-turn shadow-git snapshots ────────────
    // The list endpoint is the source of truth (turns store nothing), and
    // `enabled` tells the UI whether snapshots can happen here at all —
    // false for refused folders (home, Desktop…), a missing git, or a bot
    // whose checkpoints failed earlier this session.
    m = path.match(/^\/api\/bots\/([\w-]+)\/checkpoints$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const cwd = url.searchParams.get("cwd") ?? "";
      if (!cwd.trim()) return json(res, 400, { error: "cwd query parameter required" });
      return json(res, 200, {
        checkpoints: await checkpoints.listCheckpoints(m[1]!, cwd),
        enabled: await checkpoints.checkpointsEnabled(m[1]!, cwd),
      });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/checkpoints\/restore$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const parsed = z
        .object({ cwd: z.string().min(1), hash: z.string().regex(/^[0-9a-f]{40}$/) })
        .safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "cwd (absolute path) and hash (full 40-character checkpoint hash) required" });
      }
      // Claim synchronously with the busy check. startTurn checks the same
      // lease before reserving the bot, so no turn can enter during the
      // awaited Git operation.
      if (bot.busy) return json(res, 409, { error: "the bot is working — stop the turn before restoring files" });
      if (checkpointRestoreLeases.has(bot.id)) {
        return json(res, 409, { error: "this bot's project files are already being restored" });
      }
      checkpointRestoreLeases.add(bot.id);
      let result: checkpoints.RestoreResult;
      try {
        result = await checkpoints.restore(bot.id, parsed.data.cwd, parsed.data.hash);
      } finally {
        checkpointRestoreLeases.delete(bot.id);
      }
      if (!result.ok) return json(res, 400, { error: result.error });
      return json(res, 200, { ok: true });
    }

    // onboarding/ask cards persist their answered/dismissed state
    m = path.match(/^\/api\/bots\/([\w-]+)\/cards\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const bot = requestedTaskBot(m[1], body.threadId);
      const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card) return json(res, 404, { error: "no such card" });
      if (existing.card.requestId) {
        return json(res, 409, { error: "request cards must be answered through the approval endpoint" });
      }
      if (Object.keys(body).some((key) => key !== "answered" && key !== "dismissed" && key !== "threadId")) {
        return json(res, 400, { error: "only answered and dismissed may be changed" });
      }
      if (body.answered !== undefined && typeof body.answered !== "string") {
        return json(res, 400, { error: "answered must be a string" });
      }
      if (body.dismissed !== undefined && typeof body.dismissed !== "boolean") {
        return json(res, 400, { error: "dismissed must be true or false" });
      }
      const patched = store.patchMessage(bot.threadId, m[2], {
        card: {
          ...existing.card,
          ...(body.answered !== undefined ? { answered: body.answered } : {}),
          ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
        },
      });
      return json(res, 200, { message: patched });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      requirePinnedClientThread(bot.id, body.threadId);
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      // A retry carries its original task. That lets us return the canonical
      // receipt after a task switch, while a genuinely new send still has to
      // target the task that is active now.
      const threadId = body.threadId ?? bot.threadId;
      noteTurnTrigger(threadId, auth);
      // The send is acknowledged before the turn starts, so a workspace at its
      // spend limit is refused here, where the person can see it.
      try {
        assertWithinBudget(cfg, DATA_DIR);
      } catch (error) {
        return json(res, 409, { error: error instanceof Error ? error.message : String(error), code: "spend_cap" });
      }
      if (!store.taskByThread(bot.id, threadId)) {
        return json(res, 409, { error: "the bot switched tasks before it could receive the message" });
      }
      const sendId = parseSendId(body.sendId);
      const replyTo = resolveReplyTarget(threadId, body.replyToId);
      const receipt = await sendSequencer.run(
        sendId ? `bot:${bot.id}:${threadId}:${sendId}` : undefined,
        sendFingerprint(text, replyTo?.id),
        async () => {
          if (sendId) {
            if (cancelledChatFollowup("bot", bot.id, threadId, sendId)) {
              throw Object.assign(new Error("this queued sendId was cancelled; send a new message to try again"), { status: 409 });
            }
            const accepted = acceptedSendMatch(store.messagesFor(threadId), sendId, text, replyTo?.id);
            if (accepted.kind === "conflict") {
              throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
            }
            if (accepted.kind === "match") {
              const canonical = {
                ok: true as const,
                threadId,
                message: accepted.message,
              };
              return accepted.message.steered
                ? { ...canonical, steered: true as const }
                : canonical;
            }
            const queued = queuedSteeredMessage(bot.id, threadId, sendId);
            if (queued) {
              if (queued.text !== text || queued.replyToId !== replyTo?.id) {
                throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
              }
              return { ok: true as const, queued: true as const, queueId: queued.id, threadId, reason: queued.reason };
            }
          }

          const currentAtStart = store.projectBotForTask(bot.id, threadId);
          if (!currentAtStart) throw Object.assign(new Error("no such bot"), { status: 404 });
          if (!store.taskByThread(currentAtStart.id, threadId)) {
            throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
          }

          // Claude can accept the message inside its live turn. If the write
          // loses a race with turn settlement, or the engine cannot steer, the
          // existing server-side queue records it atomically for the next turn.
          if (currentAtStart.busy) {
            const instance = runningTurnInstance(currentAtStart, threadId);
            let steered: SteerOutcome = "refused";
            // A live text steer has no image side channel. Keep an attachment
            // message intact for the next ordinary turn, where central image
            // admission can hand it to the provider natively.
            const carriesImages = extractTurnImages(text).images.length > 0;
            const steerTarget = handoffs.current(threadId);
            if (!carriesImages && !computerSelectionTurns.get(threadId)?.selected && instance?.adapter.capabilities.queueing && instance.adapter.steer) {
              steered = await instance.adapter
                .steer(threadId, promptWithReply(text, replyTo, cfg.profile?.name?.trim() || "User"))
                .catch((): SteerOutcome => "indeterminate");
            }
            // steer() is awaited adapter work. The turn can settle, the task can
            // switch, or the whole bot can be deleted before its acknowledgement
            // arrives. Re-read every ownership invariant before appending even a
            // successful steer; otherwise that late acknowledgement writes a user
            // message into a task the bot no longer owns. A conflict leaves the
            // text in the client's composer/outbox to resend deliberately.
            const current = store.projectBotForTask(bot.id, threadId);
            if (!current) throw Object.assign(new Error("no such bot"), { status: 404 });
            if (!store.taskByThread(bot.id, threadId)) {
              throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
            }
            const delivered = steered !== "refused";
            if (delivered) {
              if (steered === "steered" && !current.busy) {
                throw Object.assign(
                  new Error("the running turn ended before the steered message could be recorded"),
                  { status: 409 },
                );
              }
              // "indeterminate" falls through to the same record: the words
              // may already be folded into a turn whose acknowledgement was
              // lost, and handing them back for a resend could run them
              // twice. Recording them once is the honest outcome.
              // A person steering a webhook turn is present, and auto mode may
              // follow them again. But this route is also reachable from the
              // bot's own shell on a headless server (loopback is the owner
              // there), and "continue" typed by the turn itself must not be
              // the thing that lifts the block written against it — so only
              // a request that proves a person (a paired session, or the
              // desktop's owner capability, which every mutation there has
              // already shown) clears the mark.
              if (auth.kind === "session" || DESKTOP_MANAGED) clearUnattended(threadId);
              const message = store.appendMessage(threadId, {
                role: "user",
                kind: "text",
                text,
                replyToId: replyTo?.id,
                sendId,
                steered: true,
                sender: messageSender(auth),
              });
              // Offered to the next turn again unless the person stops this one.
              handoffs.steered(threadId, steerTarget, instance?.instanceId, message.id);
              return { ok: true as const, steered: true as const, threadId, message };
            }
            if (!current.busy) {
              return startOrQueueDirectMessage(bot.id, threadId, text, replyTo, sendId, messageSender(auth));
            }
            const queued = queueSteeredMessage(current.id, threadId, text, {
              replyToId: replyTo?.id,
              sendId,
              prompt: promptWithReply(text, replyTo, cfg.profile?.name?.trim() || "User"),
            });
            return { ok: true as const, queued: true as const, queueId: queued.id, threadId };
          }
          return startOrQueueDirectMessage(bot.id, threadId, text, replyTo, sendId, messageSender(auth));
        },
      );
      return json(res, 202, receipt);
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/queue\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body?.threadId);
      const queueId = m[2];
      if (!cancelSteeredMessage(bot.id, queueId, bot.threadId)) {
        return json(res, 404, { error: "no such queued message" });
      }
      return json(res, 200, { ok: true });
    }

    // Steer a queued message into the RUNNING turn (no interrupt). Engines
    // without a live steer keep the queue; this never ends the current turn.
    m = path.match(/^\/api\/bots\/([\w-]+)\/queue\/([\w-]+)\/steer$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body?.threadId);
      noteTurnTrigger(bot.threadId, auth);
      // Lift the whole queue atomically: a settle racing this request can
      // drain it as a follow-up, or this request can steer it into the live
      // turn — never both for the same words.
      const held = holdSteeredQueue(bot.id, bot.threadId, m[2]);
      if (!held) return json(res, 404, { error: "no such queued message" });
      // A live steer has no image side channel. Attachment words wait for a
      // real turn where central admission can hand the images to the engine.
      if (held.items.some((item) => extractTurnImages(item.text).images.length > 0)) {
        restoreHeldSteeredQueue(held);
        return json(res, 200, { ok: true, queued: true, threadId: bot.threadId });
      }
      const currentAtStart = store.projectBotForTask(bot.id, bot.threadId);
      const instance = currentAtStart?.busy ? runningTurnInstance(currentAtStart, bot.threadId) : undefined;
      const prompt = held.items.map((item) => item.prompt).join("\n\n");
      const steerTarget = handoffs.current(bot.threadId);
      let steered: SteerOutcome = "refused";
      if (currentAtStart?.busy && instance?.adapter.capabilities.queueing && instance.adapter.steer) {
        steered = await instance.adapter
          .steer(bot.threadId, prompt)
          .catch((): SteerOutcome => "indeterminate");
      }
      // The steer was awaited adapter work: re-read every ownership
      // invariant before writing anything, exactly like the live-send path.
      const current = store.projectBotForTask(bot.id, bot.threadId);
      // "indeterminate" never restores: the words may already be folded into
      // the turn that was live when they were sent, and replaying them into
      // a fresh follow-up turn would run them twice. Record them whenever
      // the destination still exists, busy or not.
      if (
        (steered === "steered" && current?.busy ||
          steered === "indeterminate" && current) &&
        store.taskByThread(bot.id, bot.threadId)
      ) {
        if (auth.kind === "session" || DESKTOP_MANAGED) clearUnattended(bot.threadId);
        const messages = held.items.map((item) => store.appendMessage(bot.threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          sendId: item.sendId,
          queueId: item.messageId,
          peerAsk: item.peerAsk,
          steered: true,
        }));
        // Offered to the next turn again unless the person stops this one.
        for (const message of messages) handoffs.steered(bot.threadId, steerTarget, instance?.instanceId, message.id);
        const queueIds = held.items.map((item) => item.messageId);
        settleHeldSteeredQueue(held);
        return json(res, 200, { ok: true, steered: true, threadId: bot.threadId, messages, queueIds });
      }
      if (steered === "indeterminate") {
        // No destination is left: settle so a restart cannot replay words a
        // dead turn may already have run.
        settleHeldSteeredQueue(held);
        if (!store.taskByThread(bot.id, bot.threadId)) {
          throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
        }
        throw Object.assign(new Error("no such bot"), { status: 404 });
      }
      restoreHeldSteeredQueue(held);
      // The turn may have settled while the steer was refused; a queue that
      // is now drainable must not strand behind a missed settle.
      if (current && !current.busy) drainQueuedSends();
      return json(res, 200, { ok: true, queued: true, threadId: bot.threadId });
    }

    // edit a user message → fork the conversation there and rerun the turn.
    // Rewinding a live thread is refused, exactly like switching versions
    // below: interrupting mid-flight and branching under the dying turn is
    // how a conversation ends up with two tails. Stop, then edit.
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages\/([\w-]+)\/edit$/);
    if (m && method === "POST") {
      const messageId = m[2];
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body.threadId);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      // everything from here down is synchronous, so two racing edits can
      // never both get past this check: startTurn flips busy before the
      // next request is handled
      if (threadBusy(bot.id, bot.threadId)) return json(res, 409, { error: "the thread is working — stop it before editing" });
      if (phoneSecretSubmissions.hasThread(bot.threadId)) {
        return json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
      }
      const source = store.messagesFor(bot.threadId).find((msg) => msg.id === messageId);
      if (!source || source.role !== "user" || source.kind !== "text") {
        return json(res, 404, { error: "only user messages can be edited" });
      }
      if (!registry.get(bot.modelSelection.instanceId)) {
        return json(res, 409, {
          error: `provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`,
        });
      }
      // startTurn admits the rerun before branching. A shared-resource or
      // concurrency-limit refusal must leave the original transcript intact.
      const replyTo = source.replyToId ? resolveReplyTarget(bot.threadId, source.replyToId) : undefined;
      const message = await startTurn(bot.id, text, { threadId: bot.threadId, editedMessageId: messageId, replyTo });
      return json(res, 202, { ok: true, message });
    }

    // switch which fork of the conversation is visible (no new turn)
    m = path.match(/^\/api\/bots\/([\w-]+)\/active-branch$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body.threadId);
      if (threadBusy(bot.id, bot.threadId)) return json(res, 409, { error: "the thread is working — stop it before switching versions" });
      if (phoneSecretSubmissions.hasThread(bot.threadId)) {
        return json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
      }
      const leaf = store.setActiveLeaf(bot.threadId, String(body.messageId ?? ""));
      if (!leaf) return json(res, 404, { error: "no such message" });
      // provider sessions still hold the other branch — next turn replays
      store.patchTask(bot.id, bot.threadId, { rewound: true });
      return json(res, 200, { activeLeafId: leaf });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const selected = requestedTaskBot(m[1], body.threadId);
      const bot = botForThread(selected.id, selected.threadId)!;
      const behavior = requestBehavior(body.behavior);
      const reviewedSha256 = typeof body.reviewedSha256 === "string" ? body.reviewedSha256 : undefined;
      if (!behavior) return json(res, 400, { error: "behavior must be allow, deny, or answer" });
      if (await resolveAndSendTeamSetup(res, {
        botId: bot.id, threadId: bot.threadId, requestId: String(body.requestId), behavior,
      }, auth.kind === "loopback" ? DESKTOP_MANAGED || Boolean(req.headers.origin) && !store.bots.some((bot) => bot.busy || activeGroupTurnForBot(bot.id)) : auth.scopes.includes("admin"))) return;
      if (resolveAndSendRoutine(res, {
        botId: bot.id,
        botName: bot.name,
        threadId: bot.threadId,
        requestId: String(body.requestId),
        behavior,
      })) return;
      if (resolveAndSendProfile(res, {
        botId: bot.id,
        botName: bot.name,
        threadId: bot.threadId,
        requestId: String(body.requestId),
        behavior,
      })) return;
      if (sendSkillResolution(res, resolveSkillRequest({
        botId: bot.id,
        botName: bot.name,
        threadId: bot.threadId,
        requestId: String(body.requestId),
        behavior,
        reviewedSha256,
      }))) return;
      // peer-approval intercept: harness-native cards carry a requestId
      // that lives in peer-approval's pending map. Resolve them here so
      // the provider adapter never sees a request it didn't raise.
      if (store.messagesFor(bot.threadId).some((message) => message.card?.requestId === String(body.requestId)) &&
        resolvePeerComms(approvalBus, String(body.requestId), behavior)) {
        return json(res, 200, { ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" });
      }
      const outcome = await answerRequest(bot.threadId, bot.modelSelection.instanceId, String(body.requestId), behavior, body.message, { id: bot.id, name: bot.name }, body.always === true);
      return json(res, 200, { ok: true, outcome });
    }
    // Answer by THREAD, so a request raised inside a room can be answered
    // too: a member's turn runs on the room's thread, and the bot that
    // owns the pending request is the one currently speaking there.
    m = path.match(/^\/api\/threads\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const threadId = m[1];
      const body = await readBody(req);
      const behavior = requestBehavior(body.behavior);
      const reviewedSha256 = typeof body.reviewedSha256 === "string" ? body.reviewedSha256 : undefined;
      if (!behavior) return json(res, 400, { error: "behavior must be allow, deny, or answer" });
      const requestId = String(body.requestId);
      const skillCard = store.messagesFor(threadId).find(
        (message) => message.card?.requestId === requestId && message.card.skillRequest,
      );
      if (skillCard?.card?.skillRequest) {
        const skillBotId = skillCard.from?.botId ?? store.botByThread(threadId)?.id;
        if (!skillBotId) return json(res, 400, { error: "this skill request has no valid owner" });
        const skillOwner = store.bot(skillBotId);
        if (sendSkillResolution(res, resolveSkillRequest({
          botId: skillBotId,
          botName: skillOwner?.name,
          threadId,
          requestId,
          behavior,
          reviewedSha256,
        }))) return;
      }
      const routineCard = store.messagesFor(threadId).find(
        (message) => message.card?.requestId === requestId && message.card.routineRequest,
      );
      if (routineCard?.card?.routineRequest) {
        // Derive the owner from the conversation, not from the executable
        // payload being authorized. Room cards carry their trusted sender;
        // one-to-one tasks resolve through the store's thread ownership.
        const routineBotId = routineCard.from?.botId ?? store.botByThread(threadId)?.id;
        if (!routineBotId) return json(res, 400, { error: "this routine request has no valid owner" });
        const routineOwner = store.bot(routineBotId);
        if (resolveAndSendRoutine(res, {
          botId: routineBotId,
          botName: routineOwner?.name,
          threadId,
          requestId,
          behavior,
        })) return;
      }
      const setupCard = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId && message.card.teamSetupRequest);
      if (setupCard) {
        const setupBotId = setupCard.from?.botId ?? store.botByThread(threadId)?.id;
        if (!setupBotId) return json(res, 400, { error: "This team setup has no valid owner" });
        if (await resolveAndSendTeamSetup(res, { botId: setupBotId, threadId, requestId, behavior },
          auth.kind === "loopback" ? DESKTOP_MANAGED || Boolean(req.headers.origin) && !store.bots.some((bot) => bot.busy || activeGroupTurnForBot(bot.id)) : auth.scopes.includes("admin"))) return;
      }
      const profileCard = store.messagesFor(threadId).find(
        (message) => message.card?.requestId === requestId && message.card.profileRequest,
      );
      if (profileCard?.card?.profileRequest) {
        const profileBotId = profileCard.from?.botId ?? store.botByThread(threadId)?.id;
        if (!profileBotId) return json(res, 400, { error: "this profile request has no valid owner" });
        const profileOwner = store.bot(profileBotId);
        if (resolveAndSendProfile(res, {
          botId: profileBotId,
          botName: profileOwner?.name,
          threadId,
          requestId,
          behavior,
        })) return;
      }
      // peer-approval intercept (see /api/bots/:id/respond above). A peer card
      // belongs to the bus rather than to a speaker, so resolve it before we go
      // looking for one — a room between turns has no speaker to find.
      if (store.messagesFor(threadId).some((message) => message.card?.requestId === requestId) &&
        resolvePeerComms(approvalBus, requestId, behavior)) {
        return json(res, 200, { ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" });
      }
      const group = store.groupByThread(threadId);
      // busyBotId is in-memory only, so an approval that outlives its turn — or
      // the process — leaves a durable card with no speaker behind it. Fall back
      // to the member that raised it, and answer even when that member is gone:
      // answerRequest closes an unreachable card, and a pending approval owns
      // the composer, so a dead end here locks the room for good.
      const pending = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId);
      const owner = group
        ? (group.busyBotId ? store.bot(group.busyBotId) : undefined) ??
          (pending?.from ? store.bot(pending.from.botId) : undefined)
        : store.botByThread(threadId);
      if (!owner && !pending) return json(res, 404, { error: "nothing is waiting on an answer in this conversation" });
      const requestOwner = owner ? botForThread(owner.id, threadId) : null;
      const outcome = await answerRequest(threadId, requestOwner?.modelSelection.instanceId ?? "", requestId, behavior, body.message, owner ? { id: owner.id, name: owner.name } : undefined, body.always === true);
      return json(res, 200, { ok: true, outcome });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const rawBody = await readBody(req);
      if (rawBody !== null && (typeof rawBody !== "object" || Array.isArray(rawBody))) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const body = rawBody ?? {};
      requirePinnedClientThread(bot.id, body.threadId);
      const expectedThreadId = body.threadId;
      if (expectedThreadId !== undefined && (typeof expectedThreadId !== "string" || !/^[\w-]+$/.test(expectedThreadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      // Explicit thread targets never fall through to another routine or
      // channel just because it belongs to the same bot.
      if (typeof expectedThreadId === "string" && store.taskByThread(bot.id, expectedThreadId)) {
        const routine = routines!.activeBotRunForBot(bot.id);
        if (routine?.threadId === expectedThreadId) await routines!.cancelRun(routine.id);
        else {
          handoffs.stoppedByPerson(expectedThreadId);
          await interruptDirectThread(bot.id, expectedThreadId);
        }
        return json(res, 200, { ok: true });
      }
      const directClaim = directTurnDispatchClaims.get(bot.threadId);
      const routineRun = routines!.activeBotRunForBot(bot.id);
      if (routineRun) {
        if (expectedThreadId !== undefined && routineRun.threadId !== expectedThreadId) {
          return json(res, 409, { error: "this bot is running a routine in another conversation" });
        }
        cancelDirectTurnDispatch(bot.id, routineRun.threadId ?? expectedThreadId);
        if (routineRun.threadId) {
          revokeInternalCapabilitiesForThread(routineRun.threadId);
        }
        await routines!.cancelRun(routineRun.id);
        return json(res, 200, { ok: true });
      }
      const instance = registry.get((botForThread(bot.id, expectedThreadId ?? bot.threadId) ?? bot).modelSelection.instanceId);
      // a bot busy in a ROOM is running on the room's thread — stopping it
      // from its own chat must reach that turn, not just the 1:1 thread
      const busyGroup = activeGroupTurnForBot(bot.id);
      if (busyGroup) {
        if (expectedThreadId !== undefined && busyGroup.threadId !== expectedThreadId) {
          return json(res, 409, { error: `this bot is working in channel ${busyGroup.group.name}` });
        }
        cancelGroupTurnOperations(busyGroup.group.id, busyGroup.threadId);
        revokeInternalCapabilitiesForThread(busyGroup.threadId);
        await instance?.adapter.interruptTurn(busyGroup.threadId).catch(() => {});
        closeOpenApprovals(busyGroup.threadId);
        return json(res, 200, { ok: true });
      }
      if (
        expectedThreadId !== undefined &&
        !busyGroup &&
        bot.threadId !== expectedThreadId &&
        directClaim?.threadId !== expectedThreadId
      ) {
        return json(res, 409, { error: "the bot switched tasks before it could be interrupted" });
      }
      handoffs.stoppedByPerson(expectedThreadId ?? bot.threadId);
      await interruptDirectThread(bot.id, expectedThreadId ?? bot.threadId);
      return json(res, 200, { ok: true });
    }

    // ── tasks: a bot's separate contexts ────────────────────────────────
    // The bot record answers with its messages because switching tasks
    // changes which transcript is live, and a partial patch would leave
    // the client showing the previous task's conversation.
    const botWithThread = (bot: NonNullable<ReturnType<typeof store.bot>>) => ({
      ...wireBot(bot),
      messages: store.messagesFor(bot.threadId),
      activeLeafId: store.activeLeaf(bot.threadId),
      tasks: store.tasks(bot.id).map(wireTask),
    });

    // Folders organize one bot's threads; they never own settings,
    // transcripts or working directories. The project wire names stay stable.
    m = path.match(/^\/api\/bots\/([\w-]+)\/projects\/order$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "projectIds") ||
        !Array.isArray(body.projectIds) || body.projectIds.some((id: unknown) => typeof id !== "string")) {
        return json(res, 400, { error: "projectIds must be an array of folder IDs" });
      }
      const projects = store.reorderProjects(bot.id, body.projectIds);
      if (!projects) return json(res, 400, { error: "projectIds must include each of this bot's folders exactly once" });
      return json(res, 200, { projects, bot: botWithThread(bot) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/projects(?:\/([\w-]+))?$/);
    if (m && ((method === "POST" && !m[2]) || (method === "PATCH" && m[2]) || (method === "DELETE" && m[2]))) {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (m[2] && !store.project(bot.id, m[2])) return json(res, 404, { error: "no such folder" });
      if (method === "DELETE") {
        const updated = store.deleteProject(bot.id, m[2]!);
        return json(res, 200, { bot: botWithThread(updated!) });
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
      if (Object.keys(body).some((key) => key !== "name" && key !== "emoji")) {
        return json(res, 400, { error: "unsupported folder setting" });
      }
      if ((method === "POST" || body.name !== undefined) &&
        (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80)) {
        return json(res, 400, { error: "folder name must be between 1 and 80 characters" });
      }
      if (body.emoji !== undefined && body.emoji !== null && !isProjectEmoji(body.emoji)) {
        return json(res, 400, { error: "folder emoji must be one emoji, or null to reset it" });
      }
      const patch: Parameters<typeof store.patchProject>[2] = {};
      if (body.name !== undefined) patch.name = body.name.trim();
      if (body.emoji !== undefined) patch.emoji = body.emoji;
      const project = method === "POST"
        ? store.createProject(bot.id, patch.name!, patch.emoji)
        : store.patchProject(bot.id, m[2]!, patch);
      return json(res, method === "POST" ? 201 : 200, { project, bot: botWithThread(bot) });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (phoneSecretSubmissions.hasBot(bot.id)) {
        return json(res, 409, { error: "this bot is securely saving a credential — try again when it finishes" });
      }
      if (body.projectId !== undefined && (typeof body.projectId !== "string" || !store.project(bot.id, body.projectId))) {
        return json(res, 400, { error: "projectId must belong to this bot" });
      }
      const task = store.createTask(bot.id, typeof body.title === "string" ? body.title : undefined, true, body.projectId);
      if (!task) return json(res, 500, { error: "couldn't create that task" });
      const fresh = botWithThread(store.bot(bot.id)!);
      broadcast({ kind: "bot", bot: fresh });
      return json(res, 201, { bot: fresh, task: wireTask(task) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks\/([\w-]+)$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (phoneSecretSubmissions.hasBot(bot.id)) {
        return json(res, 409, { error: "this bot is securely saving a credential — try again when it finishes" });
      }
      // Navigation only: execution owns its thread, never this selected id.
      const switched = store.switchTask(bot.id, m[2]);
      if (!switched) return json(res, 404, { error: "no such task" });
      const fresh = botWithThread(switched);
      broadcast({ kind: "bot", bot: fresh });
      const responseBot = url.searchParams.get("messages") === "0"
        ? { ...wireBot(switched), tasks: store.tasks(switched.id).map(wireTask) }
        : fresh;
      return json(res, 200, { bot: responseBot });
    }
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
      const current = store.projectBotForTask(m[1], m[2]);
      if (!current) return json(res, 404, { error: "no such task" });
      const allowed = new Set(["title", "projectId", "modelSelection", "updateBotDefault", "resetApprovalToAsk", "approvalMode", "autoApprove", "requireAvailableModel", "pinnedMessageId", "acknowledgeLocalAuto", "archivedAt", "surface"]);
      if (Object.keys(body).some((key) => !allowed.has(key))) return json(res, 400, { error: "unsupported thread setting" });
      for (const key of ["requireAvailableModel", "acknowledgeLocalAuto", "updateBotDefault", "resetApprovalToAsk"] as const) {
        if (body[key] !== undefined && typeof body[key] !== "boolean") return json(res, 400, { error: `${key} must be a boolean` });
      }
      if (body.requireAvailableModel === true && body.modelSelection === undefined) return json(res, 400, { error: "requireAvailableModel requires modelSelection" });
      if (body.updateBotDefault === true && body.modelSelection === undefined) return json(res, 400, { error: "updateBotDefault requires modelSelection" });
      if (body.resetApprovalToAsk === true && (body.modelSelection === undefined ||
        (body.approvalMode !== undefined && body.approvalMode !== "ask") || body.autoApprove === true)) {
        return json(res, 400, { error: "resetApprovalToAsk requires a model selection and cannot be combined with another approval mode" });
      }
      const patch: Parameters<typeof store.patchTask>[2] = {};
      if (body.projectId !== undefined) {
        if (body.projectId === null) patch.projectId = undefined;
        else if (typeof body.projectId === "string" && store.project(current.id, body.projectId)) patch.projectId = body.projectId;
        else return json(res, 400, { error: "projectId must belong to this bot, or null to ungroup the thread" });
      }
      if (body.title !== undefined) {
        if (typeof body.title !== "string") return json(res, 400, { error: "title must be a string" });
        patch.title = body.title;
      }
      if (body.archivedAt !== undefined) {
        if (body.archivedAt === null) patch.archivedAt = undefined;
        else if (typeof body.archivedAt === "number" && Number.isFinite(body.archivedAt) && body.archivedAt >= 0) patch.archivedAt = body.archivedAt;
        else return json(res, 400, { error: "archivedAt must be a timestamp, or null to unarchive" });
      }
      if (body.surface !== undefined) {
        if (threadBusy(current.id, current.threadId)) return json(res, 409, { error: "Stop this thread before changing its computer destination." });
        // Where this conversation works, chosen from the composer. Null follows
        // the bot's Works on again. Reachability is the turn's to judge.
        if (body.surface === null) patch.surface = undefined;
        else if (parseSurface(body.surface)) patch.surface = parseSurface(body.surface);
        else return json(res, 400, { error: "surface must be cloud, vm, local, browser, or null to follow the bot" });
      }
      if (body.pinnedMessageId !== undefined) {
        if (body.pinnedMessageId === null || body.pinnedMessageId === "") patch.pinnedMessageId = undefined;
        else if (typeof body.pinnedMessageId === "string" && store.messagesFor(current.threadId).some((message) => message.id === body.pinnedMessageId)) patch.pinnedMessageId = body.pinnedMessageId;
        else return json(res, 400, { error: "pinnedMessageId must belong to this thread" });
      }
      if (body.modelSelection !== undefined) {
        if (current.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
        const checked = checkedModelSelection(body.modelSelection, { selection: current.modelSelection, busy: threadBusy(current.id, current.threadId) }, body.requireAvailableModel === true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        patch.modelSelection = checked.selection;
      }
      if (body.approvalMode !== undefined || body.autoApprove !== undefined) {
        if (body.autoApprove !== undefined && typeof body.autoApprove !== "boolean") return json(res, 400, { error: "autoApprove must be a boolean" });
        const mode = body.approvalMode ?? (body.autoApprove ? "auto" : "ask");
        // Elevated modes still require the trusted desktop transition. A
        // thread settings PATCH cannot manufacture that grant.
        if (mode !== "ask" && mode !== "auto" && mode !== "edits") return json(res, 403, { error: "Full and Custom access require trusted desktop confirmation" });
        if (approvalModeFor(current) === "custom") return json(res, 403, { error: "Leaving Custom approval requires confirmation in the packaged desktop app" });
        if (!supportsApprovalMode(registry.cliTarget((patch.modelSelection ?? current.modelSelection).instanceId)?.driverKind, mode)) {
          return json(res, 400, { error: "This provider does not support the selected approval level" });
        }
        if (threadBusy(current.id, current.threadId)) return json(res, 409, { error: "stop this thread before changing its approval mode" });
        if (current.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
        if (mode === "auto" && approvalModeFor(current) !== "auto" && auth.kind === "loopback" && !DESKTOP_MANAGED && !req.headers.origin && store.bots.some((bot) => bot.busy)) {
          return json(res, 409, { error: "Change approval mode from the app or a paired device while bots are working." });
        }
        if (mode === "auto" && current.computer === "local" && approvalModeFor(current) !== "auto" && body.acknowledgeLocalAuto !== true) {
          return json(res, 400, { error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)" });
        }
        patch.approvalMode = mode;
        patch.autoApprove = mode === "auto";
      }
      if (patch.modelSelection) {
        const checked = checkedTaskModelSwitch({ ...current,
          ...(patch.approvalMode ? { approvalMode: patch.approvalMode, autoApprove: patch.autoApprove } : {}),
        }, patch.modelSelection, body.updateBotDefault === true, body.resetApprovalToAsk === true, body.requireAvailableModel === true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
      }
      const task = patch.modelSelection
        ? store.switchTaskModel(m[1], m[2], patch.modelSelection, body.updateBotDefault === true, body.resetApprovalToAsk === true, patch)!
        : store.patchTask(m[1], m[2], patch)!;
      const fresh = botWithThread(store.bot(m[1])!);
      broadcast({ kind: "bot", bot: fresh });
      return json(res, 200, { task: wireTask(task), bot: fresh });
    }
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot || !store.taskByThread(bot.id, m[2])) {
        return json(res, 404, { error: "no such task" });
      }
      if (phoneSecretSubmissions.hasThread(m[2])) {
        return json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
      }
      if (threadBusy(bot.id, m[2]) || routines!.isActiveThread(m[2])) {
        return json(res, 409, { error: "this task is running — stop it first" });
      }
      const stagedSkillCleanups = stagedSkillCleanupsForThread(m[2]);
      roomHandoffs.cancelDirect(m[2], "The source conversation was deleted");
      cancelTeamSetupResumesForThread(m[2]);
      const updated = store.deleteTask(m[1], m[2]);
      if (!updated) return json(res, 404, { error: "no such task" });
      handoffs.forget(m[2]);
      settleDirectFollowup(directTurnGenerationByThread.get(m[2]));
      rejectDeletedThreadSkillStages(stagedSkillCleanups);
      const fresh = botWithThread(updated);
      broadcast({ kind: "bot", bot: fresh });
      return json(res, 200, { bot: fresh });
    }

    // Named team Boxes use real independent ownership, never a hidden bot or
    // an arbitrary provider id. These new routes remain admin-only by default.
    if (path === "/api/team-computers" && method === "GET") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, await teamComputersPayload());
    }
    m = path.match(/^\/api\/team-computers(?:\/([\w-]+)(?:\/(provision|join|sleep|control))?)?$/);
    if (m) {
      const computerId = m[1];
      const action = m[2];
      let found = computerId ? teamComputers.get(computerId) : undefined;
      if (computerId && !found) return json(res, 404, { error: "No such team computer" });
      if (method === "GET" && action === "control" && found) {
        return json(res, 200, computerControl.snapshot(teamComputerOwner(found.id)));
      }
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      const body = await readBody(req);
      found = computerId ? teamComputers.get(computerId) : undefined;
      const assertCurrentOwner = () => {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) throw Object.assign(new Error("Your session ended; sign in again"), { status: 401 });
        if (computerProviderConfigTransitions.has("box")) throw Object.assign(new Error(providerTransitionMessage("box")), { status: 409 });
      };
      assertCurrentOwner();
      if (action === "control" && method === "POST" && found) {
        const parsed = z.object({ action: z.enum(["take", "release"]), controlLeaseId: controlLeaseIdSchema.optional() }).strict().safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Choose take or release with a valid optional controlLeaseId" });
        const key = teamComputerOwner(found.id);
        if (parsed.data.action === "take" && boxLifecycleBusyBots.has(key)) return json(res, 409, { error: "Wait for this computer's action to finish before taking control" });
        if (parsed.data.action === "take") assertTeamControlCanBeTaken(found.id);
        if (parsed.data.controlLeaseId) {
          const result = parsed.data.action === "take"
            ? computerControl.acquireLease(key, parsed.data.controlLeaseId)
            : computerControl.releaseLease(key, parsed.data.controlLeaseId);
          return json(res, 200, { ...result.snapshot, ...result });
        }
        return json(res, 200, parsed.data.action === "take" ? computerControl.take(key) : computerControl.release(key));
      }
      if (method === "PATCH" && found && !action) {
        const parsed = teamComputerAssignment.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Confirm shared desktop access with section and acknowledgeSharedAccess: true" });
        const section = parsed.data.section;
        const checkAssignment = () => {
          assertCurrentOwner();
          if (section !== null && section !== "" && !store.sections.includes(section)) throw Object.assign(new Error("Create the team before assigning a computer"), { status: 404 });
          if (section !== null && store.bots.some(bot => sectionKey(bot.section) === section && (
            botHasActiveTurn(bot.id) || routines?.activeRunForBot(bot.id) || botComputerControlSnapshot(bot.id).held || boxLifecycleBusyBots.has(bot.id)
          ))) throw Object.assign(new Error("Stop the target team's work and release computer control before assigning this computer"), { status: 409 });
        };
        checkAssignment();
        const release = claimTeamComputerLifecycle(found);
        try {
          if (section !== null && !(await box.findBox(cfg, teamComputerOwner(found.id)))) return json(res, 409, { error: "Create or retry this computer before assigning it to a team" });
          checkAssignment();
          if (teamComputerInUse(found)) return json(res, 409, { error: "This team computer became busy; stop its work before assigning it" });
          teamComputers.assign(found.id, section);
          return json(res, 200, { ok: true });
        } finally { release(); }
      }
      if (method === "POST" && !computerId) {
        const parsed = teamComputerCreate.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Provide requestId (UUID), a name, and acknowledgeCost: true to create a paid Box" });
        if (!box.boxConfigured(cfg)) return json(res, 409, { error: "Configure Box in Settings before creating a cloud computer" });
        const computer = teamComputers.create(parsed.data.name, parsed.data.requestId);
        const release = claimTeamComputerLifecycle(computer);
        try {
          await box.provisionBox(cfg, teamComputerOwner(computer.id), computer.name);
          teamComputers.setProblem(computer.id);
          return json(res, 201, { id: computer.id });
        } catch (error) {
          teamComputers.setProblem(computer.id, redactSecretsInText(error instanceof Error ? error.message : String(error)));
          throw error;
        } finally { release(); }
      }
      if (method === "POST" && found && action && action !== "control") {
        if (action === "provision" && body?.acknowledgeCost !== true) return json(res, 400, { error: "Confirm Box creation or wake costs with acknowledgeCost: true" });
        // A ready-only join never wakes, provisions or steals an agent's turn.
        // The caller takes a separate explicit human-control lease first.
        if (action === "join") {
          const key = teamComputerOwner(found.id);
          if (boxLifecycleBusyBots.has(key)) return json(res, 409, { error: "Wait for this computer's action to finish" });
          if (!computerControl.snapshot(key).held) return json(res, 409, { error: "Take control before opening this shared desktop" });
          const release = claimBotComputerLifecycle(key);
          try { return json(res, 200, await box.joinReadyBox(cfg, key)); }
          finally { release(); }
        }
        const release = claimTeamComputerLifecycle(found);
        try {
          const result = action === "provision"
            ? await box.provisionBox(cfg, teamComputerOwner(found.id), found.name)
            : await box.sleepBox(cfg, teamComputerOwner(found.id));
          teamComputers.setProblem(found.id);
          return json(res, 200, result);
        } catch (error) {
          teamComputers.setProblem(found.id, redactSecretsInText(error instanceof Error ? error.message : String(error)));
          throw error;
        } finally { release(); }
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // Account-wide Box inventory is a Settings surface, never a provisioning
    // path. Listing remains read-only; lifecycle changes require explicit
    // JSON actions and are revalidated against a fresh provider listing.
    if (method === "GET" && path === "/api/computers/boxes") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, await box.listManagedBoxes(cfg, managedBoxOwners()));
    }
    m = path.match(/^\/api\/computers\/boxes\/([\w-]+)\/(sleep|delete)$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (computerProviderConfigTransitions.has("box")) {
        return json(res, 409, { error: providerTransitionMessage("box") });
      }
      const releaseInventoryRequest = claimBoxInventoryRequest(m[1]);
      try {
        const owners = managedBoxOwners();
        if (m[2] === "sleep") {
          return json(res, 200, await box.sleepManagedBox(cfg, owners, m[1], claimManagedBoxMutation));
        }
        if (typeof body?.confirmName !== "string" || body.confirmName.length > 100) {
          return json(res, 400, { error: "confirmName must be the cloud computer name shown in Settings" });
        }
        return json(res, 202, await box.deleteManagedBox(
          cfg,
          owners,
          m[1],
          body.confirmName,
          claimManagedBoxMutation,
        ));
      } finally {
        releaseInventoryRequest();
      }
    }
    if (method === "GET" && path === "/api/computers/vps") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, await vps.listManagedVpsComputers(cfg, managedBoxOwners()));
    }
    m = path.match(/^\/api\/computers\/vps\/([\w-]+)\/remove$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (computerProviderConfigTransitions.has("vps")) {
        return json(res, 409, { error: providerTransitionMessage("vps") });
      }
      if (typeof body?.confirmName !== "string" || body.confirmName.length > 100) {
        return json(res, 400, { error: "confirmName must be the VPS computer name shown in Settings" });
      }
      const releaseComputerLifecycle = claimManagedVpsMutation(m[1]);
      try {
        return json(res, 200, await vps.removeManagedVpsComputer(
          cfg,
          managedBoxOwners(),
          m[1],
          body.confirmName,
        ));
      } finally {
        releaseComputerLifecycle();
      }
    }

    // what the user's machine can host: which runtime is installed, whether
    // its daemon is up, and whether the desktop image and container exist
    if (method === "GET" && path === "/api/local-computer") {
      return json(res, 200, await localVmPayload(SHARED_LOCAL_VM_TARGET));
    }
    if (method === "GET" && path === "/api/local-computer/instances") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, await localVmInventoryPayload());
    }
    m = path.match(/^\/api\/local-computer\/(pull|run|start|stop|remove)$/);
    if (m && method === "POST") {
      // Requiring JSON makes these localhost lifecycle mutations non-simple
      // browser requests. A hostile web page cannot submit them with a form,
      // and its cross-origin JSON request is stopped by the browser preflight
      // because this server deliberately emits no CORS permission.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const action = z.enum(["pull", "run", "start", "stop", "remove"]).parse(m[1]);
      if (localVmImageBusy || localVmModeChangeBusy || localVmLifecycleBusy.has(SHARED_LOCAL_VM_TARGET.key)) {
        return json(res, 409, { error: "another Local VM setup action is still running" });
      }
      if (localVmMode(cfg) === "per-bot" && action === "run") {
        return json(res, 409, { error: "Per-bot mode creates each desktop from that bot's Computer panel" });
      }
      const vmOwner = localVmLeaseFor(SHARED_LOCAL_VM_TARGET).current(localVmOwnerBusy);
      if (vmOwner && (action === "stop" || action === "remove" || action === "run")) {
        return json(res, 409, { error: "the Local VM is being used by a bot — stop that turn first" });
      }
      if (action === "pull") localVmImageBusy = true;
      else localVmLifecycleBusy.add(SHARED_LOCAL_VM_TARGET.key);
      try {
        const status = await containerComputerAction(action, undefined, undefined, SHARED_LOCAL_VM_TARGET);
        if (action === "run" || action === "start") localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
        if (action === "stop" || action === "remove") localVmIdleFor(SHARED_LOCAL_VM_TARGET).cancel();
        return json(res, 200, {
          ...status,
          commands: setupCommands(status.runtime, process.platform, SHARED_LOCAL_VM_TARGET),
          idle_timeout_ms: LOCAL_VM_IDLE_MS,
          mode: localVmMode(cfg),
          max_instances: localVmMaxInstances(cfg),
        });
      } finally {
        if (action === "pull") localVmImageBusy = false;
        else localVmLifecycleBusy.delete(SHARED_LOCAL_VM_TARGET.key);
      }
    }
    if (method === "POST" && path === "/api/local-computer/screenshot") {
      localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
      return json(res, 200, {
        image: await containerComputerScreenshot(undefined, undefined, SHARED_LOCAL_VM_TARGET),
      });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer$/);
    if (m && method === "GET") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, await localVmPayload(localVmTargetForBot(bot.id)));
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/(run|stop|remove)$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (boxLifecycleBusyBots.has(bot.id)) {
        return json(res, 409, { error: "this bot's computer is being changed or deleted — wait for it to finish" });
      }
      const action = z.enum(["run", "stop", "remove"]).parse(m[2]);
      const target = localVmTargetForBot(bot.id);
      if (target.key === SHARED_LOCAL_VM_TARGET.key) {
        return json(res, 409, { error: "Shared mode manages this desktop in App Settings → Computers" });
      }
      if (localVmImageBusy || localVmModeChangeBusy || localVmLifecycleBusy.has(target.key)) {
        return json(res, 409, { error: "this bot's Local VM setup action is still running" });
      }
      if (action === "run" && localVmProvisionBusy) {
        return json(res, 409, { error: "another per-bot Local VM is being created — retry after it finishes" });
      }
      const vmOwner = localVmLeaseFor(target).current(localVmOwnerBusy);
      if (vmOwner) return json(res, 409, { error: "this bot is using its Local VM — stop the turn first" });
      // Fence this target, and the cross-target capacity decision for creates,
      // before the first await so two requests cannot both pass the limit.
      localVmLifecycleBusy.add(target.key);
      if (action === "run") localVmProvisionBusy = true;
      try {
        if (action === "run") {
          const before = await containerComputerStatus(undefined, undefined, target);
          if (!before.runtime) return json(res, 409, { error: before.problem ?? "No container runtime is installed" });
          if (!(await containerComputerExists(before.runtime, target))) {
            const count = await existingPerBotLocalVmCount(before.runtime);
            if (count >= localVmMaxInstances(cfg)) {
              return json(res, 409, {
                error: `The per-bot Local VM limit is ${localVmMaxInstances(cfg)} — delete an unused bot VM or raise the limit in App Settings`,
              });
            }
          }
        }
        const status = await containerComputerAction(action, undefined, undefined, target);
        if (action === "run") localVmIdleFor(target).touch();
        if (action === "stop" || action === "remove") localVmIdleFor(target).cancel();
        return json(res, 200, {
          ...status,
          commands: setupCommands(status.runtime, process.platform, target),
          idle_timeout_ms: LOCAL_VM_IDLE_MS,
          mode: localVmMode(cfg),
          max_instances: localVmMaxInstances(cfg),
        });
      } finally {
        if (action === "run") localVmProvisionBusy = false;
        localVmLifecycleBusy.delete(target.key);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/screenshot$/);
    if (m && method === "POST") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (url.searchParams.has("threadId") && await computerPreviewSurface(bot, bot.threadId) !== "vm") {
        return json(res, 409, { error: "This conversation is not using the Local VM" });
      }
      const target = localVmTargetForBot(bot.id);
      localVmIdleFor(target).touch();
      return json(res, 200, {
        image: await containerComputerScreenshot(undefined, undefined, target),
      });
    }

    // identity handshake for the packaged app's port fallback: the forked
    // child proves it is OURS by echoing its pid (a stray dev server has
    // the same API shape but a different pid)
    if (method === "GET" && path === "/api/health") {
      return json(res, 200, { app: "openmausbot", pid: process.pid, static: Boolean(STATIC_DIR) });
    }
    // The bots' browser engine: install it on this machine (agent-browser +
    // a Chrome for Testing, a one-time download), or ask how that is going.
    // One install at a time; the config frame's browserEngine tells the rest.
    if (method === "POST" && path === "/api/browser-engine/install") {
      if (!browserEngineInstall) {
        const status = browserEngineStatus();
        if (status.kind === "unavailable" && !status.installable) return json(res, 409, { error: status.reason });
        browserEngineInstallError = null;
        browserEngineInstall = (async () => {
          const binary = resolveAgentBrowserBinary() ?? await installAgentBrowserBinary({ log: (line) => console.log(line) });
          await ensureChrome(binary, { log: (line) => console.log(line) });
        })().then(
          () => { browserEngineInstallError = null; },
          (error: unknown) => { browserEngineInstallError = error instanceof Error ? error.message : String(error); },
        ).finally(() => {
          browserEngineInstall = null;
          broadcast({ kind: "config", ...configStatus() });
        });
        broadcast({ kind: "config", ...configStatus() });
      }
      return json(res, 202, { installing: true });
    }
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

    // Which edition this server runs and why (see server/enterprise.ts). Read-only.
    if (method === "GET" && path === "/api/edition") {
      return json(res, 200, editionStatus());
    }
    // The brand for this deployment (server/brand.ts): read per request so edits show on reload.
    if (method === "GET" && path === "/api/brand") {
      return json(res, 200, loadBrand());
    }

    // ── inspector: a thread's runtime events + native protocol tee ──
    // Both logs already exist on disk; this only reads them back. Threads
    // belong to bots or rooms — anything else is not a thread we know.
    m = path.match(/^\/api\/threads\/([\w-]+)\/events$/);
    if (m && method === "GET") {
      const threadId = m[1];
      const known =
        store.bots.some((b) => store.tasks(b.id).some((t) => t.threadId === threadId)) ||
        Boolean(store.groupByThread(threadId));
      if (!known) return json(res, 404, { error: "no such thread" });
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        return json(res, 400, { error: "limit must be a positive whole number" });
      }
      const limit = parsedLimit;
      return json(res, 200, readThreadEvents({ eventsDir: EVENTS_DIR, nativeDir: NATIVE_DIR, threadId, limit }));
    }

    if (await handleUsage(req, res, rctx)) return;

    if (await handleInstances(req, res, rctx)) return;

    if (await handleMcp(req, res, rctx)) return;

    if (await handleConfig(req, res, rctx)) return;

    if (await handleTts(req, res, rctx)) return;

    if (await handleConnectors(req, res, rctx)) return;

    // Phone credential entry arrives as an HPKE envelope bound to the exact
    // paired device, bot, task, card and allowlisted target. The companion
    // authenticates the bearer and supplies the device id; only the embedded
    // Electron server has the private key needed to open the envelope.
    m = path.match(/^\/api\/bots\/([\w-]+)\/secret-cards\/([\w-]+)\/provide$/);
    if (m && method === "POST") {
      if (req.headers["x-openmausbot-companion"] !== "1") {
        return json(res, 403, { error: "Secure phone entry must come from a paired phone" });
      }
      const rawDeviceId = req.headers["x-openmausbot-companion-device"];
      const authenticatedDeviceId = Array.isArray(rawDeviceId) ? "" : String(rawDeviceId ?? "");
      if (!/^[\w-]{1,128}$/.test(authenticatedDeviceId)) {
        return json(res, 401, { error: "This paired phone could not be verified" });
      }
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const parsed = phoneSecretEnvelopeSchema.safeParse(await readBody(req, 16_384));
      if (!parsed.success || !isCredentialTargetId(parsed.data?.target)) {
        return json(res, 400, { error: "The encrypted credential request is invalid" });
      }
      const state = await provideSecretFromPhone({
        ...parsed.data,
        botId: m[1],
        messageId: m[2],
        target: parsed.data.target,
      }, authenticatedDeviceId);
      return json(res, 200, state);
    }

    // Desktop credential cards never send the credential through this route.
    // Electron saves it through the OS-backed store first; these actions only
    // verify configured state, update card metadata, and resume the turn.
    m = path.match(/^\/api\/bots\/([\w-]+)\/secret-cards\/([\w-]+)\/(provided|resume|dismiss)$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const threadId = String(body.threadId ?? "");
      const message = secretMessage(m[1], threadId, m[2]);
      if (!message?.secret) return json(res, 404, { error: "no such credential request" });
      if (phoneSecretSubmissions.has(
        phoneSecretSubmissionKey(threadId, message.id, message.secret.requestKey),
      )) {
        return json(res, 409, { error: "this credential is currently being saved from a phone" });
      }
      if (m[3] === "provided") {
        if (message.secret.dismissed) return json(res, 409, { error: "this credential request was dismissed" });
        if (!credentialIsConfigured(cfg, message.secret.target)) {
          return json(res, 409, { error: `${message.secret.label} was not saved yet` });
        }
        if (!resumeSecretCard(m[1], threadId, message.id, "provided")) {
          return json(res, 409, { error: "this credential request is no longer available" });
        }
        const state = currentSecretState(m[1], threadId, message.id);
        if (!state) return json(res, 409, { error: "this credential request is no longer available" });
        return json(res, 200, state);
      }
      if (m[3] === "resume") {
        const outcome = credentialResumeOutcome(message.secret);
        if (!outcome) {
          return json(res, 409, { error: "this credential request is not ready to resume" });
        }
        if (outcome === "provided" && !credentialIsConfigured(cfg, message.secret.target)) {
          return json(res, 409, { error: `${message.secret.label} is no longer configured` });
        }
        if (!resumeSecretCard(m[1], threadId, message.id, outcome)) {
          return json(res, 409, { error: "this credential request is no longer available" });
        }
        const state = currentSecretState(m[1], threadId, message.id);
        if (!state) return json(res, 409, { error: "this credential request is no longer available" });
        return json(res, 200, { resumed: state.resumed });
      }
      if (!message.secret.provided && !resumeSecretCard(m[1], threadId, message.id, "dismissed")) {
        return json(res, 409, { error: "this credential request is no longer available" });
      }
      const state = currentSecretState(m[1], threadId, message.id);
      if (!state) return json(res, 409, { error: "this credential request is no longer available" });
      return json(res, 200, { dismissed: true, resumed: state.resumed });
    }

    // Inline connection cards are bound to both the bot and the exact task
    // or room thread that created them. The browser auth URL is returned
    // only to this local UI and is never stored in the transcript.
    m = path.match(/^\/api\/bots\/([\w-]+)\/connector-cards\/([\w-]+)\/(authorize|status|resume|dismiss)$/);
    if (m) {
      const body = method === "POST" ? await readBody(req) : {};
      const threadId = String(method === "GET" ? url.searchParams.get("threadId") ?? "" : body.threadId ?? "");
      const message = connectorMessage(m[1], threadId, m[2]);
      if (!message?.connector) return json(res, 404, { error: "no such connection request" });
      const connector = message.connector;
      if (m[3] === "authorize" && method === "POST") {
        store.patchMessage(threadId, message.id, {
          connector: { ...connector, status: "authorizing", error: undefined, dismissed: false },
        });
        try {
          return json(res, 200, await composio.authorizeService(cfg, connector.slug, connector.alias));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          store.patchMessage(threadId, message.id, {
            connector: { ...connector, status: "failed", error: detail.slice(0, 180) },
          });
          throw error;
        }
      }
      if (m[3] === "status" && method === "GET") {
        const service = (await composio.connectionStatus(cfg, [connector.slug]))[connector.slug];
        // A different active account must never complete a second-account card.
        // Missing alias metadata stays pending rather than guessing from the
        // toolkit-wide status (including scoped keys without account reads).
        const account = connector.alias
          ? service?.accounts?.find((item) => item.alias?.trim().toLowerCase() === connector.alias!.toLowerCase())
          : undefined;
        const state = connector.alias ? {
          connected: /^active$/i.test(account?.status ?? ""),
          pending: /^(initiated|initializing|pending)$/i.test(account?.status ?? ""),
          status: account?.status ?? "not_connected",
        } : service;
        const failed = /failed|expired|revoked|error/i.test(state?.status ?? "");
        const next = {
          ...connector,
          status: state?.connected ? ("connected" as const) : failed ? ("failed" as const) : ("authorizing" as const),
          error: failed ? `Connection ${state?.status ?? "failed"}` : undefined,
        };
        store.patchMessage(threadId, message.id, { connector: next });
        if (state?.connected) maybeResumeConnectors(m[1], threadId, connector.resumeKey);
        return json(res, 200, { connected: Boolean(state?.connected), pending: Boolean(state?.pending), status: state?.status });
      }
      if (m[3] === "resume" && method === "POST") {
        const resumed = maybeResumeConnectors(m[1], threadId, connector.resumeKey);
        return resumed
          ? json(res, 200, { resumed: true })
          : json(res, 409, { error: "finish connecting every requested app first" });
      }
      if (m[3] === "dismiss" && method === "POST") {
        store.patchMessage(threadId, message.id, { connector: { ...connector, dismissed: true } });
        return json(res, 200, { dismissed: true });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // ── the bot's cloud computer (Box) ──
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer$/);
    if (m && method === "GET") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const surface = url.searchParams.has("threadId") ? await computerPreviewSurface(bot, bot.threadId) : "cloud";
      const computerBackend = computerBackendFor(bot);
      if (surface !== "cloud") return json(res, 200, { surface, configured: false, backend: computerBackend.kind });
      const teamComputer = inheritedTeamComputer(bot);
      if (teamComputer) return json(res, 200, { surface, backend: "box", teamComputer: { id: teamComputer.id, name: teamComputer.name }, ...(await box.boxStatus(cfg, teamComputerOwner(teamComputer.id))) });
      return json(res, 200, { surface, backend: computerBackend.kind, ...(await computerBackend.status(cfg, bot.id)) });
    }
    // Who is driving this bot's computer. GET is the panel's initial read;
    // POST take/release/dismiss-help are the person's three moves. The bot
    // has no verb here at all — its only voice is the internal help plea.
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/control$/);
    if (m) {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (method === "GET") return json(res, 200, botComputerControlSnapshot(bot.id));
      if (method === "POST") {
        // JSON-only for the same anti-form-POST reason as every other
        // computer mutation below.
        if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          return json(res, 415, { error: "content-type must be application/json" });
        }
        const body = await readBody(req);
        const action = String(body.action ?? "");
        const currentBot = store.bot(bot.id);
        if (!currentBot) return json(res, 404, { error: "no such bot" });
        const controlKey = botComputerControlKey(currentBot);
        const teamComputer = inheritedTeamComputer(currentBot);
        if (action === "take" && teamComputer) assertTeamControlCanBeTaken(teamComputer.id);
        const leaseResult =
          body.controlLeaseId === undefined
            ? null
            : controlLeaseIdSchema.safeParse(body.controlLeaseId);
        if (leaseResult && !leaseResult.success) {
          return json(res, 400, { error: "controlLeaseId is invalid" });
        }
        const controlLeaseId = leaseResult?.data;
        if (action === "take" && (boxLifecycleBusyBots.has(bot.id) || boxLifecycleBusyBots.has(controlKey))) {
          return json(res, 409, { error: "this bot's cloud computer is being changed — wait before taking control" });
        }
        if (action === "take" && controlLeaseId) {
          const result = computerControl.acquireLease(controlKey, controlLeaseId);
          return json(res, 200, {
            ...result.snapshot,
            owned: result.owned,
            acquired: result.acquired,
          });
        }
        if (action === "release" && controlLeaseId) {
          const result = computerControl.releaseLease(controlKey, controlLeaseId);
          return json(res, 200, { ...result.snapshot, released: result.released });
        }
        if (action === "take") return json(res, 200, computerControl.take(controlKey));
        if (action === "release") return json(res, 200, computerControl.release(controlKey));
        if (action === "dismiss-help") return json(res, 200, computerControl.dismissHelp(controlKey));
        return json(res, 400, { error: "action must be take, release, or dismiss-help" });
      }
      return json(res, 405, { error: "method not allowed" });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/viewer-close$/);
    if (m && method === "POST") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      return json(res, 200, computerBackendFor(bot).closeViewer(bot.id));
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/(provision|join|sleep|exec|screenshot|remove)$/);
    if (m && method === "POST") {
      const botId = m[1];
      const previewOnly = m[2] === "screenshot" || m[2] === "join";
      const bot = previewOnly ? computerPreviewBot(botId, url) : store.bot(botId);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const threadPreview = previewOnly && url.searchParams.has("threadId");
      if (threadPreview && await computerPreviewSurface(bot, bot.threadId) !== "cloud") {
        return json(res, 409, { error: "This conversation is not using the cloud computer" });
      }
      // Requiring JSON makes every computer mutation a non-simple browser
      // request (same reasoning as the Local VM lifecycle routes above): a
      // hostile page cannot submit it with a form, and its cross-origin JSON
      // request dies in the preflight this server never answers. Applied to
      // both backends — the Box branch runs commands too.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const computerBackend = computerBackendFor(bot);
      const remoteProvider: RemoteComputerProvider = computerBackend.kind;
      if (computerProviderConfigTransitions.has(remoteProvider)) {
        return json(res, 409, { error: providerTransitionMessage(remoteProvider) });
      }
      if (boxLifecycleBusyBots.has(botId)) {
        return json(res, 409, { error: "this bot's cloud computer is being changed — wait for it to finish" });
      }
      const teamComputer = inheritedTeamComputer(bot);
      if (teamComputer) {
        const key = teamComputerOwner(teamComputer.id);
        if (boxLifecycleBusyBots.has(key)) return json(res, 409, { error: "This team computer is being changed; wait for it to finish" });
        if (m[2] === "provision" || m[2] === "remove") return json(res, 409, { error: "Manage this shared computer from the Team map" });
        if (m[2] === "exec") return json(res, 409, { error: "Use the bot's scoped computer tools for this shared desktop" });
        if (m[2] === "join" && !computerControl.snapshot(key).held) return json(res, 409, { error: "Take control before opening this shared desktop" });
        const release = m[2] === "sleep" ? claimTeamComputerLifecycle(teamComputer) : claimBotComputerLifecycle(key);
        try {
          if (m[2] === "join") return json(res, 200, await box.joinReadyBox(cfg, key));
          if (m[2] === "screenshot") return json(res, 200, await box.screenshotBox(cfg, key));
          return json(res, 200, await box.sleepBox(cfg, key));
        } finally { release(); }
      }
      if (computerBackend.kind === "vps") {
        if (m[2] === "screenshot") {
          let preview = vpsPreviewRequests.get(botId);
          if (!preview) {
            preview = computerBackend.screenshot(cfg, botId).finally(() => {
              vpsPreviewRequests.delete(botId);
            });
            vpsPreviewRequests.set(botId, preview);
          }
          return json(res, 200, await preview);
        }
        // Opening the existing SSH viewer can coexist with a capture. Start,
        // stop, remove and Settings deletion still exclude pending previews.
        const releaseComputerLifecycle = claimBotComputerLifecycle(botId, m[2] === "join");
        try {
          if (m[2] === "exec") {
            return json(res, 409, { error: "the VPS console is available to the bot through its scoped computer tools" });
          }
          if (m[2] === "provision" && bot.computer !== "cloud" && !bot.autoStartVps) {
            return json(res, 409, { error: "Auto may start this VPS only after Start VPS automatically is enabled" });
          }
          if ((m[2] === "sleep" || m[2] === "remove") && (bot.busy || activeVpsThreads.has(botId))) {
            return json(res, 409, { error: "the VPS computer is being used by this bot — interrupt the turn first" });
          }
          if (m[2] === "join") {
            return json(res, 200, await computerBackend.join(cfg, botId));
          }
          const action = m[2] === "provision" ? "provision" : m[2] === "remove" ? "remove" : "stop";
          return json(res, 200, await computerBackend.action(cfg, botId, action));
        } finally {
          releaseComputerLifecycle();
        }
      }
      const activeBoxTurn = botHasActiveTurn(botId);
      if (["provision", "sleep"].includes(m[2]) && activeBoxTurn) {
        return json(res, 409, {
          error: CLOUD_COMPUTER_BUSY_ERROR,
        });
      }
      // Input validity is independent of destination authorization. Preserve
      // the stable 400 contract for oversized commands without contacting the
      // provider; a valid Auto request still reaches the 409 gate below.
      let boxCommand: string | undefined;
      if (m[2] === "exec") {
        const body = await readBody(req);
        boxCommand = String(body?.command ?? "");
        if (boxCommand.length > box.MAX_REMOTE_COMMAND_LENGTH) {
          return json(res, 400, {
            error: `command is too long (maximum ${box.MAX_REMOTE_COMMAND_LENGTH} characters)`,
          });
        }
      }
      if (bot.computer !== "cloud" && !threadPreview) {
        return json(res, 409, {
          error: "Choose Cloud before changing or opening this Box. Auto only checks existing computer state.",
        });
      }
      if (m[2] === "remove") {
        // Boxes sleep and wake; only the VPS backend has a container to remove.
        return json(res, 409, { error: "the cloud Box backend has no container to remove — use sleep instead" });
      }
      const releaseComputerLifecycle = claimBotComputerLifecycle(botId);
      try {
        switch (m[2]) {
          case "provision":
            return json(res, 200, await computerBackend.action(cfg, botId, "provision", { botName: bot.name }));
          case "join":
            return json(res, 200, await computerBackend.join(cfg, botId, activeBoxTurn || threadPreview ? "ready" : "wake"));
          case "sleep":
            return json(res, 200, await computerBackend.action(cfg, botId, "sleep"));
          case "exec":
            return json(res, 200, await computerBackend.action(cfg, botId, "exec", { command: boxCommand ?? "" }));
          case "screenshot":
            return json(res, 200, await computerBackend.screenshot(cfg, botId));
        }
      } finally {
        releaseComputerLifecycle();
      }
    }

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    const status = (e as any)?.status ?? 500;
    return json(res, status, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    releaseWorkspaceRequest?.();
  }
};

const server = createServer(handleRequest);

calendarCalls.start();

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
  followupsReady = true;
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
      followupsReady = false;
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

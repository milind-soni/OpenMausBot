// OpenMausBot server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { rm as removeDirectory } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";

import { z } from "zod";
import { SharedComputers } from "./shared-computers.ts";
import { SharedComputerControl } from "./shared-computer-control.ts";
import { RoomHandoffs } from "./room-handoffs.ts";
import { escapeAttribute } from "../shared/attachments.ts";

import {
  BrowserCleanupCoordinator,
  requireBrowserCleanupAcknowledged,
  type BrowserCleanupWireRequest,
} from "./browser-lifecycle-cleanup.ts";
import { appendDecision, flushDecisionLog } from "./decision-log.ts";
import { validateBotCwd } from "./bot-cwd.ts";
import {
  cleanupStaleAttachmentPartials,
} from "./attachments.ts";
import * as box from "./box.ts";
import { TeamComputers } from "./team-computers.ts";
import type { WireGroup } from "../shared/wire.ts";
import { boxCreateRecoverySnapshot } from "./box-create-idempotency.ts";
import { boxDeletionSnapshot } from "./box-delete-journal.ts";
import * as composio from "./composio.ts";
import { canAccessTeam } from "./peer-roster.ts";
import {
  containerComputerAction,
  containerComputerStatus,
  containerRuntimeStatus,
  perBotLocalVmTarget,
  SHARED_LOCAL_VM_TARGET,
  type LocalVmTarget,
} from "./container-computer.ts";
import {
  instanceConfigs,
  loadConfig,
  localVmMode,
  threadEventLogRetentionDays,
  saveConfig,
  sharedComputersEnabled,
  builtInBrowserEnabled,
  vpsSshAlias,
  roomHandoffLimits,
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
import { HOSTED_CONTRACT_HEADER, HOSTED_CONTRACT_METADATA, HOSTED_CONTRACT_VERSION } from "./hosted-contract.ts";
import type { RuntimeEvent } from "./contracts.ts";


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
import { SendSequencer } from "./send-idempotency.ts";
import { EventBus } from "./harness/bus.ts";
import { ManagedDesktopProviders } from "./managed-desktop.ts";
import { cancelPeerApprovalsFor, dismissStalePeerCards, type ApprovalBus } from "./peer-approval.ts";
import { withPeerProvenance } from "./peer-provenance.ts";
import {
  titleFromLlm,
  type BotRecord,
  type GroupDefaultResponder,
  type GroupRecord,
  type Message,
} from "./store.ts";
import { recordHanded } from "./delta-context.ts";
import type { TurnOwner } from "./turn-resources.ts";
import { flushAllMemoryJournals } from "./memory-journal.ts";
import {
  applyStagedSkillWrite,
  getStagedSkillWrite,
  listStagedSkillWrites,
  rejectStagedSkillWrite,
} from "./skills.ts";
import type { SkillRequestCardData } from "../shared/skill-request.ts";
import { discoverExistingPerBotLocalVms, shouldArmLocalVmIdle } from "./local-vm-inventory.ts";

import * as vps from "./vps-computer.ts";
import { createEventsPipeline } from "./events-pipeline.ts";
import { createRoutineLifecycle } from "./routine-lifecycle.ts";
import { createTeamSetupLifecycle } from "./team-setup-lifecycle.ts";
import { createTurnDispatch } from "./turn-dispatch.ts";
import { RoutineManager } from "./routines.ts";
import { CalendarCallManager, type CalendarCall } from "./calendar-calls.ts";
import {
  browserEngineEncryptionKey,
  clearBrowserSessionState,
  browserEngineStatus,
  browserSessionId,
} from "./browser-engine.ts";



import type { TeamSetupRequest } from "../shared/team-setup.ts";
import { flushAllProfileHistory } from "./profile-versions.ts";
import { listenWebhookIngress, type WebhookIngress } from "./webhook-ingress.ts";
import { WebhookManager } from "./webhooks.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { loadBundledSkills, loadUserSkills, mergeSkills } from "./skill-library.ts";
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
import { createComputerLifecycle } from "./computer-lifecycle.ts";
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
  hostedWorkspaceConfiguration,
  hostedWorkspaceConfigured,
  loadEnterpriseLayer,
  type WorkspaceAccess,
} from "./enterprise.ts";
import { environmentDescriptor, serverVersion } from "./environment.ts";
import { createWorkspaceBackupRoutes, isWorkspaceBackupSessionControl } from "./workspace-backup-http.ts";
import { json, readBody } from "./http.ts";
import { createRoutinesRoutes } from "./routes/routines.ts";
import { createInternalRoutes, type AskBotOutcome, type InternalCapability } from "./routes/internal.ts";
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
  activeInternalGenerationByThread,
  computerSelectionTurns,
  internalCapabilities,
  mintInternalCapability,
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
  threadBusy,
  turnComputerResources,
  turnResourceOwners,
  turnResources,
} from "./turn-admission.ts";
import { createProviderFleet } from "./provider-fleet.ts";
import { roomHandoffHandlers } from "./room-handoff-wiring.ts";
import { createTurnCleanup } from "./turn-cleanup.ts";
import { createCustomDomainVerifier, customDomainIpv4, normalizeCustomDomain } from "./custom-domain.ts";
import { allowedScopes, createEmailSignIn, parseAllowList } from "./account-signin.ts";
import { ProviderAuthSessions } from "./provider-auth-sessions.ts";
import {
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
import { cookieMaxAgeSeconds, SessionRegistry } from "./sessions.ts";
import { describeBrand, loadBrand } from "./brand.ts";
import {
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
    localVmProvisionBusy: () => localVmProvisionBusy,
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
    releaseTurnResources, releaseLocalVmThread, startScreenPoller,
    retryDelegationsWaitingOn: (botId) => retryDelegationsWaitingOn(botId),
    drains: { drainQueuedSends: () => drainQueuedSends(), drainConnectorResumes, drainSecretResumes, drainTeamSetupResumes },
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
  drainQueuedSends: () => drainQueuedSends(),
  markTaskContextExternallyUpdated,
  markInternalTurn: (threadId) => markInternalTurn(threadId),
  isUnattended: (botId, threadId) => isUnattended(botId, threadId),
  markUnattended: (botId, threadId) => markUnattended(botId, threadId),
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
    followupsReady: () => followupsReady,
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
      unattendedDispatchState, roomSetupPending, groupIsWorking, startGroupTurn,
      cancelGroupTurnOperations, cancelDirectTurnDispatch, runningTurnInstance,
      reportIncident,
      handoffs,
    },
    state: { groupSpeakers, delegationWatch, pendingDelegationWakes, publicBot, startTurn },
  },
  helpers: {
    interruptAllDirectThreads, activeGroupTurnForBot, fullAccessForSource,
    proposalPersistence, deliverCalendarCall,
  },
  host: {
    routines: () => routines,
    setRoutines: (next) => { routines = next; },
    setCalendarCalls: (next) => { calendarCalls = next; },
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

// ── team setup / profile request cards ──────────────────────────────────
// The ProfileRequestService and TeamSetupRequestService wiring with their
// card resolution/send helpers (including resolveAndSendProfile, which
// physically sat just before the WebhookManager wiring) live in
// ./team-setup-lifecycle.ts; index.ts wires it at profileRequests'
// original site. deleteBotWithLifecycle stays above and crosses by value.
const { profileRequests, teamSetupTeams, teamSetupRequests, resolveAndSendTeamSetup, resolveAndSendProfile } = createTeamSetupLifecycle({
  helpers: {
    fullAccessForSource, proposalPersistence, assertTeamComputerChangeIdle, connectorThread,
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

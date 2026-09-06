// OpenMausBot server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";

import { z } from "zod";
import { botAvatarUrlFromStoredPath } from "../shared/bot-avatar.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import {
  approvalModeFor,
  supportsApprovalMode,
  requiresNativeApproval,
  isEmergencyApprovalDowngrade,
  isApprovalMode,
  type ApprovalMode,
} from "../shared/approval-mode.ts";
import { escapeAttribute } from "../src/lib/composer-attachments.ts";
import {
  CREDENTIAL_TARGETS,
  credentialResumeOutcome,
  credentialIsConfigured,
  isReusableCredentialRequest,
  isCredentialTargetId,
  type CredentialTargetId,
} from "../shared/credential-request.ts";

import { approvalHeldReason, approvalModeForOrigin, autoVerdict, rememberableApprovalKey } from "./auto-approve.ts";
import { requestReview, resolveAutoReviewMode, shouldReview } from "./auto-review.ts";
import { updateClaudeCli } from "./claude-update.ts";
import {
  BrowserCleanupCoordinator,
  finalizeBrowserCleanupMutation,
  requireBrowserCleanupAcknowledged,
  type BrowserCleanupRequest,
  type BrowserCleanupWireRequest,
} from "./browser-lifecycle-cleanup.ts";
import * as checkpoints from "./checkpoints.ts";
import { appendDecision, readDecisions } from "./decision-log.ts";
import { validateBotCwd } from "./bot-cwd.ts";
import {
  ATTACHMENTS_DIR,
  attachmentExists,
  extensionForMime,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  readAttachment,
  saveFile,
  saveImage,
  saveImageUpload,
  type SavedAttachment,
  validateAttachmentUploadId,
} from "./attachments.ts";
import {
  messageFileDisposition,
  messageFileDownloadName,
  messageAttachmentName,
  messageFileRoots,
  messageImageTargetAt,
  messageReferencesFile,
  openMessageFile,
} from "./message-file.ts";
import {
  avatarGenerationRequestSchema,
  avatarGenerationStateMatches,
  generateAvatarImage,
  snapshotAvatarGenerationState,
} from "./avatar-image.ts";
import { fitsOnOneLine, parseBotProfilePatch } from "./bot-profile.ts";
import { groupTurnCwd } from "./room-cwd.ts";
import { RoomTurnDeadline, RoomTurnStallRegistry, roomTurnTimeoutMessage } from "./room-turn-timeout.ts";
import * as box from "./box.ts";
import { boxCreateRecoverySnapshot, retireDeletedBoxCreate } from "./box-create-idempotency.ts";
import {
  boxAccountResourceChangeError,
  cloudBackendChangeError,
  vpsAliasResourceChangeError,
} from "./cloud-backend.ts";
import * as composio from "./composio.ts";
import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import { peerAllowed, peerName, peerRosterSystemPrompt, reachablePeers, roomPeerRosterSystemPrompt, roomRosterLine } from "./peer-roster.ts";
import { openMausStatusSystemPrompt } from "./openmaus-status-capsule.ts";
import {
  containerComputerAction,
  containerComputerExists,
  containerComputerFrame,
  containerComputerMcp,
  containerComputerScreenshot,
  containerComputerStatus,
  containerRuntimeStatus,
  localVmRecreatableOnDemand,
  perBotLocalVmTarget,
  SHARED_LOCAL_VM_TARGET,
  setupCommands,
  type LocalVmTarget,
  type Runtime,
} from "./container-computer.ts";
import {
  ensureDirs,
  instanceConfigs,
  loadConfig,
  localVmMaxInstances,
  localVmMode,
  parseConfigPatch,
  roomTurnTimeoutMinutes,
  saveConfig,
  showToolCallsEnabled,
  skillRecorderEnabled,
  builtInBrowserEnabled,
  browserProfileReplacementConflict,
  browserProfilePartitionTarget,
  syncCredentialEnv,
  withInstanceCli,
  vpsSshAlias,
  DATA_DIR,
  EVENTS_DIR,
  NATIVE_DIR,
  customMcpServers,
} from "./config.ts";
import { ComputerControl } from "./computer-control.ts";
import { MAX_REMOTE_COMMAND_LENGTH } from "./remote-computer.ts";
import { augmentedPath, findCliCandidates, resetPathCache } from "./env-path.ts";
import { describeSpawnFailure, execCli } from "./procs.ts";
import { blockedTarget, buildNotification, type Notification } from "./notify.ts";
import {
  isEffortLevel,
  type ModelSelection,
  type ProviderInstance,
  type RequestOutcome,
  type RuntimeEvent,
  newId,
} from "./contracts.ts";
import { RETRY_MAX_ATTEMPTS } from "./drivers/retry.ts";
import { decodeGeneratedImage } from "./generated-image.ts";
import {
  MAX_MCP_SERVERS,
  listMcpServers,
  parseMcpServerMutation,
  parseStoredMcpServer,
} from "./mcp-registry.ts";
import { probeMcpServer } from "./mcp-probe.ts";
import {
  GROUP_GOAL_MAX_TURNS,
  groupGoalAssignmentKey,
  groupGoalCompletionTurnId,
  groupGoalCoordinatorInstructions,
  groupGoalWorkerInstructions,
  parseGroupGoalDecision,
  resolveGroupGoalMember,
  selectGroupGoalCoordinator,
  type GoalRunMember,
} from "./group-goal-run.ts";
import type { GroupGoalRunCardData, GroupGoalRunStatus } from "../shared/group-goal-run.ts";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { getOrCreateChannel, mirrorActivity, mirrorExchange, mirrorReply, type CommsBus } from "./comms-visibility.ts";
import { readMessageText, recallMessages, searchMessages } from "./message-db.ts";

/** A session_read answer competes with the transcript for the context
 * window; a computer-use turn's output can run to hundreds of KB. */
const SESSION_READ_MAX_CHARS = 8_000;
import { promptWithReply, transcriptText } from "./replies.ts";
import { _loadPending, buildDelegationFailurePrompt, buildDelegationRevivalPrompt, DelegationWakeBudget, discardDelegations, drainDelegations, findDelegationReceipt, pendingDelegationInfo, pendingDelegationSnapshot, pendingThreads, queueDelegation, recordDelegationReceipt, releaseDelegationsWaitingOn, summarizeDelegatedActivity, type QueueResult } from "./delegations.ts";
import {
  cancelSteeredMessage,
  drainSteeredMessages,
  queuedSteeredMessage,
  queueSteeredMessage,
} from "./steer-queue.ts";
import {
  cancelChannelMessage,
  drainChannelMessages,
  queuedChannelMessage,
  queueChannelMessage,
} from "./channel-queue.ts";
import {
  acceptedSendMatch,
  parseSendId,
  sendFingerprint,
  SendSequencer,
} from "./send-idempotency.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { cancelPeerApprovalsFor, cancelPeerApprovalsForThread, dismissStalePeerCards, requestPeerApproval, resolvePeerComms, type ApprovalBus } from "./peer-approval.ts";
import { peerProvenanceNote, withPeerProvenance } from "./peer-provenance.ts";
import { decideRoomPost, emptyRoomPostBudget, type RoomPostAttempt, type RoomPostBudget } from "./room-post-budget.ts";
import {
  mentionedBots,
  roomResponders,
  sectionKey,
  Store,
  type BotRecord,
  type GroupDefaultResponder,
  type GroupRecord,
  type Message,
  type TaskRecord,
} from "./store.ts";
import * as tts from "./tts/index.ts";
import { narrateTool, toUtterances } from "./tts/speech-text.ts";
import { buildTurnContext, engineIsFresh } from "./turn-context.ts";
import { extractTurnImages } from "./turn-images.ts";
import { TurnWatchdog } from "./turn-watchdog.ts";
import {
  ensureWorkspace,
  listMemoryTopics,
  isMemoryTopicName,
  memorySystemPrompt,
  SESSION_SEARCH_SYSTEM_PROMPT,
  workspaceDir,
} from "./workspace.ts";
import {
  readMemoryFile,
  readMemoryTopic,
  writeMemoryFile,
  MEMORY_FILE_MAX_BYTES,
} from "./workspace.ts";
import {
  readSectionContext,
  sectionContextKey,
  sectionContextLabel,
  sectionContextSystemPrompt,
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
  skillsSystemPrompt,
  stageSkillWrite,
} from "./skills.ts";
import { fetchSkillFromSource } from "./skill-fetch.ts";
import { expandLearnTurnText, learnSource } from "./skill-learn.ts";
import { expandSetupTurnText, setupModeActive, setupSystemPrompt } from "./setup-mode.ts";
import type { SkillRequestCardData } from "../shared/skill-request.ts";
import { checkSoulDrift, readSoulDrift, soulFile, writeSoulMirror } from "./bot-folder.ts";
import {
  buildSystemPrompt,
  computerPrompt,
  mentionPrompt,
  COMPOSIO_PROMPT,
  CREDENTIAL_PROMPT,
  LEARN_PROMPT,
  PROFILE_PROMPT,
  ROUTINE_PROMPT,
  WEBHOOK_PROMPT,
  type ComputerPromptKind,
} from "./system-prompt.ts";
import { readCuaConnection } from "./local-computer.ts";
import {
  discoverExistingPerBotLocalVms,
  localVmInventoryEntry,
  shouldArmLocalVmIdle,
} from "./local-vm-inventory.ts";
import { LocalVmIdleTimer } from "./local-vm-idle.ts";
import { LocalVmLease, LocalVmLeasePool } from "./local-vm-lease.ts";
import { RepeatDetector, callKey } from "./repeat-detector.ts";
import { redactSecretsInText } from "./redact.ts";
import * as vps from "./vps-computer.ts";
import { RoutineManager, type RoutineRun, type RoutineRunOn, type RoutineRunTrigger } from "./routines.ts";
import { CalendarCallManager, type CalendarCall } from "./calendar-calls.ts";
import { BUILT_IN_BROWSER_SYSTEM_PROMPT } from "./browser-engine.ts";
import {
  agentBrowserIntegration,
  browserEngineEncryptionKey,
  clearBrowserSessionState,
  ensureChrome,
  installAgentBrowserBinary,
  resolveAgentBrowserBinary,
  browserEngineStatus,
  browserSessionId,
  describeBrowserEngine,
} from "./browser-engine.ts";
import { captureOutsideHumanControl } from "./private-screen-capture.ts";
import { screenFrameHash, screenTouchingTool, settledFrameIsNews } from "./screen-frame-gate.ts";
import { RoutineRequestService } from "./routine-requests.ts";
import { buildBotOverview, type BotOverview, connectedAppsFacts } from "./bot-overview.ts";
import { ProfileRequestService } from "./profile-requests.ts";
import { profileRevision, profileSnapshot } from "./profile-revision.ts";
import { flushAllProfileHistory, flushProfileHistory, readHistory, recordProfileChange } from "./profile-versions.ts";
import { fetchBotDirectory, matchDirectoryBots, type MatchedDirectoryBot } from "./bot-directory.ts";
import { scoutProject, suggestTeam } from "./project-scout.ts";
import { fetchGithubTeam, fetchLibraryTeam, fetchTeamCatalog } from "./team-library.ts";
import { isBotPackage, packageAgentAsMember, parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";
import { createTeamManifest, importedMemberProfile, parseTeamManifest } from "./team-manifest.ts";
import { readThreadEvents } from "./thread-events.ts";
import { listenWebhookIngress, webhookCredential, type WebhookIngress } from "./webhook-ingress.ts";
import { memberTurnSelection } from "./member-turn.ts";
import { WebhookManager } from "./webhooks.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { loadBundledSkills, loadUserSkills, mergeSkills, renderSkillInstructions, selectBundledSkills } from "./skill-library.ts";
import { installedPlaybookInstructions } from "./installed-playbooks.ts";
import { createBotPackageExport } from "./package-export.ts";
import { createTeamBackup, importTeamBackup } from "./team-backup.ts";
import { MAX_TEAM_BACKUP_BYTES } from "../shared/team-backup.ts";
import { shouldMountLocalComputer } from "./local-routing.ts";
import { resolveSurface } from "./surface.ts";
import {
  PendingTurnCancellations,
  ProviderTurnGenerationRegistry,
  RetiredTurnRegistry,
  guardTurnDispatch,
  isTurnEventQuarantined,
} from "./turn-dispatch-guard.ts";
import { createGracefulShutdown } from "./graceful-shutdown.ts";
import { acquireDataDirLeaseForProcess } from "./data-dir-lease.ts";
import { describeEdition, editionStatus, loadEnterpriseLayer } from "./enterprise.ts";
import { environmentDescriptor, loadEnvironmentId } from "./environment.ts";
import {
  clearSessionCookie,
  clientBotPatchViolation,
  clientGroupPatchViolation,
  labelFromUserAgent,
  requestOrigin,
  requestSource,
  resolveRequestAuth,
  serializeSessionCookie,
  sessionCookieName,
} from "./request-auth.ts";
import { formatPairingCode, SESSION_TTL_MS, SessionRegistry, type Scope } from "./sessions.ts";
import { describeBrand, loadBrand } from "./brand.ts";
import {
  PHONE_SECRET_PROTOCOL_VERSION,
  PhoneSecretBridge,
  PhoneSecretError,
  PhoneSecretSubmissionRegistry,
  assertPhoneSecretRequestMatches,
  phoneSecretOperationId,
  type PhoneSecretContext,
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

ensureDirs();
// The desktop parent owns the primary lease and delegates one private child
// claim; a standalone/headless server owns the primary lease itself. Acquire
// before any durable identity, sessions, config, or Store state is loaded.
const dataDirLease = acquireDataDirLeaseForProcess(DATA_DIR);
let dataDirLeaseReleaseAttempted = false;
function releaseDataDirLeaseAtExit(): void {
  if (dataDirLeaseReleaseAttempted) return;
  dataDirLeaseReleaseAttempted = true;
  try {
    dataDirLease.release();
  } catch (error) {
    // A failed release deliberately leaves a stale, owner-token-protected
    // lease. The next process can recover it only after this PID is dead.
    console.error(`[data-directory] lease release failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.once("exit", releaseDataDirLeaseAtExit);
// Only after ensureDirs(): it performs the one-time rename of the legacy data
// dir, which must not find a freshly created ~/.openmausbot already there.
// Remote clients (server/request-auth.ts, server/sessions.ts): a stable identity
// for this server, the paired sessions, and the cookie the served UI uses.
const ENVIRONMENT_ID = loadEnvironmentId(DATA_DIR);
const sessions = new SessionRegistry({ file: join(DATA_DIR, "sessions.json") });
const SESSION_COOKIE = sessionCookieName(PORT, ENVIRONMENT_ID);
const DESKTOP_MANAGED = process.env.OMB_DESKTOP_PARENT === "1";
// Empty is deliberately a deny-all bootstrap state. Only Electron's private
// utility-process port can replace it with the per-launch owner capability.
let desktopMutationToken: string | undefined = DESKTOP_MANAGED ? "" : undefined;
let companionMutationToken: string | undefined = DESKTOP_MANAGED ? "" : undefined;
// Where remote clients reach this server (a proxy's public address); pairing URLs use it.
const PUBLIC_URL = process.env.OMB_PUBLIC_URL?.trim().replace(/\/+$/, "") || null;
const cfg = loadConfig();
const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
await registry.load(instanceConfigs(cfg));
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
  type: "approval-trusted-mode-result";
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
    // Best effort, never a reason to keep a deleted bot or profile around:
    // the engine's saved state is a per-session file set, and an engine that
    // cannot run here (or was never installed) has nothing to clear. A real
    // failure is logged with the session name so it can be cleared by hand.
    const work = status.kind === "ready" && sessions.length
      ? Promise.all(sessions.map(async (session) => {
          const ok = await clearBrowserSessionState(status.binaryPath, session, { encryptionKey: browserEngineEncryptionKey() });
          if (!ok) console.warn(`browser cleanup: could not clear the engine's saved state for session ${session}; clear it with \`agent-browser --session ${session} state clear --all\``);
          return ok;
        }))
      : Promise.resolve([true]);
    void work.finally(() => {
      browserCleanup.receive({ type: "openmausbot:browser-lifecycle-result", requestId: request.requestId, ok: true });
    });
    return true;
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

// ── peer-agent comms wiring ────────────────────────────────────────────
// Every mounted proxy receives a fresh, turn-scoped capability for localhost
// /api/internal calls. Identity, source thread, recursion depth and route
// family all come from this server-side record; caller fields are assertions,
// never authority. Full mode can inspect its own MCP environment, so a shared
// or reusable boot token would let one bot impersonate another later.
type InternalCapability = {
  botId: string;
  threadId: string;
  generation: string;
  depth: number;
  kind: "agents" | "connectors" | "computer";
  skillAuthoring: boolean;
  createdBots: number;
  orphanExpiresAt: number;
};
// A capability lives for the exact provider-turn generation, including while
// that turn is parked on a human approval. The long ceiling is only an orphan
// backstop for an impossible-to-settle adapter; normal terminal paths revoke
// synchronously and app restart destroys this in-memory set.
const INTERNAL_CAPABILITY_ORPHAN_MS = 30 * 24 * 60 * 60_000;
const internalCapabilities = new Map<string, InternalCapability>();
const activeInternalGenerationByThread = new Map<string, string>();
const internalGenerationByProviderTurn = new ProviderTurnGenerationRegistry();

function beginInternalCapabilityGeneration(threadId: string, generation = randomUUID()): string {
  const previous = activeInternalGenerationByThread.get(threadId);
  if (previous) revokeInternalCapabilityGeneration(threadId, previous);
  activeInternalGenerationByThread.set(threadId, generation);
  return generation;
}

function mintInternalCapability(capability: Omit<InternalCapability, "orphanExpiresAt">): string {
  if (activeInternalGenerationByThread.get(capability.threadId) !== capability.generation) {
    throw new Error("cannot mint an integration capability for an inactive turn");
  }
  const token = randomBytes(24).toString("hex");
  internalCapabilities.set(token, {
    ...capability,
    orphanExpiresAt: Date.now() + INTERNAL_CAPABILITY_ORPHAN_MS,
  });
  return token;
}

function revokeInternalCapabilityGeneration(threadId: string, generation: string): void {
  for (const [token, capability] of internalCapabilities) {
    if (capability.threadId === threadId && capability.generation === generation) {
      internalCapabilities.delete(token);
    }
  }
  if (activeInternalGenerationByThread.get(threadId) === generation) {
    activeInternalGenerationByThread.delete(threadId);
  }
  internalGenerationByProviderTurn.deleteGeneration(threadId, generation);
}

function revokeInternalCapabilitiesForThread(threadId: string): void {
  const generation = activeInternalGenerationByThread.get(threadId);
  if (generation) revokeInternalCapabilityGeneration(threadId, generation);
  // Defensive cleanup for any generation orphaned before exact ownership was
  // introduced. This force variant is used only by explicit stop/delete and
  // before a brand-new generation is published, never by a stale async catch.
  for (const [token, capability] of internalCapabilities) {
    if (capability.threadId === threadId) internalCapabilities.delete(token);
  }
}

function revokeAllInternalCapabilities(): void {
  internalCapabilities.clear();
  activeInternalGenerationByThread.clear();
  internalGenerationByProviderTurn.clear();
}

function bindInternalCapabilityToProviderTurn(threadId: string, generation: string, turnId?: string): void {
  if (turnId && !internalGenerationByProviderTurn.bind(threadId, generation, turnId)) {
    revokeInternalCapabilityGeneration(threadId, generation);
  }
}

function revokeInternalCapabilityForProviderEvent(event: RuntimeEvent): void {
  if (!event.turnId) return;
  const owner = internalGenerationByProviderTurn.complete(event.threadId, event.turnId);
  if (!owner) return;
  revokeInternalCapabilityGeneration(owner.threadId, owner.generation);
}

/** Resolve a high-entropy bearer to its immutable server-side claims.
 * Constant-time comparisons keep the check independent of matching prefix
 * length; only capabilities for currently active turns are retained. */
function authorizedInternalCapability(header: string | string[] | undefined): InternalCapability | null {
  const got = Buffer.from(Array.isArray(header) ? "" : (header ?? ""));
  const now = Date.now();
  for (const [token, capability] of internalCapabilities) {
    if (
      capability.orphanExpiresAt <= now ||
      activeInternalGenerationByThread.get(capability.threadId) !== capability.generation
    ) {
      internalCapabilities.delete(token);
      continue;
    }
    const expected = Buffer.from(`Bearer ${token}`);
    if (got.length === expected.length && timingSafeEqual(got, expected)) return capability;
  }
  return null;
}

function internalCapabilityIsActive(capability: InternalCapability): boolean {
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
  botIds: z.array(z.string().regex(/^[\w-]+$/)).min(1).max(MAX_WORKSPACE_BOTS),
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
) {
  const token = mintInternalCapability({
    botId,
    threadId,
    generation,
    depth,
    kind: "agents",
    skillAuthoring,
    createdBots: 0,
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
      OMB_SKILL_AUTHORING_ENABLED: skillAuthoring ? "1" : "0",
    },
  };
}


type DirectTurnDispatchClaim = {
  id: string;
  threadId: string;
  phase: "setup" | "dispatching";
};
class DirectTurnSetupCancelled extends Error {}
const directTurnDispatchClaims = new Map<string, DirectTurnDispatchClaim>();
const directTurnGenerationByBot = new Map<string, string>();
const retiredProviderTurns = new RetiredTurnRegistry();
const pendingCancelledProviderHandshakes = new PendingTurnCancellations();
const generatedImagesByTurn = new Map<
  string,
  Array<NonNullable<Message["attachments"]>[number]>
>();

function generatedImageTurnKey(threadId: string, turnId?: string): string {
  return `${threadId}:${turnId ?? "active"}`;
}

function purgeGeneratedImagesForThread(threadId: string): void {
  for (const [key, attachments] of generatedImagesByTurn) {
    if (!key.startsWith(`${threadId}:`)) continue;
    generatedImagesByTurn.delete(key);
    for (const attachment of attachments) {
      try { unlinkSync(attachment.path); } catch {}
    }
  }
}

function markCancelledProviderHandshake(threadId: string, ownerId: string): void {
  pendingCancelledProviderHandshakes.mark(threadId, ownerId);
}

function clearCancelledProviderHandshake(threadId: string, ownerId: string): void {
  pendingCancelledProviderHandshakes.clear(threadId, ownerId);
}

function retireProviderTurn(turnId: string): void {
  retiredProviderTurns.retire(turnId);
  // A stopped/replaced turn is never folded again. Delete only image files
  // that were staged for that exact provider turn so unattached output does
  // not accumulate invisibly on disk.
  for (const [key, attachments] of generatedImagesByTurn) {
    if (!key.endsWith(`:${turnId}`)) continue;
    generatedImagesByTurn.delete(key);
    for (const attachment of attachments) {
      try { unlinkSync(attachment.path); } catch {}
    }
  }
}

function shouldIgnoreProviderEvent(event: RuntimeEvent): boolean {
  // Some adapters publish completion/error synchronously just before their
  // sendTurn promise resolves. Stop can already have cancelled that handshake,
  // but its returned turn id is not available to retire yet. Quarantine the
  // narrow pre-id window and tombstone any id it reveals; the broad gate is
  // time-bounded so a broken promise cannot suppress a later turn forever.
  if (isTurnEventQuarantined(pendingCancelledProviderHandshakes, retiredProviderTurns, event)) return true;
  if (event.type !== "session.exited" || event.turnId !== undefined) return false;
  return store.botByThread(event.threadId)?.busy === true || Boolean(store.groupByThread(event.threadId)?.busyBotId);
}

function directTurnClaimIsCurrent(botId: string, claimId: string, threadId: string): boolean {
  const claim = directTurnDispatchClaims.get(botId);
  const bot = store.bot(botId);
  return claim?.id === claimId && claim.threadId === threadId && bot?.busy === true;
}

function directTurnClaimExists(botId: string, claimId: string, threadId: string): boolean {
  const claim = directTurnDispatchClaims.get(botId);
  return claim?.id === claimId && claim.threadId === threadId;
}

function markDirectTurnDispatching(botId: string, claimId: string, threadId: string): boolean {
  if (!directTurnClaimIsCurrent(botId, claimId, threadId)) return false;
  directTurnDispatchClaims.set(botId, { id: claimId, threadId, phase: "dispatching" });
  return true;
}

function clearDirectTurnDispatch(botId: string, claimId: string): void {
  if (directTurnDispatchClaims.get(botId)?.id === claimId) directTurnDispatchClaims.delete(botId);
}

function cancelDirectTurnDispatch(botId: string, expectedThreadId?: string): DirectTurnDispatchClaim | null {
  const claim = directTurnDispatchClaims.get(botId);
  if (!claim || (expectedThreadId !== undefined && claim.threadId !== expectedThreadId)) return null;
  directTurnDispatchClaims.delete(botId);
  // Setup has not called the adapter yet, so there is no provider handshake
  // (and no unknown turn id) to quarantine. Dispatching is the only phase in
  // which a late provider event can exist.
  if (claim.phase === "dispatching") {
    markCancelledProviderHandshake(claim.threadId, `direct:${claim.id}`);
  }
  // Keep setup ownership until the guarded send resolves and retires its
  // provider turn id. Some adapters can emit completion synchronously just
  // before sendTurn returns; making the bot idle here would let a replacement
  // start early enough for those old events to settle the replacement.
  return claim;
}

/** The bot's browser for this turn: agent-browser, one isolated session per
 * browser profile or per bot (docs/plans/browser-engine.md). Null, with the
 * reason logged once, when the engine is not on this machine. */
function browserIntegration(botId: string, profile: string | undefined) {
  const status = browserEngineStatus();
  if (status.kind !== "ready") {
    if (!engineUnavailableLogged) {
      engineUnavailableLogged = true;
      console.warn(`${describeBrowserEngine(status)}; bots get no browser tools until it is installed`);
    }
    return null;
  }
  // A profile that no longer exists falls back to the bot's own session.
  const profileTarget = profile && profile !== "guest" ? browserProfilePartitionTarget(cfg, profile) : null;
  const partitionId = profile === "guest" ? "guest" : (profileTarget?.partitionId ?? "");
  const session = browserSessionId(botId, partitionId);
  return {
    profile: partitionId,
    integration: agentBrowserIntegration({
      binaryPath: status.binaryPath,
      session,
      encryptionKey: browserEngineEncryptionKey(),
      persistent: profile !== "guest",
    }),
  };
}
let engineUnavailableLogged = false;

let browserEngineInstall: Promise<void> | null = null;
let browserEngineInstallError: string | null = null;
export function browserEngineSummary(): { kind: "engine" | "unavailable"; reason?: string; installable?: boolean; version?: string; installing?: boolean; installError?: string } {
  const status = browserEngineStatus();
  const progress = { ...(browserEngineInstall ? { installing: true } : {}), ...(browserEngineInstallError ? { installError: browserEngineInstallError } : {}) };
  return status.kind === "ready"
    ? { kind: "engine", version: status.version, ...progress }
    : { kind: "unavailable", reason: status.reason, installable: status.installable, ...progress };
}

function phoneIntegration() {
  const env: Record<string, string> = { ...AGENTS_NODE_FLAG };
  if (process.env.OMB_ADB_PATH) env.OMB_ADB_PATH = process.env.OMB_ADB_PATH;
  if (process.env.OMB_RESOURCES_PATH) env.OMB_RESOURCES_PATH = process.env.OMB_RESOURCES_PATH;
  if (process.env.PH_ANDROID_SERIAL) env.PH_ANDROID_SERIAL = process.env.PH_ANDROID_SERIAL;
  return { command: process.execPath, args: [phoneProxyPath], env };
}

function connectedAppsIntegration(botId: string, threadId: string, generation: string) {
  const token = mintInternalCapability({
    botId,
    threadId,
    generation,
    depth: 0,
    kind: "connectors",
    skillAuthoring: false,
    createdBots: 0,
  });
  return composio.mcpIntegration(cfg, {
    harnessUrl: `http://127.0.0.1:${PORT}`,
    commsToken: token,
    botId,
    threadId,
  });
}

// ── computer control (who is driving) ──────────────────────────────────
// The person can take the wheel of a bot's computer from the panel; while
// they hold it, the bot's computer proxies refuse every action. The record
// lives here; the proxies consult it over loopback with the boot token.
const computerControlRevision = new Map<string, number>();
const computerControl = new ComputerControl((botId, snapshot) => {
  computerControlRevision.set(botId, (computerControlRevision.get(botId) ?? 0) + 1);
  // One-way, fail-closed mirror into the Electron process that owns the
  // native browser. Never send release: a loopback caller can influence the
  // server record, while only the trusted Browser panel may clear Electron's
  // local gate after its server-first release succeeds.
  if (snapshot.held && /^[A-Za-z0-9_-]{1,120}$/.test(botId)) {
    postDesktopPrivateMessage({ type: "openmausbot:browser-control", botId, held: true });
  }
  broadcast({ kind: "computer-control", botId, held: snapshot.held, helpReason: snapshot.helpReason });
});
const controlLeaseIdSchema = z.string().min(16).max(120).regex(/^[A-Za-z0-9_-]+$/);
const routineRequestSourceSchema = {
  fromBotId: z.string().min(1).max(128),
  fromThreadId: z.string().min(1).max(128),
};
const routineRequestEnvelopeSchema = z.discriminatedUnion("action", [
  z.object({ ...routineRequestSourceSchema, action: z.literal("create"), routine: z.unknown(), forBotId: z.unknown().optional() }).strict(),
  z.object({
    ...routineRequestSourceSchema,
    action: z.literal("update"),
    routineId: z.unknown(),
    changes: z.unknown(),
  }).strict(),
  ...(["pause", "resume", "run_now", "delete"] as const).map((action) =>
    z.object({ ...routineRequestSourceSchema, action: z.literal(action), routineId: z.unknown() }).strict()
  ),
]);

/** The loopback endpoint a bot's computer proxy polls before acting. */
function controlIntegration(botId: string, threadId: string, generation: string) {
  return {
    url: `http://127.0.0.1:${PORT}/api/internal/computer-control?botId=${encodeURIComponent(botId)}`,
    token: mintInternalCapability({
      botId,
      threadId,
      generation,
      depth: 0,
      kind: "computer",
      skillAuthoring: false,
      createdBots: 0,
    }),
  };
}

/** Run a turn on `targetBotId` and resolve with its assistant text — the
 * synchronous half of ask_bot. Subscribes to the bus, folds assistant_text
 * for that thread, resolves on turn.completed (or a 4-min ceiling). */
type AskBotOutcome = {
  status: "reply" | "failed" | "timeout" | "error";
  text: string;
  /** Provider's stop reason when the turn completed not-ok. */
  stopReason?: string | null;
};

function askBotAndWait(targetBotId: string, message: string, depth: number, fromBotId?: string): Promise<AskBotOutcome> {
  const target = store.bot(targetBotId);
  if (!target) return Promise.resolve({ status: "error", text: "(no such bot)" });
  const threadId = target.threadId;
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
    const unattended = isUnattended(fromBotId);
    startTurn(targetBotId, message, {
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

// default selection for new bots: first available instance, claude preferred
async function defaultSelection() {
  const described = await registry.describe();
  const available = described.filter((d) => d.snapshot.state === "available");
  // Deliberately NO fallback to described[0]. Handing a bot an engine whose
  // CLI isn't installed makes it look ready and then fail on send with a raw
  // spawn ENOENT — the single worst first-run experience, and the one every
  // user with no CLIs used to get. An empty selection is honest: the UI shows
  // the setup path instead of a bot that cannot answer.
  const pick = available.find((d) => d.driverKind === "claudeAgent") ?? available[0];
  return { instanceId: pick?.instanceId ?? "", model: pick?.models.default ?? "" };
}

function checkedModelSelection(
  raw: unknown,
  current?: { selection: ModelSelection; busy: boolean },
  requireAvailableModel = false,
): { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "modelSelection must be an object" };
  }
  const value = raw as { instanceId?: unknown; model?: unknown; effort?: unknown };
  if (typeof value.instanceId !== "string" || !value.instanceId.trim()) {
    return { ok: false, status: 400, error: "modelSelection.instanceId is required" };
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    return { ok: false, status: 400, error: "modelSelection.model is required" };
  }
  const selection: ModelSelection = {
    instanceId: value.instanceId.trim(),
    model: value.model.trim(),
  };
  if (value.effort !== undefined) {
    if (!isEffortLevel(value.effort)) {
      return { ok: false, status: 400, error: `effort "${String(value.effort)}" is not recognized` };
    }
    selection.effort = value.effort;
  }
  const changed = current && (
    selection.instanceId !== current.selection.instanceId ||
    selection.model !== current.selection.model ||
    selection.effort !== current.selection.effort
  );
  if (current?.busy && changed) {
    return { ok: false, status: 409, error: "the bot is working — stop it before changing models" };
  }
  const target = registry.get(selection.instanceId);
  // Model IDs remain free-form at the app's general API boundary. Custom
  // engines can accept IDs that are not in their discovery catalog, and
  // several drivers only learn the final catalog when a turn starts. The
  // MCP tool applies a stricter discovered-model policy for its own calls.
  if (requireAvailableModel) {
    if (!target) {
      return { ok: false, status: 400, error: `model instance "${selection.instanceId}" is unavailable` };
    }
    const offered =
      selection.model === target.models.default ||
      target.models.options.some((option) => option.id === selection.model);
    if (!offered) {
      return {
        ok: false,
        status: 400,
        error: `model "${selection.model}" is not offered by instance "${selection.instanceId}"`,
      };
    }
  }
  const allowed: readonly string[] = target?.adapter.capabilities.effortLevels ?? [];
  if (target && selection.effort !== undefined && !allowed.includes(selection.effort)) {
    return { ok: false, status: 400, error: `effort "${selection.effort}" is not offered by this bot's engine` };
  }
  return { ok: true, selection };
}

function checkedGroupResponder(value: unknown, memberIds: string[]): GroupDefaultResponder | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const responder = value as { kind?: unknown; botId?: unknown };
  if (responder.kind === "everyone") return { kind: "everyone" };
  if (responder.kind === "mentions") return { kind: "mentions" };
  if (
    responder.kind === "member" &&
    typeof responder.botId === "string" &&
    memberIds.includes(responder.botId)
  ) {
    return { kind: "member", botId: responder.botId };
  }
  return null;
}

function checkedMemberIds(value: unknown): { ok: true; memberIds: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "memberIds must be a list of bot IDs" };
  const invalidIndex = value.findIndex(
    (id) => typeof id !== "string" || !id.trim() || !store.bot(id),
  );
  if (invalidIndex !== -1) {
    return { ok: false, error: `unknown channel member: ${String(value[invalidIndex])}` };
  }
  const memberIds = [...new Set(value as string[])];
  if (!memberIds.length) return { ok: false, error: "a channel needs at least one bot" };
  // A room whose every member is archived accepts messages and answers none of
  // them — the failure only surfaces later, as "… is archived and can't
  // respond" on the first turn. Refuse it here, where the mistake is made.
  if (memberIds.every((id) => store.bot(id)?.hidden)) {
    return {
      ok: false,
      error: "a channel needs at least one active bot — every member given is archived",
    };
  }
  return { ok: true, memberIds };
}
let bootSelection = { instanceId: "", model: "" };
const store = new Store(() => bootSelection);
const sendSequencer = new SendSequencer();
bootSelection = await defaultSelection();
store.seedIfEmpty();
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

/** A bot as a client may see it: no provider session bookkeeping.
 *
 * `resumeCursors` is the harness's own bookkeeping — the native session id
 * to resume, per instance, per task. No client has ever used it, and a
 * paired phone has even less business holding provider session identifiers
 * than the desktop window did. Stripped here rather than at each call site
 * so a new broadcast cannot forget. */
const wireTask = ({ resumeCursors: _resumeCursors, lastInstanceId: _lastInstanceId, ...task }: TaskRecord) => task;

const wireBot = (bot: NonNullable<ReturnType<typeof store.bot>>) => {
  const { resumeCursors: _resumeCursors, tasks, approvalGrant, lastProfileRequestId: _lastProfileRequestId, ...rest } = bot;
  // An elevated selection is inert until the desktop confirms its exact
  // private reply. Every ordinary client sees the effective Ask state during
  // that two-phase window, never a grant that may still roll back.
  const visible = approvalGrant
    ? { ...rest, approvalMode: "ask" as const, autoApprove: false }
    : rest;
  return { ...visible, avatarUrl: visible.avatarUrl ?? null, ...(tasks ? { tasks: tasks.map(wireTask) } : {}) };
};

/** The correlated private response carries the requested value so Electron
 * can validate it before sending the confirmation that makes it effective. */
const wireTrustedApprovalBot = (bot: NonNullable<ReturnType<typeof store.bot>>) => {
  const { resumeCursors: _resumeCursors, tasks, approvalGrant: _approvalGrant, lastProfileRequestId: _lastProfileRequestId, ...rest } = bot;
  return { ...rest, avatarUrl: rest.avatarUrl ?? null, ...(tasks ? { tasks: tasks.map(wireTask) } : {}) };
};

/** A settings-based preview, not a receipt of a dispatched turn. No
 * provisioning or credentials are needed to inspect it. The selected engine
 * bounds advertised tools; task-specific context is added only at dispatch. */
function previewSystemPrompt(bot: BotRecord) {
  // `cfg` is the module-level config (`const cfg = loadConfig()` near the
  // top of index.ts), the same object the turn code reads.
  const persona = [
    `You are ${bot.name}, a personal bot in OpenMausBot.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
  ]
    .filter(Boolean)
    .join(" ");
  const instance = registry.get(bot.modelSelection.instanceId);
  const caps = instance?.adapter.capabilities;
  const computerPromptKind: ComputerPromptKind | null =
    bot.computer === "vm"
      ? caps?.computerMcp ? localVmMode(cfg) === "per-bot" ? "vm-private" : "vm-shared" : null
      : bot.computer === "cloud"
        ? instance?.driverKind === "boxAgent" ? "box-agent" : caps?.computerMcp ? bot.cloudBackend === "vps" ? "vps" : "box" : null
        : bot.computer === "local"
          ? caps?.localComputerMcp ? "local" : null
          : null;
  const peers = reachablePeers(store.bots, bot);
  const coordination = bot.chiefOfStaff
    ? chiefOfStaffSystemPrompt(bot.id, store.bots, true, openMausStatusSystemPrompt())
    : peers.length > 0
      ? peerRosterSystemPrompt(peers)
      : "";
  // Same gate a real turn applies: the block only goes to a bot whose
  // engine actually mounts agent tools, since it names propose_profile,
  // propose_routine and request_credential.
  const agentsMounted = caps?.agentsMcp === true;
  const privateWorkspace = instance && !["grok", "boxAgent"].includes(instance.driverKind);
  const built = buildSystemPrompt(persona, bot.soul ?? "", [
    {
      id: "setup",
      label: "Setup",
      text: setupSystemPrompt(agentsMounted && setupModeActive({ soul: bot.soul, description: bot.description, text: "" }), {
        skills: skillRecorderEnabled(cfg),
        cwd: bot.cwd,
      }),
    },
    { id: "computer", label: "Computer", text: computerPrompt(computerPromptKind) },
    { id: "composio", label: "Connected apps", text: caps?.composioMcp && bot.composio !== false && composio.configured(cfg) ? COMPOSIO_PROMPT : "" },
    { id: "browser", label: "Browser", text: caps?.browserMcp && builtInBrowserEnabled(cfg) && bot.browser !== false && bot.computer !== "off" ? BUILT_IN_BROWSER_SYSTEM_PROMPT : "" },
    { id: "coordination", label: "Team", text: agentsMounted && coordination ? ` ${coordination}` : "" },
    { id: "credential", label: "Credentials", text: agentsMounted ? CREDENTIAL_PROMPT : "" },
    { id: "routine", label: "Routines", text: agentsMounted ? ROUTINE_PROMPT : "" },
    { id: "profile", label: "Profile changes", text: agentsMounted ? PROFILE_PROMPT : "" },
    { id: "section-context", label: "Section context", text: sectionContextSystemPrompt(bot.section) },
    { id: "memory", label: "Memory", text: privateWorkspace ? memorySystemPrompt(bot.id) : "" },
    { id: "skills", label: "Skills index", text: privateWorkspace ? skillsSystemPrompt(bot.id) : "" },
  ]);
  const totalBytes = built.sections.reduce((n, s) => n + s.bytes, 0);
  return {
    sections: built.sections,
    totalBytes,
    approxTokens: Math.ceil(totalBytes / 4),
    note:
      "Preview from current bot settings, not the exact prompt of a running task. Task folders, notes, recall, selected skills and available connections can change the dispatched prompt. Token count is an estimate.",
  };
}

/** The plain-language "what does this bot do" facts, gathered once from
 * every server-only source (engine capabilities, connected-apps inventory,
 * routines/webhooks/skills, and recent history) and handed to the pure
 * sentence builder. The phones (step 5) and the web settings dialog both
 * read this same route, so they can never disagree about what a bot does. */
async function botOverview(bot: BotRecord): Promise<BotOverview> {
  const connectedApps = await connectedAppsFacts(
    composio.configured(cfg),
    composio.connectorAvailability(cfg),
    () => composio.connectedServices(cfg),
  );
  const engine = registry.get(bot.modelSelection.instanceId)?.adapter.capabilities ?? null;
  const sectionPeers = reachablePeers(store.bots, bot).length;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Same flush as GET /history: profile-change rows queue in
  // profile-versions.ts and land asynchronously, so a client checking the
  // overview right after causing a change must see its own row.
  await flushProfileHistory(bot.id);
  const recent = readHistory(bot.id, 5).map((r) => ({ at: r.at, summary: r.summary }));
  return buildBotOverview({
    bot: {
      name: bot.name,
      title: bot.title,
      description: bot.description,
      soul: bot.soul,
      computer: bot.computer,
      cloudBackend: bot.cloudBackend,
      cwd: bot.cwd,
      autoApprove: bot.autoApprove,
      approvalMode: approvalModeForTurn(bot),
      approvePeerComms: bot.approvePeerComms,
      peers: bot.peers,
      composio: bot.composio,
      browser: bot.browser,
      chiefOfStaff: bot.chiefOfStaff,
    },
    routines: routines!.listRoutines()
      .filter((routine) => routine.botId === bot.id)
      .map((routine) => ({
        id: routine.id,
        name: routine.name,
        enabled: routine.enabled,
        schedule: routine.schedule,
        nextRunAt: routine.nextRunAt,
      })),
    runs: routines!.listRuns()
      .filter((run) => run.botId === bot.id)
      .map((run) => ({
        routineId: run.routineId,
        status: run.status,
        finishedAt: run.finishedAt,
        startedAt: run.startedAt,
        scheduledFor: run.scheduledFor,
      })),
    webhooks: webhooks.list()
      .filter((webhook) => webhook.botId === bot.id)
      .map((webhook) => ({ name: webhook.name, enabled: webhook.enabled })),
    skills: listSkills(bot.id).map((skill) => ({
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
    })),
    engine,
    browserEnabled: builtInBrowserEnabled(cfg),
    connectedApps,
    sectionPeers,
    timeZone,
    recent,
  });
}

/** Defense in depth for hand-edited/corrupt durable records: elevated
 * approval semantics require an implemented provider mapping. The trusted transition enforces
 * this too, but no provider dispatch or later permission callback relies on
 * persistence having been produced exclusively by that route. And a turn
 * another bot started never runs as Full — see approvalModeForOrigin. */
const approvalModeForTurn = (bot: BotRecord, peerInitiated = false): ApprovalMode => {
  const mode = approvalModeForOrigin(approvalModeFor(bot), { peerInitiated });
  if (!supportsApprovalMode(registry.cliTarget(bot.modelSelection.instanceId)?.driverKind, mode)) {
    return "ask";
  }
  // Native reviewers can approve before a permission reaches this process.
  // Unattended Auto must therefore downgrade before spawning the provider.
  if (mode === "auto" && isUnattended(bot.id)) return "ask";
  return mode;
};

/** Privileged approval-mode transitions are deliberately absent from the
 * loopback HTTP authority model: a bot with shell access can curl that
 * surface itself. Only Electron's private utility-process channel can deliver
 * this message. */
function handleDesktopTrustedApprovalMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const message = raw as Record<string, unknown>;
  if (message.type === "approval-trusted-mode-commit") {
    const requestId = typeof message.requestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(message.requestId)
      ? message.requestId
      : null;
    const botId = typeof message.botId === "string" && /^[\w-]{1,128}$/.test(message.botId)
      ? message.botId
      : null;
    const mode = message.mode === "full" || message.mode === "custom" ? message.mode : null;
    if (!requestId) return true;
    if (!botId || !mode) return true;
    const bot = store.bot(botId);
    if (
      bot?.approvalGrant?.requestId === requestId &&
      bot.approvalGrant.mode === mode &&
      bot.approvalGrant.phase === "committed" &&
      bot.approvalMode === mode &&
      !bot.busy &&
      supportsApprovalMode(registry.cliTarget(bot.modelSelection.instanceId)?.driverKind, mode)
    ) {
      store.patchBot(botId, { approvalGrant: undefined });
    } else if (bot?.approvalGrant?.requestId === requestId) {
      store.patchBot(botId, { approvalMode: "ask", autoApprove: false, approvalGrant: undefined });
    }
    return true;
  }
  if (message.type === "approval-trusted-mode-confirm") {
    const requestId = typeof message.requestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(message.requestId)
      ? message.requestId
      : null;
    const botId = typeof message.botId === "string" && /^[\w-]{1,128}$/.test(message.botId)
      ? message.botId
      : null;
    const mode = message.mode === "full" || message.mode === "custom" ? message.mode : null;
    if (!requestId) return true;
    const confirm = (ok: boolean, error?: string) => {
      postDesktopPrivateMessage({
        type: "approval-trusted-mode-confirm-result",
        requestId,
        ok,
        ...(error ? { error } : {}),
      });
    };
    if (!botId || !mode) {
      confirm(false, "The approval confirmation was invalid");
      return true;
    }
    const bot = store.bot(botId);
    if (
      bot?.approvalGrant?.requestId === requestId &&
      bot.approvalGrant.mode === mode &&
      bot.approvalGrant.phase === "prepared" &&
      bot.approvalMode === mode
    ) {
      if (!supportsApprovalMode(registry.cliTarget(bot.modelSelection.instanceId)?.driverKind, mode)) {
        store.patchBot(botId, { approvalMode: "ask", autoApprove: false, approvalGrant: undefined });
        confirm(false, "This provider does not support the selected approval level");
        return true;
      }
      store.patchBot(botId, {
        approvalGrant: { requestId, mode, phase: "confirmed" },
      });
      confirm(true);
      return true;
    }
    // A matching journal whose other fields no longer agree is ambiguous.
    // Revoke only that request; never clear a newer grant for the same bot.
    if (bot?.approvalGrant?.requestId === requestId) {
      store.patchBot(botId, { approvalMode: "ask", autoApprove: false, approvalGrant: undefined });
    }
    confirm(false, "The approval confirmation no longer matches this bot");
    return true;
  }
  if (message.type === "approval-trusted-mode-activate") {
    const requestId = typeof message.requestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(message.requestId)
      ? message.requestId
      : null;
    const botId = typeof message.botId === "string" && /^[\w-]{1,128}$/.test(message.botId)
      ? message.botId
      : null;
    const mode = message.mode === "full" || message.mode === "custom" ? message.mode : null;
    if (!requestId) return true;
    const activate = (ok: boolean, error?: string) => {
      postDesktopPrivateMessage({
        type: "approval-trusted-mode-activate-result",
        requestId,
        ok,
        ...(error ? { error } : {}),
      });
    };
    if (!botId || !mode) {
      activate(false, "The approval activation was invalid");
      return true;
    }
    const bot = store.bot(botId);
    if (
      bot?.approvalGrant?.requestId === requestId &&
      bot.approvalGrant.mode === mode &&
      bot.approvalGrant.phase === "confirmed" &&
      bot.approvalMode === mode
    ) {
      if (bot.busy || !supportsApprovalMode(registry.cliTarget(bot.modelSelection.instanceId)?.driverKind, mode)) {
        store.patchBot(botId, { approvalMode: "ask", autoApprove: false, approvalGrant: undefined });
        activate(false, bot.busy
          ? "Stop this bot's turn before changing its approval level"
          : "This provider does not support the selected approval level");
        return true;
      }
      // Still inert: Electron must receive this acknowledgement and request
      // finalization before the durable mode can affect any turn.
      store.patchBot(botId, { approvalGrant: { requestId, mode, phase: "activated" } });
      activate(true);
      return true;
    }
    if (bot?.approvalGrant?.requestId === requestId) {
      store.patchBot(botId, { approvalMode: "ask", autoApprove: false, approvalGrant: undefined });
    }
    activate(false, "The approval activation no longer matches this bot");
    return true;
  }
  if (message.type === "approval-trusted-mode-finalize") {
    const requestId = typeof message.requestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(message.requestId)
      ? message.requestId
      : null;
    const botId = typeof message.botId === "string" && /^[\w-]{1,128}$/.test(message.botId)
      ? message.botId
      : null;
    const mode = message.mode === "full" || message.mode === "custom" ? message.mode : null;
    if (!requestId) return true;
    const finalize = (ok: boolean, error?: string) => {
      postDesktopPrivateMessage({
        type: "approval-trusted-mode-finalize-result",
        requestId,
        ok,
        ...(error ? { error } : {}),
      });
    };
    if (!botId || !mode) {
      finalize(false, "The approval finalization was invalid");
      return true;
    }
    const bot = store.bot(botId);
    if (
      bot?.approvalGrant?.requestId === requestId &&
      bot.approvalGrant.mode === mode &&
      bot.approvalGrant.phase === "activated" &&
      bot.approvalMode === mode &&
      !bot.busy &&
      supportsApprovalMode(registry.cliTarget(bot.modelSelection.instanceId)?.driverKind, mode)
    ) {
      // Durable but still inert. Electron must observe this exact ACK before
      // sending the one-way commit release that clears the journal.
      store.patchBot(botId, { approvalGrant: { requestId, mode, phase: "committed" } });
      finalize(true);
      return true;
    }
    if (bot?.approvalGrant?.requestId === requestId) {
      store.patchBot(botId, { approvalMode: "ask", autoApprove: false, approvalGrant: undefined });
    }
    finalize(false, bot?.busy
      ? "Stop this bot's turn before changing its approval level"
      : "The approval finalization no longer matches this bot");
    return true;
  }
  if (message.type !== "approval-trusted-mode-set") return false;
  const requestId = typeof message.requestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(message.requestId)
    ? message.requestId
    : null;
  if (!requestId) return true;
  const respond = (result: Omit<Extract<DesktopPrivateMessage, { type: "approval-trusted-mode-result" }>, "type" | "requestId">) => {
    postDesktopPrivateMessage({
      type: "approval-trusted-mode-result",
      requestId,
      ...result,
    });
  };
  const botId = typeof message.botId === "string" && /^[\w-]{1,128}$/.test(message.botId)
    ? message.botId
    : null;
  if (!botId) {
    respond({ ok: false, error: "The bot id is invalid" });
    return true;
  }
  const mode = isApprovalMode(message.mode) ? message.mode : null;
  if (!mode) {
    respond({ ok: false, error: "The approval mode is invalid" });
    return true;
  }
  const existing = store.bot(botId);
  if (!existing) {
    respond({ ok: false, error: "No such bot" });
    return true;
  }
  const currentMode = approvalModeFor(existing);
  const emergencyDowngrade = existing.busy && isEmergencyApprovalDowngrade(currentMode, mode);
  const clearsPendingElevation = mode === "ask" && existing.approvalGrant !== undefined;
  if (existing.busy && !emergencyDowngrade && !clearsPendingElevation) {
    respond({ ok: false, error: "Stop this bot's turn before changing its approval level" });
    return true;
  }
  if (!supportsApprovalMode(registry.cliTarget(existing.modelSelection.instanceId)?.driverKind, mode)) {
    respond({
      ok: false,
      error: mode === "full"
        ? "This provider does not support Full access"
        : "Custom approval settings are available only for Codex bots",
    });
    return true;
  }
  if (
    mode === "auto" &&
    existing.computer === "local" &&
    approvalModeFor(existing) !== "auto" &&
    message.acknowledgeLocalAuto !== true
  ) {
    respond({ ok: false, error: "Auto mode on this computer requires confirming the warning" });
    return true;
  }
  const updated = store.patchBot(botId, {
    approvalMode: mode,
    autoApprove: mode === "auto",
    approvalGrant: mode === "full" || mode === "custom"
      ? { requestId, mode, phase: "prepared" }
      : undefined,
  });
  if (!updated) {
    respond({ ok: false, error: "No such bot" });
    return true;
  }
  if (emergencyDowngrade) {
    // A lost Full/Custom reply is ambiguous: Electron compensates with Ask.
    // Persist that fail-closed state before the first await, then stop the
    // exact setup/turn that may already hold an elevated per-turn snapshot.
    // Only answer once the interrupt has been issued, so Electron cannot
    // advance a newer selection while the old turn is still live.
    void stopBotForEmergencyApprovalDowngrade(updated.id).then(
      () => respond({ ok: true, bot: wireBot(store.bot(updated.id) ?? updated) }),
      (error) => respond({
        ok: false,
        error: `Approval was reset to Ask, but the active turn could not be stopped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
    return true;
  }
  respond({ ok: true, bot: wireTrustedApprovalBot(updated) });
  return true;
}

/** Profile URLs are app-owned references, not merely strings with a trusted
 * prefix. Resolve them before persistence so every accepted avatar can be
 * fetched immediately and a deleted/guessed attachment id cannot become a
 * dangling profile reference. */
const storedAvatarExists = (avatarUrl: string): boolean =>
  attachmentExists(avatarUrl.slice("/api/attachments/".length));

const publicBot = (bot: NonNullable<ReturnType<typeof store.bot>>) => ({
  ...wireBot(bot),
  messages: store.messagesFor(bot.threadId),
  activeLeafId: store.activeLeaf(bot.threadId),
  tasks: store.tasks(bot.id).map(wireTask),
});

type GroupTurnOperation = {
  id: string;
  threadId: string;
  botIds: Set<string>;
  cancelled: boolean;
  cancellation: AbortController;
  providerHandshakePending: boolean;
  goalRun?: {
    runId: string;
    cardMessageId: string;
    goal: string;
    coordinatorBotId: string;
    coordinatorName: string;
    turnCount: number;
    maxTurns: number;
    startedAt: number;
    finished: boolean;
  };
};

// busyBotId names only the speaker that currently owns the provider process.
// A room turn is wider: it also includes async setup and every responder still
// queued behind that speaker. Keep that operation visible for its whole
// lifetime so polling clients cannot mistake a handoff for completion.
const groupTurnOperations = new Map<string, Set<GroupTurnOperation>>();

/** The central runtime fold uses this to hide a coordinator's private
 * decision envelope from both streaming UI and the durable transcript. */
type GroupGoalCoordinatorTurn = {
  token: symbol;
  turnId?: string;
  assistantItems: string[];
  /** A timed-out provider may still emit after the goal operation returns.
   * Keep swallowing that abandoned turn until its real completion arrives. */
  discard: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};
const groupGoalCoordinatorTurns = new Map<string, Set<GroupGoalCoordinatorTurn>>();
const GROUP_GOAL_COORDINATOR_GUARD_MS = 5 * 60_000;

function addGroupGoalCoordinatorTurn(threadId: string, turn: GroupGoalCoordinatorTurn): void {
  const turns = groupGoalCoordinatorTurns.get(threadId) ?? new Set<GroupGoalCoordinatorTurn>();
  turns.add(turn);
  groupGoalCoordinatorTurns.set(threadId, turns);
}

function removeGroupGoalCoordinatorTurn(threadId: string, turn: GroupGoalCoordinatorTurn): void {
  if (turn.cleanupTimer) clearTimeout(turn.cleanupTimer);
  const turns = groupGoalCoordinatorTurns.get(threadId);
  turns?.delete(turn);
  if (turns?.size === 0) groupGoalCoordinatorTurns.delete(threadId);
}

function hasUnboundDiscardedGroupGoalTurn(threadId: string): boolean {
  return [...(groupGoalCoordinatorTurns.get(threadId) ?? [])]
    .some((turn) => turn.discard && !turn.turnId);
}

/** Match private coordinator output to one provider turn, never merely to a
 * reusable room thread. Most adapters emit turn.started before sendTurn
 * resolves, so the first stable event may bind an otherwise pending guard. */
function groupGoalCoordinatorTurnForEvent(event: RuntimeEvent): GroupGoalCoordinatorTurn | undefined {
  const turns = groupGoalCoordinatorTurns.get(event.threadId);
  if (!turns?.size) return undefined;
  const candidates = [...turns];
  if (event.turnId) {
    const exact = candidates.find((turn) => turn.turnId === event.turnId);
    if (exact) return exact;
    // Until an interrupted handshake returns its own id, no new id can be
    // attributed safely. The stall fallback keeps this thread unavailable in
    // that narrow window; private text is suppressed below until sendTurn's
    // result binds the old guard or its bounded expiry releases ownership.
    const unboundDiscarded = candidates.filter((turn) => turn.discard && !turn.turnId);
    if (unboundDiscarded.length > 0) {
      // The ownership fallback below keeps a lone abandoned handshake's
      // thread closed, so its first eventual id can safely bind here. More
      // than one unbound candidate is genuinely ambiguous and stays gated.
      if (candidates.length === 1) {
        unboundDiscarded[0]!.turnId = event.turnId;
        // This event is the first stable identity for an already-abandoned
        // provider turn. Tombstone it immediately so this event and every
        // later completion/request cannot settle a replacement on the same
        // room thread.
        retireProviderTurn(event.turnId);
        return unboundDiscarded[0];
      }
      return undefined;
    }
    const pending = candidates.findLast((turn) => !turn.turnId && !turn.discard);
    if (pending && !pending.turnId) {
      pending.turnId = event.turnId;
      return pending;
    }
    return undefined;
  }
  // Turn-scoped events normally carry an id. If an adapter omits it, fail
  // closed for private text; with multiple overlapping guards there is no
  // safe way to attribute a completion, so leave cleanup to the bounded timer.
  return candidates.length === 1 ? candidates[0] : undefined;
}

function groupIsWorking(group: GroupRecord): boolean {
  return Boolean(group.busyBotId) || Boolean(groupTurnOperations.get(group.id)?.size);
}

function publicGroupState(group: GroupRecord) {
  return { ...group, working: groupIsWorking(group) };
}

function beginGroupTurnOperation(
  groupId: string,
  threadId: string,
  botIds: Iterable<string> = [],
): GroupTurnOperation {
  const operation = {
    id: randomUUID(),
    threadId,
    botIds: new Set(botIds),
    cancelled: false,
    cancellation: new AbortController(),
    providerHandshakePending: false,
  };
  const operations = groupTurnOperations.get(groupId) ?? new Set<GroupTurnOperation>();
  operations.add(operation);
  groupTurnOperations.set(groupId, operations);
  const group = store.group(groupId);
  if (group) broadcast({ kind: "group", group: publicGroupState(group) });
  return operation;
}

function finishGroupTurnOperation(groupId: string, operation: GroupTurnOperation) {
  if (operation.goalRun && !operation.goalRun.finished) {
    finishGroupGoalRun(groupId, operation, "failed", "The team run ended before the lead reported an outcome.");
  }
  clearCancelledProviderHandshake(operation.threadId, `group:${operation.id}`);
  const operations = groupTurnOperations.get(groupId);
  operations?.delete(operation);
  if (operations?.size === 0) groupTurnOperations.delete(groupId);
  const group = store.group(groupId);
  if (group) broadcast({ kind: "group", group: publicGroupState(group) });
  // A follow-up sent while this operation was running belongs to the
  // harness, not whichever composer happened to be mounted. Hand the next
  // one to the ordinary channel runner as soon as the channel is truly idle.
  drainQueuedChannelSends();
}

function finishGroupGoalRun(
  groupId: string,
  operation: GroupTurnOperation,
  status: Exclude<GroupGoalRunStatus, "working">,
  detail: string,
): void {
  const run = operation.goalRun;
  if (!run || run.finished) return;
  run.finished = true;
  const finishedAt = Date.now();
  const safeDetail = redactSecretsInText(detail.trim()).slice(0, 500);
  const card: GroupGoalRunCardData = {
    runId: run.runId,
    goal: redactSecretsInText(run.goal),
    status,
    coordinatorBotId: run.coordinatorBotId,
    coordinatorName: redactSecretsInText(run.coordinatorName),
    turnCount: run.turnCount,
    maxTurns: run.maxTurns,
    detail: safeDetail,
    startedAt: run.startedAt,
    finishedAt,
  };
  // A calendar-triggered team goal reuses its RoutineRun id for this card.
  // Manual goals have unrelated ids, so the manager safely ignores them.
  const routineRun = routines?.finishGoalRun(run.runId, status, safeDetail);
  // Member-level turn completions are intentionally private/intermediate for
  // a team goal, so the normal direct-routine notification path never fires.
  // Notify once from the correlated terminal receipt instead.
  // A scheduled team goal that stops to ask is the one outcome a person
  // most needs to hear about — it must never be filed as a quiet completion.
  if (routineRun?.status === "waiting") {
    const coordinator = store.bot(routineRun.botId);
    if (coordinator) {
      notify(buildNotification(
        "question",
        coordinator,
        routineSourceThread(routineRun) ?? routineRun.threadId ?? operation.threadId,
        safeDetail || `${routineRun.routineName} needs your input`,
        { avatarUrl: coordinator.avatarUrl },
      ));
    }
  }
  if (routineRun?.status === "completed") {
    const coordinator = store.bot(routineRun.botId);
    if (coordinator) {
      notify(buildNotification(
        "done",
        coordinator,
        routineSourceThread(routineRun) ?? routineRun.threadId ?? operation.threadId,
        safeDetail || routineRun.routineName,
        { avatarUrl: coordinator.avatarUrl },
      ));
    }
  }
  const group = store.group(groupId);
  const ownsThread = group?.dm
    ? group.threadId === operation.threadId
    : Boolean(group && store.groupTaskByThread(group.id, operation.threadId));
  if (!ownsThread) return;
  const fallbackState = status === "completed"
    ? "completed"
    : status === "needs-input"
      ? "needs your input"
      : status === "limit-reached"
        ? "reached its limit"
        : status;
  store.patchMessage(operation.threadId, run.cardMessageId, {
    text: `Goal ${fallbackState}: ${card.detail || card.goal}`,
    goalRun: card,
  });
}

function updateGroupGoalRunProgress(operation: GroupTurnOperation, detail: string): void {
  const run = operation.goalRun;
  if (!run || run.finished) return;
  const safeDetail = redactSecretsInText(detail.trim()).slice(0, 500);
  const current = store.messagesFor(operation.threadId).find((message) => message.id === run.cardMessageId);
  if (current?.goalRun?.status === "working" && current.goalRun.detail === safeDetail) return;
  store.patchMessage(operation.threadId, run.cardMessageId, {
    text: `Goal in progress: ${safeDetail || redactSecretsInText(run.goal)}`,
    goalRun: {
      runId: run.runId,
      goal: redactSecretsInText(run.goal),
      status: "working",
      coordinatorBotId: run.coordinatorBotId,
      coordinatorName: redactSecretsInText(run.coordinatorName),
      turnCount: run.turnCount,
      maxTurns: run.maxTurns,
      ...(safeDetail ? { detail: safeDetail } : {}),
      startedAt: run.startedAt,
    },
  });
}

type GroupMemberBotAvailability = "ready" | "busy" | "unavailable" | "cancelled" | "timed_out";
type GroupMemberBotWaitResult = Exclude<GroupMemberBotAvailability, "busy">;

function groupMemberBotAvailability(botId: string, operation: GroupTurnOperation): GroupMemberBotAvailability {
  if (operation.cancelled || operation.cancellation.signal.aborted) return "cancelled";
  const bot = store.bot(botId);
  if (!bot || bot.hidden) return "unavailable";
  return bot.busy ? "busy" : "ready";
}

/** A room is patient with a member's work already in progress: a busy bot
 * is woken later, never dropped. Goal runs and ordinary chat rounds share
 * this wait; only the note they leave differs (`onWaiting` fires once, when
 * the wait actually begins). Store changes are the wake-up signal, so waiting
 * consumes neither a model turn nor a polling loop. The operation's abort
 * signal lets the room Stop button release the listener immediately without
 * touching the unrelated turn that owns bot.busy. While it waits, the bot is
 * not part of this operation: its own Stop button must keep reaching the
 * conversation it is actually in. */
async function waitForGroupMemberBot(
  bot: BotRecord,
  operation: GroupTurnOperation,
  onWaiting: (detail: string) => void,
): Promise<GroupMemberBotWaitResult> {
  operation.botIds.delete(bot.id);
  const initial = groupMemberBotAvailability(bot.id, operation);
  if (initial !== "busy") return initial;
  onWaiting(`${bot.name} is finishing another conversation.`);

  return await new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (availability: GroupMemberBotWaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(waitCap);
      unsubscribe();
      operation.cancellation.signal.removeEventListener("abort", onAbort);
      resolve(availability);
    };
    // unref'd: a parked room must never keep the process alive on its own
    const waitCap = setTimeout(() => finish("timed_out"), GROUP_GOAL_WAIT_MAX_MS);
    waitCap.unref?.();
    const check = () => {
      const availability = groupMemberBotAvailability(bot.id, operation);
      if (availability !== "busy") finish(availability);
    };
    const onAbort = () => finish("cancelled");
    unsubscribe = store.onChange((change) => {
      if (
        (change.type === "bot" && change.botId === bot.id) ||
        (change.type === "bot.deleted" && change.botId === bot.id)
      ) {
        check();
      }
    });
    operation.cancellation.signal.addEventListener("abort", onAbort, { once: true });
    // Close the read→subscribe race: the bot may have settled between the
    // initial check and listener registration.
    check();
  });
}

/** Ordinary chat rounds share the goal wait, with the room's own notes: one
 * neutral chip when the wait begins (the transcript's promise that the member
 * replies here when free), rewritten in place if the cap runs out so the
 * promise never outlives the truth. `ok` stays undefined while waiting on
 * purpose — this is neither a failure nor a finished step, and the live label
 * reads `spoken` while the chip is the newest thing in the room. Stop leaves
 * nothing extra behind: the round simply ends. */
async function waitForChatRoomMember(
  operation: GroupTurnOperation,
  threadId: string,
  bot: BotRecord,
): Promise<"run" | "skip" | "stop"> {
  const waitTool = {
    name: `${bot.name} is finishing another conversation — will reply here when free`,
    spoken: `${bot.name} is finishing another conversation`,
  };
  let waitChip: Message | undefined;
  const availability = await waitForGroupMemberBot(bot, operation, () => {
    waitChip = store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: bot.id, name: bot.name, color: bot.color },
      tool: waitTool,
    });
  });
  switch (availability) {
    case "ready":
      // The promise is kept the moment the turn starts; settle the chip so
      // the live label stops narrating a wait that is over.
      if (waitChip) store.patchMessage(threadId, waitChip.id, { tool: { ...waitTool, ok: true } });
      // Membership means the bot is part of the room operation NOW, so its
      // own Stop button reaches this turn rather than an idle 1:1 thread.
      operation.botIds.add(bot.id);
      return "run";
    case "cancelled":
      return "stop";
    case "unavailable":
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        from: { botId: bot.id, name: bot.name, color: bot.color },
        tool: { name: `${bot.name} is no longer available — skipped this round`, ok: false },
      });
      return "skip";
    case "timed_out": {
      const minutes = Math.max(1, Math.round(GROUP_GOAL_WAIT_MAX_MS / 60_000));
      const name =
        `${bot.name} stayed busy in another conversation for ${minutes} minute${minutes === 1 ? "" : "s"} — skipped this round`;
      // The cap only fires after a wait began, so the chip exists; append
      // rather than lose the verdict if that ever stops being true.
      if (waitChip) store.patchMessage(threadId, waitChip.id, { tool: { name, ok: false } });
      else {
        store.appendMessage(threadId, {
          role: "bot",
          kind: "activity",
          from: { botId: bot.id, name: bot.name, color: bot.color },
          tool: { name, ok: false },
        });
      }
      return "skip";
    }
  }
}

function cancelGroupTurnOperations(
  groupId: string,
  threadId: string,
  outcome: { status: "stopped" | "limit-reached"; detail: string } = {
    status: "stopped",
    detail: "Stopped by you.",
  },
) {
  for (const operation of groupTurnOperations.get(groupId) ?? []) {
    if (operation.threadId !== threadId) continue;
    operation.cancelled = true;
    operation.cancellation.abort();
    finishGroupGoalRun(groupId, operation, outcome.status, outcome.detail);
    if (operation.providerHandshakePending) {
      markCancelledProviderHandshake(operation.threadId, `group:${operation.id}`);
    }
  }
}

function groupProviderHandshakeStarted(operation: GroupTurnOperation): void {
  operation.providerHandshakePending = true;
}

function groupProviderHandshakeSettled(operation: GroupTurnOperation): void {
  operation.providerHandshakePending = false;
  clearCancelledProviderHandshake(operation.threadId, `group:${operation.id}`);
}

function activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null {
  for (const group of store.groups) {
    for (const operation of groupTurnOperations.get(group.id) ?? []) {
      if (!operation.cancelled && operation.botIds.has(botId)) {
        return { group, threadId: operation.threadId };
      }
    }
    if (group.busyBotId !== botId) continue;
    // A detached scheduled goal deliberately leaves group.threadId pointing
    // at the task visible before the routine began. Resolve the live speaker
    // by its exact room task before falling back to legacy active-task work.
    for (const [threadId, speaker] of groupSpeakers) {
      if (speaker.botId !== botId) continue;
      const ownsThread = group.dm
        ? group.threadId === threadId
        : Boolean(store.groupTaskByThread(group.id, threadId));
      if (ownsThread) return { group, threadId };
    }
    return { group, threadId: group.threadId };
  }
  return null;
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

/** `limit === undefined` is the original, unpaginated shape. */
function messagePage(threadId: string, limit: number | undefined, before?: string | null) {
  const all = store.messagesFor(threadId);
  if (limit === undefined) return { messages: all };
  const end = before ? all.findIndex((msg) => msg.id === before) : -1;
  const stop = end === -1 ? all.length : end;
  const start = Math.max(0, stop - limit);
  return { messages: all.slice(start, stop).map(slimMessage), hasMore: start > 0 };
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
/** One connected client, and what it asked to be sent. */
interface SseClient {
  res: ServerResponse;
  /** Live screen frames carry a base64 desktop capture every few seconds
   * while a bot works. A client that isn't showing the computer panel —
   * a phone on cellular, most of all — should not pay for them. */
  screens: boolean;
  /** The paired session behind this stream, when there is one: revoking or
   * expiring it must end the stream, not just future requests. */
  sessionId?: string;
}
const sseClients = new Set<SseClient>();
sessions.onSessionRevoked((sessionId) => {
  for (const client of sseClients) {
    if (client.sessionId !== sessionId) continue;
    sseClients.delete(client);
    try {
      client.res.end();
    } catch {
      /* already gone */
    }
  }
});

/** Every frame is numbered, and the last few hundred are kept, so a client
 * whose connection dropped can ask for what it missed instead of
 * re-downloading every transcript. The desktop reconnects in milliseconds
 * and barely needs this; a phone reconnects every time it unlocks.
 *
 * The stream id makes the cursor safe across restarts: sequence numbers
 * begin again at 1 on boot, so a cursor from a previous run must be
 * rejected rather than used to replay a different run's frames. It rides
 * inside the SSE `id:` field, which means a browser EventSource resumes
 * correctly through its own Last-Event-ID with no client code at all. */
const STREAM_ID = randomUUID().slice(0, 8);
const REPLAY_MAX = 500;
const configuredSseHeartbeatMs = Number(process.env.OMB_SSE_HEARTBEAT_MS);
const SSE_HEARTBEAT_MS =
  Number.isFinite(configuredSseHeartbeatMs) && configuredSseHeartbeatMs > 0
    ? configuredSseHeartbeatMs
    : 15_000;
let lastSeq = 0;
const replayBuffer: Array<{ seq: number; kind: string; frame: string | null }> = [];

/** Screen frames are the only kind a client can decline. */
const wants = (client: SseClient, kind: string) => kind !== "screen" || client.screens;

/** `<streamId>:<seq>` — opaque to clients, and the only thing they need to
 * remember to resume. Returns null when it belongs to another run. */
function cursorSeq(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const [stream, seq] = value.split(":");
  if (stream !== STREAM_ID) return null;
  const parsed = Number(seq);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function broadcast(payload: Record<string, unknown>) {
  const seq = ++lastSeq;
  const kind = String(payload.kind ?? "");
  const frame = `id: ${STREAM_ID}:${seq}\ndata: ${JSON.stringify({ ...payload, seq })}\n\n`;
  // Live desktop captures can each be hundreds of kilobytes and become stale
  // as soon as the next one arrives. Keep their sequence slots so resume-gap
  // detection stays honest, but never retain their base64 payloads.
  replayBuffer.push({ seq, kind, frame: kind === "screen" ? null : frame });
  if (replayBuffer.length > REPLAY_MAX) replayBuffer.shift();
  for (const client of [...sseClients]) {
    if (!wants(client, kind)) continue;
    try {
      client.res.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ── server-side event folding (upstream's ingestion worker, miniature) ──
// The canonical stream is the source of truth; the persisted transcript
// and every client view are projections of it.
// keyed by `${threadId}:${itemId}` / `${threadId}:${requestId}` — provider
// item/request ids are only unique within a thread, so two bots acting at
// once can collide on a bare id and patch each other's messages.
const toolMessageByItem = new Map<string, string>(); // threadId:itemId -> messageId
const askMessageByRequest = new Map<string, string>(); // threadId:requestId -> messageId

/** Deliver a person's answer to the engine that asked, and tell the truth
 * about what happened. `unavailable` — the turn ended, the ask timed out,
 * the engine has no asks — is fail-closed: the action was never run. The
 * card is settled and a chip says so, instead of the answer vanishing into
 * a 500 while the card sits open forever. */
async function answerRequest(
  threadId: string,
  instanceId: string,
  requestId: string,
  behavior: "allow" | "deny" | "answer",
  message?: string,
  decidedFor?: { id: string; name: string },
): Promise<RequestOutcome> {
  // Snapshot the card BEFORE delivering the answer: a delivered answer
  // resolves the request synchronously through the fold, which consumes
  // the askMessageByRequest entry — by the time the await returns, nobody
  // remembers which tool this requestId was about.
  const thread = store.messagesFor(threadId);
  const cardMessageId = askMessageByRequest.get(`${threadId}:${requestId}`);
  // The map is an in-flight optimization and disappears on restart; the
  // durable transcript still carries the request id and its audit metadata.
  const cardMessage = cardMessageId
    ? thread.find((m) => m.id === cardMessageId)
    : thread.find((m) => m.card?.requestId === requestId);
  const card = cardMessage?.card;
  const instance = registry.get(instanceId);
  let outcome: RequestOutcome = "unavailable";
  if (instance) {
    try {
      outcome = await instance.adapter.respondToRequest(threadId, requestId, { behavior, message });
    } catch {
      outcome = "unavailable";
    }
  }
  // The human's verdict, recorded only when it actually reached the engine:
  // `unavailable` means the action never ran, and a "user-approved" row
  // over a request nothing answered would be the audit log lying. A
  // question's `answer` is conversation, not authorization, so it is not a
  // decision either.
  if (outcome !== "unavailable" && behavior !== "answer") {
    appendDecision(DATA_DIR, {
      threadId,
      requestId,
      botId: decidedFor?.id,
      botName: decidedFor?.name,
      tool: card?.tool,
      summary: card?.subtitle,
      decision: behavior === "allow" ? "user-approved" : "user-denied",
      source: "user",
    });
  }
  if (outcome === "unavailable") {
    // The in-flight map is memory-only. After a restart the card is still on
    // the thread, so fall back to the request it carries — otherwise an
    // unreachable approval is never closed and keeps owning the composer.
    const messageId = askMessageByRequest.get(`${threadId}:${requestId}`);
    const thread = store.messagesFor(threadId);
    const existing = messageId
      ? thread.find((m) => m.id === messageId)
      : thread.find((m) => m.card?.requestId === requestId);
    if (existing?.card && !existing.card.answered) {
      store.patchMessage(threadId, existing.id, { card: { ...existing.card, answered: "unavailable", dismissed: true } });
    }
    if (messageId) askMessageByRequest.delete(`${threadId}:${requestId}`);
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: "Couldn't deliver that answer — the request is no longer open, so the action was not run", ok: false },
    });
  }
  return outcome;
}

/** Close every provider-owned approval still open on a thread. Interrupting a
 * turn kills the process that raised its questions, so those cards can never
 * be answered. Routine proposals are harness-owned and durable, so they stay
 * actionable even after the proposing turn has stopped. */
function closeOpenApprovals(threadId: string): void {
  // Peer approvals also hold an in-memory promise. Resolve those first; merely
  // patching their cards would leave the delegation queue waiting 15 minutes.
  cancelPeerApprovalsForThread(threadId);
  for (const message of store.messagesFor(threadId)) {
    const card = message.card;
    if (!card?.requestId || card.answered || card.dismissed) continue;
    if (card.routineRequest || card.skillRequest) continue;
    store.patchMessage(threadId, message.id, { card: { ...card, answered: "unavailable", dismissed: true } });
    askMessageByRequest.delete(`${threadId}:${card.requestId}`);
  }
}

function requestBehavior(value: unknown): "allow" | "deny" | "answer" | null {
  return value === "allow" || value === "deny" || value === "answer" ? value : null;
}
// the last settled assistant text per thread, so a "finished" notification
// can carry what the bot actually said
const lastReply = new Map<string, string>();

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

// The latest running token totals for the turn in flight on each thread.
// Providers report cumulative-within-turn numbers; the final value is folded
// into the task's tally when the turn settles.
const turnUsage = new Map<string, { input: number; output: number; cachedInput?: number }>();

// Bounded per active turn. OpenHands uses a bounded recent-event scan for
// the same class of stuck-loop detection; retaining an unlimited set of
// unique arguments would let one pathological turn grow the server forever.
const repeats = new RepeatDetector({ thresholds: [5, 10, 20], maxKeysPerThread: 256 });

// ── stall watchdog ─────────────────────────────────────────────────────
// ask_bot has a 4-minute ceiling, while room turns have a separately
// configurable absolute ceiling. The main 1:1 path had none, so a wedged CLI
// left its bot busy forever. The watchdog stops a turn whose thread has emitted NOTHING for stallMs —
// activity-based, so an hour-long turn that keeps streaming is never
// touched, and turns parked on a human approval are exempt.
const TURN_STALL_MS = Math.max(60_000, Number(process.env.OMB_TURN_STALL_MS) || 20 * 60_000);
/** How long ask_bot waits synchronously before the ask is converted into a
 * delegation claim ticket (the peer's turn keeps running either way). */
const ASK_BOT_TIMEOUT_MS = Math.max(5_000, Number(process.env.OMB_ASK_BOT_TIMEOUT_MS) || 4 * 60_000);
// A room waits for a busy teammate instead of dropping them, but never
// forever: a bot parked on a permission card in another chat is "busy" until
// a human returns. Past this cap a goal's lead is told the teammate could not
// free up and reassigns, and a chat round moves on with a chip that says so —
// the wait ends as data, not as a dead room. Tests shrink it.
const GROUP_GOAL_WAIT_MAX_MS = Math.max(1_000, Number(process.env.OMB_GOAL_WAIT_MAX_MS) || 30 * 60_000);
// Reassigning around a busy teammate is bounded too: after this many
// exhausted waits in one run the team is blocked on availability, not stuck.
const GROUP_GOAL_MAX_WAIT_EXHAUSTIONS = 3;
const roomStallCompletions = new RoomTurnStallRegistry();
const watchdog = new TurnWatchdog({
  stallMs: TURN_STALL_MS,
  checkMs: 60_000,
  onStall: (turn) => {
    revokeInternalCapabilitiesForThread(turn.threadId);
    repeats.settle(turn.threadId);
    const bot = store.bot(turn.botId);
    const instance = bot ? registry.get(bot.modelSelection.instanceId) : null;
    void instance?.adapter.interruptTurn(turn.threadId).catch(() => {});
    const minutes = Math.round(TURN_STALL_MS / 60_000);
    store.appendMessage(turn.threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `error: no activity for ${minutes} minutes — the turn was stopped`, ok: false },
    });
    finalizeDelegationWatch(turn.threadId, false, "", "Delegated turn stalled and was stopped");
    turnUsage.delete(turn.threadId);
    roomStallCompletions.stall(turn.threadId);
    // ACP interruption settles within five seconds; other adapters settle
    // sooner. Keep ownership during that grace period so another turn cannot
    // overlap the process we are stopping. The normal turn.completed fold
    // clears it first when the adapter responds.
    const releaseOwnership = () => {
      // A goal coordinator can stall before sendTurn reveals its provider
      // turn id. Reusing the room during that ambiguous pre-id window would
      // make old and replacement events indistinguishable. Keep ownership
      // until the guard binds or reaches its bounded expiry.
      if (hasUnboundDiscardedGroupGoalTurn(turn.threadId)) {
        const retry = setTimeout(releaseOwnership, 1_000);
        retry.unref?.();
        return;
      }
      const group = store.groupByThread(turn.threadId);
      const speaker = groupSpeakers.get(turn.threadId);
      if (group && group.busyBotId === turn.botId && speaker?.botId === turn.botId) {
        groupSpeakers.delete(turn.threadId);
        store.patchGroup(group.id, { busyBotId: null, unread: true });
      }
      const currentBot = store.bot(turn.botId);
      if (currentBot?.busy) {
        stopScreenPoller(currentBot.id);
        if (activeVpsThreads.get(currentBot.id) === turn.threadId) activeVpsThreads.delete(currentBot.id);
        store.setActivity(currentBot.id, "idle");
        retryDelegationsWaitingOn(currentBot.id);
        // The grace fallback replaces a missing turn.completed event. Release
        // every kind of work that may have queued behind this bot, including
        // connector and credential continuations.
        drainQueuedSends();
        drainConnectorResumes();
        drainSecretResumes();
      }
    };
    const release = setTimeout(releaseOwnership, 6_000);
    release.unref?.();
  },
});
watchdog.start();

async function reviewPermissionCard(args: {
  instance: ProviderInstance;
  asker: {
    id: string;
    name: string;
    title?: string;
    description?: string;
    autoReview?: string;
    modelSelection: { instanceId: string };
  };
  threadId: string;
  requestId: string;
  messageId: string;
  tool: string;
  summary: string;
}): Promise<boolean> {
  const mode = resolveAutoReviewMode(args.asker.autoReview);
  if (mode === "off" || !args.instance.reviewPermission) return false;
  const persona = [args.asker.name, args.asker.title, args.asker.description].filter(Boolean).join(" — ");
  const reviewed = await requestReview(args.instance.reviewPermission.bind(args.instance), {
    tool: args.tool,
    summary: args.summary,
    persona,
  });
  if (!reviewed) return false;

  if (mode === "shadow") {
    appendDecision(DATA_DIR, {
      threadId: args.threadId,
      requestId: args.requestId,
      botId: args.asker.id,
      botName: args.asker.name,
      tool: args.tool,
      summary: args.summary,
      decision: reviewed.allow ? "review-would-approve" : "review-would-deny",
      source: "auto-review-shadow",
      rule: reviewed.reason,
    });
    return false;
  }
  if (!reviewed.allow) return false;

  // The human can answer while review is running. Their click wins before
  // the provider receives anything and before the audit log claims approval.
  const card = store.messagesFor(args.threadId).find((message) => message.id === args.messageId)?.card;
  if (!card || card.answered) return false;
  let outcome: RequestOutcome = "unavailable";
  try {
    outcome = await args.instance.adapter.respondToRequest(args.threadId, args.requestId, { behavior: "allow" });
  } catch {
    return false;
  }
  if (outcome === "unavailable") return false;

  store.appendMessage(args.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `review approved ${args.tool}: ${reviewed.reason}`, ok: true },
  });
  appendDecision(DATA_DIR, {
    threadId: args.threadId,
    requestId: args.requestId,
    botId: args.asker.id,
    botName: args.asker.name,
    tool: args.tool,
    summary: args.summary,
    decision: "auto-approved",
    source: "auto-review",
    rule: reviewed.reason,
  });
  return true;
}

bus.subscribe((event: RuntimeEvent) => {
  if (shouldIgnoreProviderEvent(event)) return;
  if (event.type === "request.opened") watchdog.setWaitingOnHuman(event.threadId, true);
  else if (event.type === "request.resolved") watchdog.setWaitingOnHuman(event.threadId, false);
  else if (event.type === "turn.completed") {
    watchdog.settle(event.threadId);
    revokeInternalCapabilityForProviderEvent(event);
  } else if (event.type === "session.exited") {
    // A retained provider session can exit after a newer turn reused the same
    // thread. An unscoped session event must never revoke that newer turn's
    // capability; its turn completion or watchdog owns release instead.
    const directBotBusy = store.botByThread(event.threadId)?.busy === true;
    const roomBusy = Boolean(store.groupByThread(event.threadId)?.busyBotId);
    if (!directBotBusy && !roomBusy) {
    }
  } else watchdog.touch(event.threadId);
});

// Bots currently working with nobody at the keyboard — a webhook turn, or a
// turn a webhook-driven bot handed to a teammate. Auto mode is a decision
// someone made for turns they were present for, so these don't inherit it:
// the guard behind auto mode is a pattern list, not a security boundary, and
// it must not stand in for a human at 3am.
//
// Keyed by BOT rather than thread because a bot runs one turn at a time, so
// the identity is exact, and because the peer-comms paths know who is asking
// but not always from which thread. Idle marks expire rather than clearing on
// turn.completed: bus subscribers fire in registration order, and the
// delegation drain runs AFTER the main fold — clearing there would blank the
// flag before the hop that needs to read it. A busy bot never ages out, and a
// stale mark only ever means "ask a human", so this fails closed.
const unattendedBots = new Map<string, number>();
const UNATTENDED_TTL_MS = 30 * 60_000;

function markUnattended(botId: string) {
  unattendedBots.set(botId, Date.now());
}
function clearUnattended(botId: string) {
  unattendedBots.delete(botId);
}
function isUnattended(botId?: string | null): boolean {
  if (!botId) return false;
  const at = unattendedBots.get(botId);
  if (at === undefined) return false;
  // A long-running turn is still unattended even if its next approval comes
  // more than 30 minutes after the previous one. Only an idle bot may age
  // out; every positive read refreshes the inactivity window.
  if (Date.now() - at > UNATTENDED_TTL_MS && !store.bot(botId)?.busy) {
    unattendedBots.delete(botId);
    return false;
  }
  unattendedBots.set(botId, Date.now());
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
const localVmOwnerBusy = (botId: string) => store.bot(botId)?.busy === true;
const localVmLeases = new LocalVmLeasePool(30 * 60_000);
const localVmLifecycleBusy = new Set<string>();
const localVmThreadTargets = new Map<string, LocalVmTarget>();
const localVmActiveThreads = new Map<string, string>();
let localVmImageBusy = false;
let localVmProvisionBusy = false;
let localVmModeChangeBusy = false;
const activeVpsThreads = new Map<string, string>();
const boxLifecycleBusyBots = new Set<string>();
const orphanBoxLifecycleBusyIds = new Set<string>();
const boxInventoryRequestsBusyIds = new Set<string>();
type RemoteComputerProvider = "box" | "vps";
const computerProviderConfigTransitions = new Set<RemoteComputerProvider>();
// A restore mutates and cleans a project work tree. Claim the bot across the
// entire async Git operation so a turn cannot start in that folder midway.
const checkpointRestoreLeases = new Set<string>();
const LOCAL_VM_IDLE_MS = 8 * 60 * 60_000;
/** How long a turn waits for Cua Driver after starting the container itself.
 * A cold XFCE desktop needs some seconds; past this the turn reports the
 * status it has rather than hanging on a container that will not come up. */
const LOCAL_VM_DESKTOP_WAIT_MS = 90_000;
const localVmIdles = new Map<string, LocalVmIdleTimer>();

function managedBoxOwners(): box.ManagedBoxOwner[] {
  return store.bots.map((bot) => ({
    botId: bot.id,
    name: bot.name,
    // A machine is not safe to mutate while any app-level work or human
    // control lease still names its owner. This is deliberately conservative
    // across destination changes: an old Box may still contain valuable state.
    inUse:
      bot.busy === true ||
      directTurnDispatchClaims.has(bot.id) ||
      activeGroupTurnForBot(bot.id) !== null ||
      Boolean(routines?.activeRunForBot(bot.id)) ||
      activeVpsThreads.has(bot.id) ||
      computerControl.snapshot(bot.id).held,
  }));
}

function botHasActiveTurn(botId: string): boolean {
  const bot = store.bot(botId);
  return bot?.busy === true ||
    directTurnDispatchClaims.has(botId) ||
    activeGroupTurnForBot(botId) !== null;
}

function providerTransitionMessage(provider: RemoteComputerProvider): string {
  return provider === "box"
    ? "Box account settings are being updated — wait for them to finish"
    : "VPS connection settings are being updated — wait for them to finish";
}

/** Work which started first wins. This is intentionally conservative: a
 * control lease or detached routine can still refer to a durable computer
 * after the bot record's current destination changes. */
function providerOperationConflict(provider: RemoteComputerProvider): string | null {
  if (provider === "vps" && activeVpsThreads.size > 0) {
    return "stop the active VPS turn before changing the SSH config alias";
  }
  if (managedBoxOwners().some((owner) => owner.inUse)) {
    return `stop active bot work and computer control before changing ${provider === "box" ? "the Box account" : "the VPS connection"}`;
  }
  if (boxLifecycleBusyBots.size > 0) {
    return "wait for cloud computer actions to finish before changing provider settings";
  }
  if (provider === "box") {
    if (boxInventoryRequestsBusyIds.size > 0 || orphanBoxLifecycleBusyIds.size > 0) {
      return "wait for cloud computer actions to finish before changing the Box account";
    }
    if (boxCreateRecoverySnapshot().some((entry) => !entry.resolved)) {
      return "finish reconciling pending cloud computer creation before changing the Box account";
    }
  } else if (vps.vpsLifecycleBusy()) {
    return "wait for VPS computer actions to finish before changing the SSH config alias";
  }
  return null;
}

function turnProvider(bot: NonNullable<ReturnType<typeof store.bot>>, runOn?: RoutineRunOn): RemoteComputerProvider | null {
  if (runOn === "cloud" || registry.get(bot.modelSelection.instanceId)?.driverKind === "boxAgent") return "box";
  if (bot.computer !== undefined && bot.computer !== "cloud") return null;
  return bot.cloudBackend === "vps" ? "vps" : "box";
}

function providerTransitionForTurn(
  bot: NonNullable<ReturnType<typeof store.bot>>,
  runOn?: RoutineRunOn,
): string | null {
  const provider = turnProvider(bot, runOn);
  return provider && computerProviderConfigTransitions.has(provider)
    ? providerTransitionMessage(provider)
    : null;
}

function claimBoxInventoryRequest(boxId: string): () => void {
  if (boxInventoryRequestsBusyIds.has(boxId)) {
    throw Object.assign(new Error("this cloud computer is being changed — wait for it to finish"), { status: 409 });
  }
  boxInventoryRequestsBusyIds.add(boxId);
  return () => boxInventoryRequestsBusyIds.delete(boxId);
}

/** Claim the owning bot synchronously after Box revalidation and before the
 * provider mutation. startTurn checks the same set before doing any work, so
 * a new turn and an irreversible lifecycle action cannot pass each other. */
function claimManagedBoxMutation(instance: box.ManagedBoxInventoryInstance): () => void {
  const ownerBotId = instance.ownerBotId;
  if (!ownerBotId) {
    if (orphanBoxLifecycleBusyIds.has(instance.boxId)) {
      throw Object.assign(new Error("this cloud computer is being changed — wait for it to finish"), { status: 409 });
    }
    orphanBoxLifecycleBusyIds.add(instance.boxId);
    return () => orphanBoxLifecycleBusyIds.delete(instance.boxId);
  }
  const owner = managedBoxOwners().find((candidate) => candidate.botId === ownerBotId);
  if (owner?.inUse) {
    throw Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 });
  }
  return claimBotComputerLifecycle(ownerBotId);
}

/** One synchronous lane for every Box lifecycle consumer. Both Settings and
 * bot-scoped actions use it, so whichever operation starts first excludes the
 * other instead of relying on a stale check made before a provider await. */
function claimBotComputerLifecycle(botId: string): () => void {
  if (boxLifecycleBusyBots.has(botId)) {
    throw Object.assign(new Error("this bot's cloud computer is being changed — wait for it to finish"), { status: 409 });
  }
  boxLifecycleBusyBots.add(botId);
  return () => boxLifecycleBusyBots.delete(botId);
}

function claimManagedVpsMutation(containerName: string): () => void {
  const owner = store.bots.find((candidate) => vps.vpsContainerName(candidate.id) === containerName);
  if (!owner) return () => {};
  const ownerState = managedBoxOwners().find((candidate) => candidate.botId === owner.id);
  if (ownerState?.inUse) {
    throw Object.assign(new Error("this VPS computer is in use — stop its bot's work first"), { status: 409 });
  }
  return claimBotComputerLifecycle(owner.id);
}

function localVmTargetForBot(botId: string): LocalVmTarget {
  return localVmMode(cfg) === "per-bot" ? perBotLocalVmTarget(botId) : SHARED_LOCAL_VM_TARGET;
}

function localVmLeaseFor(target: LocalVmTarget): LocalVmLease {
  return localVmLeases.forTarget(target.key);
}

function localVmIdleFor(target: LocalVmTarget): LocalVmIdleTimer {
  let idle = localVmIdles.get(target.key);
  if (idle) return idle;
  idle = new LocalVmIdleTimer(
    LOCAL_VM_IDLE_MS,
    () => localVmImageBusy || localVmLifecycleBusy.has(target.key) || localVmActiveThreads.has(target.key),
    async () => {
      localVmLifecycleBusy.add(target.key);
      try {
        const status = await containerComputerStatus(undefined, undefined, target);
        // The desktop leaves a stale X lock after stop, so idle cleanup
        // removes only the disposable container. Its target-specific durable
        // workspace and the shared prepared image remain.
        if (status.container === "running") {
          await containerComputerAction("remove", undefined, undefined, target);
        }
      } finally {
        localVmLifecycleBusy.delete(target.key);
      }
    },
  );
  localVmIdles.set(target.key, idle);
  return idle;
}

function releaseLocalVmThread(threadId: string): void {
  const target = localVmThreadTargets.get(threadId);
  if (!target) return;
  localVmLeaseFor(target).release(threadId);
  if (localVmActiveThreads.get(target.key) === threadId) localVmActiveThreads.delete(target.key);
  localVmThreadTargets.delete(threadId);
}

// A running VM may have survived an app/server restart. Start its idle
// backstop even if nobody opens Settings or begins a turn this session. The
// bot's current destination is intentionally ignored: moving a bot to Cloud,
// Browser, This computer, Auto, or Off does not delete its old Local VM.
void (async () => {
  if (localVmMode(cfg) !== "per-bot") {
    const status = await containerComputerStatus(undefined, undefined, SHARED_LOCAL_VM_TARGET).catch(() => null);
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
    if (shouldArmLocalVmIdle(statuses[index])) localVmIdleFor(target).touch();
  });
})().catch(() => {
  // Startup inspection is a backstop, not a reason to keep the app offline.
  // The Settings inventory remains available for a later explicit retry.
});

async function localVmInventoryPayload() {
  const runtime = await containerRuntimeStatus();
  if (!runtime.runtime || !runtime.daemonUp) {
    return {
      instances: [],
      maxInstances: localVmMaxInstances(cfg),
      available: false,
      problem: runtime.runtime ? `Start ${runtime.runtime} first` : "Install a supported container runtime first",
    };
  }
  const existing = await discoverExistingPerBotLocalVms(store.bots, runtime.runtime);
  const statuses = await Promise.all(existing.map(({ target }) =>
    containerComputerStatus(undefined, undefined, target),
  ));
  const instances = existing.flatMap(({ bot, target }, index) => {
    const status = statuses[index];
    if (!status) return [];
    const inUse = localVmActiveThreads.has(target.key) ||
      localVmLeaseFor(target).current(localVmOwnerBusy) !== null;
    const entry = localVmInventoryEntry(bot, status, inUse);
    return entry ? [entry] : [];
  });
  return { instances, maxInstances: localVmMaxInstances(cfg), available: true, problem: null };
}

bus.subscribe((event: RuntimeEvent) => {
  if (shouldIgnoreProviderEvent(event)) return;
  const localVmTarget = localVmThreadTargets.get(event.threadId);
  if (localVmTarget) {
    localVmLeaseFor(localVmTarget).touch(event.threadId);
    localVmIdleFor(localVmTarget).touch();
  }
  if (event.type === "turn.completed") {
    releaseLocalVmThread(event.threadId);
  }
  const coordinatorTurnsForThread = groupGoalCoordinatorTurns.get(event.threadId);
  const ambiguousCoordinatorText = !event.turnId && (coordinatorTurnsForThread?.size ?? 0) > 1;
  const goalCoordinatorTurn = groupGoalCoordinatorTurnForEvent(event);
  const completedTurnId = event.type === "turn.completed"
    ? groupGoalCompletionTurnId(event.turnId, goalCoordinatorTurn?.turnId)
    : event.turnId;
  if (goalCoordinatorTurn?.discard && retiredProviderTurns.has(event.turnId)) {
    removeGroupGoalCoordinatorTurn(event.threadId, goalCoordinatorTurn);
    return;
  }
  // Buffer every coordinator text item for the whole provider turn. A model
  // can split the private envelope across assistant items (or emit multiple
  // envelopes), so sanitizing item-by-item can leak protocol into the chat.
  if (
    event.type === "item.completed" &&
    event.itemType === "assistant_text" &&
    (goalCoordinatorTurn || ambiguousCoordinatorText)
  ) {
    if (goalCoordinatorTurn && !goalCoordinatorTurn.discard) goalCoordinatorTurn.assistantItems.push(event.text);
    return;
  }
  // Goal coordinators speak a private control envelope. Their incidental
  // artifacts are private too; never leak one into the public room.
  if (
    event.type === "item.completed" &&
    event.itemType === "assistant_image" &&
    (goalCoordinatorTurn || ambiguousCoordinatorText)
  ) return;
  if (
    event.type === "content.delta" &&
    event.streamKind === "assistant_text" &&
    (goalCoordinatorTurn || ambiguousCoordinatorText)
  ) return;
  const coordinatorVisibleText = goalCoordinatorTurn && !goalCoordinatorTurn.discard && event.type === "turn.completed"
    ? parseGroupGoalDecision(goalCoordinatorTurn.assistantItems.join("\n")).visibleText
    : "";
  if (goalCoordinatorTurn && event.type === "turn.completed") {
    removeGroupGoalCoordinatorTurn(event.threadId, goalCoordinatorTurn);
  }
  if (coordinatorVisibleText) {
    const publicAssistantEvent: RuntimeEvent = {
      ...event,
      eventId: `${event.eventId}-goal-text`,
      type: "item.completed",
      itemType: "assistant_text",
      text: coordinatorVisibleText,
    };
    broadcast({ kind: "runtime", event: publicAssistantEvent });
  }
  const privateImageEvent = event.type === "item.completed" && event.itemType === "assistant_image";
  // The durable message patch below is the public frame. Sending raw base64
  // through runtime SSE would multiply large bytes across every app window.
  if (!privateImageEvent) broadcast({ kind: "runtime", event });
  const routineRun = privateImageEvent ? null : (routines?.handleRuntimeEvent(event) ?? null);
  const bot = store.botByThread(event.threadId);
  const group = bot ? undefined : store.groupByThread(event.threadId);
  if (!bot && !group) return;
  const speaker = group ? groupSpeakers.get(event.threadId) : undefined;

  const pushMessage = (m: Omit<Message, "id" | "at">) => {
    const message = store.appendMessage(event.threadId, group && m.role === "bot" ? { ...m, from: speaker } : m);
    return message;
  };

  if (coordinatorVisibleText) {
    pushMessage({ role: "bot", kind: "text", text: coordinatorVisibleText, turnId: completedTurnId });
    lastReply.set(event.threadId, coordinatorVisibleText);
  }

  switch (event.type) {
    case "session.started":
      if (bot && event.sessionId && event.providerInstanceId) {
        store.setResumeCursor(bot.id, event.providerInstanceId, event.sessionId, event.threadId);
      }
      break;
    case "item.completed":
      if (event.itemType === "assistant_text") {
        const text = event.text;
        pushMessage({ role: "bot", kind: "text", text, turnId: event.turnId });
        // kept so "finished" can say what it finished with, rather than
        // just that something ended
        lastReply.set(event.threadId, text);
      } else if (event.itemType === "assistant_image") {
        try {
          const decoded = decodeGeneratedImage(event.data);
          const saved = saveImage(decoded.bytes, decoded.mime);
          const key = generatedImageTurnKey(event.threadId, event.turnId);
          const current = generatedImagesByTurn.get(key) ?? [];
          current.push({ kind: "image", path: saved.path, mime: saved.mime });
          generatedImagesByTurn.set(key, current);
        } catch (error) {
          pushMessage({
            role: "bot",
            kind: "activity",
            tool: {
              name: `generated image could not be attached — ${error instanceof Error ? error.message : "invalid image"}`.slice(0, 160),
              ok: false,
            },
          });
        }
      } else if (event.itemType === "tool" && event.itemId) {
        const itemKey = `${event.threadId}:${event.itemId}`;
        const messageId = toolMessageByItem.get(itemKey);
        let toolName = "tool";
        if (messageId) {
          // the whole tool object is replaced, so carry `spoken` across —
          // dropping it here would silently un-narrate every completed tool
          const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId)?.tool;
          toolName = existing?.name ?? "tool";
          store.patchMessage(event.threadId, messageId, {
            tool: { name: toolName, ok: event.ok, spoken: existing?.spoken },
          });
          toolMessageByItem.delete(itemKey);
        }
        // the bot just acted ON ITS SCREEN — refresh the preview now. Only
        // computer tools can change the screen, and each capture competes
        // with the agent for the box's command endpoint, so a bot grinding
        // through file edits must not trigger one per tool. The refresh is
        // deliberately broad (a computer_exec may well have launched a
        // window); whether the turn has EARNED a settled screenshot is the
        // narrower question, and only the allow-list answers it.
        if (bot) {
          const touches = screenTouchingTool(toolName);
          if (touches || /computer|screenshot|click|type_text|press_key|scroll|open_url|wait_for|browser_/i.test(toolName)) {
            pokeScreenPoller(bot.id, touches);
          }
        }
      }
      break;
    case "item.started":
      if (event.itemType === "tool") {
        // ask_bot's raw tool chip is redundant — the internal endpoint
        // appends a richer "Messaged @X" chip linking to the channel
        if (event.title?.endsWith("__ask_bot")) break;
        const name = event.title ?? "tool";
        // narration is folded in here, once, so call mode can read the
        // chip aloud without re-deriving it — and so the phrase a user
        // hears and the chip they see can never drift apart
        const message = pushMessage({
          role: "bot",
          kind: "activity",
          tool: { name, spoken: narrateTool(name) ?? undefined },
        });
        if (event.itemId) toolMessageByItem.set(`${event.threadId}:${event.itemId}`, message.id);
      }
      break;
    case "request.opened": {
      const permission = event.requestType === "permission";
      // Approval modes and always-allow can answer permission requests for
      // the bot so it keeps working. A QUESTION always reaches the human —
      // even Full access never invents a person's answer. Safe Auto stops on
      // the guards in auto-approve.ts; explicitly acknowledged Full does not.
      const asker = bot ?? (speaker ? store.bot(speaker.botId) : undefined);
      const unattended = permission && asker && event.requestId ? isUnattended(asker.id) : false;
      const verdict = permission && asker && event.requestId
        ? autoVerdict({
            // the same origin the dispatch used, so a peer-started turn's
            // residual asks are judged as Approve for me here too
            approvalMode: approvalModeForTurn(asker, isInternalTurn(event.threadId)),
            autoApprove: false,
            alwaysAllow: asker.alwaysAllow,
          }, event.tool, event.summary, {
            unattended,
            scope: event.approvalScope,
            requiresExplicitApproval: event.requiresExplicitApproval,
            nativeApproval: requiresNativeApproval(event.provider, approvalModeForTurn(asker)),
          })
        : null;
      if (verdict?.approve && asker && event.requestId) {
        const settled = verdict.approve;
        const instance = event.providerInstanceId
          ? registry.get(event.providerInstanceId)
          : registry.get(asker.modelSelection.instanceId);
        const requestId = event.requestId;
        const { tool, summary } = event;
        // The chip is written only AFTER the provider takes the answer.
        // Claiming approval first and correcting later means a moment
        // where the transcript says "approved" over a request nothing
        // answered — and if the provider is gone entirely, forever.
        void (async () => {
          try {
            if (!instance) throw new Error("provider unavailable");
            const outcome = await instance.adapter.respondToRequest(event.threadId, requestId, { behavior: "allow" });
            if (outcome === "unavailable") throw new Error("the ask is no longer open");
            pushMessage({
              role: "bot",
              kind: "activity",
              tool: { name: `${settled}: ${summary.slice(0, 120)}`, ok: true },
            });
            // logged under the same discipline as the chip: only once the
            // provider has actually taken the answer, so the audit log
            // never claims an approval nothing received
            appendDecision(DATA_DIR, {
              threadId: event.threadId,
              requestId,
              botId: asker.id,
              botName: asker.name,
              tool,
              summary,
              decision: "auto-approved",
              source: verdict.source,
              rule: verdict.rule,
            });
          } catch {
            // couldn't answer it for them — hand it back to the human
            // rather than leaving the bot waiting on nobody
            const card = pushMessage({
              role: "bot",
              kind: "options",
              card: {
                title: "Approval needed",
                subtitle: summary,
                options: ["Allow", "Deny"],
                requestId,
                tool,
                allowKey: rememberableApprovalKey(asker, tool, summary, {
                  source: verdict.source,
                  scope: event.approvalScope,
                  requiresExplicitApproval: event.requiresExplicitApproval,
                }),
                held: verdict.source === "full-access"
                  ? "Full access couldn't deliver this approval."
                  : "Approve for me couldn't answer this one.",
                approvalScope: event.approvalScope,
              },
            });
            askMessageByRequest.set(`${event.threadId}:${requestId}`, card.id);
            appendDecision(DATA_DIR, {
              threadId: event.threadId,
              requestId,
              botId: asker.id,
              botName: asker.name,
              tool,
              summary,
              decision: "card-shown",
              source: "auto-fallback",
              rule: verdict.rule,
            });
          }
        })();
        break;
      }
      const message = pushMessage({
        role: "bot",
        kind: "options",
        card: {
          title:
            permission && event.approvalScope === "local-computer"
              ? "Local computer approval"
              : permission
                ? "Approval needed"
                : "Your bot has a question",
          subtitle: event.summary,
          options: event.choices?.length ? event.choices : permission ? ["Allow", "Deny"] : [],
          requestId: event.requestId,
          tool: permission ? event.tool : undefined,
          // the exact grant "always allow" would remember, decided here so
          // client and server can never derive it differently
          allowKey: permission
            ? rememberableApprovalKey(asker, event.tool, event.summary, {
                source: verdict?.source,
                scope: event.approvalScope,
                requiresExplicitApproval: event.requiresExplicitApproval,
              })
            : undefined,
          // A card can outlive the bot record that raised it. Without one
          // there is no mode to explain, but the sandbox note still applies.
          held: approvalHeldReason({
            source: verdict?.source,
            permission,
            requiresExplicitApproval: event.requiresExplicitApproval,
            mode: asker ? approvalModeForOrigin(approvalModeFor(asker), { peerInitiated: isInternalTurn(event.threadId) }) : "ask",
            unattended: Boolean(unattended),
            fullAccessAvailable: asker && !isInternalTurn(event.threadId)
              ? supportsApprovalMode(registry.cliTarget(asker.modelSelection.instanceId)?.driverKind, "full")
              : false,
          }),
          approvalScope: event.approvalScope,
        },
      });
      if (event.requestId) askMessageByRequest.set(`${event.threadId}:${event.requestId}`, message.id);
      const reviewMode = resolveAutoReviewMode(asker?.autoReview);
      let reviewTask: Promise<boolean> | undefined;
      if (
        permission &&
        !event.requiresExplicitApproval &&
        asker &&
        event.requestId &&
        shouldReview({
          source: verdict?.source,
          mode: reviewMode,
          approvalMode: approvalModeFor(asker),
          unattended: Boolean(unattended),
          approvalScope: event.approvalScope,
        })
      ) {
        // Review stays on the provider boundary that opened the request.
        // Falling back to an arbitrary sibling could disclose action details
        // to a provider the user did not choose for this bot.
        const instance = registry.get(event.providerInstanceId ?? asker.modelSelection.instanceId);
        if (instance?.reviewPermission) {
          reviewTask = reviewPermissionCard({
            instance,
            asker,
            threadId: event.threadId,
            requestId: event.requestId,
            messageId: message.id,
            tool: event.tool,
            summary: event.summary,
          });
        }
      }
      // Every card that reaches a human is a decision too — "a rule sent
      // this to you, and here is which one". `question` marks the cards no
      // rule may ever answer; a permission card without a verdict (no known
      // asker, or no requestId to answer through) can only mean nothing was
      // granted.
      appendDecision(DATA_DIR, {
        threadId: event.threadId,
        requestId: event.requestId,
        botId: asker?.id,
        botName: asker?.name,
        tool: event.tool,
        summary: event.summary,
        decision: "card-shown",
        source: !permission ? "question" : verdict ? verdict.source : "no-grant",
        rule: verdict?.rule,
        unattended: unattended || undefined,
      });
      // Notify from HERE, not from a separate subscriber on request.opened:
      // this is the branch where a card actually reached a human. Anything
      // auto mode answered took the early return above and never buzzes.
      const notifyHuman = () => {
        if (!asker) return;
        const card = store.messagesFor(event.threadId).find((candidate) => candidate.id === message.id)?.card;
        if (!card || card.answered) return;
        // the bot is not working now — it is waiting on a person
        if (asker.busy) store.setActivity(asker.id, "waiting-on-you");
        notify(buildNotification(
          permission ? "approval" : "question",
          asker,
          (routineRun && routineSourceThread(routineRun)) || event.threadId,
          event.summary,
        ));
      };
      if (reviewTask && reviewMode === "enforce") {
        // Avoid buzzing the owner for a card the reviewer is about to answer.
        // A deny, failure, or timeout falls back to the normal notification;
        // if the human already answered meanwhile, notifyHuman is a no-op.
        void reviewTask
          .catch(() => false)
          .then((approved) => {
            if (!approved) notifyHuman();
          });
      } else {
        // Watch mode notifies immediately, but its background audit must not
        // become an unhandled rejection if an unexpected store error occurs.
        if (reviewTask) void reviewTask.catch(() => false);
        notifyHuman();
      }
      break;
    }
    case "request.resolved": {
      // answered (by whoever): the turn is working again, unless it settled
      const waiting = bot ?? (speaker ? store.bot(speaker.botId) : undefined);
      if (waiting?.activity === "waiting-on-you") store.setActivity(waiting.id, "working");
      const messageId = event.requestId ? askMessageByRequest.get(`${event.threadId}:${event.requestId}`) : null;
      if (messageId) {
        const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId);
        if (existing?.card && !existing.card.answered) {
          store.patchMessage(event.threadId, messageId, {
            card: { ...existing.card, answered: event.behavior, dismissed: event.source !== "user" },
          });
        }
        if (event.requestId) askMessageByRequest.delete(`${event.threadId}:${event.requestId}`);
      }
      break;
    }
    case "turn.retrying":
      // the driver is about to relaunch the turn after a transient failure;
      // the activity chip keeps the bot visibly busy through the backoff
      pushMessage({
        role: "bot",
        kind: "activity",
        tool: { name: `retrying — attempt ${event.attempt + 1}/${RETRY_MAX_ATTEMPTS} in ${Math.round(event.delayMs / 1000)}s — ${event.reason}`, ok: true },
      });
      break;
    case "runtime.error":
      pushMessage({
        role: "bot",
        kind: "activity",
        tool: { name: `error: ${event.message.slice(0, 160)}`, ok: false, setup: event.setup },
      });
      // a setup error means the engine could not even start: the bot is
      // dead until something changes, not merely idle. The next successful
      // dispatch moves it to working; turn.completed (which follows a setup
      // failure) is told to leave "dead" alone.
      if (event.setup && bot) store.setActivity(bot.id, "dead");
      break;
    case "thread.token-usage.updated":
      // running totals for the turn in flight; folded into the task's
      // tally at turn.completed (below) so retries never double-count
      turnUsage.set(event.threadId, { input: event.input, output: event.output, cachedInput: event.cachedInput });
      break;
    case "turn.completed": {
      // A peer-started turn settles as coordination, not as news. What keeps
      // that classification from outliving its turn is the rewrite at
      // dispatch, not this line — releasing it here too is hygiene, so a
      // thread nobody types in again (a deleted bot's) is not held forever.
      const internal = isInternalTurn(event.threadId);
      clearInternalTurn(event.threadId);
      const generatedKey = generatedImageTurnKey(event.threadId, event.turnId);
      const generated = generatedImagesByTurn.get(generatedKey) ?? [];
      generatedImagesByTurn.delete(generatedKey);
      if (generated.length) {
        const response = [...store.messagesFor(event.threadId)].reverse().find(
          (message) =>
            message.role === "bot" &&
            message.kind === "text" &&
            message.turnId === completedTurnId,
        );
        if (response) {
          store.patchMessage(event.threadId, response.id, {
            attachments: [...(response.attachments ?? []), ...generated],
          });
        } else {
          // Some image turns have no textual epilogue. Keep the image as the
          // terminal assistant response instead of inventing model words.
          pushMessage({
            role: "bot",
            kind: "text",
            text: "",
            attachments: generated,
            turnId: completedTurnId,
          });
        }
      }
      if (completedTurnId) store.markTerminalAssistantMessage(event.threadId, completedTurnId);
      const reply = lastReply.get(event.threadId) ?? "";
      lastReply.delete(event.threadId);
      const lastReported = turnUsage.get(event.threadId);
      turnUsage.delete(event.threadId);
      // group turns run on the room's thread — the speaking bot's task
      // tally is not the right home for a shared room's spend, so only
      // 1:1 task turns are tallied for now.
      if (bot) {
        const vpsTurn = activeVpsThreads.get(bot.id) === event.threadId;
        const clearVpsTurn = () => {
          if (activeVpsThreads.get(bot.id) === event.threadId) activeVpsThreads.delete(bot.id);
        };
        // bank what this turn spent before the bot broadcast carries the
        // task list to every window. The driver's own per-turn figure
        // (turn.completed.usage) is authoritative; a driver that only
        // streams the running indicator falls back to its last value.
        const tokens = event.usage ?? lastReported;
        store.addTaskUsage(bot.id, event.threadId, {
          input: tokens?.input,
          output: tokens?.output,
          cachedInput: tokens?.cachedInput,
          costUsd: event.cost ?? null,
        });
        // settled → idle; a setup failure already marked it dead, keep that
        if (store.bot(bot.id)?.activity !== "dead") store.setActivity(bot.id, "idle");
        const routineReportThread = routineRun ? routineSourceThread(routineRun) : null;
        const routineReportGroup = routineReportThread ? store.groupByThread(routineReportThread) : undefined;
        // Group-origin routines belong to that channel's unread state. Their
        // hidden execution task should not light up the bot's 1:1 sidebar too.
        // Neither should a peer's hop: the exchange is already recorded in the
        // pair channel and chipped into both threads, which is the whole of
        // what the person needs to be able to find it.
        if (!routineReportGroup && !internal) store.patchBot(bot.id, { unread: true });
        // A failed peer turn stays a chip too. The bot that delegated is woken
        // with the failure and answers the person in its own thread — buzzing
        // here as well would ring twice for one piece of news.
        if (routineRun?.status !== "failed" && !internal) {
          // the frame carries the bot's avatar so every desktop client can
          // show the notification under that bot's own face
          const completionDetail = routineRun
            ? reply || routineRun.output || routineRun.routineName
            : reply;
          notify(buildNotification("done", bot, routineReportThread ?? event.threadId, completionDetail, { avatarUrl: bot.avatarUrl }));
        }
        if (screenPollers.has(bot.id)) {
          // the last live frame becomes a settled inline screen message —
          // the screenshot-in-chat moment. One fresh capture first, so the
          // frame shows the turn's END state (the final tool's poke may
          // still be in flight).
          //
          // The capture is slow (a real screenshot round trip) and the bot
          // is already idle, so a fast follow-up send or the steer-queue
          // drain can land BEFORE the frame does. Anchor the frame to the
          // turn's actual last message now, and chain-insert it there when
          // it arrives — otherwise the user's next message ends up stranded
          // above the screenshot (the browser-mode ordering bug).
          const settleLeafId = store.activePath(event.threadId).at(-1)?.id;
          void finalScreenFrame(bot.id, event.threadId).then((frame) => {
            // the bot may have been deleted while the capture ran
            if (frame && store.bot(bot.id)) {
              if (group) pushMessage({ role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
              else store.insertMessageAfter(event.threadId, settleLeafId, { role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
            }
          }).finally(clearVpsTurn);
        } else if (vpsTurn) {
          clearVpsTurn();
        }
      }
      const speaker = groupSpeakers.get(event.threadId);
      const group = store.groupByThread(event.threadId);
      if (speaker && group?.busyBotId === speaker.botId) {
        groupSpeakers.delete(event.threadId);
        store.patchGroup(group.id, { busyBotId: null, unread: true });
        const speakingBot = store.bot(speaker.botId);
        if (speakingBot?.busy) {
          store.setActivity(speakingBot.id, "idle");
          retryDelegationsWaitingOn(speakingBot.id);
        }
      }
      // A delegated turn's terminal state belongs in the A⇄B channel:
      // the request was mirrored there when the delegation drained, and a
      // channel that only ever shows requests is half a record. Mirror the
      // reply on success; mirror a failed/stopped terminal chip otherwise.
      const delegationFailureName = !event.ok && event.stopReason?.trim()
        ? `Delegated turn did not finish — ${event.stopReason.trim().slice(0, 120)}`
        : undefined;
      finalizeDelegationWatch(event.threadId, event.ok, reply, delegationFailureName);
      // group busy/unread settle in the group turn engine, which knows
      // whether more member turns are queued behind this one
      break;
    }
  }
});

/** A delegated turn's terminal state belongs in the A⇄B channel:
 * the request was mirrored there when the delegation drained, and a
 * channel that only ever shows requests is half a record. Mirror the
 * reply on success; mirror a failed/stopped terminal chip otherwise. */
const delegationWatch = new Map<string, {
  channelId?: string;
  toBotId: string;
  toBotName?: string;
  taskId?: string;
  sourceThreadId?: string;
  sourceBotId?: string;
  /** when the delegated turn was dispatched — elapsed time for status checks */
  startedAtMs?: number;
}>();

// Peer wake: when a delegated reply lands, resume the source bot so it can
// fold the result in and answer the user instead of sitting idle. Mirrors
// the cardContinuation resume pattern used for connector/credential cards.
const delegationWakeBudget = new DelegationWakeBudget();
const pendingDelegationWakes = new Map<string, { botId: string; targetName: string; failureReason?: string }>();

function dispatchDelegationWake(botId: string, threadId: string, targetName: string, failureReason?: string): void {
  const prompt = failureReason
    ? buildDelegationFailurePrompt(targetName, failureReason)
    : buildDelegationRevivalPrompt(targetName);
  void startTurn(botId, prompt, {
    threadId,
    cardContinuation: true,
    unattended: isUnattended(botId),
  })
    .then(() => undefined)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      // Raced with a user turn claiming the bot — retry once it settles.
      if (/already working/i.test(message)) {
        pendingDelegationWakes.set(threadId, { botId, targetName, failureReason });
        return;
      }
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: {
          name: `error: could not resume after delegation — ${message.slice(0, 120)}`,
          ok: false,
        },
      });
    });
}

function wakeDelegationSource(source: BotRecord, threadId: string, targetName: string, failureReason?: string): void {
  // Busy? Hold the wake until the source settles, then drain it — the
  // delegated reply is already in the thread, so nothing is lost, and the
  // source processes it the moment it is free rather than only on a later
  // user nudge.
  if (store.bot(source.id)?.busy) {
    pendingDelegationWakes.set(threadId, { botId: source.id, targetName, failureReason });
    return;
  }
  if (!delegationWakeBudget.tryAcquire(threadId)) return;
  dispatchDelegationWake(source.id, threadId, targetName, failureReason);
}

function drainDelegationWakes(): void {
  for (const [threadId, entry] of pendingDelegationWakes) {
    if (store.bot(entry.botId)?.busy) continue;
    pendingDelegationWakes.delete(threadId);
    if (!delegationWakeBudget.tryAcquire(threadId)) continue;
    dispatchDelegationWake(entry.botId, threadId, entry.targetName, entry.failureReason);
  }
}

// Provider-native sessions only know about messages produced inside their
// own turns. A delegated result is appended later by the harness, so mark the
// source task with a persisted, impossible-to-resume owner. Its next turn
// will replay the active branch once before replacing this marker with the
// real provider instance id. A unique suffix also closes the setup race: if
// another result arrives while that replay is launching, the newer marker is
// left intact for one more replay instead of being accidentally consumed.
const EXTERNAL_CONTEXT_MARKER_PREFIX = "__openmaus_external_context__:";

function isExternalContextMarker(value: string | undefined): boolean {
  return Boolean(value?.startsWith(EXTERNAL_CONTEXT_MARKER_PREFIX));
}

function markTaskContextExternallyUpdated(bot: BotRecord, threadId: string): void {
  const task = store.taskByThread(bot.id, threadId);
  if (!task) return;
  task.resumeCursors = {};
  task.lastInstanceId = `${EXTERNAL_CONTEXT_MARKER_PREFIX}${randomUUID()}`;
  // patchBot persists the task mutation and broadcasts unread/context state.
  // The legacy cursor mirror follows only the task currently open in chat.
  const patch: Partial<BotRecord> = { unread: true };
  if (bot.threadId === threadId) patch.resumeCursors = {};
  store.patchBot(bot.id, patch);
}

/** Consume one delegated-turn watch and mirror exactly one terminal state.
 * Some harness paths settle a busy bot without a provider turn.completed
 * event, so they call this same finalizer explicitly. */
function finalizeDelegationWatch(
  threadId: string,
  ok: boolean,
  reply = "",
  failureName = "Delegated turn did not finish",
): boolean {
  const watched = delegationWatch.get(threadId);
  if (!watched) return false;
  delegationWatch.delete(threadId);
  // The receipt is written before any mirror short-circuits: the delegating
  // bot's check/wait_delegation must see a terminal state even when the
  // channel or target is gone.
  if (watched.taskId && watched.sourceThreadId) {
    recordDelegationReceipt({
      id: watched.taskId,
      sourceThreadId: watched.sourceThreadId,
      toBotId: watched.toBotId,
      toBotName: store.bot(watched.toBotId)?.name ?? watched.toBotId,
      status: ok ? "done" : "failed",
      result: ok ? reply : failureName,
    });
  }
  const target = store.bot(watched.toBotId);
  const targetName = target?.name ?? watched.toBotName ?? watched.toBotId;
  const source = watched.sourceBotId
    ? store.bot(watched.sourceBotId)
    : (watched.sourceThreadId ? store.botByThread(watched.sourceThreadId) : undefined);

  let channel: GroupRecord | undefined = watched.channelId ? store.group(watched.channelId) : undefined;
  let terminalThreadId: string | undefined = watched.sourceThreadId;

  if (source && watched.sourceThreadId) {
    const sourceGroup = store.groupByThread(watched.sourceThreadId);
    if (sourceGroup) {
      // Shared-channel (or DM) source: revalidate membership, since a roster
      // change while the target ran must not force a result into a group
      // that no longer contains both bots.
      const sourceStillMember = sourceGroup.memberIds.includes(source.id);
      const targetStillMember = target ? sourceGroup.memberIds.includes(target.id) : false;
      if (!sourceStillMember || !targetStillMember) {
        if (target) {
          channel = getOrCreateChannel(store, source, target);
          terminalThreadId = channel.threadId;
        } else {
          // Target is gone: the source may still see the original group, but
          // there is no peer to share a DM with. Keep the group for source.
          terminalThreadId = sourceStillMember ? watched.sourceThreadId : undefined;
          channel = undefined;
        }
      }
      if (terminalThreadId) {
        if (ok && reply.trim()) {
          const sourceReply: Omit<Message, "id" | "at"> = {
            role: "bot",
            kind: "text",
            text: `@${targetName} replied to the delegated task:\n\n${reply.trim()}`,
          };
          if (target) sourceReply.from = { botId: target.id, name: target.name, color: target.color };
          store.appendMessage(terminalThreadId, sourceReply);
        } else {
          store.appendMessage(terminalThreadId, {
            role: "bot",
            kind: "activity",
            tool: {
              name: ok
                ? `Delegation to @${targetName} completed without a text reply`
                : `Delegation to @${targetName} failed — ${failureName}`,
              ok,
            },
          });
        }
        if (channel && terminalThreadId === channel.threadId && !channel.dm) {
          store.patchGroup(channel.id, { unread: true });
        }
      }
      // Group/DM sources do not have a single direct task to mark or wake.
      // The delegated result is already in the shared transcript; a group
      // continuation is the responsibility of the room's own turn engine.
    } else {
      // 1:1 source: the source thread is the delegating bot's own task.
      if (ok && reply.trim()) {
        const sourceReply: Omit<Message, "id" | "at"> = {
          role: "bot",
          kind: "text",
          text: `@${targetName} replied to the delegated task:\n\n${reply.trim()}`,
        };
        if (target) sourceReply.from = { botId: target.id, name: target.name, color: target.color };
        store.appendMessage(watched.sourceThreadId, sourceReply);
      } else {
        store.appendMessage(watched.sourceThreadId, {
          role: "bot",
          kind: "activity",
          tool: {
            name: ok
              ? `Delegation to @${targetName} completed without a text reply`
              : `Delegation to @${targetName} failed — ${failureName}`,
            ok,
          },
        });
      }
      markTaskContextExternallyUpdated(source, watched.sourceThreadId);
      // Peer wake: a settled delegated turn resumes the source bot so it
      // folds the result in and answers the user, instead of sitting idle
      // with the reply only visible in the thread (the "delegated and went
      // silent" gap). Failures wake it too — the user must hear the task did
      // not finish. Idle-checked and burst-capped so a busy source or a
      // re-delegating loop cannot spin up runs.
      if (ok && reply.trim()) {
        wakeDelegationSource(source, watched.sourceThreadId, targetName);
      } else if (!ok) {
        wakeDelegationSource(source, watched.sourceThreadId, targetName, failureName || "the delegated turn did not finish");
      }
    }
  }

  if (target && channel) {
    if (ok && reply.trim()) mirrorReply(commsBus, target, reply, channel);
    else if (ok) mirrorActivity(commsBus, target, channel, "Delegated turn completed", true);
    else mirrorActivity(commsBus, target, channel, failureName, false);
  }
  return true;
}

// A bot going in circles — the same call with the same arguments, over and
// over in one turn — gets a chip at 5, 10 and 20 repeats. Observe and say
// so; the human has Stop. Keyed on tool + arguments, so a bare tool name
// (Claude's item.started carries only that) is never counted: five "Bash"
// may be five different commands. Arguments come from ACP item titles and
// from every permission ask's summary (the command being approved).
bus.subscribe((event: RuntimeEvent) => {
  if (shouldIgnoreProviderEvent(event)) return;
  if (event.type === "turn.completed" || event.type === "session.exited") return void repeats.settle(event.threadId);
  let key: string | null = null;
  if (event.type === "item.started" && event.itemType === "tool") {
    // a title with more than a bare identifier is a call with arguments
    // (ACP: "echo hi", "Read src/x.ts"); a bare "Bash" is not countable
    const title = event.title ?? "";
    if (/\s|\//.test(title.trim())) key = callKey("tool", title);
  } else if (event.type === "request.opened" && event.requestType === "permission") key = callKey(event.tool, event.summary);
  if (!key) return;
  const { threshold } = repeats.record(event.threadId, key);
  if (!threshold) return;
  const [tool, ...rest] = key.split(":");
  const args = rest.join(":");
  store.appendMessage(event.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Same call repeated ${threshold}× — ${tool}: ${args.slice(0, 80)}${args.length > 80 ? "…" : ""} — it may be stuck`, ok: false },
  });
});

// Drain queued delegations for a source thread after its turn settles.
// Run as a separate subscriber so the drain logic stays out of the main
// fold (which has its own switch/case noise) and its approval + startTurn
// calls never have to share locals with the fold's state machine.
/** How a drained delegation becomes a real turn on the target. Shared by
 * the settle-time drain and the boot-time drain of what a previous process
 * left queued. */
const runDelegatedTurn: Parameters<typeof drainDelegations>[3] = (toBotId, text, commsDepth, sourceThreadId, channel, taskId, sourceBotId) => {
    // startTurn REJECTS on an ordinary condition — busy target, deleted bot,
    // unavailable provider. Unhandled, that rejection is fatal to the
    // harness (Node's default), which in the packaged app kills the server
    // child. Every delegation failure has to land as a chip instead.
    const targetThreadId = store.bot(toBotId)?.threadId;
    const target = store.bot(toBotId);
    if (targetThreadId) {
      delegationWatch.set(targetThreadId, {
        channelId: channel?.id,
        toBotId,
        toBotName: target?.name,
        taskId,
        sourceThreadId,
        sourceBotId,
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
      commsDepth,
      unattended: isUnattended(sourceBotId),
      // startTurn schedules provider/integration setup after marking the bot
      // busy. Those asynchronous setup failures do not emit turn.completed,
      // so clear the watch and report them through this callback too.
      onDispatchError: reportStartFailure,
    }).then(() => undefined).catch((err) => {
      reportStartFailure(err);
    });
};

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
    if (store.bot(botId)?.busy) return;
    for (const waitingThread of releaseDelegationsWaitingOn(botId)) {
      drainDelegations(commsBus, approvalBus, waitingThread, runDelegatedTurn);
    }
  });
}

bus.subscribe((event: RuntimeEvent) => {
  if (shouldIgnoreProviderEvent(event)) return;
  if (event.type !== "turn.completed") return;
  // A turn that failed or was interrupted drops its queue rather than
  // firing it later: the user who hit Stop does not expect the delegations
  // that turn queued to run anyway, minutes later, on an unrelated turn.
  if (!event.ok) discardDelegations(commsBus, event.threadId);
  else drainDelegations(commsBus, approvalBus, event.threadId, runDelegatedTurn);
  // A settling bot frees itself as a delegation TARGET too: handoffs that
  // found it busy earlier were kept queued (bounded retries) on their own
  // source threads, and this is the moment they get their retry.
  const settledBot = store.botByThread(event.threadId);
  if (settledBot) retryDelegationsWaitingOn(settledBot.id);
});

// ── steer-queue drain: messages sent while the bot was busy ────────────
// Runs on ANY turn.completed rather than resolving the settling thread: a
// bot busy in a room settles on the room's thread, and by the time this
// subscriber runs the main fold has already dropped the speaker record —
// so the drain matches on "this queue's bot is idle now" instead.
// Registration order puts this after the main fold, so busy is already
// false when it looks. Deliberately NOT gated on event.ok (unlike the
// delegation drain above): queued delegations are a bot's fan-out and
// dropping them on Stop is a safety property, but queued messages are the
// user's own words — stop-then-steer is the point, so an interrupted turn
// drains too.
bus.subscribe((event: RuntimeEvent) => {
  if (shouldIgnoreProviderEvent(event)) return;
  if (event.type !== "turn.completed") return;
  drainQueuedSends();
  drainDelegationWakes();
});

function drainQueuedSends() {
  drainSteeredMessages(store, (botId, threadId, prompt, userMessage, excludeIds) =>
    // A plain attended turn — no automationSource, no unattended, no comms
    // depth: exactly what typing the same words into an idle bot would run.
    // Drain just appended the held lines; userMessage keeps startTurn
    // from duplicating the last one, and excludeIds drops every drained
    // line from the transcript-replay so they are not also in `prompt`.
    startTurn(botId, prompt, { threadId, userMessage, excludeMessageIds: excludeIds }).then(() => undefined).catch((err) => {
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: {
          name: `error: queued message could not start — ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
          ok: false,
        },
      });
    }),
  );
}

// ── live screen: poll the bot's computer while it works ───────────────
// Frames stream to clients as SSE {kind:'screen'} (the "Bot's screen"
// panel); the final frame is folded into the transcript on turn end.
type Frame = { png: string; mime: string };
const screenPollers = new Map<
  string,
  {
    timer: ReturnType<typeof setInterval> | null;
    capture: () => Promise<void>;
    last: Frame | null;
    /** Did this turn actually reach for the screen? A bot that merely HAS
     * a computer would otherwise end every reply — a one-word "yes"
     * included — with the same picture of an idle desktop. The flag lives
     * on the poller entry, which is created and dropped per turn, so it
     * cannot leak into a later one. */
    touched: boolean;
  }
>();

/** The preview shares the box's single command endpoint with the agent's
 * own actions, so every frame we take is latency stolen from the work the
 * user is waiting on. Hence: a slow interval, a floor between captures,
 * and never two in flight. */
const SCREEN_POLL_MS = 6000;
const SCREEN_MIN_GAP_MS = 3000;

/** `screenIsTheWork` starts the turn already counting as screen usage: a
 * boxAgent's whole session runs ON the box, so every tool it calls acts on
 * that screen even though none of them is named like a computer tool. Its
 * shell-only turns are kept honest by the settle-time hash gate instead. */
function startScreenPoller(
  botId: string,
  capture: () => Promise<{ png: string; format: string }>,
  { screenIsTheWork = false } = {},
) {
  if (screenPollers.has(botId)) return;
  // One capture at a time, shared by the interval, the pokes, and the
  // turn-end grab: awaiting the in-flight promise (rather than dropping the
  // call) is what lets the final frame be the settled one. The min-gap keeps
  // a tool-heavy turn from spending the box's single command endpoint on
  // previews the user isn't waiting for.
  let current: Promise<void> | null = null;
  let lastAt = 0;
  const entry = {
    timer: null as ReturnType<typeof setInterval> | null,
    capture: (): Promise<void> => {
      // A person can type credentials while driving any browser/computer
      // surface. Never take a preview during that lease: live frames and the
      // settled transcript image must retain only the last pre-takeover view.
      if (computerControl.snapshot(botId).held) return Promise.resolve();
      if (!current && Date.now() - lastAt < SCREEN_MIN_GAP_MS) return Promise.resolve();
      current ??= (async () => {
        try {
          const frame = await captureOutsideHumanControl(
            () => ({
              held: computerControl.snapshot(botId).held,
              revision: computerControlRevision.get(botId) ?? 0,
            }),
            capture,
          );
          if (!frame) return;
          entry.last = frame;
          broadcast({ kind: "screen", botId, ...frame });
        } catch {
          /* box asleep or mid-command — try again next tick */
        } finally {
          lastAt = Date.now();
          current = null;
        }
      })();
      return current;
    },
    last: null as Frame | null,
    touched: screenIsTheWork,
  };
  entry.timer = setInterval(() => void entry.capture(), SCREEN_POLL_MS);
  screenPollers.set(botId, entry);
}

/** Event-driven refresh: capture NOW (the bot just acted on its screen)
 * instead of waiting for the next interval tick. Rate-limited inside
 * capture() — a tool-heavy turn used to fire one full REST chain per
 * completed tool, competing with the agent for the same endpoint. */
function pokeScreenPoller(botId: string, touches: boolean) {
  const entry = screenPollers.get(botId);
  if (!entry) return;
  // the same signal, read twice: a completed computer tool is both the
  // reason to refresh the preview NOW and — when it acted on or looked at
  // the screen — the proof that this turn's final frame is worth settling
  // into the transcript. A shell command or a status read earns only the
  // refresh: under the Claude driver every tool of the computer server is
  // named mcp__computer__*, and matching that alone used to append an
  // untouched desktop to every curl-and-answer reply.
  if (touches) entry.touched = true;
  void entry.capture();
}

function stopScreenPoller(botId: string) {
  const entry = screenPollers.get(botId);
  if (!entry) return;
  if (entry.timer) clearInterval(entry.timer);
  screenPollers.delete(botId);
}

/** sha256 of the frame each bot last settled into a transcript — the
 * comparison the hash gate needs is "this turn's end state against what
 * the reader can already see". Keyed per bot (one physical screen, however
 * many threads it reports into); a cold entry is seeded from the thread's
 * newest screen message so a restart does not re-picture the same idle
 * desktop either. */
const settledScreenHashes = new Map<string, string>();

function shownScreenHash(botId: string, threadId: string): string | undefined {
  const known = settledScreenHashes.get(botId);
  if (known) return known;
  const shown = store.messagesFor(threadId).findLast((m) => m.kind === "screen" && Boolean(m.png));
  return shown?.png ? screenFrameHash(shown.png) : undefined;
}

/** Turn end: stop polling, then take ONE last fresh frame (awaiting any
 * in-flight poke first) so the settled screenshot shows the screen's actual
 * end state, not the previous action's. A turn that never touched the
 * screen settles nothing — and skips the capture, which is one less
 * command on the box's single endpoint. A frame the reader can already see
 * settles nothing either: the boxAgent pre-touch counts every turn as
 * screen work, so without this its shell-only replies would all end in the
 * same idle desktop. Either way the poller is torn down here, so no
 * per-turn state survives the turn. */
async function finalScreenFrame(botId: string, threadId: string): Promise<Frame | null> {
  const entry = screenPollers.get(botId);
  if (!entry) return null;
  if (entry.timer) clearInterval(entry.timer);
  screenPollers.delete(botId);
  if (!entry.touched) return null;
  await entry.capture();
  const frame = entry.last;
  if (!frame || !settledFrameIsNews(shownScreenHash(botId, threadId), frame.png)) return null;
  settledScreenHashes.set(botId, screenFrameHash(frame.png));
  return frame;
}

// ── turn dispatch (upstream ProviderCommandReactor, miniature) ──────────
async function startTurn(
  botId: string,
  text: string,
  opts?: {
    commsDepth?: number;
    userMessage?: Message;
    /** Extra transcript ids to omit (every drained queued line, not just the last). */
    excludeMessageIds?: string[];
    /** Routines run in detached tasks; pin the destination for the whole turn. */
    threadId?: string;
    /** Cloud routines run the whole agent inside the bot's Box VM instead
     * of merely mounting that VM's computer tools on the MAUS's provider. */
    runOn?: RoutineRunOn;
    /** Lets the system prompt put externally supplied payloads behind an
     * explicit untrusted-data boundary without changing ordinary chat. */
    automationSource?: RoutineRunTrigger;
    /** the caller was already running unattended, so this turn is too */
    unattended?: boolean;
    /** ask_bot delivery: the bot whose words this user-role line carries,
     * recorded on the message itself (Message.peerAsk). */
    peerAsk?: Message["peerAsk"];
    /** Resume an agent after the user completed an inline connection or credential card.
     * The prompt is control-plane context: it reaches the provider without
     * masquerading as another message authored by the user. */
    cardContinuation?: boolean;
    /** Earlier text message this user turn is replying to. */
    replyTo?: Message;
    /** Stable identity supplied by the composer so a network retry cannot
     * dispatch the same user action twice. */
    sendId?: string;
    onDispatchError?: (message: string) => void;
  },
) {
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
  if (bot.approvalGrant) {
    throw Object.assign(new Error("this bot's approval level is still being confirmed — try again"), { status: 409 });
  }
  const transitionError = providerTransitionForTurn(bot, opts?.runOn);
  if (transitionError) throw Object.assign(new Error(transitionError), { status: 409 });
  if (checkpointRestoreLeases.has(botId)) {
    throw Object.assign(new Error("this bot's project files are being restored — wait for the restore to finish"), {
      status: 409,
    });
  }
  if (boxLifecycleBusyBots.has(botId)) {
    throw Object.assign(new Error("this bot's cloud computer is being changed — wait for it to finish"), { status: 409 });
  }
  if (bot.busy) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });
  const threadId = opts?.threadId ?? bot.threadId;
  // Retire anything a previous turn left behind before minting this turn's
  // integrations. Completion and interrupt paths do the same; this is the
  // final backstop against a retained proxy process.
  revokeInternalCapabilitiesForThread(threadId);
  // a webhook turn, or one inherited from a bot already running unattended
  if (opts?.automationSource === "webhook" || opts?.unattended) markUnattended(bot.id);
  // a person typing into this bot ends the unattended window immediately
  else if (opts?.automationSource === undefined && !opts?.commsDepth && !opts?.cardContinuation) {
    clearUnattended(bot.id);
    delegationWakeBudget.reset(threadId);
  }
  const task = store.taskByThread(bot.id, threadId);
  if (!task) throw Object.assign(new Error("no such task"), { status: 404 });
  const instance = opts?.runOn === "cloud"
    ? registry.instances().find((candidate) => candidate.driverKind === "boxAgent") ?? null
    : registry.get(bot.modelSelection.instanceId);
  if (!instance) {
    throw Object.assign(
      new Error(
        opts?.runOn === "cloud"
          ? "the Cloud VM runner is unavailable — configure Box in App Settings"
          : `provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`,
      ),
      { status: 409 },
    );
  }
  // Resolve only transport tags from this newly submitted text. The original
  // string remains the durable message. Native-image providers get a
  // path-free prompt and bounded inputs instead of needing a Read tool;
  // path-reading drivers retain the attachment tag as their compatibility route.
  const resolvedImages = extractTurnImages(text);
  const usesNativeImageInput = instance.adapter.capabilities.nativeImageInput === true;
  const providerText = usesNativeImageInput ? resolvedImages.text : text;
  const turnImages = usesNativeImageInput ? resolvedImages.images : [];
  const commsDepth = opts?.commsDepth ?? 0;
  // Classify the turn where the peer paths' depth actually arrives: by the
  // time it settles, the fold has only a thread id to go on.
  if (commsDepth > 0) markInternalTurn(threadId);
  else clearInternalTurn(threadId);
  // a task takes its name from the first thing you asked it to do
  if (resolvedImages.text.trim() && !opts?.cardContinuation) {
    store.titleTaskFromFirstMessage(bot.id, resolvedImages.text, threadId);
  }

  console.error(`[omb-turn] bot=${botId} text=${JSON.stringify(resolvedImages.text.slice(0, 70))} images=${turnImages.length} depth=${commsDepth} card=${Boolean(opts?.cardContinuation)}`);
  const instanceId = instance.instanceId;
  const model = opts?.runOn === "cloud" ? instance.models.default : bot.modelSelection.model;
  // a cloud routine borrows the instance default model, so it borrows no
  // per-bot effort either
  const effort = opts?.runOn === "cloud" ? undefined : bot.modelSelection.effort;
  // A selection can be persisted while its engine is offline. Re-check when
  // the engine returns so an old or unsupported value never reaches a CLI.
  if (effort && !instance.adapter.capabilities.effortLevels?.includes(effort)) {
    throw Object.assign(
      new Error(`effort "${effort}" is not offered by this bot's engine — choose another level in settings`),
      { status: 409 },
    );
  }

  // an edit hands us its already-branched user message; a plain send appends
  let userMessage = opts?.userMessage;
  if (!userMessage) {
    userMessage = opts?.cardContinuation
      ? { id: `card-${randomUUID()}`, at: Date.now(), role: "user", kind: "text", text }
      : store.appendMessage(threadId, {
          role: "user",
          kind: "text",
          text,
          replyToId: opts?.replyTo?.id,
          sendId: opts?.sendId,
          peerAsk: opts?.peerAsk,
        });
  }
  // A card continuation neither starts nor ends the person's ask: it
  // resumes the turn their last message began, so that record stands.
  if (!opts?.cardContinuation) {
    if (commsDepth === 0 && opts?.automationSource === undefined && !opts?.unattended) {
      personAskAt.set(threadId, userMessage.at);
    } else {
      personAskAt.delete(threadId);
    }
  }

  // transcript for API-backed drivers: settled text turns on the ACTIVE
  // branch only — abandoned forks never reach the model
  const skipTranscript = new Set<string>([userMessage.id, ...(opts?.excludeMessageIds ?? [])]);
  const activeMessages = store.activePath(threadId);
  // A flat reply may deliberately point across a fork in the same thread.
  // Resolve its quote from full storage, while the replay itself remains
  // strictly limited to the selected branch below.
  const messagesById = new Map(store.messagesFor(threadId).map((message) => [message.id, message]));
  const transcript = activeMessages
    .filter((m) => m.kind === "text" && m.text && !skipTranscript.has(m.id))
    .slice(-40)
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      text: transcriptText(m, messagesById, cfg.profile?.name?.trim() || "User"),
    }));

  // After a rewind (edit / branch switch) the provider's native session
  // still contains the abandoned branch: start a fresh session instead of
  // resuming, and for cursor-resuming drivers replay the surviving path
  // inline (transcript-replay drivers get it via transcript). The flag is
  // cleared only once the turn is actually dispatched — clearing it here
  // would cost the next attempt its history if this dispatch fails.
  const rewound = threadId === bot.threadId && Boolean(bot.rewound);
  // A fresh engine — the user switched this bot's model mid-thread — has no
  // current session here either, so it gets the same replay. Distinct from
  // rewound: the OTHER instances' cursors are left alone (a rewind wipes
  // them all), and "fresh" is decided by who ran the last turn, not by
  // whether we hold a cursor — see engineIsFresh.
  const externalContextMarker = isExternalContextMarker(task.lastInstanceId)
    ? task.lastInstanceId
    : undefined;
  const fresh =
    !rewound &&
    !externalContextMarker &&
    engineIsFresh({ instanceId, lastInstanceId: task.lastInstanceId, resumeCursors: task.resumeCursors, transcript });
  // Agent-tool gate shared by skill authoring, the /setup turn-text rewrite,
  // the setup prompt block, and the peer-comms integration below: a driver
  // that never mounts agent tools (or a turn already at the comms-depth cap)
  // must not be steered into — or told about — tools it cannot call.
  const agentsMounted = commsDepth < MAX_COMMS_DEPTH && instance.adapter.capabilities.agentsMcp === true;
  const skillAuthoring = skillRecorderEnabled(cfg) && agentsMounted;
  // Setup mode's turn-text rewrite (parseSetupCommand/expandSetupTurnText)
  // must not run ahead of a system prompt that can't explain it: a driver
  // without agent tools sees the user's literal "/setup ..." message. The
  // gate on whether the coaching block itself is active — setupModeActive,
  // which also depends on the bot's soul/description — is decided below,
  // from the same bot snapshot the prompt's soul is built from.
  const setupText = agentsMounted ? expandSetupTurnText(providerText) : providerText;
  const { turnText, resume } = buildTurnContext({
    text: promptWithReply(
      skillAuthoring ? expandLearnTurnText(setupText) : setupText,
      opts?.replyTo,
      cfg.profile?.name?.trim() || "User",
    ),
    transcript,
    rewound,
    fresh,
    externallyUpdated: Boolean(externalContextMarker),
    replaysNatively: instance.driverKind === "grok",
  });
  // Snapshot the cursor alongside the context decision. An external result
  // can arrive during async computer/setup work and clear the task cursor;
  // this already-built turn must either keep its old session or replay on the
  // following turn, never start a blank session with no transcript.
  const resumeCursor = resume ? task.resumeCursors[instanceId] : undefined;

  const persona = [
    `You are ${bot.name}, a personal bot in OpenMausBot.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
  ]
    .filter(Boolean)
    .join(" ");

  // The SOUL.md mirror is checked here, at dispatch, and only reported:
  // the prompt below reads bot.soul, never the file.
  {
    const drift = checkSoulDrift(bot.id, bot.soul ?? "", bot.soulHash ?? "");
    if (drift.drift !== Boolean(bot.soulDrift)) store.patchBot(bot.id, { soulDrift: drift.drift });
  }

  // busy flips immediately so the composer locks; the dispatch itself runs
  // in the background — box provisioning can take ~90s and must never
  // hang the HTTP request
  const dispatchClaimId = randomUUID();
  directTurnGenerationByBot.set(bot.id, dispatchClaimId);
  directTurnDispatchClaims.set(bot.id, { id: dispatchClaimId, threadId, phase: "setup" });
  beginInternalCapabilityGeneration(threadId, dispatchClaimId);
  store.setActivity(bot.id, "working");
  // The badge is "this bot answered you, and you have not looked yet". A
  // person starting a turn has looked; a teammate's hop has not — the fold
  // never re-marks an internal turn, so clearing here would silently spend
  // a signal the person still owes a glance to.
  if (commsDepth === 0) store.patchBot(bot.id, { unread: false });
  turnUsage.delete(threadId);

  void (async () => {
    try {
      const integrations: NonNullable<Parameters<typeof instance.adapter.sendTurn>[0]["integrations"]> = {};
      let browser: Awaited<ReturnType<typeof browserIntegration>> = null;
      const selectedSkills = selectBundledSkills(
        providerText,
        [
          ...(instance.adapter.capabilities.phoneMcp === true ? ["phoneMcp"] : []),
          ...(skillAuthoring ? ["skillAuthoring"] : []),
        ],
        availableSkills(),
      );
      if (selectedSkills.some((skill) => skill.manifest.requiredCapabilities.includes("phoneMcp"))) {
        integrations.phone = phoneIntegration();
      }
      // the user's connected apps, but only to a driver that can mount
      // them — a key in the config says the connections exist, not that
      // this engine can reach them — and only to a bot the user has not
      // switched off: the key is workspace-wide, the grant is per bot.
      if (bot.composio !== false && composio.configured(cfg) && instance.adapter.capabilities.composioMcp === true) {
        const connection = await connectedAppsIntegration(bot.id, threadId, dispatchClaimId);
        if (connection) integrations.composio = connection;
      }
      // user-configured MCP servers (config.json mcpServers): same rule as
      // composio — only to a driver that can mount them. Their tools are
      // never pre-allowed, so every call rides the normal permission flow.
      if (instance.adapter.capabilities.customMcp === true) {
        const custom = customMcpServers(cfg);
        if (Object.keys(custom).length) integrations.custom = custom;
      }
      // CLI engines work inside the bot's own workspace directory rather
      // than the user's home: a bot with file tools and acceptEdits gets a
      // desk, not the whole house — and the workspace is where its
      // MEMORY.md lives. API/box engines have no local filesystem story.
      const worksInWorkspace = instance.driverKind !== "grok" && instance.driverKind !== "boxAgent";
      const privateWorkspace = worksInWorkspace ? ensureWorkspace(bot.id) : undefined;
      const skillInstructions = renderSkillInstructions(selectedSkills, {
        includeRoot: worksInWorkspace && opts?.runOn !== "cloud",
      });
      const packagePlaybooks = installedPlaybookInstructions(providerText, bot.playbooks);
      // An explicit working folder wins for new tasks; otherwise they use
      // the private bot workspace. A legacy task with an existing provider
      // session deliberately pins to null (the old home-folder behavior),
      // because moving a live session would break resume.
      // A cloud run happens on the box, where a host folder means nothing:
      // pin the task to the default so the header chip never shows the
      // bot's folder for a task that runs elsewhere.
      if (opts?.runOn === "cloud") store.pinTaskCwd(bot.id, threadId, undefined, { none: true });
      const pinnedCwd =
        privateWorkspace && opts?.runOn !== "cloud"
          ? store.pinTaskCwd(bot.id, threadId, privateWorkspace)
          : null;
      const cwd = pinnedCwd ?? undefined;
      // Checkpoint explicit project folders, where a bot can overwrite the
      // user's work. Its private OpenMaus workspace is app-owned and changes
      // on nearly every ordinary chat; snapshotting it would add hidden disk
      // and process overhead without a user project to restore.
      const checkpointCwd = cwd && cwd !== privateWorkspace ? cwd : undefined;
      // dweb is opt-in: without an explicit daemon URL, do not advertise
      // tools that would fail on every call or spawn an unnecessary proxy.
      const dwebUrl = process.env.DWEB_URL?.trim();
      if (dwebUrl) integrations.dweb = { url: dwebUrl };
      // Cloud routines always use Box/BoxAgent. The per-bot backend applies
      // only to ordinary turns that mount a computer into the local agent.
      const cloudBackend = opts?.runOn === "cloud" || bot.cloudBackend !== "vps" ? "box" : "vps";
      const mountsComputerMcp = instance.adapter.capabilities.computerMcp === true;
      const mountsCloudComputer = mountsComputerMcp || instance.driverKind === "boxAgent";
      const mountsLocalComputer = instance.adapter.capabilities.localComputerMcp === true;
      // Where this turn's hands may land. The bot's "Works on" choice is
      // strict; a browser-only bot gets no computer at all, and a bot whose
      // browser is withheld (workspace flag, its own switch, or an engine
      // without browser tools) gets told so instead of silently falling back
      // to a desktop it was never meant to touch.
      const browserOn =
        builtInBrowserEnabled(cfg) &&
        bot.browser !== false &&
        instance.adapter.capabilities.browserMcp === true;
      const plan = resolveSurface({
        destination: opts?.runOn === "cloud" ? "cloud" : bot.computer, // cloud routine overrides the MAUS default
        browserOn,
      });
      if (bot.computer === "browser" && plan.computer === "off" && instance.driverKind === "boxAgent") {
        throw new Error("the Computer engine works on the cloud computer — set Works on to Cloud, or choose another engine");
      }
      const wants = plan.computer;
      let previewCapture: (() => Promise<{ png: string; format: string }>) | null = null;
      let computerKind: "box" | "vps" | "vm" | "local" | null = null;
      let autoVpsProblem: string | null = null;

      // Explicit destinations are strict. In particular, Local VM must never
      // fall through to host CUA and accidentally click on the user's Mac.
      if (wants === "vm") {
        if (!mountsComputerMcp || instance.driverKind === "boxAgent") {
          throw new Error("this model engine cannot use the Local VM — choose Claude or an ACP engine, or select another computer destination");
        }
        const localVmTarget = localVmTargetForBot(bot.id);
        if (localVmImageBusy || localVmModeChangeBusy || localVmLifecycleBusy.has(localVmTarget.key)) {
          throw new Error("this Local VM is being started, stopped, or replaced — wait for setup to finish");
        }
        // Claim before the first await. The lifecycle route performs its
        // matching check synchronously, so neither side can enter while the
        // other is between inspection and mutation.
        if (!localVmLeaseFor(localVmTarget).claim(threadId, bot.id, localVmOwnerBusy)) {
          throw new Error("this Local VM is already being used by another turn — wait for that turn to finish");
        }
        localVmThreadTargets.set(threadId, localVmTarget);
        localVmActiveThreads.set(localVmTarget.key, threadId);
        localVmIdleFor(localVmTarget).touch();
        const localVm = await readyLocalVmForTurn(bot.id, localVmTarget);
        if (!localVm.ready || !localVm.runtime) {
          throw new Error(`${localVm.problem ?? "the Local VM is not ready"} (App Settings → Computers)`);
        }
        integrations.localComputer = containerComputerMcp(
          localVm.runtime,
          controlIntegration(bot.id, threadId, dispatchClaimId),
          localVmTarget,
        );
        computerKind = "vm";
        // Same contract as the Box and VPS branches below: without this the
        // poller never starts, so the Local VM publishes no `screen` events
        // and every client that only has the stream (the phone) waits
        // forever. The web panel hid the gap by polling the screenshot
        // route itself.
        previewCapture = () => {
          // The shared desktop outlives the turn. Once another thread owns
          // it, a capture still in flight would picture ITS work under this
          // bot's name — live and in the settled transcript frame, which is
          // taken after the lease is already released. No owner means the
          // desktop is simply idle: that final frame is ours to keep.
          const owner = localVmLeaseFor(localVmTarget).current(localVmOwnerBusy);
          if (owner && owner.threadId !== threadId) {
            throw new Error("the Local VM moved on to another turn");
          }
          return containerComputerFrame(undefined, undefined, localVmTarget);
        };
      } else if (wants === "local") {
        if (!shouldMountLocalComputer({
          requested: "local",
          hostPlatform: process.platform,
          providerSupportsLocal: mountsLocalComputer,
        })) {
          throw new Error("this model engine cannot control this computer — choose Claude or an ACP engine, or select another destination");
        }
        const cua = readCuaConnection();
        if (!cua) throw new Error("CUA Driver is not ready for this computer — check permissions and restart OpenMausBot");
        integrations.localComputer = cua;
        computerKind = "local";
      }

      // A VPS is a local-agent computer mount, never a remote agent runner.
      // Explicit Cloud may prepare/start it. Auto remains read-only unless
      // the person explicitly opted this bot into remote lifecycle actions.
      if ((wants === "cloud" || wants === undefined) && cloudBackend === "vps") {
        const unsupported = vps.vpsDriverError(instance.driverKind, mountsComputerMcp);
        if (unsupported && wants === "cloud") throw new Error(unsupported);
        if (unsupported && wants === undefined) autoVpsProblem = unsupported;
        if (!unsupported) {
          activeVpsThreads.set(bot.id, threadId);
          const remote = wants === "cloud" || bot.autoStartVps
            ? await vps.vpsComputerAction("provision", cfg, bot.id)
            : await vps.inspectVpsForAuto(cfg, bot.id);
          if (remote?.ready && remote.sshAlias) {
            const targetCfg = { ...cfg, vps: { sshAlias: remote.sshAlias } };
            const vpsMcp = vps.vpsComputerMcp(targetCfg, bot.id, remote.container_id ?? undefined);
            const vpsControl = controlIntegration(bot.id, threadId, dispatchClaimId);
            integrations.localComputer = {
              ...vpsMcp,
              env: { ...vpsMcp.env, OMB_CONTROL_URL: vpsControl.url, OMB_CONTROL_TOKEN: vpsControl.token },
            };
            computerKind = "vps";
            previewCapture = () => vps.vpsComputerScreenshot(targetCfg, bot.id);
          } else {
            activeVpsThreads.delete(bot.id);
            if (wants === "cloud") {
              throw new Error(remote?.problem ?? "the VPS computer could not be created or reached");
            }
            autoVpsProblem = remote?.problem ?? "the VPS computer could not be reached";
          }
        }
      }

      // Cloud is also strict when explicitly selected. Auto (unset) reuses an
      // existing cloud box, then falls back to host CUA without provisioning.
      if ((wants === "cloud" || wants === undefined) && cloudBackend === "box" && box.boxConfigured(cfg)) {
        if (!mountsCloudComputer && wants === "cloud") {
          throw new Error("this model engine cannot use computer tools — choose Claude, an ACP engine, or the Computer engine");
        }
        let b = await box.findBox(cfg, bot.id).catch(() => null);
        let lifecycle = box.boxTurnLifecycleAction({
          explicitCloud: wants === "cloud",
          canMount: mountsCloudComputer,
          state: typeof b?.state === "string" ? b.state : null,
        });
        if (lifecycle === "provision") {
          broadcast({ kind: "computer", botId: bot.id, state: "provisioning" });
          await box.provisionBox(cfg, bot.id, bot.name);
          b = await box.findBox(cfg, bot.id).catch(() => null);
          lifecycle = box.boxTurnLifecycleAction({
            explicitCloud: true,
            canMount: mountsCloudComputer,
            state: typeof b?.state === "string" ? b.state : null,
          });
        }
        // an archived box answers every action with an error until it
        // resumes — wake it here, once, instead of letting the agent
        // discover it one failed tool call at a time. Explicit Cloud is the
        // consent boundary for the resume (~8s, and it un-pauses billing).
        if (lifecycle === "wake") {
          broadcast({ kind: "computer", botId: bot.id, state: "waking" });
          b = (await box.readyBox(cfg, bot.id).catch(() => null)) ?? b;
          lifecycle = box.boxTurnLifecycleAction({
            explicitCloud: true,
            canMount: mountsCloudComputer,
            state: typeof b?.state === "string" ? b.state : null,
          });
        }
        if (b && lifecycle === "attach") {
          previewCapture = () => box.screenshotBox(cfg, bot.id, b!.id);
          if (mountsCloudComputer) {
            integrations.computer = {
              kind: "box",
              boxId: b.id,
              token: cfg.box!.token!,
              control: controlIntegration(bot.id, threadId, dispatchClaimId),
            };
            computerKind = "box";
          }
        }
      }
      if (wants === "cloud" && cloudBackend === "box" && !box.boxConfigured(cfg)) {
        throw new Error("Cloud box is not configured — add a Box API key or choose Local VM");
      }
      if (wants === "cloud" && cloudBackend === "box" && !integrations.computer) {
        throw new Error("the cloud computer could not be created or reached");
      }

      // Auto-only host fallback. Electron owns cua-driver/TCC attribution;
      // the harness only reads its already-running connection descriptor.
      if (
        !integrations.computer &&
        !integrations.localComputer &&
        wants === undefined &&
        shouldMountLocalComputer({
          requested: undefined,
          hostPlatform: process.platform,
          providerSupportsLocal: mountsLocalComputer,
        })
      ) {
        const cua = readCuaConnection();
        if (cua) {
          integrations.localComputer = cua;
          computerKind = "local";
        }
      }
      if (
        wants === undefined &&
        cloudBackend === "vps" &&
        !integrations.computer &&
        !integrations.localComputer &&
        autoVpsProblem
      ) {
        const hint = bot.autoStartVps
          ? "Check the VPS connection in App Settings → Connections."
          : "Open Computer and enable Start VPS automatically, or choose Cloud to start it manually.";
        throw new Error(`${autoVpsProblem}. ${hint}`);
      }
      // Agent control tools include peer comms and the secure credential
      // request card. A comms-invoked turn (depth ≥ cap) gets none — hard recursion
      // stop, so the user's tokens can't be burned by a bot-to-bot loop.
      // Only drivers that mount the tools get the integration (and, via the
      // integrations.agents gate below, the prompt hint) — a bot on a driver
      // without it must not be told about tools it cannot call. Any bot can
      // still be the TARGET of ask_bot regardless of its driver.
      // One reachability rule for the roster, list_bots and @mention
      // resolution: a bot is never told about — or nudged toward — a peer
      // that ask_bot and delegate_bot would then refuse.
      const sectionPeers = reachablePeers(store.bots, bot);
      if (agentsMounted) {
        integrations.agents = agentsIntegration(bot.id, threadId, commsDepth, skillAuthoring, dispatchClaimId);
      }
      // @mentions in the user's message (the composer's tagging UI) become
      // an explicit coordination nudge. The agent still chooses the matching
      // peer tool, so the harness stays the single owner of turns/permissions.
      const tagged = integrations.agents
        ? mentionedBots(
            providerText,
            sectionPeers,
          )
        : [];
      const coordinationPrompt = bot.chiefOfStaff
        ? chiefOfStaffSystemPrompt(
            bot.id,
            store.bots,
            Boolean(integrations.agents),
            openMausStatusSystemPrompt(),
          )
        : integrations.agents && sectionPeers.length > 0
          // Ordinary bots could always CALL the peer tools; until now the
          // one generic sentence they got never named a teammate, so the
          // first move of any collaboration was a list_bots round trip the
          // model mostly did not think to make.
          ? peerRosterSystemPrompt(sectionPeers)
          : "";
      const credentialPrompt = integrations.agents ? CREDENTIAL_PROMPT : "";
      const routinePrompt = integrations.agents ? ROUTINE_PROMPT : "";
      const profilePrompt = integrations.agents ? PROFILE_PROMPT : "";
      const recallPrompt = integrations.agents ? SESSION_SEARCH_SYSTEM_PROMPT : "";
      const learnPrompt = skillAuthoring ? LEARN_PROMPT : "";

      // (activeVpsThreads was already claimed above, before the provision or
      // reuse await, so the backend guards saw this turn the whole time.)
      // Wait immediately before dispatch: resources are already claimed, but
      // the engine cannot edit the project until the snapshot has settled.
      // snapshot() absorbs failures, so checkpointing may delay but never fail
      // a turn.
      if (checkpointCwd) await checkpoints.snapshot(bot.id, checkpointCwd, `turn ${threadId.slice(0, 8)}`);
      if (!directTurnClaimIsCurrent(bot.id, dispatchClaimId, threadId)) {
        throw new DirectTurnSetupCancelled("turn stopped before dispatch");
      }
      // Mint the browser bearer at the last possible moment. The desktop
      // registration is asynchronous, so validate this exact setup claim
      // again inside browserIntegration before the capability is published.
      // Also the one bot snapshot setupModeActive and the prompt's soul
      // (below) share, so a soul saved mid-dispatch is seen by both instead
      // of the two disagreeing about whether setup mode is still active.
      const liveBot = store.bot(bot.id);
      const setupMode =
        agentsMounted &&
        setupModeActive({
          soul: liveBot?.soul ?? bot.soul,
          description: liveBot?.description ?? bot.description,
          text: providerText,
        });
      if (
        liveBot &&
        plan.browser &&
        builtInBrowserEnabled(cfg) &&
        liveBot.browser !== false &&
        instance.adapter.capabilities.browserMcp === true
      ) {
        const selectedProfile = liveBot.browserProfile;
        browser = browserIntegration(bot.id, selectedProfile);
        if (browser) integrations.browser = browser.integration;
      }
      // A cancelled adapter can be between accepting sendTurn and revealing
      // its provider turn id. Never overlap a replacement with that ambiguous
      // pre-id window: wait for the old handshake to settle or for its bounded
      // quarantine to expire, then revalidate this exact claim before launch.
      await pendingCancelledProviderHandshakes.waitForClear(threadId);
      if (!markDirectTurnDispatching(bot.id, dispatchClaimId, threadId)) {
        throw new DirectTurnSetupCancelled("turn stopped before dispatch");
      }
      watchdog.watch(threadId, bot.id);
      const computerPromptKind: ComputerPromptKind | null =
        computerKind === "vm"
          ? localVmMode(cfg) === "per-bot" ? "vm-private" : "vm-shared"
          : computerKind === "box"
            ? instance.driverKind === "boxAgent" ? "box-agent" : "box"
            : computerKind === "vps"
              ? "vps"
              : computerKind === "local"
                ? "local"
                : null;
      const prompt = buildSystemPrompt(persona, liveBot?.soul ?? bot.soul ?? "", [
        // first after the soul: the block names agent tools, so it only goes
        // to a turn whose engine actually mounted them (setupMode is already
        // false when they are not — see agentsMounted above)
        { id: "setup", label: "Setup", text: setupSystemPrompt(setupMode, { skills: skillAuthoring, cwd: liveBot?.cwd ?? bot.cwd }) },
        { id: "computer", label: "Computer", text: computerPrompt(computerPromptKind) },
        { id: "plan", label: "Surface", text: plan.note },
        // gated on the integration, not the key: the hint only goes to a
        // bot whose driver actually mounted the tools
        { id: "composio", label: "Connected apps", text: integrations.composio ? COMPOSIO_PROMPT : "" },
        { id: "browser", label: "Browser", text: integrations.browser ? BUILT_IN_BROWSER_SYSTEM_PROMPT : "" },
        { id: "coordination", label: "Team", text: coordinationPrompt ? ` ${coordinationPrompt}` : "" },
        { id: "credential", label: "Credentials", text: credentialPrompt },
        { id: "recall", label: "Recall", text: recallPrompt },
        { id: "routine", label: "Routines", text: routinePrompt },
        { id: "profile", label: "Profile changes", text: profilePrompt },
        { id: "learn", label: "Skill authoring", text: learnPrompt },
        { id: "section-context", label: "Section context", text: sectionContextSystemPrompt(bot.section) },
        { id: "memory", label: "Memory", text: privateWorkspace ? memorySystemPrompt(bot.id) : "" },
        { id: "skills", label: "Skills index", text: privateWorkspace ? skillsSystemPrompt(bot.id) : "" },
        { id: "skill-instructions", label: "Skill instructions", text: skillInstructions },
        { id: "playbooks", label: "Playbooks", text: packagePlaybooks },
        { id: "webhook", label: "Webhook provenance", text: opts?.automationSource === "webhook" ? WEBHOOK_PROMPT : "" },
        { id: "mentions", label: "Mentions", text: mentionPrompt(tagged) },
      ]);
      const dispatch = await guardTurnDispatch(instance.adapter.sendTurn({
        threadId,
        text: turnText,
        images: turnImages,
        approvalMode: approvalModeForTurn(liveBot ?? bot, commsDepth > 0),
        model,
        effort,
        // a rewound thread never resumes the abandoned branch's session
        // the active task's own session — another task's cursor would
        // resume the wrong conversation and defeat the context bubble
        resumeCursor,
        transcript,
        system: prompt.text,
        integrations,
        cwd,
      }), () => !directTurnClaimExists(bot.id, dispatchClaimId, threadId), async () => {
        await instance.adapter.interruptTurn(threadId).catch(() => {});
      });
      if (dispatch.cancelled) {
        retireProviderTurn(dispatch.value.turnId);
        throw new DirectTurnSetupCancelled("turn stopped during provider setup");
      }
      bindInternalCapabilityToProviderTurn(threadId, dispatchClaimId, dispatch.value.turnId);
      clearDirectTurnDispatch(bot.id, dispatchClaimId);
      // dispatched: the rewind is spent, and the old cursors are dead
      if (rewound) store.patchBot(bot.id, { rewound: false, resumeCursors: {} });
      // and this engine now owns the thread's most recent turn
      // Consume exactly the external-update generation this turn replayed.
      // If a newer delegated result landed during setup, its unique marker
      // differs and must survive so the next turn also receives that update.
      if (!isExternalContextMarker(task.lastInstanceId) || task.lastInstanceId === externalContextMarker) {
        store.markTaskDispatched(bot.id, threadId, instanceId);
      }
      // a turn can settle before dispatch returns, and a poller started
      // after its own turn.completed would never be torn down — it would
      // keep polling the box forever, carrying dead per-turn state. busy
      // is flipped false in the fold, so it is the honest "still running".
      if (previewCapture && store.bot(bot.id)?.busy) {
        startScreenPoller(bot.id, previewCapture, { screenIsTheWork: instance.driverKind === "boxAgent" });
      }
      // An adapter may publish completion synchronously just before its
      // dispatch promise resolves. The event could not use the turn-id map
      // above yet, so close this exact generation from durable busy state.
      if (store.bot(bot.id)?.busy !== true) {
        revokeInternalCapabilityGeneration(threadId, dispatchClaimId);
      }
    } catch (e) {
      clearCancelledProviderHandshake(threadId, `direct:${dispatchClaimId}`);
      clearDirectTurnDispatch(bot.id, dispatchClaimId);
      revokeInternalCapabilityGeneration(threadId, dispatchClaimId);
      const ownsLatestGeneration = directTurnGenerationByBot.get(bot.id) === dispatchClaimId;
      if (ownsLatestGeneration) {
        releaseLocalVmThread(threadId);
        if (activeVpsThreads.get(bot.id) === threadId) activeVpsThreads.delete(bot.id);
        watchdog.settle(threadId);
        turnUsage.delete(threadId);
      }
      if (e instanceof DirectTurnSetupCancelled) {
        opts?.onDispatchError?.(e.message);
        if (ownsLatestGeneration && store.bot(bot.id)?.busy) {
          store.setActivity(bot.id, "idle");
          retryDelegationsWaitingOn(bot.id);
        }
        if (ownsLatestGeneration) {
          drainQueuedSends();
          drainConnectorResumes();
          drainSecretResumes();
          drainDelegationWakes();
        }
        return;
      }
      if (!ownsLatestGeneration) return;
      const message = e instanceof Error ? e.message : String(e);
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `error: ${message.slice(0, 160)}`, ok: false },
      });
      // Worth a buzz for the same reason a routine failure is, and the rule
      // notify.ts encodes: the bot is not working, and the cause is usually
      // a setting only a person can change — an unattended user would
      // otherwise learn nothing until they next opened the thread.
      //
      // Only for a turn the person started themselves. A routine reaches
      // this same catch and then reports through onDispatchError, which
      // raises routine-failed; buzzing here too would ring twice for one
      // failure. A delegated sub-turn is reported to the bot that asked
      // for it, in its own thread, so it does not need a second channel.
      if (opts?.automationSource === undefined && !opts?.commsDepth && !opts?.cardContinuation) {
        notify(
          buildNotification("turn-failed", bot, threadId, redactSecretsInText(message), { avatarUrl: bot.avatarUrl }),
        );
      }
      store.setActivity(bot.id, "idle");
      retryDelegationsWaitingOn(bot.id);
      opts?.onDispatchError?.(message);
      // a dispatch failure never emits turn.completed, so the settle-driven
      // drain would strand anything queued behind this turn
      drainQueuedSends();
      drainConnectorResumes();
      drainSecretResumes();
      drainDelegationWakes();
    }
  })();
  return userMessage;
}

// ── routines: persisted definitions → detached bot tasks ───────────────
// The scheduler owns timing and receipts; the existing harness remains the
// only owner of provider sessions, approvals, tools, computers and messages.
function routineSourceOwner(run: RoutineRun) {
  const threadId = run.sourceThreadId?.trim();
  if (!threadId) return null;
  // Validate before messagesFor(): Store lazily opens transcript storage, so
  // reading an orphan id first would recreate a deleted conversation.
  const bot = store.bot(run.botId);
  if (!bot) return null;
  if (store.taskByThread(bot.id, threadId)) return { bot, group: undefined, threadId };
  const group = store.groupByThread(threadId);
  return group?.memberIds.includes(bot.id) ? { bot, group, threadId } : null;
}

function routineSourceThread(run: RoutineRun): string | null {
  return routineSourceOwner(run)?.threadId ?? null;
}

function routineRunCard(run: RoutineRun): NonNullable<Message["routineRun"]> {
  const visibleSummary = run.status === "waiting" ? run.attention : run.output;
  const summary = visibleSummary ? redactSecretsInText(visibleSummary).slice(0, 2_000) : undefined;
  const error = run.error ? redactSecretsInText(run.error).slice(0, 500) : undefined;
  const card: NonNullable<Message["routineRun"]> = {
    runId: run.id,
    routineId: run.routineId,
    routineName: redactSecretsInText(run.routineName),
    status: run.status,
  };
  if (run.goalStatus) card.goalStatus = run.goalStatus;
  if (run.threadId) card.executionThreadId = run.threadId;
  if (summary) card.summary = summary;
  if (error) card.error = error;
  return card;
}

function routineRunFallbackText(card: NonNullable<Message["routineRun"]>): string {
  const goalState = card.goalStatus === "needs-input"
    ? "needs your input"
    : card.goalStatus === "blocked"
      ? "was blocked"
      : card.goalStatus === "limit-reached"
        ? "reached its limit"
        : card.goalStatus === "stopped"
          ? "was stopped"
          : card.goalStatus === "failed"
            ? "failed"
            : undefined;
  const state = goalState ?? (
    card.status === "waiting"
      ? "needs your attention"
      : card.status === "completed"
        ? "completed"
        : card.status === "failed"
          ? "failed"
          : card.status === "cancelled"
            ? "was cancelled"
            : card.status === "missed"
              ? "was missed"
              : card.status
  );
  return `Routine “${card.routineName}” ${state}`;
}

/** Upsert one durable lifecycle card per run. Replaying the same transition,
 * including restart recovery, patches the existing run id instead of adding
 * another chat message. */
function syncRoutineRunToSource(run: RoutineRun): string | null {
  const source = routineSourceOwner(run);
  if (!source) return null;
  const sourceThreadId = source.threadId;
  const card = routineRunCard(run);
  const text = routineRunFallbackText(card);
  const existing = store.messagesFor(sourceThreadId).find(
    (message) => message.kind === "routine.run" && message.routineRun?.runId === run.id,
  );
  const statusChanged = existing?.routineRun?.status !== run.status;
  if (existing) {
    store.patchMessage(sourceThreadId, existing.id, { text, routineRun: card });
  } else {
    const message: Omit<Message, "id" | "at"> = {
      role: "bot",
      kind: "routine.run",
      text,
      routineRun: card,
    };
    if (source.group) {
      message.from = { botId: source.bot.id, name: source.bot.name, color: source.bot.color };
    }
    store.appendMessage(sourceThreadId, message);
  }

  // Merely queueing/running is ambient progress. Attention and terminal
  // states become unread in the conversation where the user asked for them.
  if (statusChanged && ["waiting", "completed", "failed", "missed"].includes(run.status)) {
    if (source.group) store.patchGroup(source.group.id, { unread: true });
    else store.patchBot(source.bot.id, { unread: true });
  }
  return sourceThreadId;
}

async function interruptRoutineGroupGoal(
  groupId: string,
  threadId: string,
  outcome?: { status: "stopped" | "limit-reached"; detail: string },
): Promise<void> {
  const speaker = groupSpeakers.get(threadId);
  const bot = speaker ? store.bot(speaker.botId) : undefined;
  cancelGroupTurnOperations(groupId, threadId, outcome);
  revokeInternalCapabilitiesForThread(threadId);
  await (bot ? registry.get(bot.modelSelection.instanceId) : undefined)
    ?.adapter.interruptTurn(threadId)
    .catch(() => {});
  closeOpenApprovals(threadId);
}

/** Stop work that may have captured Full/Custom before a fail-closed Ask
 * compensation arrived over Electron's private channel. Cancellation flags
 * are flipped synchronously; the awaited work only drains capabilities and
 * interrupts the already-started provider process. */
async function stopBotForEmergencyApprovalDowngrade(botId: string): Promise<void> {
  const bot = store.bot(botId);
  if (!bot) return;

  const routineRun = routines?.activeBotRunForBot(bot.id);
  if (routineRun) {
    if (routineRun.threadId) revokeInternalCapabilitiesForThread(routineRun.threadId);
    cancelDirectTurnDispatch(bot.id, routineRun.threadId);
    await routines!.cancelRun(routineRun.id);
    if (routineRun.threadId) closeOpenApprovals(routineRun.threadId);
    return;
  }

  const groupTurn = activeGroupTurnForBot(bot.id);
  if (groupTurn) {
    revokeInternalCapabilitiesForThread(groupTurn.threadId);
    cancelGroupTurnOperations(groupTurn.group.id, groupTurn.threadId);
    const results = await Promise.allSettled([
      registry.get(bot.modelSelection.instanceId)?.adapter.interruptTurn(groupTurn.threadId),
    ]);
    closeOpenApprovals(groupTurn.threadId);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    return;
  }

  const directClaim = cancelDirectTurnDispatch(bot.id);
  const threadId = directClaim?.threadId ?? bot.threadId;
  revokeInternalCapabilitiesForThread(threadId);
  const results = await Promise.allSettled([
    registry.get(bot.modelSelection.instanceId)?.adapter.interruptTurn(threadId),
  ]);
  closeOpenApprovals(threadId);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

routines = new RoutineManager({
  emit: broadcast,
  botState: (botId) => {
    const bot = store.bot(botId);
    return !bot ? "missing" : bot.busy ? "busy" : "ready";
  },
  goalState: (groupId, coordinatorBotId) => {
    const group = store.group(groupId);
    const coordinator = store.bot(coordinatorBotId);
    if (
      !group ||
      group.dm ||
      roomSetupPending(group) ||
      !coordinator ||
      coordinator.hidden ||
      !group.memberIds.includes(coordinator.id)
    ) {
      return "missing";
    }
    return groupIsWorking(group) || coordinator.busy ? "busy" : "ready";
  },
  createTask: (botId, title, activate = false) => {
    const task = store.createTask(botId, title, activate);
    const bot = store.bot(botId);
    if (task && bot) broadcast({ kind: "bot", bot: publicBot(bot) });
    return task;
  },
  createGoalTask: (groupId, title) => store.createGroupTask(groupId, title, false),
  startTurn: (botId, threadId, prompt, runOn, triggerSource, onDispatchError) =>
    startTurn(botId, prompt, { threadId, runOn, automationSource: triggerSource, onDispatchError })
      .then(() => undefined),
  startGoal: async (groupId, threadId, prompt, coordinatorBotId, runId, _onDispatchError) => {
    startGroupTurn(groupId, prompt, undefined, undefined, "goal", undefined, {
      threadId,
      goalCoordinatorBotId: coordinatorBotId,
      goalRunId: runId,
    });
  },
  interruptTurn: async (botId, threadId, runOn) => {
    const bot = store.bot(botId);
    cancelDirectTurnDispatch(botId, threadId);
    revokeInternalCapabilitiesForThread(threadId);
    const instance = runOn === "cloud"
      ? registry.instances().find((candidate) => candidate.driverKind === "boxAgent") ?? null
      : bot
        ? registry.get(bot.modelSelection.instanceId)
        : null;
    try {
      await instance?.adapter.interruptTurn(threadId);
    } finally {
      closeOpenApprovals(threadId);
    }
  },
  interruptGoal: interruptRoutineGroupGoal,
  onRunChanged: syncRoutineRunToSource,
  onRunFailed: (run) => {
    const bot = store.bot(run.botId);
    if (!bot) return;
    const detail = run.error ? `${run.routineName}: ${run.error}` : run.routineName;
    notify(buildNotification("routine-failed", bot, routineSourceThread(run) ?? run.threadId ?? bot.threadId, detail));
  },
});
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
routines.start();

// Chat tools can prepare routine changes, but the harness applies them only
// after the user confirms a durable card. Keeping this beside the scheduler
// makes the card resolvable after an app restart without involving the model.
async function cloudRoutineReadiness(): Promise<{ ready: boolean; reason?: string }> {
  if (!box.boxConfigured(cfg)) {
    return {
      ready: false,
      reason: "Cloud VM needs a working Box API key in App Settings before this routine can run.",
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
  cloudReady: cloudRoutineReadiness,
  canPersist: proposalPersistence,
  // Cross-bot routines: the confirmation card can sit open indefinitely, so
  // the target is re-authorized when the user confirms, not just at proposal.
  validateTarget: (proposerBotId, target) => {
    const proposer = store.bot(proposerBotId);
    const targetBot = store.bot(target.botId);
    if (!targetBot) return `@${target.name} no longer exists, so this routine cannot be scheduled for it`;
    if (!proposer || sectionKey(targetBot.section) !== sectionKey(proposer.section)) {
      return `@${target.name} is no longer in this section, so this routine cannot be scheduled for it`;
    }
    return null;
  },
});
const profileRequests = new ProfileRequestService({
  store,
  canPersist: proposalPersistence,
  // A Chief may change a section peer; anyone else only itself. Re-checked at confirm.
  validateTarget: (proposerBotId, targetBotId) => {
    const proposer = store.bot(proposerBotId);
    const target = store.bot(targetBotId);
    if (!target) return "that bot no longer exists";
    if (!proposer?.chiefOfStaff) return "only a section's Chief of Staff can change another bot's profile";
    if (sectionKey(target.section) !== sectionKey(proposer.section)) return "that bot belongs to a different section";
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
          }
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
  botState: (botId) => {
    const bot = store.bot(botId);
    return !bot ? "missing" : bot.busy ? "busy" : "ready";
  },
  enqueue: (input) => routines!.enqueueWebhook(input),
  cancelQueued: (webhookId, message) => routines!.cancelQueuedWebhook(webhookId, message),
  pendingRuns: (webhookId) => routines!.activeWebhookRunCount(webhookId),
});

let webhookIngress: WebhookIngress | null = null;
let webhookIngressError: string | null = null;
try {
  webhookIngress = await listenWebhookIngress(webhooks, { port: WEBHOOK_PORT, publicBaseUrl: WEBHOOK_PUBLIC_URL });
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
// ── group turn engine ──────────────────────────────────────────────────
// Room messages go to the configured default responder unless the user
// explicitly @mentions members. Responders run SEQUENTIALLY (one speaker at
// a time — the transcript and streaming bubble stay coherent), each on a
// fresh session with recent room context. A member's reply may @mention
// teammates; those get one chained turn (hop 1), never deeper.
const groupQueues = new Map<string, Promise<void>>();
const GROUP_CONTEXT_MESSAGES = 30;
const MAX_GROUP_HOPS = 1;

type GroupMemberTurnOutcome =
  | "settled"
  | "provider_failed"
  | "dispatch_failed"
  | "stalled"
  | "timed_out"
  | "cancelled"
  | "busy"
  | "unavailable";
type GroupTurnOrchestration = {
  systemInstructions: string;
  followMentions: boolean;
  result: { replyText?: string; outcome?: GroupMemberTurnOutcome; stopReason?: string | null };
  onClaimed?: () => void;
  onTurnStarted?: (turnId: string) => void;
};

function serializeRoomContext(
  threadId: string,
  userName: string,
  textOverride?: { messageId: string; text: string },
  readerBotId?: string,
): string {
  const messages = store.messagesFor(threadId);
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  return messages
    .filter((m) => m.kind === "text" && m.text)
    .slice(-GROUP_CONTEXT_MESSAGES)
    .map((m) => {
      const rendered = textOverride?.messageId === m.id ? { ...m, text: textOverride.text } : m;
      // a bot's name is quoted on the speaker line, so it gets one line; a
      // user line that came through the API says so, since the reader would
      // otherwise take it for the person typing
      const speaker = m.role === "user"
        ? m.via === "api" ? `${userName} (sent through the local API, not typed)` : userName
        : m.from ? peerName(m.from.name) : "Bot";
      const line = `${speaker}: ${transcriptText(rendered, messagesById, userName)}`;
      // A room reply is the room talking. A post_to_room message is another
      // bot's text carried in from somewhere else, so it says so — the
      // reader's own posts excepted, which would only be telling it about
      // itself.
      if (!m.peerPost || !m.from || m.from.botId === readerBotId) return line;
      return `${peerProvenanceNote({ botName: m.from.name, delivery: "post_to_room", unattended: m.peerPost.unattended })}\n${line}`;
    })
    .join("\n");
}


// comms bus: passed into the visibility helpers in comms-visibility.ts so
// they can mirror messages + chips without re-deriving SSE plumbing. Same
// shape every comms entry point uses (ask_bot, delegate_bot).
const commsBus: CommsBus = { store, broadcast };

// What each room has already taken from its bots. Keyed by room because the
// loop post_to_room can start is a property of the room, not of any one
// caller — three bots posting twice each is the same runaway as one bot
// posting six times. In memory only: a restart ends every turn that could
// have been mid-loop, so a fresh budget is the truthful state.
const roomPostBudgets = new Map<string, RoomPostBudget>();
/** Long enough for a real update, short enough that a room stays readable. */
const ROOM_POST_MAX_CHARS = 4_000;

// approval bus: peer-approval.ts only needs to push cards and broadcast
// them — its pending map lives in the module so the two respond endpoints
// can call resolvePeerComms without holding a reference back to here.
const approvalBus: ApprovalBus = { store, broadcast, notify };

// Approvals live only in memory, so any peer card still open on disk is one
// whose resolver died with the previous process. Left alone it can never be
// answered, and the composer stays disabled behind it — settle them at boot.
{
  const stale = dismissStalePeerCards(approvalBus);
  if (stale) console.log(`peer approvals: dismissed ${stale} card(s) left by a previous run`);
}

// Handoffs a previous process queued but never ran: the source turn is
// dead (no turn survives a restart) so they would otherwise wait forever.
// Run them now, through the same drain — target and approvePeerComms are
// re-checked there as always; a source bot that no longer exists is skipped.
_loadPending();
{
  const leftover = pendingThreads();
  if (leftover.length) console.log(`delegations: ${leftover.length} thread(s) with queued handoffs from a previous run — draining`);
  for (const threadId of leftover) drainDelegations(commsBus, approvalBus, threadId, runDelegatedTurn);
}

async function runGroupMemberTurn(
  groupId: string,
  threadId: string,
  botId: string,
  hop: number,
  // bots that already spoke for this user message — "@Scout ask @Pixel"
  // must not run Pixel twice (once chained, once as a direct responder)
  spoken: Set<string> = new Set(),
  cardContinuation?: string,
  onDispatchError?: (message: string) => void,
  isCancelled?: () => boolean,
  onProviderHandshakeStarted?: () => void,
  onProviderHandshakeSettled?: () => void,
  skillAuthoringClaim: { claimed: boolean } = { claimed: false },
  orchestration?: GroupTurnOrchestration,
  // chat rounds only: lets a chained @mention wait for a busy teammate the
  // way the responder loop does (goal runs never follow mentions)
  operation?: GroupTurnOperation,
  // Connected-app discovery yields before the bot is claimed. If an
  // execution setting changes in that gap, rebuild the turn once from the
  // fresh bot rather than mixing a stale adapter with fresh permissions.
  setupRetry = 0,
): Promise<boolean> {
  if (isCancelled?.()) return false;
  const group = store.group(groupId);
  const bot = store.bot(botId);
  const ownsThread = group?.dm
    ? group.threadId === threadId
    : Boolean(group && store.groupTaskByThread(group.id, threadId));
  if (!group || !bot || !ownsThread) return false;
  if (bot.approvalGrant) {
    onDispatchError?.(`${bot.name}'s approval level is still being confirmed — skipped this round`);
    return true;
  }
  revokeInternalCapabilitiesForThread(threadId);
  spoken.add(botId);
  const preparedApprovalMode = approvalModeForTurn(bot);
  const preparedSelection = { ...bot.modelSelection };
  const preparedComposio = bot.composio;
  const instance = registry.get(bot.modelSelection.instanceId);
  const userName = cfg.profile?.name?.trim() || "User";
  if (!instance) {
    const message = `${bot.name}'s model is unavailable`;
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: bot.id, name: bot.name, color: bot.color },
      tool: { name: `error: ${message}`, ok: false },
    });
    onDispatchError?.(message);
    return true;
  }
  // One turn per bot at a time, across BOTH engines. Without this a bot
  // could run its 1:1 turn and a room turn concurrently — two provider
  // processes, interleaved token spend, and an interrupt that only ever
  // reached one of them. Callers wait for a busy member before getting here
  // (waitForChatRoomMember / the goal wait), so this is the last-line guard
  // for the narrow window in which a 1:1 re-claims the bot between that wait
  // settling and this turn starting.
  if (bot.busy) {
    if (orchestration) {
      orchestration.result.outcome = "busy";
      return true;
    }
    const message = `${bot.name} is busy in another conversation — skipped this round`;
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: bot.id, name: bot.name, color: bot.color },
      tool: { name: message, ok: false },
    });
    onDispatchError?.(message);
    return true;
  }
  const internalGeneration = beginInternalCapabilityGeneration(threadId);
  try {
  const integrations: NonNullable<Parameters<typeof instance.adapter.sendTurn>[0]["integrations"]> = {};
  const skillAuthoring =
    skillRecorderEnabled(cfg) &&
    hop === 0 &&
    !skillAuthoringClaim.claimed &&
    !cardContinuation &&
    instance.adapter.capabilities.agentsMcp === true;
  if (hop < MAX_COMMS_DEPTH && instance.adapter.capabilities.agentsMcp === true) {
    integrations.agents = agentsIntegration(bot.id, threadId, hop, skillAuthoring, internalGeneration);
  }
  const latestUser = [...store.activePath(threadId)].reverse().find(
    (message) => message.role === "user" && message.kind === "text" && message.text,
  );
  const resolvedLatestImages = latestUser?.text && !cardContinuation
    ? extractTurnImages(latestUser.text)
    : { text: latestUser?.text ?? "", images: [] };
  const usesNativeImageInput = instance.adapter.capabilities.nativeImageInput === true;
  const roomContext = serializeRoomContext(
    threadId,
    userName,
    usesNativeImageInput && latestUser
      ? { messageId: latestUser.id, text: resolvedLatestImages.text }
      : undefined,
    bot.id,
  );
  const turnImages = usesNativeImageInput ? resolvedLatestImages.images : [];
  const skills = availableSkills();
  const selectedSkills = mergeSkills(
    selectBundledSkills(
      roomContext,
      instance.adapter.capabilities.phoneMcp === true ? ["phoneMcp"] : [],
      skills,
    ),
    selectBundledSkills(
      latestUser?.text ?? "",
      skillAuthoring ? ["skillAuthoring"] : [],
      skills,
    ),
  );
  if (selectedSkills.some((skill) => skill.manifest.requiredCapabilities.includes("phoneMcp"))) {
    integrations.phone = phoneIntegration();
  }
  try {
    if (bot.composio !== false && composio.configured(cfg) && instance.adapter.capabilities.composioMcp === true) {
      const connection = await connectedAppsIntegration(bot.id, threadId, internalGeneration);
      if (connection) integrations.composio = connection;
    }
  } catch (error) {
    const message = `connected apps are unavailable — ${error instanceof Error ? error.message : String(error)}`;
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: bot.id, name: bot.name, color: bot.color },
      tool: { name: `error: ${message}`, ok: false },
    });
    onDispatchError?.(message);
    return true;
  }
  // user-configured MCP servers: same gating as the 1:1 site above.
  if (instance.adapter.capabilities.customMcp === true) {
    const custom = customMcpServers(cfg);
    if (Object.keys(custom).length) integrations.custom = custom;
  }
  // Connected-app discovery is intentionally awaited before a provider owns
  // the bot. An interrupt during that setup window must still stop the queued
  // room operation before it starts a process.
  if (isCancelled?.()) return false;
  // A 1:1 or another room turn may have claimed this bot while connected-app
  // setup was in flight. Re-check immediately before the synchronous claim so
  // one bot can never own two provider processes.
  const readyBot = store.bot(bot.id);
  if (!readyBot) return false;
  const readyGroup = store.group(group.id);
  const stillOwnsThread = readyGroup?.dm
    ? readyGroup.threadId === threadId
    : Boolean(readyGroup && store.groupTaskByThread(readyGroup.id, threadId));
  if (!readyGroup || !stillOwnsThread || !readyGroup.memberIds.includes(readyBot.id)) return false;
  const setupChanged =
    registry.get(preparedSelection.instanceId) !== instance ||
    approvalModeForTurn(readyBot) !== preparedApprovalMode ||
    readyBot.modelSelection.instanceId !== preparedSelection.instanceId ||
    readyBot.modelSelection.model !== preparedSelection.model ||
    readyBot.modelSelection.effort !== preparedSelection.effort ||
    readyBot.composio !== preparedComposio;
  if (setupChanged) {
    if (setupRetry === 0) {
      return runGroupMemberTurn(
        groupId,
        threadId,
        botId,
        hop,
        spoken,
        cardContinuation,
        onDispatchError,
        isCancelled,
        onProviderHandshakeStarted,
        onProviderHandshakeSettled,
        skillAuthoringClaim,
        orchestration,
        operation,
        1,
      );
    }
    if (orchestration) {
      orchestration.result.outcome = "busy";
      return true;
    }
    const message = `${readyBot.name}'s settings changed while starting — skipped this round`;
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: readyBot.id, name: readyBot.name, color: readyBot.color },
      tool: { name: message, ok: false },
    });
    onDispatchError?.(message);
    return true;
  }
  const providerChangeError = providerTransitionForTurn(readyBot);
  if (providerChangeError) {
    if (orchestration) {
      orchestration.result.outcome = "busy";
      return true;
    }
    const message = `${bot.name}'s computer provider is being updated — skipped this round`;
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: bot.id, name: bot.name, color: bot.color },
      tool: { name: message, ok: false },
    });
    onDispatchError?.(message);
    return true;
  }
  if (boxLifecycleBusyBots.has(readyBot.id)) {
    if (orchestration) {
      orchestration.result.outcome = "busy";
      return true;
    }
    const message = `${bot.name}'s cloud computer is being changed — skipped this round`;
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: bot.id, name: bot.name, color: bot.color },
      tool: { name: message, ok: false },
    });
    onDispatchError?.(message);
    return true;
  }
  if (readyBot.busy) {
    if (orchestration) {
      // Connected-app discovery yields. A direct turn can legitimately win
      // the claim during that gap; tell goal mode to wait and retry instead
      // of misclassifying the lost race as a failed team turn.
      orchestration.result.outcome = "busy";
      return true;
    }
    const message = `${bot.name} became busy in another conversation — skipped this round`;
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: bot.id, name: bot.name, color: bot.color },
      tool: { name: message, ok: false },
    });
    onDispatchError?.(message);
    return true;
  }
  store.setActivity(bot.id, "working");
  orchestration?.onClaimed?.();

  // Connected-app discovery above can yield for a network round trip. A
  // profile may be removed, or the browser feature switched off, during that
  // window. Mint the capability only after this turn has synchronously
  // claimed the fresh bot record so a deleted profile cannot be resurrected
  // as a ghost session by an already-preparing room turn.
  if (
    builtInBrowserEnabled(cfg) &&
    readyBot.browser !== false &&
    instance.adapter.capabilities.browserMcp === true
  ) {
    const selectedProfile = readyBot.browserProfile;
    const browser = browserIntegration(readyBot.id, selectedProfile);
    if (browser) integrations.browser = browser.integration;
  }
  // Stop/delete may land while Electron is registering the capability. The
  // callback above prevents publication; this second check also unwinds the
  // room's setup claim so no provider turn starts after Stop returned.
  const browserReadyBot = store.bot(readyBot.id);
  if (isCancelled?.() || !browserReadyBot || !browserReadyBot.busy) {
    if (browserReadyBot?.busy) {
      store.setActivity(browserReadyBot.id, "idle");
      retryDelegationsWaitingOn(browserReadyBot.id);
    }
    return false;
  }

  store.patchGroup(readyGroup.id, { busyBotId: bot.id }); // the store's change stream carries the frame
  groupSpeakers.set(threadId, { botId: bot.id, name: bot.name, color: bot.color });

  const roster = readyGroup.memberIds
    .map((id) => store.bot(id))
    .filter((b): b is NonNullable<typeof b> => Boolean(b))
    .map(roomRosterLine)
    .join(", ");
  // The roster above is who an @mention can reach; the section's other bots
  // are who it cannot. The 1:1 prompt has carried a peer roster since #774,
  // and a room turn had nothing — the only advice it gave ("mention them
  // like @Name") sends the model after a teammate who will never see it.
  // Same reachability rule as list_bots, minus the room's own members.
  const outsideRoom = integrations.agents
    ? reachablePeers(store.bots, bot).filter((peer) => !readyGroup.memberIds.includes(peer.id))
    : [];
  const system = [
    `You are ${bot.name}, a bot in the room "${readyGroup.name}" in OpenMausBot.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
    `Room members: ${roster}, and ${userName} (the human).`,
    readyGroup.bulletin.trim() && `Room bulletin (shared instructions for everyone):\n${readyGroup.bulletin.trim()}`,
    `Reply as yourself, briefly and conversationally. To bring a teammate in, mention them like @Name — they'll see the conversation and respond.`,
    outsideRoom.length > 0 && roomPeerRosterSystemPrompt(outsideRoom),
    integrations.agents && CREDENTIAL_PROMPT.trim(),
    integrations.agents && ROUTINE_PROMPT.trim(),
    integrations.agents && PROFILE_PROMPT.trim(),
    skillAuthoring && LEARN_PROMPT.trim(),
    orchestration?.systemInstructions,
  ]
    .filter(Boolean)
    .join("\n");

  const latestUserText = usesNativeImageInput ? resolvedLatestImages.text : latestUser?.text;
  const learnTurn = skillAuthoring && latestUserText ? expandLearnTurnText(latestUserText) : "";
  const learnBlock = learnTurn && learnTurn !== latestUserText ? `\n\n${learnTurn}` : "";
  const text = `${roomContext}\n\n(Reply to the conversation above as ${bot.name}.)${learnBlock}${cardContinuation ? `\n\n${cardContinuation}` : ""
  }`;

  // same workspace + memory as a 1:1 turn — the room is a different
  // conversation, not a different bot
  const worksInWorkspace = instance.driverKind !== "grok" && instance.driverKind !== "boxAgent";
  const workspace = worksInWorkspace ? ensureWorkspace(bot.id) : undefined;
  // The room's folder pins here — on the first turn that actually
  // dispatches, not at PATCH time — so a folder set on a never-used room
  // still takes effect, while a room that already worked somewhere never
  // has its folder moved underneath it. Off-host members skip the folder
  // but must not decide the pin: the room's desk is a property of the
  // room, not of whichever member happened to speak first.
  const cwd = groupTurnCwd(workspace, () => store.pinGroupCwd(readyGroup.id, threadId));
  {
    const drift = checkSoulDrift(bot.id, bot.soul ?? "", bot.soulHash ?? "");
    if (drift.drift !== Boolean(bot.soulDrift)) store.patchBot(bot.id, { soulDrift: drift.drift });
  }
  const roomSystem = buildSystemPrompt(system, store.bot(bot.id)?.soul ?? bot.soul ?? "", [
    { id: "browser", label: "Browser", text: integrations.browser ? BUILT_IN_BROWSER_SYSTEM_PROMPT : "" },
    { id: "recall", label: "Recall", text: integrations.agents ? SESSION_SEARCH_SYSTEM_PROMPT : "" },
    { id: "section-context", label: "Section context", text: sectionContextSystemPrompt(bot.section) },
    // the room path has always put a newline before memory and trimmed
    // the block's leading space; keep that so existing prompts are
    // byte-identical
    { id: "memory", label: "Memory", text: workspace ? `\n${memorySystemPrompt(bot.id).trim()}` : "" },
    { id: "skills", label: "Skills index", text: workspace ? skillsSystemPrompt(bot.id) : "" },
    { id: "skill-instructions", label: "Skill instructions", text: renderSkillInstructions(selectedSkills, { includeRoot: Boolean(workspace) }) },
    { id: "playbooks", label: "Playbooks", text: installedPlaybookInstructions(text, bot.playbooks) },
  ]).text;

  // run the turn and wait for it to settle, folding the reply text so a
  // chained @mention can be routed afterwards
  // Claim only after setup succeeded. An unavailable, busy, unsupported, or
  // connector-failed first responder must not silently consume /learn for the
  // next eligible room member.
  if (skillAuthoring) skillAuthoringClaim.claimed = true;
  // A stopped room handshake may not have revealed its provider turn id yet.
  // Do not launch a replacement into that ambiguous window; once the old id
  // is known it is retired and this bounded gate clears immediately.
  await pendingCancelledProviderHandshakes.waitForClear(threadId);
  if (
    isCancelled?.() ||
    store.group(group.id)?.busyBotId !== bot.id ||
    store.bot(bot.id)?.busy !== true
  ) {
    if (store.group(group.id)?.busyBotId === bot.id) {
      groupSpeakers.delete(threadId);
      store.patchGroup(group.id, { busyBotId: null, unread: true });
    }
    if (store.bot(bot.id)?.busy) {
      store.setActivity(bot.id, "idle");
      retryDelegationsWaitingOn(bot.id);
    }
    return false;
  }
  let replyText = "";
  let providerTurnId: string | undefined;
  let abandoned = false;
  const retirementOwner = `room-abandoned:${randomUUID()}`;
  const abandonProviderTurn = () => {
    if (abandoned) return;
    abandoned = true;
    watchdog.settle(threadId);
    if (providerTurnId) retireProviderTurn(providerTurnId);
    else markCancelledProviderHandshake(threadId, retirementOwner);
  };
  const timeoutMinutes = roomTurnTimeoutMinutes(cfg);
  const outcome = await new Promise<GroupMemberTurnOutcome>((resolve) => {
    let done = false;
    let unsub = () => {};
    let unregisterStall = () => {};
    const deadline = new RoomTurnDeadline(timeoutMinutes, () => {
      abandonProviderTurn();
      void instance.adapter.interruptTurn(threadId).catch(() => {});
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        from: { botId: bot.id, name: bot.name, color: bot.color },
        tool: { name: roomTurnTimeoutMessage(bot.name, timeoutMinutes), ok: false },
      });
      finish("timed_out");
    });
    const finish = (value: GroupMemberTurnOutcome) => {
      if (done) return;
      done = true;
      deadline.stop();
      unsub();
      unregisterStall();
      resolve(value);
    };
    unsub = bus.subscribe((e: RuntimeEvent) => {
      if (shouldIgnoreProviderEvent(e)) return;
      if (e.threadId !== threadId) return;
      if (providerTurnId && e.turnId && e.turnId !== providerTurnId) return;
      if (e.type === "item.completed" && e.itemType === "assistant_text") replyText += `\n${e.text}`;
      else if (e.type === "turn.completed") {
        if (orchestration && !e.ok) {
          orchestration.result.stopReason = e.stopReason ?? null;
          finish("provider_failed");
        } else {
          finish("settled");
        }
      }
      // Waiting on a person is not turn work: hold the ceiling while an
      // approval or question card is open, so deciding slowly does not
      // stop the turn underneath the card. Everything else keeps burning it.
      else if (e.type === "request.opened") deadline.setWaitingOnHuman(true);
      else if (e.type === "request.resolved") deadline.setWaitingOnHuman(false);
    });
    deadline.start();
    unregisterStall = roomStallCompletions.register(threadId, () => {
      abandonProviderTurn();
      finish("stalled");
    });
    watchdog.watch(threadId, bot.id);
    onProviderHandshakeStarted?.();
    guardTurnDispatch(instance.adapter.sendTurn({
        threadId,
        text,
        images: turnImages,
        approvalMode: approvalModeForTurn(readyBot),
        system: roomSystem,
        cwd,
        integrations,
        ...memberTurnSelection(readyBot.modelSelection),
      }), () => abandoned || Boolean(isCancelled?.()), async () => {
        // Stop may have landed while the adapter was authenticating, before
        // it had an active process for the first interrupt to reach. Now that
        // sendTurn completed setup, revoke again and interrupt the real turn.
        await instance.adapter.interruptTurn(threadId).catch(() => {});
      })
      .then((dispatch) => {
        providerTurnId = dispatch.value.turnId;
        bindInternalCapabilityToProviderTurn(threadId, internalGeneration, dispatch.value.turnId);
        orchestration?.onTurnStarted?.(dispatch.value.turnId);
        if (abandoned) {
          retireProviderTurn(dispatch.value.turnId);
          clearCancelledProviderHandshake(threadId, retirementOwner);
        }
        if (dispatch.cancelled) {
          retireProviderTurn(dispatch.value.turnId);
          onProviderHandshakeSettled?.();
          finish("cancelled");
          return;
        }
        onProviderHandshakeSettled?.();
      })
      .catch((err) => {
        onProviderHandshakeSettled?.();
        clearCancelledProviderHandshake(threadId, retirementOwner);
        if (abandoned) return;
        const message = err instanceof Error ? err.message : "turn failed";
        store.appendMessage(threadId, {
          role: "bot",
          kind: "activity",
          from: { botId: bot.id, name: bot.name, color: bot.color },
          tool: { name: `error: ${message.slice(0, 140)}`, ok: false },
        });
        onDispatchError?.(message);
        watchdog.settle(threadId);
        finish("dispatch_failed");
      });
  });
  // The provider turn is terminal now. Revoke before any chained teammate
  // work so a retained proxy from this member cannot act during the next
  // member's generation.
  revokeInternalCapabilityGeneration(threadId, internalGeneration);
  if (orchestration) {
    orchestration.result.replyText = replyText.trim();
    orchestration.result.outcome = outcome;
  }
  // A timed-out provider still owns the room thread until its interrupt
  // produces turn.completed (or the stall watchdog's grace fallback runs).
  // Do not clear busy or start the next member on that same thread early.
  if (outcome === "cancelled") {
    // The guarded dispatch already waited for the adapter to become
    // addressable and issued the second interrupt. Retire its later events and
    // settle this exact room owner explicitly so those events cannot touch a
    // replacement turn on the same thread.
    const currentGroup = store.group(group.id);
    if (currentGroup?.busyBotId === bot.id) {
      groupSpeakers.delete(threadId);
      store.patchGroup(currentGroup.id, { busyBotId: null, unread: true });
    }
    const currentBot = store.bot(bot.id);
    if (currentBot?.busy) {
      store.setActivity(currentBot.id, "idle");
      retryDelegationsWaitingOn(currentBot.id);
    }
    watchdog.settle(threadId);
    drainQueuedSends();
    drainConnectorResumes();
    drainSecretResumes();
    return false;
  }
  if (outcome === "timed_out") {
    // turn.completed is intentionally retired above, so it cannot release
    // room ownership for us. Give interrupt a short grace period, then do the
    // same bounded cleanup as the stall watchdog. An unbound goal handshake
    // keeps the room closed until attribution becomes safe.
    const releaseOwnership = () => {
      if (hasUnboundDiscardedGroupGoalTurn(threadId)) {
        const retry = setTimeout(releaseOwnership, 1_000);
        retry.unref?.();
        return;
      }
      const currentGroup = store.group(group.id);
      const speaker = groupSpeakers.get(threadId);
      if (currentGroup?.busyBotId === bot.id && speaker?.botId === bot.id) {
        groupSpeakers.delete(threadId);
        store.patchGroup(group.id, { busyBotId: null, unread: true });
      }
      const currentBot = store.bot(bot.id);
      if (currentBot?.busy) {
        store.setActivity(bot.id, "idle");
        retryDelegationsWaitingOn(bot.id);
        drainQueuedSends();
        drainConnectorResumes();
        drainSecretResumes();
      }
    };
    const release = setTimeout(releaseOwnership, 6_000);
    release.unref?.();
    return false;
  }
  if (outcome === "stalled") return false;
  // turn.completed normally performs this cleanup. Only use the fallback
  // when this invocation still owns the room; otherwise it would emit a
  // duplicate group frame or clear a newer speaker's state.
  if (store.group(group.id)?.busyBotId === bot.id) {
    groupSpeakers.delete(threadId);
    store.patchGroup(group.id, { busyBotId: null, unread: true });
    if (store.bot(bot.id)?.busy) {
      store.setActivity(bot.id, "idle");
      retryDelegationsWaitingOn(bot.id);
    }
  }
  if (outcome === "dispatch_failed") {
    if (skillAuthoring) skillAuthoringClaim.claimed = false;
    // No turn.completed follows a rejected room dispatch. Anything that was
    // queued while this bot briefly owned the room must be retried now.
    drainQueuedSends();
    drainConnectorResumes();
    drainSecretResumes();
  }
  if (outcome === "provider_failed") {
    if (skillAuthoring) skillAuthoringClaim.claimed = false;
    return false;
  }

  // chained mentions: a member's reply can summon teammates — one hop only
  if (
    (orchestration?.followMentions ?? true) &&
    !isCancelled?.() &&
    hop < MAX_GROUP_HOPS &&
    replyText.trim()
  ) {
    const members = group.memberIds
      .map((id) => store.bot(id))
      .filter((b): b is NonNullable<typeof b> => Boolean(b) && b!.id !== bot.id);
    // A mention of a section peer who is NOT in the room reaches nobody:
    // no turn, no error, just a name in the reply that looks like it did
    // something. Say so in the room, where the person who can fix it — by
    // adding them — is the one reading. Only reachable peers are checked,
    // so the chip never names a bot this one could not contact anyway.
    const missed = mentionedBots(
      replyText,
      reachablePeers(store.bots, bot).filter((peer) => !group.memberIds.includes(peer.id)),
    );
    for (const peer of missed) {
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: {
          name: `${peer.name} isn't in this room, so that mention didn't reach them — add them to the room to bring them in.`,
          ok: false,
        },
      });
    }
    for (const next of roomResponders(replyText, members, { kind: "mentions" })) {
      if (isCancelled?.()) return false;
      if (spoken.has(next.id)) continue;
      if (operation) {
        // a summoned teammate busy elsewhere is woken later, exactly like a
        // direct responder; one skipped by the cap must not be retried as a
        // direct responder of the same round
        const verdict = await waitForChatRoomMember(operation, threadId, next);
        if (verdict === "stop") return false;
        if (verdict === "skip") {
          spoken.add(next.id);
          continue;
        }
      }
      if (!(await runGroupMemberTurn(
        groupId,
        threadId,
        next.id,
        hop + 1,
        spoken,
        undefined,
        undefined,
        isCancelled,
        onProviderHandshakeStarted,
        onProviderHandshakeSettled,
        skillAuthoringClaim,
        undefined,
        operation,
      ))) {
        return false;
      }
    }
  }
  return true;
  } finally {
    // Covers connector/setup failures, cancellation before dispatch, and all
    // other early returns that never produce a provider terminal event.
    revokeInternalCapabilityGeneration(threadId, internalGeneration);
  }
}

async function runGroupGoalStep(args: {
  groupId: string;
  threadId: string;
  bot: BotRecord;
  operation: GroupTurnOperation;
  skillAuthoringClaim: { claimed: boolean };
  coordinator: boolean;
  instructions: string;
}): Promise<{ ran: boolean; replyText: string; outcome?: GroupMemberTurnOutcome; stopReason?: string | null }> {
  const run = args.operation.goalRun;
  if (!run || args.operation.cancelled || run.turnCount >= run.maxTurns) {
    return { ran: false, replyText: "" };
  }
  let retriedTransient = false;
  for (;;) {
    const availability = await waitForGroupMemberBot(args.bot, args.operation, (detail) => {
      updateGroupGoalRunProgress(args.operation, `${detail} This goal will continue when they are available.`);
    });
    if (availability === "cancelled") return { ran: false, replyText: "", outcome: "cancelled" };
    if (availability === "unavailable") {
      return { ran: false, replyText: "", outcome: "unavailable", stopReason: `${args.bot.name} is no longer available` };
    }
    if (availability === "timed_out") {
      // still busy after the cap: surface it as a busy outcome the loop can
      // route around, never as a provider failure
      const minutes = Math.max(1, Math.round(GROUP_GOAL_WAIT_MAX_MS / 60_000));
      return {
        ran: false,
        replyText: "",
        outcome: "busy",
        stopReason: `${args.bot.name} stayed busy in another conversation for ${minutes} minute${minutes === 1 ? "" : "s"}`,
      };
    }
    if (run.turnCount >= run.maxTurns) return { ran: false, replyText: "" };

    const result: GroupTurnOrchestration["result"] = {};
    let claimed = false;
    const coordinatorTurn: GroupGoalCoordinatorTurn | undefined = args.coordinator
      ? { token: Symbol("goal-coordinator-turn"), assistantItems: [], discard: false }
      : undefined;
    if (coordinatorTurn) addGroupGoalCoordinatorTurn(args.threadId, coordinatorTurn);
    try {
      const ran = await runGroupMemberTurn(
        args.groupId,
        args.threadId,
        args.bot.id,
        run.turnCount === 0 ? 0 : 1,
        new Set(),
        undefined,
        undefined,
        () => args.operation.cancelled,
        () => groupProviderHandshakeStarted(args.operation),
        () => groupProviderHandshakeSettled(args.operation),
        args.skillAuthoringClaim,
        {
          systemInstructions: args.instructions,
          followMentions: false,
          result,
          onClaimed: () => {
            if (claimed) return;
            claimed = true;
            run.turnCount += 1;
            args.operation.botIds.add(args.bot.id);
            updateGroupGoalRunProgress(
              args.operation,
              `${args.bot.name} is working on team turn ${run.turnCount} of ${run.maxTurns}.`,
            );
          },
          onTurnStarted: (turnId) => {
            if (coordinatorTurn && !coordinatorTurn.turnId) coordinatorTurn.turnId = turnId;
          },
        },
      );
      if (result.outcome === "busy") continue;
      // One retry for a transient provider failure: a 13-turn goal must not
      // die on a single blip at turn 11. The retry claims the bot again and
      // so costs a turn like any other model call — budget is spent, never
      // stretched, and the cap still holds.
      const outcome = result.outcome;
      const transient =
        outcome === "provider_failed" ||
        outcome === "dispatch_failed" ||
        outcome === "stalled" ||
        outcome === "timed_out";
      if (transient && !retriedTransient) {
        retriedTransient = true;
        updateGroupGoalRunProgress(
          args.operation,
          `${args.bot.name}'s turn did not settle (${outcome.replace("_", " ")}) — retrying once.`,
        );
        continue;
      }
      return {
        ran,
        replyText: result.replyText ?? "",
        outcome: result.outcome,
        stopReason: result.stopReason,
      };
    } finally {
      // Membership here means this bot is part of the room operation NOW,
      // not merely the next teammate the coordinator hopes to use. In
      // particular, an idle waiter must never redirect the bot's Stop button
      // away from unrelated direct work.
      args.operation.botIds.delete(args.bot.id);
      if (coordinatorTurn && groupGoalCoordinatorTurns.get(args.threadId)?.has(coordinatorTurn)) {
        if (result.outcome === "timed_out" || result.outcome === "stalled") {
          // interruptTurn is asynchronous: the orchestration can stop before
          // the provider emits its final text/completion. Retain a discard-only
          // guard so a late private decision envelope never reaches the room.
          // Broken providers get a bounded fallback; the token check keeps an
          // old timer from deleting a newer goal turn on the same thread.
          coordinatorTurn.discard = true;
          coordinatorTurn.assistantItems = [];
          const cleanupTimer = setTimeout(() => {
            removeGroupGoalCoordinatorTurn(args.threadId, coordinatorTurn);
          }, GROUP_GOAL_COORDINATOR_GUARD_MS);
          cleanupTimer.unref?.();
          coordinatorTurn.cleanupTimer = cleanupTimer;
        } else {
          removeGroupGoalCoordinatorTurn(args.threadId, coordinatorTurn);
        }
      }
    }
  }
}

async function runGroupGoalOperation(args: {
  groupId: string;
  threadId: string;
  coordinator: BotRecord;
  members: BotRecord[];
  operation: GroupTurnOperation;
}): Promise<void> {
  const run = args.operation.goalRun;
  if (!run) return;
  const skillAuthoringClaim = { claimed: false };
  const assignmentCounts = new Map<string, number>();
  const goalMembers: GoalRunMember[] = args.members.map((member) => ({
    id: member.id,
    name: member.name,
    hidden: member.hidden,
    chiefOfStaff: member.chiefOfStaff,
  }));

  // A teammate that stayed busy past the wait cap comes back to the lead as
  // a note on its next turn, so the lead reassigns instead of the run dying.
  let coordinatorNote: string | undefined;
  let waitExhaustions = 0;
  while (!args.operation.cancelled && run.turnCount < run.maxTurns) {
    const coordinatorTurn = run.turnCount + 1;
    const note = coordinatorNote;
    coordinatorNote = undefined;
    const coordinatorResult = await runGroupGoalStep({
      ...args,
      bot: args.coordinator,
      skillAuthoringClaim,
      coordinator: true,
      instructions: groupGoalCoordinatorInstructions({
        goal: run.goal,
        members: goalMembers,
        turn: coordinatorTurn,
        maxTurns: run.maxTurns,
        remainingTurns: run.maxTurns - coordinatorTurn,
        note,
      }),
    });
    if (args.operation.cancelled) return;
    if (coordinatorResult.outcome === "unavailable") {
      finishGroupGoalRun(args.groupId, args.operation, "blocked", `${args.coordinator.name} is not available.`);
      return;
    }
    if (coordinatorResult.outcome === "busy") {
      // The lead is the one member the run cannot route around. Blocked, not
      // failed: the goal text is intact and nothing about the team broke.
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "blocked",
        `${coordinatorResult.stopReason ?? `${args.coordinator.name} stayed busy`} — send the goal again when they are free.`,
      );
      return;
    }
    if (!coordinatorResult.ran || coordinatorResult.outcome !== "settled") {
      const reason = coordinatorResult.stopReason?.trim().slice(0, 120);
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "failed",
        `${args.coordinator.name} could not complete the coordination step${reason ? ` — ${reason}` : ""}.`,
      );
      return;
    }

    const decision = parseGroupGoalDecision(coordinatorResult.replyText).decision;
    if (!decision) {
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "blocked",
        `${args.coordinator.name} did not provide a valid next-step decision.`,
      );
      return;
    }
    if (decision.status !== "continue") {
      finishGroupGoalRun(args.groupId, args.operation, decision.status, decision.detail);
      return;
    }
    if (run.turnCount >= run.maxTurns) break;

    const worker = resolveGroupGoalMember(decision.next, goalMembers);
    if (!worker) {
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "blocked",
        `${args.coordinator.name} selected a teammate who is not an active member of this channel.`,
      );
      return;
    }
    const workerBot = store.bot(worker.id);
    if (!workerBot || workerBot.hidden) {
      finishGroupGoalRun(args.groupId, args.operation, "blocked", `${worker.name} is not available.`);
      return;
    }
    const assignmentKey = groupGoalAssignmentKey(worker.id, decision.instruction);
    const repeated = (assignmentCounts.get(assignmentKey) ?? 0) + 1;
    assignmentCounts.set(assignmentKey, repeated);
    if (repeated >= 3) {
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "blocked",
        `The team repeated the same assignment three times without resolving the goal.`,
      );
      return;
    }

    const workerTurn = run.turnCount + 1;
    const workerResult = await runGroupGoalStep({
      ...args,
      bot: workerBot,
      skillAuthoringClaim,
      coordinator: false,
      instructions: groupGoalWorkerInstructions({
        goal: run.goal,
        coordinatorName: args.coordinator.name,
        assignment: decision.instruction,
        turn: workerTurn,
        maxTurns: run.maxTurns,
      }),
    });
    if (args.operation.cancelled) return;
    if (workerResult.outcome === "unavailable") {
      finishGroupGoalRun(args.groupId, args.operation, "blocked", `${workerBot.name} is not available.`);
      return;
    }
    if (workerResult.outcome === "busy") {
      // bounded: a team that keeps landing on busy teammates is blocked, not
      // looping — three exhausted waits per run, then stop and say so
      waitExhaustions += 1;
      if (waitExhaustions >= GROUP_GOAL_MAX_WAIT_EXHAUSTIONS) {
        finishGroupGoalRun(
          args.groupId,
          args.operation,
          "blocked",
          `Teammates stayed busy past the wait limit ${waitExhaustions} times — try again when the team is free.`,
        );
        return;
      }
      // Soft failure, returned to the lead as data (the way a delegation
      // error reaches a manager): the goal keeps going with the remaining
      // team instead of ending on one teammate's calendar.
      const reason = workerResult.stopReason?.trim().slice(0, 120) ?? `${workerBot.name} stayed busy`;
      store.appendMessage(args.threadId, {
        role: "bot",
        kind: "activity",
        from: { botId: args.coordinator.id, name: args.coordinator.name, color: args.coordinator.color },
        tool: { name: `${reason} — asking ${args.coordinator.name} to reassign`, ok: false },
      });
      updateGroupGoalRunProgress(args.operation, `${reason}. ${args.coordinator.name} is reassigning.`);
      coordinatorNote =
        `${reason} and could not take the assignment "${decision.instruction.slice(0, 160)}". ` +
        "Reassign it to another available member, do it yourself if you can, or report blocked.";
      continue;
    }
    if (!workerResult.ran || workerResult.outcome !== "settled" || !workerResult.replyText.trim()) {
      const reason = workerResult.stopReason?.trim().slice(0, 120);
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "failed",
        `${workerBot.name} could not return a result to ${args.coordinator.name}${reason ? ` — ${reason}` : ""}.`,
      );
      return;
    }
  }

  if (!args.operation.cancelled && !run.finished) {
    finishGroupGoalRun(
      args.groupId,
      args.operation,
      "limit-reached",
      `Paused at the ${run.maxTurns}-turn safety limit. Send the goal again to continue with a fresh bounded run.`,
    );
  }
}

type StartGroupTurnOptions = {
  /** Run against an existing background room task instead of the active UI task. */
  threadId?: string;
  /** Internal routine goals choose their lead explicitly rather than by @mention/default. */
  goalCoordinatorBotId?: string;
  /** Correlates a room goal card with its durable RoutineRun receipt. */
  goalRunId?: string;
  /** The message came through the HTTP API with nothing to say a person
   * sent it (see Message.via). */
  via?: "api";
};

function startGroupTurn(
  groupId: string,
  text: string,
  replyTo?: Message,
  sendId?: string,
  channelMode: "chat" | "goal" = "chat",
  queueId?: string,
  options: StartGroupTurnOptions = {},
) {
  const group = store.group(groupId);
  if (!group) throw Object.assign(new Error("no such group"), { status: 404 });
  if (roomSetupPending(group)) {
    throw Object.assign(new Error("finish room setup before sending the first message"), { status: 409 });
  }
  // Capture the chosen thread once. Manual sends use the active task; a
  // scheduled team goal supplies its detached background task explicitly.
  const threadId = options.threadId ?? group.threadId;
  const ownsThread = group.dm
    ? group.threadId === threadId
    : Boolean(store.groupTaskByThread(group.id, threadId));
  if (!ownsThread) {
    throw Object.assign(new Error("no such room task"), { status: 404 });
  }
  const members = group.memberIds
    .map((id) => store.bot(id))
    .filter((bot): bot is NonNullable<typeof bot> => Boolean(bot));
  const availableMembers = members.filter((member) => !member.hidden);
  const requestedGoalCoordinator = options.goalCoordinatorBotId
    ? availableMembers.find((member) => member.id === options.goalCoordinatorBotId)
    : undefined;
  if (options.goalCoordinatorBotId && (channelMode !== "goal" || !requestedGoalCoordinator)) {
    throw Object.assign(new Error("the selected goal coordinator is not an active room member"), { status: 409 });
  }
  const message = store.appendMessage(threadId, {
    role: "user",
    kind: "text",
    text,
    replyToId: replyTo?.id,
    sendId,
    channelMode,
    queueId,
    via: options.via,
  });
  if (!group.dm) store.titleGroupTaskFromFirstMessage(group.id, text, threadId);

  const archived = members.filter((member) => member.hidden);
  const mentionedArchived = mentionedBots(text, archived.map(({ name }) => ({ name })))[0];
  if (mentionedArchived) {
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      tool: {
        name: `${mentionedArchived.name} is archived and can't respond — restore it or mention an active room member.`,
        ok: false,
      },
    });
  }
  let responders = roomResponders(text, members, group.defaultResponder);
  const explicitlyMentionedLead = roomResponders(text, availableMembers, { kind: "mentions" })[0];
  const goalCoordinator = channelMode === "goal"
    ? requestedGoalCoordinator ?? explicitlyMentionedLead ?? selectGroupGoalCoordinator(availableMembers, group.defaultResponder)
    : null;
  // bot⇄bot channels: chipping in without a tag addresses the last speaker
  if (!responders.length && group.dm) {
    const lastSpeakerId = [...store.messagesFor(threadId)]
      .reverse()
      .find((msg) => msg.kind === "text" && msg.from)?.from?.botId;
    const last = availableMembers.find((b) => b.id === lastSpeakerId) ?? availableMembers[0];
    responders = last ? [last] : [];
  }
  if (!responders.length && !goalCoordinator) {
    const defaultArchivedId = group.defaultResponder.kind === "member" ? group.defaultResponder.botId : undefined;
    const defaultArchived = archived.find((member) => member.id === defaultArchivedId);
    let unavailableMessage: string | undefined;
    if (!mentionedArchived && !availableMembers.length) {
      unavailableMessage = "No active room members can respond — restore an archived bot or add an active member.";
    } else if (!mentionedArchived && defaultArchived) {
      unavailableMessage = `${defaultArchived.name} is archived and can't respond — restore it or mention an active room member.`;
    }
    if (unavailableMessage) {
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: unavailableMessage, ok: false },
      });
    }
    return message;
  }

  const operation = beginGroupTurnOperation(
    groupId,
    threadId,
    goalCoordinator ? [] : responders.map((responder) => responder.id),
  );
  if (goalCoordinator) {
    const runId = options.goalRunId?.trim() || `goal-${Date.now().toString(36)}-${randomUUID()}`;
    const startedAt = Date.now();
    const detail = `${goalCoordinator.name} is coordinating this goal.`;
    const card = store.appendMessage(threadId, {
      role: "bot",
      kind: "goal.run",
      text: `Goal in progress: ${detail}`,
      from: { botId: goalCoordinator.id, name: goalCoordinator.name, color: goalCoordinator.color },
      goalRun: {
        runId,
        goal: text,
        status: "working",
        coordinatorBotId: goalCoordinator.id,
        coordinatorName: goalCoordinator.name,
        turnCount: 0,
        maxTurns: GROUP_GOAL_MAX_TURNS,
        detail,
        startedAt,
      },
    });
    operation.goalRun = {
      runId,
      cardMessageId: card.id,
      goal: text,
      coordinatorBotId: goalCoordinator.id,
      coordinatorName: goalCoordinator.name,
      turnCount: 0,
      maxTurns: GROUP_GOAL_MAX_TURNS,
      startedAt,
      finished: false,
    };
  }
  const prev = groupQueues.get(groupId) ?? Promise.resolve();
  const next = prev.then(async () => {
    if (operation.cancelled) return;
    const current = store.group(groupId);
    if (current?.busyBotId) {
      const owner = store.bot(current.busyBotId);
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `${owner?.name ?? "A room member"} is still stopping — this message was not dispatched`, ok: false },
      });
      return;
    }
    if (goalCoordinator) {
      await runGroupGoalOperation({ groupId, threadId, coordinator: goalCoordinator, members, operation });
    } else {
      const spoken = new Set<string>();
      const skillAuthoringClaim = { claimed: false };
      for (const responder of responders) {
        if (operation.cancelled) break;
        if (spoken.has(responder.id)) continue;
        // A responder busy in another conversation takes its turn when it
        // frees (the host wakes each member in turn) — never skipped, only
        // bounded. Stop ends the round; a member the cap gave up on, or one
        // that vanished meanwhile, is passed over for this round only.
        const verdict = await waitForChatRoomMember(operation, threadId, responder);
        if (verdict === "stop") break;
        if (verdict === "skip") {
          spoken.add(responder.id);
          continue;
        }
        if (!(await runGroupMemberTurn(
          groupId,
          threadId,
          responder.id,
          0,
          spoken,
          undefined,
          undefined,
          () => operation.cancelled,
          () => groupProviderHandshakeStarted(operation),
          () => groupProviderHandshakeSettled(operation),
          skillAuthoringClaim,
          undefined,
          operation,
        ))) break;
      }
    }
  });
  const tracked = next.finally(() => finishGroupTurnOperation(groupId, operation));
  groupQueues.set(groupId, tracked.catch(() => {}));
  return message;
}

function drainQueuedChannelSends(): void {
  drainChannelMessages(
    (groupId) => {
      const group = store.group(groupId);
      return group ? groupIsWorking(group) : false;
    },
    ({ groupId, threadId, text, replyToId, sendId, mode, id, via }) => {
      const group = store.group(groupId);
      const ownsThread = group?.dm
        ? group.threadId === threadId
        : Boolean(group && store.groupTaskByThread(group.id, threadId));
      if (!group || !ownsThread) return;
      try {
        startGroupTurn(groupId, text, resolveReplyTarget(threadId, replyToId), sendId, mode, id, { via });
      } catch (error) {
        store.appendMessage(threadId, {
          role: "bot",
          kind: "activity",
          tool: {
            name: `error: queued channel message could not start — ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`,
            ok: false,
          },
        });
      }
      // A message with no eligible responder creates no operation. Continue
      // draining instead of leaving later user messages behind it forever.
      queueMicrotask(drainQueuedChannelSends);
    },
  );
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

const CONNECTOR_SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/;
const pendingConnectorResumes = new Map<
  string,
  { botId: string; threadId: string; resumeKey: string; labels: string[] }
>();

function connectorThread(botId: string, threadId: string) {
  const bot = store.bot(botId);
  if (!bot) return null;
  if (store.taskByThread(botId, threadId)) return { bot, group: undefined };
  const group = store.groupByThread(threadId);
  if (group?.memberIds.includes(botId)) return { bot, group };
  return null;
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
    .find((member) => member && sectionKey(member.section) !== sectionKey(bot.section));
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
  // Only cards on the visible branch can be acted on from the composer.
  // Abandoned branches must not permanently consume the proposal quota.
  // Routine and profile proposals share one budget per bot per thread, so
  // one thread cannot pile up 8 of each.
  const openRequests = store.activePath(threadId).filter(
    (message) =>
      (message.card?.routineRequest?.botId === botId || message.card?.profileRequest?.botId === botId) &&
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
      options: [args.staged.action === "create" ? "Enable" : "Update", "Deny"],
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

function connectorMessage(botId: string, threadId: string, messageId: string) {
  if (!connectorThread(botId, threadId)) return null;
  const message = store.messagesFor(threadId).find((candidate) => candidate.id === messageId);
  return message?.kind === "connector" && message.connector ? message : null;
}

function connectorCards(threadId: string, resumeKey: string) {
  return store.messagesFor(threadId).filter(
    (message) => message.kind === "connector" && message.connector?.resumeKey === resumeKey,
  );
}

function markConnectorResumeFailed(threadId: string, resumeKey: string, error: string) {
  for (const message of connectorCards(threadId, resumeKey)) {
    if (!message.connector) continue;
    store.patchMessage(threadId, message.id, {
      connector: { ...message.connector, resumed: false, error: error.slice(0, 180) },
    });
  }
}

function dispatchConnectorResume(entry: { botId: string; threadId: string; resumeKey: string; labels: string[] }) {
  const owner = connectorThread(entry.botId, entry.threadId);
  if (!owner) return;
  const names = entry.labels.join(", ");
  const prompt = `OpenMausBot connection update: the user securely connected ${names}. Continue the task that paused for this connection. Do not ask them to connect it again.`;
  if (owner.bot.busy) {
    pendingConnectorResumes.set(`${entry.threadId}:${entry.resumeKey}`, entry);
    return;
  }
  if (owner.group) {
    const groupId = owner.group.id;
    const operation = beginGroupTurnOperation(groupId, entry.threadId, [entry.botId]);
    const previous = groupQueues.get(groupId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (operation.cancelled) return;
      const current = connectorThread(entry.botId, entry.threadId);
      if (!current?.group) return;
      if (current.bot.busy) {
        pendingConnectorResumes.set(`${entry.threadId}:${entry.resumeKey}`, entry);
        return;
      }
      await runGroupMemberTurn(
        current.group.id,
        entry.threadId,
        entry.botId,
        0,
        new Set(),
        prompt,
        (message) => markConnectorResumeFailed(entry.threadId, entry.resumeKey, message),
        () => operation.cancelled,
        () => groupProviderHandshakeStarted(operation),
        () => groupProviderHandshakeSettled(operation),
      );
    });
    const tracked = next.finally(() => finishGroupTurnOperation(groupId, operation));
    groupQueues.set(
      groupId,
      tracked.catch((error) => {
        markConnectorResumeFailed(entry.threadId, entry.resumeKey, error instanceof Error ? error.message : String(error));
      }),
    );
    return;
  }
  void startTurn(entry.botId, prompt, {
    threadId: entry.threadId,
    cardContinuation: true,
    onDispatchError: (message) => markConnectorResumeFailed(entry.threadId, entry.resumeKey, message),
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/already working/i.test(message)) pendingConnectorResumes.set(`${entry.threadId}:${entry.resumeKey}`, entry);
    else markConnectorResumeFailed(entry.threadId, entry.resumeKey, message);
  });
}

function maybeResumeConnectors(botId: string, threadId: string, resumeKey: string) {
  const cards = connectorCards(threadId, resumeKey);
  if (!cards.length || cards.some((message) => message.connector?.dismissed || message.connector?.status !== "connected")) return false;
  if (cards.every((message) => message.connector?.resumed)) return true;
  const labels = cards.map((message) => message.connector!.label);
  for (const message of cards) {
    store.patchMessage(threadId, message.id, { connector: { ...message.connector!, resumed: true, error: undefined } });
  }
  dispatchConnectorResume({ botId, threadId, resumeKey, labels });
  return true;
}

function drainConnectorResumes() {
  for (const [key, entry] of pendingConnectorResumes) {
    if (store.bot(entry.botId)?.busy) continue;
    pendingConnectorResumes.delete(key);
    dispatchConnectorResume(entry);
  }
}

type SecretResumeEntry = {
  botId: string;
  threadId: string;
  messageId: string;
  label: string;
  outcome: "provided" | "dismissed";
};
const pendingSecretResumes = new Map<string, SecretResumeEntry>();
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

function phoneSecretSubmissionKey(threadId: string, messageId: string, requestKey: string): string {
  return `${threadId}:${messageId}:${requestKey}`;
}

function credentialDesktopHandoff(label: string): string {
  return `Securely provide the ${label} from OpenMausBot on your phone or computer. It is never added to chat.`;
}

function secretMessage(botId: string, threadId: string, messageId: string): Message | null {
  const owner = connectorThread(botId, threadId);
  if (!owner) return null;
  // A credential card is actionable only while it is visible on the chosen
  // conversation branch. In a channel, the sender attribution is also the
  // durable owner: any member may share the thread, but only the bot that
  // requested this credential may bind it into HPKE AAD or resume its turn.
  const message = store.activePath(threadId).find((candidate) => candidate.id === messageId);
  if (owner.group && message?.from?.botId !== botId) return null;
  return message?.kind === "secret" && message.secret ? message : null;
}

function currentSecretState(botId: string, threadId: string, messageId: string) {
  const message = secretMessage(botId, threadId, messageId);
  if (!message?.secret) return null;
  return {
    provided: message.secret.provided === true,
    resumed: message.secret.resumed === true,
  };
}

function markSecretResumeFailed(threadId: string, messageId: string, error: string) {
  const message = store.messagesFor(threadId).find((candidate) => candidate.id === messageId);
  if (!message?.secret) return;
  store.patchMessage(threadId, message.id, {
    secret: { ...message.secret, resumed: false, error: error.slice(0, 180) },
  });
}

function dispatchSecretResume(entry: SecretResumeEntry) {
  const owner = connectorThread(entry.botId, entry.threadId);
  if (!owner) return;
  const prompt =
    entry.outcome === "provided"
      ? `OpenMausBot credential update: the user securely provided ${entry.label}. Continue the task that paused for it. You do not receive the secret and must not ask them to paste it into chat.`
      : `OpenMausBot credential update: the user declined to provide ${entry.label}. Continue without it if possible, or briefly explain the limitation. Do not ask them to paste it into chat.`;
  if (owner.bot.busy) {
    pendingSecretResumes.set(`${entry.threadId}:${entry.messageId}`, entry);
    return;
  }
  if (owner.group) {
    const groupId = owner.group.id;
    const operation = beginGroupTurnOperation(groupId, entry.threadId, [entry.botId]);
    const previous = groupQueues.get(groupId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (operation.cancelled) return;
      const current = connectorThread(entry.botId, entry.threadId);
      if (!current?.group) return;
      if (current.bot.busy) {
        pendingSecretResumes.set(`${entry.threadId}:${entry.messageId}`, entry);
        return;
      }
      await runGroupMemberTurn(
        current.group.id,
        entry.threadId,
        entry.botId,
        0,
        new Set(),
        prompt,
        (message) => markSecretResumeFailed(entry.threadId, entry.messageId, message),
        () => operation.cancelled,
        () => groupProviderHandshakeStarted(operation),
        () => groupProviderHandshakeSettled(operation),
      );
    });
    const tracked = next.finally(() => finishGroupTurnOperation(groupId, operation));
    groupQueues.set(
      groupId,
      tracked.catch((error) => {
        markSecretResumeFailed(
          entry.threadId,
          entry.messageId,
          error instanceof Error ? error.message : String(error),
        );
      }),
    );
    return;
  }
  void startTurn(entry.botId, prompt, {
    threadId: entry.threadId,
    cardContinuation: true,
    onDispatchError: (message) => markSecretResumeFailed(entry.threadId, entry.messageId, message),
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/already working/i.test(message)) {
      pendingSecretResumes.set(`${entry.threadId}:${entry.messageId}`, entry);
    } else {
      markSecretResumeFailed(entry.threadId, entry.messageId, message);
    }
  });
}

function resumeSecretCard(botId: string, threadId: string, messageId: string, outcome: SecretResumeEntry["outcome"]) {
  const message = secretMessage(botId, threadId, messageId);
  if (!message?.secret) return false;
  if (message.secret.resumed) return true;
  store.patchMessage(threadId, message.id, {
    secret: {
      ...message.secret,
      provided: outcome === "provided" ? true : message.secret.provided,
      dismissed: outcome === "dismissed" ? true : message.secret.dismissed,
      resumed: true,
      error: undefined,
    },
  });
  dispatchSecretResume({ botId, threadId, messageId, label: message.secret.label, outcome });
  return true;
}

async function provideSecretFromPhone(
  context: PhoneSecretContext,
  authenticatedDeviceId: string,
): Promise<{ provided: boolean; resumed: boolean }> {
  const owner = connectorThread(context.botId, context.threadId);
  const message = secretMessage(context.botId, context.threadId, context.messageId);
  if (!owner || !message?.secret) throw new PhoneSecretError("No such credential request", 404);
  if (message.secret.dismissed) throw new PhoneSecretError("This credential request was dismissed", 409);
  assertPhoneSecretRequestMatches(context, authenticatedDeviceId, {
    target: message.secret.target,
    requestKey: message.secret.requestKey,
  });
  const operationId = phoneSecretOperationId(context);
  if (message.secret.phoneOperationId && message.secret.phoneOperationId !== operationId) {
    throw new PhoneSecretError(
      "This credential request was already completed by another submission",
      409,
    );
  }
  // The encrypted store may have committed immediately before a process
  // interruption. Recording the winning operation precedes completing the
  // card, so the exact retry can repair that tiny window without writing the
  // credential again. A different randomized envelope was rejected above.
  if (message.secret.phoneOperationId === operationId && !message.secret.provided) {
    if (!credentialIsConfigured(cfg, message.secret.target)) {
      throw new PhoneSecretError(`${message.secret.label} is no longer configured`, 409);
    }
    if (!resumeSecretCard(context.botId, context.threadId, context.messageId, "provided")) {
      throw new PhoneSecretError("This credential request is no longer available", 409);
    }
    const recovered = currentSecretState(context.botId, context.threadId, context.messageId);
    if (!recovered) throw new PhoneSecretError("This credential request is no longer available", 409);
    return recovered;
  }
  if (message.secret.provided) {
    if (message.secret.phoneOperationId !== operationId) {
      throw new PhoneSecretError(
        "This credential request was already completed by another submission",
        409,
      );
    }
    if (!credentialIsConfigured(cfg, message.secret.target)) {
      throw new PhoneSecretError(`${message.secret.label} is no longer configured`, 409);
    }
    // A crash or older build may have committed the credential and marked
    // the card provided without dispatching its continuation. An exact phone
    // retry repairs that state instead of silently claiming it resumed.
    if (!message.secret.resumed && !resumeSecretCard(
      context.botId,
      context.threadId,
      context.messageId,
      "provided",
    )) {
      throw new PhoneSecretError("This credential request is no longer available", 409);
    }
    const recovered = currentSecretState(context.botId, context.threadId, context.messageId);
    if (!recovered) throw new PhoneSecretError("This credential request is no longer available", 409);
    return recovered;
  }

  const submissionKey = phoneSecretSubmissionKey(context.threadId, context.messageId, context.requestKey);
  await phoneSecretSubmissions.run({
    cardKey: submissionKey,
    botId: context.botId,
    threadId: context.threadId,
    ...(owner.group ? { groupId: owner.group.id } : {}),
  }, operationId, async () => {
    await phoneSecrets.provide(context);
    const current = secretMessage(context.botId, context.threadId, context.messageId);
    if (!current?.secret || current.secret.requestKey !== context.requestKey) {
      throw new PhoneSecretError("This credential request is no longer available", 409);
    }
    if (current.secret.dismissed) {
      throw new PhoneSecretError("This credential request was dismissed", 409);
    }
    // Electron acknowledges only after credentials.bin and the server's
    // external-secret config update both commit. Keep this assertion at the
    // boundary so a future parent handler cannot accidentally resume first.
    if (!credentialIsConfigured(cfg, current.secret.target)) {
      throw new PhoneSecretError(`${current.secret.label} was not saved yet`, 409);
    }
    // Persist the winning randomized envelope id before completing the card.
    // A later exact retry can recover a lost response, while a newly sealed
    // value can never be reported as though it were the value already saved.
    store.patchMessage(context.threadId, current.id, {
      secret: { ...current.secret, phoneOperationId: operationId },
    });
    if (!resumeSecretCard(context.botId, context.threadId, context.messageId, "provided")) {
      throw new PhoneSecretError("This credential request is no longer available", 409);
    }
  });
  const settled = currentSecretState(context.botId, context.threadId, context.messageId);
  if (!settled) throw new PhoneSecretError("This credential request is no longer available", 409);
  return settled;
}

function drainSecretResumes() {
  for (const [key, entry] of pendingSecretResumes) {
    if (store.bot(entry.botId)?.busy) continue;
    pendingSecretResumes.delete(key);
    dispatchSecretResume(entry);
  }
}

bus.subscribe((event: RuntimeEvent) => {
  if (shouldIgnoreProviderEvent(event)) return;
  if (event.type === "turn.completed") {
    drainConnectorResumes();
    drainSecretResumes();
  }
});

/** Pre-save probe for a CLI path override: run `<cli> --version` with the
 * same environment a real turn gets (augmented PATH). Returns ok + the
 * version line, or a fail the UI can act on — ENOENT on a GUI-launched app
 * usually means "not on the app's PATH", the exact mistake this catches
 * before the override is saved. */
async function testCliBinary(
  cli: string,
  driver: (typeof BUILT_IN_DRIVERS)[number] | undefined,
): Promise<{ ok: boolean; version?: string; message?: string; install?: (typeof BUILT_IN_DRIVERS)[number]["install"] }> {
  return new Promise((resolve) => {
    execCli(
      cli,
      ["--version"],
      {
        timeout: 10_000,
        // SIGKILL, not SIGTERM: a child that traps TERM (sh -c "trap '' TERM;
        // sleep 99999") would otherwise never fire the callback and pin the
        // HTTP socket forever. maxBuffer bounds a chatty --version too.
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 64,
        env: cliProbeEnvironment(),
      },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          // err.code is an errno CONSTANT ("ENOENT", "EACCES") only for spawn
          // failures; for a non-zero exit it's the exit STATUS (a number) and
          // for a timeout it's null + killed:true — describeSpawnFailure words
          // only the first kind
          const exceededBuffer = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          const isSpawnError = typeof e.code === "string" && !exceededBuffer;
          const message = exceededBuffer
            ? "CLI test produced more than 64 KiB of output"
            : isSpawnError
              ? describeSpawnFailure(e, cli).message
              : e.killed
              ? "CLI test timed out after 10s"
              : `CLI exited with error ${String(e.code)}: ${(stderrOf(err) || "").slice(0, 200) || err.message.split("\n")[0]}`;
          resolve({ ok: false, message, ...(driver?.install && isSpawnError ? { install: driver.install } : {}) });
          return;
        }
        resolve({ ok: true, version: stdout.trim().split("\n")[0] });
      },
    );
  });
}

/** A pre-save probe only needs PATH. Never hand credentials inherited by the
 * desktop/server process to an arbitrary wrapper selected through Settings. */
function cliProbeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
  for (const key of [
    "XAI_API_KEY",
    "BOX_TOKEN",
    "OPENCODE_API_KEY",
    "COMPOSIO_API_KEY",
    "OMB_COMPOSIO_BROKER_TOKEN",
    "OMB_TTS_KEY",
    "OMB_OPENAI_IMAGE_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ]) {
    delete env[key];
  }
  return env;
}

/** execFile's error carries the child's stderr in .stderr. */
function stderrOf(err: unknown): string {
  const s = (err as { stderr?: unknown }).stderr;
  return typeof s === "string" ? s : Buffer.isBuffer(s) ? s.toString("utf8") : "";
}

async function localVmPayload(target: LocalVmTarget) {
  const status = await containerComputerStatus(undefined, undefined, target);
  return {
    ...status,
    commands: setupCommands(status.runtime, process.platform, target),
    idle_timeout_ms: LOCAL_VM_IDLE_MS,
    mode: localVmMode(cfg),
    max_instances: localVmMaxInstances(cfg),
  };
}

/** The Local VM a turn is about to use, recreated if the idle timer took it.
 *
 * `LocalVmIdleTimer` REMOVES an unused Local VM rather than pausing it. The
 * turn then failed with "Create the Local VM (App Settings → Local VM)" —
 * which reads like a fault the person must repair by hand, for a container the
 * app itself deleted eight hours earlier. Someone who steps away overnight
 * comes back to an error on their first message.
 *
 * The cloud branch below already does the opposite: an absent box is
 * provisioned on first use behind a `provisioning` broadcast. This gives the
 * Local VM the same lifecycle for the same reason.
 *
 * Only `missing` is recovered, and only when a fresh `run` is all it takes.
 * Every other problem still surfaces: no runtime installed, no image pulled,
 * `create_supported` false, or an existing container that is stale, unmanaged
 * or unsafe. Those need a decision — install podman, download 1.4 GB, replace
 * a container someone else made — and a stopped container is deliberately not
 * resumed here, because `localVmProblem` says this desktop image cannot safely
 * resume and asks for a recreate rather than a start. Per-bot mode keeps its
 * instance cap; creating past it would quietly do what the lifecycle route
 * refuses.
 */
async function readyLocalVmForTurn(botId: string, target: LocalVmTarget) {
  let status = await containerComputerStatus(undefined, undefined, target);
  if (status.ready || !localVmRecreatableOnDemand(status)) return status;

  if (target.key !== SHARED_LOCAL_VM_TARGET.key) {
    const count = await existingPerBotLocalVmCount(status.runtime);
    if (count >= localVmMaxInstances(cfg)) return status;
  }

  broadcast({ kind: "computer", botId, state: "provisioning" });
  localVmLifecycleBusy.add(target.key);
  localVmProvisionBusy = true;
  try {
    status = await containerComputerAction("run", undefined, undefined, target);
  } catch {
    // Keep the inspected status: its `problem` names the real obstacle, which
    // is more use to the person than "podman run exited non-zero".
    return status;
  } finally {
    localVmProvisionBusy = false;
    localVmLifecycleBusy.delete(target.key);
  }
  localVmIdleFor(target).touch();

  // The container is up before Cua Driver is. Waiting here rather than failing
  // the turn is the whole point: a person who has been away eight hours should
  // not have to send their message twice.
  const deadline = Date.now() + LOCAL_VM_DESKTOP_WAIT_MS;
  while (!status.ready && status.container === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    status = await containerComputerStatus(undefined, undefined, target);
  }
  return status;
}

async function existingPerBotLocalVmCount(runtime: Runtime) {
  return (await discoverExistingPerBotLocalVms(store.bots, runtime)).length;
}

async function perBotLocalVmCountForModeChange(): Promise<number | null> {
  const targets = [...new Map(store.bots.map((bot) => {
    const target = perBotLocalVmTarget(bot.id);
    return [target.key, target] as const;
  })).values()];
  if (targets.length === 0) return 0;
  const runtime = await containerRuntimeStatus();
  if (!runtime.runtime || !runtime.daemonUp) {
    return targets.some((target) => existsSync(target.workspaceDir)) ? null : 0;
  }
  return existingPerBotLocalVmCount(runtime.runtime);
}

function configStatus() {
  return {
    xai: { configured: Boolean(cfg.xai?.key) },
    composio: {
      configured: composio.configured(cfg),
      mode: composio.connectionMode(cfg),
    },
    box: { configured: Boolean(cfg.box?.token) },
    vps: { configured: Boolean(vpsSshAlias(cfg)), sshAlias: vpsSshAlias(cfg) ?? "" },
    opencodeGo: { configured: Boolean(cfg.opencodeGo?.apiKey) },
    // the chosen voice is a setting, not a secret; the key is reported the
    // same configured-or-not way as every other credential
    tts: tts.describeVoice(cfg),
    imageGen: { configured: Boolean(cfg.imageGen?.key) },
    // not a secret — the sidebar shows it
    profile: { name: cfg.profile?.name ?? "", email: cfg.profile?.email ?? "" },
    // not a secret — the settings picker shows it; "" = follow the system
    language: cfg.language ?? "",
    rooms: { turnTimeoutMinutes: roomTurnTimeoutMinutes(cfg) },
    localVm: {
      mode: localVmMode(cfg),
      maxInstances: localVmMaxInstances(cfg),
    },
    features: {
      skillRecorder: skillRecorderEnabled(cfg),
      showToolCalls: showToolCallsEnabled(cfg),
      browser: builtInBrowserEnabled(cfg),
    },
    // Which browser this server can give bots: the desktop app's surface,
    // the agent-browser engine, or nothing yet (with the reason).
    browserEngine: browserEngineSummary(),
    // partitionId is non-secret routing metadata. The renderer needs it to
    // show the same durable session as an agent, but config PATCH validation
    // keeps it read-only and rejects callers that try to choose it.
    browserProfiles: cfg.browserProfiles ?? [],
  };
}

function mcpServerResponse() {
  return { servers: listMcpServers(cfg.mcpServers) };
}

function persistMcpServers(next: Record<string, unknown>): void {
  saveConfig({ mcpServers: next });
  // Do not reload the provider fleet: integrations are assembled from cfg at
  // the next turn boundary. Updating this property directly also correctly
  // clears the final entry; Object.assign(loadConfig()) would leave it stale
  // when an empty section is omitted by an older config file.
  cfg.mcpServers = next;
}

/** Rebuild the provider fleet after a config change so new keys take
 * effect without a server restart (kills any in-flight turns). */
async function reloadProviders() {
  // Every provider process is about to die. Revoke all turn capabilities in
  // one synchronous step before the first teardown await, including room/task
  // threads that are not a bot's default DM.
  revokeAllInternalCapabilities();
  bus.detachAll();
  await registry.disposeAll();
  await registry.load(instanceConfigs(cfg));
  bus.attach(registry.instances());
  // A killed turn's terminal events can die with the old fleet (dispose is
  // async under the hood), stranding the bot busy — and its screen poller —
  // forever. Settle anything still marked busy.
  for (const b of store.bots.filter((b) => b.busy)) {
    const vmThread = [...localVmThreadTargets.entries()].find(([, target]) =>
      localVmLeaseFor(target).current(localVmOwnerBusy)?.botId === b.id
    )?.[0];
    if (vmThread) releaseLocalVmThread(vmThread);
    stopScreenPoller(b.id);
    activeVpsThreads.delete(b.id);
    finalizeDelegationWatch(
      b.threadId,
      false,
      "",
      "Delegated turn did not finish — provider settings changed",
    );
    store.appendMessage(b.threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: "error: turn interrupted — provider settings changed", ok: false },
    });
    store.setActivity(b.id, "idle");
    retryDelegationsWaitingOn(b.id);
  }
  // killed turns settle here without a turn.completed event, so anything
  // queued behind them drains now — onto the freshly loaded fleet
  drainQueuedSends();
  drainConnectorResumes();
  drainSecretResumes();
}

// Config writes rebuild the whole provider registry. Keep the read-modify-write
// and reload sequence single-flight so two settings requests cannot drop one
// another's changes or dispose a fleet while another reload is creating it.
let providerConfigBusy = false;
let mcpConfigBusy = false;
const MAX_CONCURRENT_MCP_PROBES = 2;
let mcpProbesInFlight = 0;
// One updater per executable: multiple Claude instances can point at the same
// install, and running two self-updates against it would race its files.
const claudeUpdatesInFlight = new Set<string>();

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

function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let done = false;
    const fail = (status: number, msg: string) => {
      if (done) return;
      done = true;
      const err = Object.assign(new Error(msg), { status });
      reject(err);
    };
    req.on("data", (c) => {
      if (done) return;
      bytes += typeof c === "string" ? Buffer.byteLength(c) : c.length;
      if (bytes > limit) {
        // Keep draining the socket, but stop retaining attacker-controlled
        // bytes. Destroying the request here prevents the caller from
        // receiving the useful 413 response.
        return fail(413, "body too large");
      }
      data += c;
    });
    req.on("end", () => {
      if (done) return;
      let body: any;
      try {
        body = data ? JSON.parse(data) : {};
      } catch {
        return fail(400, "invalid JSON body");
      }
      done = true;
      resolve(body);
    });
    req.on("error", (e) => fail(400, e instanceof Error ? e.message : String(e)));
  });
}

// Loopback-only enforcement: the harness runs on 127.0.0.1 but accepts
// requests from any loopback connection and any web page that DNS-rebinds
// onto it. Reject non-loopback Hosts outright (defeats rebinding) and
// origins outside loopback (blocks remote-web CSRF).

const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  /** scratch for route matches, shared by every `path.match` below */
  let m: RegExpMatchArray | null = null;
  try {
    // ── who is asking (server/request-auth.ts) ──────────────────────────
    // Two public routes come first: what this server is, and turning a pairing
    // code into a session. Everything else needs the loopback owner or a
    // paired session with the right scope.
    if (method === "GET" && !path.startsWith("/api/") && !path.startsWith("/.well-known/") && serveStatic(res, path)) return;
    if (method === "GET" && path === "/.well-known/openmausbot/environment") {
      return json(res, 200, environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED }));
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
      const environment = environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED });
      if (wantsCookie) {
        const secure = requestOrigin(req)?.startsWith("https://") === true;
        res.setHeader("set-cookie", serializeSessionCookie(SESSION_COOKIE, result.token, { secure, maxAgeSeconds: SESSION_TTL_MS / 1000 }));
        return json(res, 200, { session: result.session, environment });
      }
      return json(res, 200, { token: result.token, session: result.session, environment });
    }
    const gate = resolveRequestAuth(req, {
      sessions,
      cookieName: SESSION_COOKIE,
      streamPath: "/api/events",
      url,
      loopbackMutationToken: desktopMutationToken,
      companionMutationToken,
    });
    // Reachability probe, public: the phone races it across a server's
    // addresses before it has a session, and the tunnel verifier polls it.
    // A stranger learns only the app name; pid (the desktop boot probe keys
    // on it) and the static flag stay behind the gate below.
    if (method === "GET" && path === "/api/health" && !gate.auth) {
      return json(res, 200, { app: "openmausbot" });
    }
    if (!gate.auth) return json(res, gate.status, { error: gate.error });
    const auth = gate.auth;

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
      const requested: unknown = body?.scopes;
      const scopes = Array.isArray(requested) ? requested.filter((v): v is Scope => v === "admin" || v === "client") : undefined;
      const opened = sessions.openPairing({ label: typeof body?.label === "string" ? body.label : undefined, scopes });
      const origin = requestOrigin(req);
      const base = PUBLIC_URL ?? (auth.kind === "session" && origin ? origin : null);
      const code = formatPairingCode(opened.code);
      return json(res, 200, {
        id: opened.id,
        code,
        expiresAt: opened.expiresAt,
        url: base ? `${base}/pair#code=${code}` : null,
        hint: base
          ? null
          : "this server has no public address to put in a link: set OMB_PUBLIC_URL, or open /pair on the address you use and type the code",
      });
    }
    if (method === "GET" && path === "/api/auth/pairing") return json(res, 200, { pairings: sessions.openPairings() });
    m = path.match(/^\/api\/auth\/pairing\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const cancelled = sessions.cancelPairing(m[1]);
      return json(res, cancelled ? 200 : 404, cancelled ? { ok: true } : { error: "no such pairing code" });
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
      });
      return json(res, 201, { token });
    }
    // ── internal peer-agent comms (localhost + bot capability only) ───
    // The agents-proxy (spawned inside a bot's agent process) calls these to
    // discover peers and hand a message to one. Not part of the public API.
    if (path.startsWith("/api/internal/")) {
      const internalCapability = authorizedInternalCapability(req.headers.authorization);
      if (!internalCapability) {
        return json(res, 401, { error: "unauthorized" });
      }
      const internalSender = store.bot(internalCapability.botId);
      if (!internalSender) {
        return json(res, 401, { error: "unauthorized" });
      }
      const requiredCapabilityKind = path.startsWith("/api/internal/connectors/")
        ? "connectors"
        : path === "/api/internal/computer-control"
          ? "computer"
          : "agents";
      if (internalCapability.kind !== requiredCapabilityKind) {
        return json(res, 403, { error: "this internal capability cannot access that service" });
      }
      // Query/body sender ids remain on the wire for proxy compatibility,
      // but the opaque bearer is the authority. Refuse disagreement instead
      // of letting a Full bot reuse its own token to impersonate a peer.
      for (const key of ["self", "fromBotId", "botId"] as const) {
        const claimed = url.searchParams.get(key);
        if (claimed !== null && claimed !== internalSender.id) {
          return json(res, 403, { error: "the internal capability belongs to a different bot" });
        }
      }
      const claimedThread = url.searchParams.get("fromThreadId");
      if (claimedThread !== null && claimedThread !== internalCapability.threadId) {
        return json(res, 403, { error: "the internal capability belongs to a different conversation" });
      }
      const readInternalBody = async () => {
        const body = await readBody(req);
        // The body may arrive slowly. Authorization at header time is not a
        // lease: if the owning turn settled while bytes were in flight, this
        // request must die before it reaches any side effect.
        if (!internalCapabilityIsActive(internalCapability)) {
          throw Object.assign(new Error("the internal turn capability has expired"), { status: 401 });
        }
        if (body && typeof body === "object" && !Array.isArray(body)) {
          for (const key of ["fromBotId", "botId"] as const) {
            if (body[key] !== undefined && String(body[key]) !== internalSender.id) {
              throw Object.assign(new Error("the internal capability belongs to a different bot"), { status: 403 });
            }
          }
          for (const key of ["fromThreadId", "threadId"] as const) {
            if (body[key] !== undefined && String(body[key]) !== internalCapability.threadId) {
              throw Object.assign(new Error("the internal capability belongs to a different conversation"), { status: 403 });
            }
          }
        }
        return body;
      };
      const requireActiveInternalCapability = () => {
        if (!internalCapabilityIsActive(internalCapability)) {
          throw Object.assign(new Error("the internal turn capability has expired"), { status: 401 });
        }
      };
      if (method === "GET" && path === "/api/internal/agents") {
        const sender = internalSender;
        // title/description included so the caller can judge the team (who
        // does what, who has no job description yet). Every bot reads this
        // now, not just the Chief, so it answers the same reachability
        // question the roster does — same peers, same order.
        const bots = reachablePeers(store.bots, sender)
          .map((b) => ({
            id: b.id,
            name: b.name,
            model: b.modelSelection.model,
            busy: !!b.busy,
            title: b.title || undefined,
            description: b.description || undefined,
          }));
        return json(res, 200, { bots });
      }
      // Nothing else ever tells a bot a room id, so this is the discovery
      // half of post_to_room: it lists exactly the rooms that tool would
      // accept, resolved from the sender's own membership. A room a post
      // would be refused for gets no id — an id would only teach the model
      // to keep trying — but it is still NAMED, with the refusal it would
      // have met. Without that the bot can only say it is in no room at
      // all, while the person is looking at it in that very room.
      if (method === "GET" && path === "/api/internal/rooms") {
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        const rooms: Array<{ id: string; name: string; members: string[] }> = [];
        const unpostable: Array<{ name: string; reason: string }> = [];
        for (const group of store.groups) {
          if (group.dm || !group.memberIds.includes(from.id)) continue;
          const eligibility = roomPostEligibility(from, group);
          if (!eligibility.ok) {
            unpostable.push({ name: group.name, reason: eligibility.error });
            continue;
          }
          rooms.push({
            id: group.id,
            name: group.name,
            members: group.memberIds
              .map((id) => store.bot(id))
              .filter((member): member is BotRecord => Boolean(member))
              .map((member) => member.name),
          });
        }
        return json(res, 200, { rooms: rooms.slice(0, 50), unpostable: unpostable.slice(0, 50) });
      }
      if (method === "GET" && path === "/api/internal/routines") {
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        const latestRuns = new Map<string, RoutineRun>();
        // listRuns is newest-first. Keep the first receipt per definition so
        // the agent can answer "did it run?" from scheduler truth rather
        // than guessing from conversation history.
        for (const run of routines!.listRuns()) {
          if (run.botId === from.id && !latestRuns.has(run.routineId)) latestRuns.set(run.routineId, run);
        }
        return json(res, 200, {
          now: new Date().toISOString(),
          timeZone: routineTimeZone(),
          routines: routines!.listRoutines()
            .filter((routine) => routine.botId === from.id)
            .slice(0, 100)
            .map((routine) => agentRoutine(routine, latestRuns.get(routine.id))),
        });
      }
      if (method === "POST" && path === "/api/internal/routine-requests") {
        const parsed = routineRequestEnvelopeSchema.safeParse(await readInternalBody());
        if (!parsed.success) return json(res, 400, { error: "invalid routine proposal" });
        const body = parsed.data;
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        const owner = connectorThread(from.id, fromThreadId);
        if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
        // "Make a routine for @B": resolve the target up front so the model
        // gets a teaching error now, not a mis-bound routine later. Omitted
        // (or the sender's own id) keeps the schedule-for-self path unchanged.
        let forBot: { botId: string; name: string } | undefined;
        if (body.action === "create" && body.forBotId !== undefined) {
          const parsedForBotId = z.string().max(128).safeParse(body.forBotId);
          const forBotId = parsedForBotId.success ? parsedForBotId.data.trim() : "";
          if (!forBotId) {
            return json(res, 400, { error: 'for_bot_id must be a bot id from list_bots, e.g. { "for_bot_id": "bot-abc123" }' });
          }
          if (forBotId !== from.id) {
            const target = store.bot(forBotId);
            if (!target) {
              return json(res, 404, { error: "no bot with that id — call list_bots and copy the exact id from the result" });
            }
            if (sectionKey(target.section) !== sectionKey(from.section)) {
              return json(res, 403, { error: "that bot belongs to a different section" });
            }
            forBot = { botId: target.id, name: target.name };
          }
        }
        const persistence = proposalPersistence(from.id, fromThreadId);
        if (!persistence.ok) {
          return json(res, persistence.status, { error: persistence.error });
        }
        const proposedInput = body.action === "create"
          ? { action: body.action, routine: body.routine, forBot }
          : body.action === "update"
            ? { action: body.action, routineId: body.routineId, changes: body.changes }
            : { action: body.action, routineId: body.routineId };
        const proposed = await routineRequests.propose({
          botId: from.id,
          threadId: fromThreadId,
          proposal: proposedInput,
          from: owner.group ? { botId: from.id, name: from.name, color: from.color } : undefined,
          canCommit: () => internalCapabilityIsActive(internalCapability),
        });
        const proposedCard = store.messagesFor(fromThreadId).find((message) => message.id === proposed.messageId)?.card;
        appendDecision(DATA_DIR, {
          threadId: fromThreadId,
          requestId: proposed.requestId,
          botId: from.id,
          botName: from.name,
          tool: proposedCard?.tool,
          // Audit what the human was actually shown, not the shorter tool
          // response returned to the model.
          summary: proposedCard?.subtitle ?? proposed.summary,
          decision: "card-shown",
          source: "routine",
        });
        return json(res, 201, proposed);
      }
      if (method === "POST" && path === "/api/internal/profile-requests") {
        const parsed = z.object({
          fromBotId: z.string().min(1).max(128),
          fromThreadId: z.string().min(1).max(128),
          forBotId: z.string().max(128).optional(),
          changes: z.unknown(),
          reason: z.unknown(),
        }).strict().safeParse(await readInternalBody());
        if (!parsed.success) return json(res, 400, { error: "invalid profile proposal" });
        const body = parsed.data;
        const from = store.bot(body.fromBotId);
        if (!from) return json(res, 403, { error: "unknown sender" });
        const owner = connectorThread(from.id, body.fromThreadId);
        if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
        const targetBotId = body.forBotId?.trim() || from.id;
        const proposed = profileRequests.propose({
          botId: from.id,
          threadId: body.fromThreadId,
          targetBotId,
          changes: body.changes,
          reason: body.reason,
          from: owner.group ? { botId: from.id, name: from.name, color: from.color } : undefined,
        });
        appendDecision(DATA_DIR, {
          threadId: body.fromThreadId, requestId: proposed.requestId, botId: from.id, botName: from.name,
          tool: "update_profile", summary: proposed.detail, decision: "card-shown", source: "profile",
        });
        return json(res, 201, proposed);
      }
      // session_search: ranked recall over the calling bot's OWN threads,
      // every task included. Own-bot only, on purpose — a bot's transcripts
      // are its notebook the same way MEMORY.md is (section-context.ts draws
      // that line), and search across bots would be an isolation change.
      if (method === "GET" && path === "/api/internal/session-search") {
        const fromBotId = String(url.searchParams.get("fromBotId") ?? "");
        const from = store.bot(fromBotId);
        if (!from) return json(res, 403, { error: "unknown sender" });
        const fromThreadId = String(url.searchParams.get("fromThreadId") ?? from.threadId);
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        const q = String(url.searchParams.get("q") ?? "").trim();
        if (!q) return json(res, 400, { error: "q is required" });
        const rawLimit = Number(url.searchParams.get("limit"));
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 25) : 12;
        const ownThreads = [...new Set([from.threadId, ...(from.tasks ?? []).map((task) => task.threadId)])];
        const hits = recallMessages(q, ownThreads, limit).map((hit) => ({
          ...hit,
          task: store.taskByThread(from.id, hit.threadId)?.title,
          current: hit.threadId === fromThreadId,
        }));
        return json(res, 200, { hits });
      }
      // session_read: the whole message behind a session_search hit. Same
      // own-bot scope — a message id from another bot's thread reads as
      // missing, not as forbidden, so the id space leaks nothing.
      if (method === "GET" && path === "/api/internal/session-read") {
        const fromBotId = String(url.searchParams.get("fromBotId") ?? "");
        const from = store.bot(fromBotId);
        if (!from) return json(res, 403, { error: "unknown sender" });
        const fromThreadId = String(url.searchParams.get("fromThreadId") ?? from.threadId);
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        const threadId = String(url.searchParams.get("threadId") ?? "").trim();
        const messageId = String(url.searchParams.get("messageId") ?? "").trim();
        if (!threadId || !messageId) return json(res, 400, { error: "threadId and messageId are required" });
        const own = threadId === from.threadId || Boolean(store.taskByThread(from.id, threadId));
        const message = own ? readMessageText(threadId, messageId) : null;
        if (!message) return json(res, 404, { error: "no such message in your conversations" });
        return json(res, 200, {
          ...message,
          text: message.text.length > SESSION_READ_MAX_CHARS ? `${message.text.slice(0, SESSION_READ_MAX_CHARS)}…` : message.text,
          task: store.taskByThread(from.id, threadId)?.title,
        });
      }
      if (method === "GET" && path === "/api/internal/skills") {
        if (!skillRecorderEnabled(cfg)) return json(res, 403, { error: "learned skills are not enabled" });
        if (!internalCapability.skillAuthoring) {
          return json(res, 403, { error: "skill authoring is not enabled for this turn" });
        }
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        return json(res, 200, {
          skills: listSkills(from.id),
          staged: listStagedSkillWrites(from.id).map(stagedSkillListing),
        });
      }
      if (method === "POST" && path === "/api/internal/skills/stage") {
        if (!skillRecorderEnabled(cfg)) return json(res, 403, { error: "learned skills are not enabled" });
        if (!internalCapability.skillAuthoring) {
          return json(res, 403, { error: "skill authoring is not enabled for this turn" });
        }
        const body = await readInternalBody();
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        const persistence = skillProposalPersistence(from.id, fromThreadId);
        if (!persistence.ok) return json(res, persistence.status, { error: persistence.error });
        const action = body.action === "create" || body.action === "update" ? body.action : "";
        if (!action) return json(res, 400, { error: 'action must be "create" or "update"' });
        const skillMd = typeof body.skill_md === "string" ? body.skill_md : "";
        if (!skillMd.trim()) {
          return json(res, 400, { error: 'skill_manage needs skill_md: the full SKILL.md including YAML frontmatter, for example ---\\nname: file-expense\\ndescription: Files an expense in the company portal.\\n---\\n\\n# File expense\\n' });
        }
        const source = typeof body.source === "string" ? body.source.trim() : "";
        if (!source) return json(res, 400, { error: 'source must be a URL, folder, or "conversation"' });
        const targetName = typeof body.skill_name === "string" ? body.skill_name.trim() : "";
        if (action === "update" && !targetName) {
          return json(res, 400, { error: "skill_name is required when action is update" });
        }
        const staged = stageSkillWrite(from.id, {
          action,
          targetName: targetName || undefined,
          files: [{ path: "SKILL.md", content: skillMd }],
          gist: typeof body.gist === "string" ? body.gist : undefined,
          source: learnSource(source),
        });
        if ("error" in staged) return json(res, 422, { error: staged.error });
        let card: ReturnType<typeof appendSkillRequestCard>;
        try {
          card = appendSkillRequestCard({ botId: from.id, threadId: fromThreadId, staged });
        } catch (error) {
          rejectStagedSkillWrite(from.id, staged.id);
          throw error;
        }
        appendDecision(DATA_DIR, {
          threadId: fromThreadId,
          requestId: card.requestId,
          botId: from.id,
          botName: from.name,
          tool: "stage_skill",
          summary: card.summary,
          decision: "card-shown",
          source: "skill",
        });
        return json(res, 201, {
          stagedId: staged.id,
          name: staged.name,
          action: staged.action,
          gist: staged.gist,
          warnings: staged.warnings,
          summary: card.summary,
        });
      }
      if (method === "POST" && path === "/api/internal/ask-bot") {
        const body = await readInternalBody();
        const fromBotId = internalSender.id;
        const toBotId = String(body.toBotId ?? "");
        const message = String(body.message ?? "").trim();
        if (
          body.depth !== undefined &&
          (!Number.isInteger(body.depth) || body.depth < 0 || body.depth !== internalCapability.depth)
        ) {
          return json(res, 403, { error: "the recursion depth does not match this turn" });
        }
        const depth = internalCapability.depth;
        if (!toBotId || !message) return json(res, 400, { error: "toBotId and message required" });
        if (toBotId === fromBotId) return json(res, 400, { error: "a bot cannot message itself" });
        if (depth >= MAX_COMMS_DEPTH) return json(res, 200, { error: "message chains are limited to one hop" });
        const target = store.bot(toBotId);
        if (!target) return json(res, 404, { error: "no such bot" });
        // An unknown sender used to fall through: no mirroring AND no
        // approval, while still running the peer turn. That made an
        // unresolvable id the cheapest way past the gate, so it is now a
        // hard refusal — every peer turn has an accountable sender.
        const from = internalSender;
        if (sectionKey(from.section) !== sectionKey(target.section)) {
          return json(res, 403, { error: "that bot belongs to a different section" });
        }
        // The sender's allow-list, when it has one. Checked here rather than
        // trusted from the roster: the tool call carries a bot id, and an id
        // the model held from an earlier turn must not outlive the grant.
        if (!peerAllowed(from, target.id)) {
          return json(res, 403, { error: "that bot is not on this bot's allowed peers — call list_bots for the ones you can reach" });
        }
        const fromThreadId = internalCapability.threadId;
        // Rooms are conversations too. The task-only lookup here refused every
        // ask made from a room turn — the bot could see its teammates and not
        // reach them — while create_bot and the routine endpoints already
        // accepted a group thread the sender belongs to. One ownership rule,
        // and it is still the sender's own membership that decides.
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source thread does not belong to sender" });
        }
        // A busy peer used to be a flat bounce ("try again later") — a
        // dead-end mid-turn that models rarely retry, so the exchange just
        // evaporated. Demote the synchronous ask into a durable handoff
        // instead: the message waits in the delegation ledger (bounded busy
        // retries, receipts, restart-safe) and the asker gets a task id it
        // can check next turn. If the ledger refuses (cap/depth), fall back
        // to the plain busy bounce rather than dropping the refusal reason.
        const queueBusyFallback = (approvalAlreadyGranted = false) => {
          const queued = queueDelegation(
            commsBus,
            from,
            { toBotId, message, reason: "asked while busy", depth, approvalAlreadyGranted },
            MAX_COMMS_DEPTH,
            fromThreadId,
          );
          if (queued.result !== "ok" || !queued.id) return json(res, 200, { busy: true });
          return json(res, 200, { busy: true, taskId: queued.id, toBotName: target.name });
        };
        if (target.busy) return queueBusyFallback();
        let currentFrom = from;
        let currentTarget = target;

        // the exchange is mirrored into a bot⇄bot channel: it shows up in
        // the sidebar like any room, keeps the pair's full history, and the
        // user can open it and chip in. Both 1:1 threads get a clickable
        // chip that opens the channel, so bot-to-bot turns are never
        // invisible (they cost the user tokens).
        //
        // per-bot approval gate: a chief-of-staff bot without this on is
        // free to coordinate; one with it on must wait for a human card
        // (15-min timeout → deny) before its peer turn starts. The channel
        // and the chips are created only AFTER the verdict, so a denied
        // contact leaves no trace of an exchange that never happened.
        if (from.approvePeerComms) {
          const verdict = await requestPeerApproval(
            approvalBus,
            from,
            target,
            message,
            "ask_bot",
            fromThreadId,
          );
          requireActiveInternalCapability();
          if (verdict !== "allow") return json(res, 200, { error: "denied by user" });
          // The card may have been open for minutes. Re-read both records so
          // deleted bots cannot recreate transcripts through stale objects.
          const freshFrom = store.bot(fromBotId);
          const freshTarget = store.bot(toBotId);
          if (!freshFrom || !freshTarget) return json(res, 404, { error: "no such bot" });
          if (sectionKey(freshFrom.section) !== sectionKey(freshTarget.section)) {
            return json(res, 200, { error: "that bot moved to a different section" });
          }
          if (!peerAllowed(freshFrom, freshTarget.id)) {
            return json(res, 200, { error: "that bot is no longer an allowed peer" });
          }
          // Membership can be revoked while the card is open: re-check the
          // same way, so a bot removed from a room mid-approval cannot go on
          // speaking through it.
          if (!connectorThread(freshFrom.id, fromThreadId)) {
            return json(res, 404, { error: "source conversation no longer belongs to sender" });
          }
          // The user just approved this exact ask_bot request. Preserve that
          // decision if it has to become an async handoff; asking twice makes
          // the fallback look stuck behind a second, surprising card.
          if (freshTarget.busy) return queueBusyFallback(true);
          currentFrom = freshFrom;
          currentTarget = freshTarget;
        }
        // An ask made from inside a room is mirrored into that room — the
        // conversation the person is actually reading — the way delegate_bot
        // already does. The pair channel is for asks made from a bot's own
        // thread; sending a room's ask there put the whole exchange behind
        // an unbadged "A ⇄ B" entry nobody had a reason to open.
        const channel = getOrCreateChannel(
          store,
          currentFrom,
          currentTarget,
          connectorThread(currentFrom.id, fromThreadId)?.group,
        );
        mirrorExchange(commsBus, currentFrom, currentTarget, message, channel, fromThreadId);
        const prefixed = withPeerProvenance(message, {
          botName: currentFrom.name,
          delivery: "ask_bot",
          unattended: isUnattended(currentFrom.id),
        });
        const outcome = await askBotAndWait(toBotId, prefixed, depth, fromBotId);
        requireActiveInternalCapability();
        if (outcome.status === "timeout" && !delegationWatch.has(currentTarget.threadId)) {
          // The peer's turn is still running — only the wait ended. Convert
          // the ask into a delegation claim ticket: the watch mirrors the
          // terminal state into the channel AND the asker's thread when the
          // turn settles, and check/wait_delegation read the same receipt.
          // Losing the reply was the old behavior, and it read as "the bots
          // don't respond to each other".
          const taskId = newId();
          delegationWatch.set(currentTarget.threadId, {
            channelId: channel.id,
            toBotId,
            toBotName: currentTarget.name,
            taskId,
            sourceThreadId: fromThreadId,
            sourceBotId: currentFrom.id,
          });
          store.appendMessage(fromThreadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `@${currentTarget.name} is still working — ask converted to a delegation` },
          });
          return json(res, 200, { timeout: true, taskId, toBotName: currentTarget.name, waitedMs: ASK_BOT_TIMEOUT_MS });
        }
        if (outcome.status === "failed" && !outcome.text.trim()) {
          // No partial answer to hand back — mirror the failure where the
          // exchange lives, with the provider's reason instead of silence.
          const why = outcome.stopReason?.trim() ? ` — ${outcome.stopReason.trim().slice(0, 120)}` : "";
          mirrorActivity(commsBus, currentTarget, channel, `Turn failed${why}`, false);
          return json(res, 200, { botName: currentTarget.name, text: `(the bot's turn failed${why})` });
        }
        const reply = outcome.status === "timeout"
          ? outcome.text || "(timed out waiting for the bot to reply)"
          : outcome.text;
        mirrorReply(commsBus, currentTarget, reply, channel);
        return json(res, 200, { botName: currentTarget.name, text: reply });
      }
      // Async handoff: the source bot queues a task for a peer and goes
      // back to the user; the peer turn runs after the source's
      // turn.completed. Returns immediately (the caller does not wait).
      const delegationMatch = method === "GET" ? path.match(/^\/api\/internal\/delegations\/([\w-]{4,64})$/) : null;
      if (delegationMatch) {
        const taskId = delegationMatch[1];
        const fromThreadId = internalCapability.threadId;
        const from = internalSender;
        if (!connectorThread(from.id, fromThreadId)) return json(res, 403, { error: "unknown sender" });
        const waitMs = Math.min(Math.max(Number(url.searchParams.get("wait_ms")) || 0, 0), 240_000);
        const deadline = Date.now() + waitMs;
        // Bounded long-poll: the delegating bot parks ONE cheap HTTP request
        // here instead of burning a model inference per status check.
        for (;;) {
          const receipt = findDelegationReceipt(taskId);
          if (receipt) {
            if (receipt.sourceThreadId !== fromThreadId) {
              return json(res, 403, { error: "that task belongs to a different conversation" });
            }
            return json(res, 200, { status: receipt.status, toBotName: receipt.toBotName, result: receipt.result ?? "" });
          }
          const stillQueued = pendingDelegationInfo(taskId);
          const runningEntry = [...delegationWatch.entries()].find(([, watch]) => watch.taskId === taskId);
          const running = runningEntry?.[1];
          const owner = stillQueued?.sourceThreadId ?? running?.sourceThreadId;
          if (!owner) return json(res, 404, { error: "unknown task id — delegation receipts are kept for about 48 hours" });
          if (owner !== fromThreadId) return json(res, 403, { error: "that task belongs to a different conversation" });
          if (Date.now() >= deadline) {
            const toBotId = stillQueued?.toBotId ?? running?.toBotId ?? "";
            if (running && runningEntry) {
              const recent = summarizeDelegatedActivity(
                store.messagesFor(runningEntry[0]),
                running.startedAtMs ?? Date.now(),
              );
              return json(res, 200, {
                status: "running",
                toBotName: store.bot(toBotId)?.name ?? toBotId,
                elapsedMs: Math.max(0, Date.now() - (running.startedAtMs ?? Date.now())),
                recentActivity: recent,
              });
            }
            return json(res, 200, {
              status: "queued",
              toBotName: store.bot(toBotId)?.name ?? toBotId,
            });
          }
          await new Promise((wake) => setTimeout(wake, 500));
        }
      }
      if (method === "POST" && path === "/api/internal/delegate-bot") {
        const body = await readInternalBody();
        const toBotId = String(body.toBotId ?? "");
        const message = String(body.message ?? "").trim();
        const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
        if (
          body.depth !== undefined &&
          (!Number.isInteger(body.depth) || body.depth < 0 || body.depth !== internalCapability.depth)
        ) {
          return json(res, 403, { error: "the recursion depth does not match this turn" });
        }
        const depth = internalCapability.depth;
        if (!toBotId || !message) return json(res, 400, { error: "toBotId and message required" });
        const from = internalSender;
        const target = store.bot(toBotId);
        if (!target) return json(res, 404, { error: "no such bot" });
        if (sectionKey(from.section) !== sectionKey(target.section)) {
          return json(res, 403, { error: "that bot belongs to a different section" });
        }
        if (!peerAllowed(from, target.id)) {
          return json(res, 403, { error: "that bot is not on this bot's allowed peers — call list_bots for the ones you can reach" });
        }
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source thread does not belong to sender" });
        }
        const queued = queueDelegation(
          commsBus,
          from,
          { toBotId, message, reason, depth },
          MAX_COMMS_DEPTH,
          fromThreadId,
        );
        if (queued.result !== "ok" || !queued.id) {
          // the agent reads this string — a bare enum ("too_deep") tells it
          // nothing about what to do instead
          const said: Record<Exclude<QueueResult, "ok">, string> = {
            self: "a bot cannot delegate to itself",
            too_deep: "delegation chains are limited to one hop — do this one yourself",
            no_target: "no such bot",
            too_many: "too many delegations queued on this turn — finish some first",
          };
          return json(res, 200, { error: said[queued.result === "ok" ? "no_target" : queued.result] });
        }
        const targetName = store.bot(toBotId)?.name ?? toBotId;
        return json(res, 200, {
          queued: true,
          taskId: queued.id,
          message: from.approvePeerComms
            ? `Queued for review — @${targetName} will only pick it up if the user approves after your turn finishes.`
            : `Delegation queued — @${targetName} will pick it up after your current turn finishes.`,
        });
      }
      // post_to_room: a bot puts ONE message into a room it belongs to,
      // without a turn being started for anyone. Everything about it is a
      // deliberate non-event:
      //
      //   role "bot", never "user". A user-role append is what the composer
      //   writes, and it re-enters responder selection — one tool call would
      //   become a round of real turns, which is the notification storm this
      //   whole surface exists to avoid.
      //
      //   no startGroupTurn and no queue kick. The post lands, the room is
      //   marked unread, the person reads it when they look. A bot wanting a
      //   reply has ask_bot and delegate_bot, both of which are accounted for.
      //
      //   membership from the record, never from the argument: the argument
      //   only says which room to look up.
      if (method === "POST" && path === "/api/internal/post-to-room") {
        const body = await readInternalBody();
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        const owner = connectorThread(from.id, fromThreadId);
        if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
        const groupId = String(body.groupId ?? "").trim();
        const message = String(body.message ?? "").trim();
        if (!groupId || !message) {
          return json(res, 400, { error: "post_to_room needs group_id (from list_rooms) and message" });
        }
        if (message.length > ROOM_POST_MAX_CHARS) {
          return json(res, 400, {
            error: `a room post is at most ${ROOM_POST_MAX_CHARS} characters — post the short version and keep the detail in your own reply`,
          });
        }
        let room = store.group(groupId);
        if (!room) return json(res, 404, { error: "no such room — call list_rooms and copy the exact id from the result" });
        // Posting into the room you are already speaking in is not a peer
        // message, it is your own reply arriving twice — and it feeds your
        // words back into the context the same turn is answering from.
        if (room.id === owner.group?.id) {
          return json(res, 409, { error: "you are already speaking in that room — say it in your reply instead" });
        }
        const eligibility = roomPostEligibility(from, room);
        if (!eligibility.ok) return json(res, eligibility.status, { error: eligibility.error });
        // The budget is read BEFORE any approval card and CHARGED only on
        // the path that actually appends. Reading it early is what stops a
        // bot in a loop turning that loop into a queue of cards for a person
        // to work through: the refusal lands on the bot, not in the inbox.
        // Charging it early would have been a lie in the other direction —
        // a denied card, a room deleted while the card was open, or a
        // roster change that ends the post all leave the room with nothing
        // in it, and a room that took no post must not be told it did. The
        // model would then be refused its retry with "you already posted
        // that", which is the one thing worse than a refusal: a false
        // receipt for a message nobody can read.
        const askBudget = (bot: BotRecord, group: GroupRecord) => {
          const attempt: RoomPostAttempt = {
            botId: bot.id,
            botName: bot.name,
            text: message,
            now: Date.now(),
          };
          // The person attending is whoever wrote last: in the room, or —
          // when the post was asked for in the sender's own conversation —
          // there. A room-sourced post has no such person; its room is the
          // conversation, and what a person wrote in it is already counted.
          const askedAt = owner.group ? undefined : personAskAt.get(fromThreadId);
          const spokeAt = Math.max(lastHumanRoomMessageAt(group) ?? -Infinity, askedAt ?? -Infinity);
          if (Number.isFinite(spokeAt)) attempt.lastHumanAt = spokeAt;
          return decideRoomPost(roomPostBudgets.get(group.id) ?? emptyRoomPostBudget(), attempt);
        };
        // A refusal is stored, an allowance is not: the budget a refusal
        // hands back never contains the attempt — it is the pruning, plus
        // the breaker if this call is what tripped it — so keeping it costs
        // the room nothing and losing it would let a ring re-form one call
        // later.
        const preflight = askBudget(from, room);
        if (!preflight.allowed) {
          roomPostBudgets.set(room.id, preflight.budget);
          return json(res, 429, { error: preflight.message });
        }
        let poster = from;
        if (from.approvePeerComms) {
          // Same gate ask_bot carries, aimed at the room instead of a peer:
          // a bot the user asked to be consulted about must be consulted here
          // too, or the newest way to reach other bots is the one way round it.
          const verdict = await requestPeerApproval(
            approvalBus,
            from,
            { id: room.id, name: room.name },
            message,
            "post_to_room",
            fromThreadId,
          );
          requireActiveInternalCapability();
          if (verdict !== "allow") return json(res, 200, { error: "denied by user" });
          // The card may have been open for minutes. Re-read both records so a
          // roster change, a section move, or a deletion during that window
          // cannot be posted through on a stale decision.
          const freshFrom = store.bot(internalSender.id);
          const freshRoom = store.group(groupId);
          if (!freshFrom || !freshRoom) return json(res, 404, { error: "that bot or room no longer exists" });
          const stillEligible = roomPostEligibility(freshFrom, freshRoom);
          if (!stillEligible.ok) return json(res, stillEligible.status, { error: stillEligible.error });
          poster = freshFrom;
          room = freshRoom;
        }
        // The room's budget is charged here, against the records the append
        // below will actually use. Between the preflight and this line the
        // room may have taken another bot's post, so this decision — not the
        // preflight — is the one that can refuse.
        const decision = askBudget(poster, room);
        roomPostBudgets.set(room.id, decision.budget);
        if (!decision.allowed) return json(res, 429, { error: decision.message });
        // Unattended inheritance: the mark rides the sender, and reading it
        // here is also what keeps its window alive through a turn that only
        // posts — an aged-out mark would hand the next hop to auto-approve.
        const unattended = isUnattended(poster.id);
        const posted = store.appendMessage(room.threadId, {
          role: "bot",
          kind: "text",
          text: message,
          from: { botId: poster.id, name: poster.name, color: poster.color },
          peerPost: unattended ? { unattended: true } : {},
        });
        store.patchGroup(room.id, { unread: true });
        // The same visibility contract the peer tools keep: whatever a bot
        // does elsewhere shows up in the conversation it is actually in.
        // The chip is settled — the post has already landed — and carries
        // the same link a "Messaged @X" chip does, which is what makes it a
        // receipt rather than a log line: linked chips stay visible with
        // tool calls off, and open the room they name.
        const chip: Omit<Message, "id" | "at"> = {
          role: "bot",
          kind: "activity",
          tool: { name: `Posted in ${room.name}`, ok: true },
          comm: { groupId: room.id, withBotId: poster.id, withName: room.name, withColor: poster.color },
        };
        if (owner.group) chip.from = { botId: poster.id, name: poster.name, color: poster.color };
        store.appendMessage(fromThreadId, chip);
        return json(res, 201, { ok: true, messageId: posted.id, roomName: room.name });
      }
      if (method === "POST" && path === "/api/internal/create-bot") {
        const body = await readInternalBody();
        const chief = internalSender;
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(chief.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        if (!chief.chiefOfStaff) {
          return json(res, 403, { error: "only a section's Chief of Staff can create operator bots" });
        }
        if (internalCapability.createdBots >= 4) {
          return json(res, 429, { error: "you can create at most 4 bots in one turn" });
        }
        if (store.bots.length >= MAX_WORKSPACE_BOTS) {
          return json(res, 409, { error: `this workspace is limited to ${MAX_WORKSPACE_BOTS} bots` });
        }
        const name = String(body.name ?? "").trim();
        const role = String(body.role ?? "").trim();
        const instructions = String(body.instructions ?? "").trim();
        if (!name || !role || !instructions) {
          return json(res, 400, { error: "name, role, and instructions are required" });
        }
        if (name.length > 80) return json(res, 400, { error: "name must be at most 80 characters" });
        if (role.length > 120) return json(res, 400, { error: "role must be at most 120 characters" });
        // the same door the profile endpoints keep: both fields are quoted
        // into every other room member's system prompt, one line each
        if (!fitsOnOneLine(name)) return json(res, 400, { error: "name must fit on one line" });
        if (!fitsOnOneLine(role)) return json(res, 400, { error: "role must fit on one line" });
        if (instructions.length > 1_000) {
          return json(res, 400, { error: "instructions must be at most 1000 characters" });
        }
        const duplicate = store.bots.find(
          (candidate) =>
            !candidate.hidden &&
            sectionKey(candidate.section) === sectionKey(chief.section) &&
            candidate.name.trim().toLowerCase() === name.toLowerCase(),
        );
        if (duplicate) {
          return json(res, 409, { error: `@${duplicate.name} already exists in this section; use list_bots` });
        }
        const created = store.createBot(
          {
            name,
            title: role,
            description: instructions,
            modelSelection: { ...chief.modelSelection },
            section: chief.section,
          },
          { seedMessages: false },
        );
        const safeBot = store.patchBot(created.id, {
          composio: false,
          autoApprove: false,
          approvePeerComms: false,
        })!;
        internalCapability.createdBots += 1;
        return json(res, 201, {
          id: safeBot.id,
          name: safeBot.name,
          title: safeBot.title,
          section: safeBot.section || "General",
          model: safeBot.modelSelection.model,
        });
      }
      if (method === "POST" && path === "/api/internal/request-credential") {
        const body = await readInternalBody();
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        const owner = connectorThread(from.id, fromThreadId);
        if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
        if (!isCredentialTargetId(body.credentialId)) {
          return json(res, 400, { error: "unsupported credential id" });
        }
        const credentialId: CredentialTargetId = body.credentialId;
        const target = CREDENTIAL_TARGETS[credentialId];
        if (credentialIsConfigured(cfg, credentialId)) {
          return json(res, 200, { alreadyConfigured: true, label: target.label });
        }
        const existing = store.activePath(fromThreadId).find((message) =>
          isReusableCredentialRequest(message, credentialId, from.id, Boolean(owner.group))
        );
        if (existing) {
          if (!existing.text?.trim()) {
            store.patchMessage(fromThreadId, existing.id, {
              text: credentialDesktopHandoff(target.label),
            });
          }
          return json(res, 200, { messageId: existing.id, label: target.label });
        }
        const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 240) : "";
        const message = store.appendMessage(fromThreadId, {
          role: "bot",
          kind: "secret",
          text: credentialDesktopHandoff(target.label),
          ...(owner.group ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
          secret: {
            target: credentialId,
            label: target.label,
            description: `${reason ? `${target.description} ${reason}` : target.description} ${from.name} can use it but never read it back.`,
            placeholder: target.placeholder,
            helpUrl: target.helpUrl,
            requestKey: randomUUID(),
          },
        });
        return json(res, 201, { messageId: message.id, label: target.label });
      }
      if (method === "POST" && path === "/api/internal/connectors/mcp") {
        const body = await readInternalBody();
        // Reading a streamed MCP body yields to ordinary settings requests.
        // Re-read the live bot immediately before relay so turning Connected
        // Apps off wins over a request that authenticated under the old value.
        const currentSender = store.bot(internalCapability.botId);
        if (!currentSender || currentSender.composio === false || !composio.configured(cfg)) {
          return json(res, 403, { error: "connected apps are not enabled for this bot" });
        }
        const upstream = await composio.relayMcp(
          cfg,
          body,
          Array.isArray(req.headers["mcp-session-id"])
            ? req.headers["mcp-session-id"][0]
            : req.headers["mcp-session-id"],
        );
        const headers: Record<string, string> = {
          "content-type": upstream.contentType,
          "cache-control": "no-store",
        };
        if (upstream.transportSessionId) headers["mcp-session-id"] = upstream.transportSessionId;
        res.writeHead(upstream.status, headers);
        return res.end(Buffer.from(upstream.bytes));
      }
      // ── computer control: proxies read the hold, bots plead for help ──
      if (path === "/api/internal/computer-control") {
        const botId = url.searchParams.get("botId") ?? "";
        const bot = store.bot(botId);
        if (!bot) return json(res, 404, { error: "no such bot" });
        if (method === "GET") {
          const snapshot = computerControl.snapshot(botId);
          return json(res, 200, { held: snapshot.held, helpOpen: snapshot.helpReason !== null });
        }
        if (method === "POST") {
          const body = await readInternalBody();
          const { snapshot, requestId } = computerControl.requestHelpLease(botId, body.reason);
          // worth a buzz: the bot is blocked on the person's hands, which
          // is exactly the "blocked on you" rule notify.ts encodes.
          // A bot stuck mid-room is not in its 1:1 thread — the turn and the
          // screen it needs hands on are in the room — so send the person
          // where the work is, and say which room it was.
          const roomTurn = activeGroupTurnForBot(bot.id);
          const target = blockedTarget(bot, roomTurn && { ...roomTurn.group, threadId: roomTurn.threadId });
          notify(
            buildNotification("takeover", bot, target.threadId, snapshot.helpReason ?? "asked you to take over", {
              group: target.group,
            }),
          );
          return json(res, 200, { held: snapshot.held, helpOpen: snapshot.helpReason !== null, requestId });
        }
        if (method === "DELETE") {
          const body = await readInternalBody();
          const snapshot = computerControl.expireHelp(botId, body.requestId);
          return json(res, 200, { held: snapshot.held, helpOpen: snapshot.helpReason !== null });
        }
        return json(res, 405, { error: "method not allowed" });
      }
      if (method === "POST" && path === "/api/internal/connectors/request") {
        const body = await readInternalBody();
        const botId = String(body.botId ?? "");
        const threadId = String(body.threadId ?? "");
        const resumeKey = String(body.resumeKey ?? "");
        const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.slugs) ? body.slugs : [];
        const items: { slug: string; alias?: string }[] = [];
        for (const raw of rawItems as unknown[]) {
          if (typeof raw === "string") {
            const slug = raw.trim().toLowerCase();
            if (CONNECTOR_SLUG.test(slug)) items.push({ slug });
            continue;
          }
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const row = raw as { slug?: unknown; toolkit?: unknown; alias?: unknown; account?: unknown };
          const slug = typeof row.slug === "string" ? row.slug : typeof row.toolkit === "string" ? row.toolkit : undefined;
          if (!slug || !CONNECTOR_SLUG.test(slug.toLowerCase())) continue;
          const alias = composio.normalizeAccountAlias((row.alias ?? row.account) as string | undefined);
          items.push({ slug: slug.toLowerCase(), ...(alias ? { alias } : {}) });
        }
        const slugs = [...new Set(items.map((item) => item.slug))];
        const owner = connectorThread(botId, threadId);
        if (!owner) return json(res, 403, { error: "conversation does not belong to this bot" });
        if (!/^[\w-]{8,100}$/.test(resumeKey)) return json(res, 400, { error: "invalid resume key" });
        if (!items.length || items.length > 12) return json(res, 400, { error: "one to twelve valid connection requests are required" });
        if (!composio.configured(cfg) || owner.bot.composio === false) {
          return json(res, 409, { error: "connected apps are not enabled for this bot" });
        }
        const connectionState: Record<string, { connected?: boolean }> = await composio.connectionStatus(cfg, slugs).catch(() => ({}));
        requireActiveInternalCapability();
        const messageIds: string[] = [];
        for (const item of items) {
          const existing = store.messagesFor(threadId).find(
            (message) => message.connector?.resumeKey === resumeKey && message.connector.slug === item.slug
              && (message.connector.alias ?? "").toLowerCase() === (item.alias ?? "").toLowerCase(),
          );
          if (existing) {
            messageIds.push(existing.id);
            continue;
          }
          const toolkit = await composio.toolkitCard(cfg, item.slug);
          requireActiveInternalCapability();
          const connected = connectionState[item.slug]?.connected === true;
          const status = item.alias ? "required" : connected ? "connected" : "required";
          const description = item.alias
            ? `Connect ${toolkit.label} as “${item.alias}” so the bot can continue`
            : toolkit.blurb || `Connect ${toolkit.label} so the bot can continue`;
          const message = store.appendMessage(threadId, {
            role: "bot",
            kind: "connector",
            ...(owner.group ? { from: { botId: owner.bot.id, name: owner.bot.name, color: owner.bot.color } } : {}),
            connector: {
              slug: item.slug,
              label: toolkit.label,
              description,
              status,
              resumeKey,
              ...(item.alias ? { alias: item.alias } : {}),
            },
          });
          messageIds.push(message.id);
        }
        maybeResumeConnectors(botId, threadId, resumeKey);
        return json(res, 200, { messageIds });
      }
      return json(res, 404, { error: "unknown internal endpoint" });
    }

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
    if (path === "/api/routines" && method === "GET") {
      const fromParam = url.searchParams.get("from");
      const toParam = url.searchParams.get("to");
      const from = fromParam == null ? undefined : Number(fromParam);
      const to = toParam == null ? undefined : Number(toParam);
      return json(res, 200, {
        routines: routines!.listRoutines(),
        runs: routines!.listRuns(from != null && Number.isFinite(from) ? from : undefined, to != null && Number.isFinite(to) ? to : undefined),
      });
    }
    if (path === "/api/routines" && method === "POST") {
      return json(res, 201, { routine: routines!.create(await readBody(req)) });
    }
    let routineMatch = path.match(/^\/api\/routines\/([\w-]+)\/run$/);
    if (routineMatch && method === "POST") {
      const run = routines!.runNow(routineMatch[1]);
      return run ? json(res, 201, { run }) : json(res, 404, { error: "no such routine" });
    }
    routineMatch = path.match(/^\/api\/routines\/([\w-]+)$/);
    if (routineMatch && method === "PATCH") {
      const routine = routines!.update(routineMatch[1], await readBody(req));
      return routine ? json(res, 200, { routine }) : json(res, 404, { error: "no such routine" });
    }
    if (routineMatch && method === "DELETE") {
      return routines!.remove(routineMatch[1])
        ? json(res, 200, { ok: true })
        : json(res, 404, { error: "no such routine" });
    }
    const runMatch = path.match(/^\/api\/routine-runs\/([\w-]+)\/(cancel|seen)$/);
    if (runMatch && method === "POST") {
      const run = runMatch[2] === "cancel"
        ? await routines!.cancelRun(runMatch[1])
        : routines!.markSeen(runMatch[1]);
      return run ? json(res, 200, { run }) : json(res, 404, { error: "no such active run" });
    }

    // ── scheduled room sessions ────────────────────────────────────────
    if (path === "/api/calendar-calls" && method === "GET") {
      return json(res, 200, { calls: calendarCalls!.list() });
    }
    if (path === "/api/calendar-calls" && method === "POST") {
      try {
        return json(res, 201, { call: calendarCalls!.create(await readBody(req)) });
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 });
      }
    }
    const calendarCallRoomMatch = path.match(/^\/api\/calendar-calls\/([\w-]+)\/room$/);
    if (calendarCallRoomMatch && method === "POST") {
      const call = calendarCalls!.get(calendarCallRoomMatch[1]);
      if (!call) return json(res, 404, { error: "no such scheduled call" });
      if (call.botIds.length < 2) {
        return json(res, 400, { error: "single-bot events open that bot's chat directly" });
      }
      const group = ensureCalendarCallRoom(call);
      return json(res, 200, { group: { ...publicGroupState(group), messages: store.messagesFor(group.threadId) } });
    }
    const calendarCallMatch = path.match(/^\/api\/calendar-calls\/([\w-]+)$/);
    if (calendarCallMatch && method === "PATCH") {
      if (!calendarCalls!.get(calendarCallMatch[1])) return json(res, 404, { error: "no such scheduled call" });
      try {
        return json(res, 200, { call: calendarCalls!.update(calendarCallMatch[1], await readBody(req)) });
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 });
      }
    }
    if (calendarCallMatch && method === "DELETE") {
      return calendarCalls!.remove(calendarCallMatch[1])
        ? json(res, 200, { ok: true })
        : json(res, 404, { error: "no such scheduled call" });
    }

    // ── independent webhook triggers ────────────────────────────────────
    // Management stays on the app-only server. Actual deliveries land on a
    // second, webhook-only loopback listener so Funnel or a future hosted
    // relay never has to expose the rest of OpenMausBot's control surface.
    if (path === "/api/webhooks" && method === "GET") {
      return json(res, 200, { webhooks: webhooks.list(), attempts: webhooks.listAttempts(), ingress: webhookIngressStatus() });
    }
    if (path === "/api/webhooks" && method === "POST") {
      const created = webhooks.create(await readBody(req));
      const ingress = webhookIngressStatus();
      return json(res, 201, {
        webhook: created.webhook,
        ingress,
        credential: webhookCredential(ingress.baseUrl, created.webhook.endpointId, created.secret),
      });
    }
    let webhookMatch = path.match(/^\/api\/webhooks\/([\w-]+)\/(rotate|test)$/);
    if (webhookMatch && method === "POST") {
      if (webhookMatch[2] === "test") {
        const result = webhooks.test(webhookMatch[1], await readBody(req));
        return result ? json(res, 202, result) : json(res, 404, { error: "no such webhook" });
      }
      const rotated = webhooks.rotateSecret(webhookMatch[1]);
      if (!rotated) return json(res, 404, { error: "no such webhook" });
      const ingress = webhookIngressStatus();
      return json(res, 200, {
        webhook: rotated.webhook,
        ingress,
        credential: webhookCredential(ingress.baseUrl, rotated.webhook.endpointId, rotated.secret),
      });
    }
    webhookMatch = path.match(/^\/api\/webhooks\/([\w-]+)$/);
    if (webhookMatch && method === "PATCH") {
      const webhook = webhooks.update(webhookMatch[1], await readBody(req));
      return webhook ? json(res, 200, { webhook }) : json(res, 404, { error: "no such webhook" });
    }
    if (webhookMatch && method === "DELETE") {
      return webhooks.remove(webhookMatch[1])
        ? json(res, 200, { ok: true })
        : json(res, 404, { error: "no such webhook" });
    }

    // ── events stream ──
    if (method === "GET" && path === "/api/events") {
      const client: SseClient = { res, screens: url.searchParams.get("screens") !== "off" };
      if (auth.kind === "session") client.sessionId = auth.session.id;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        // Honoured by nginx-compatible reverse proxies; harmless elsewhere.
        // Remote clients need each frame now, not when a proxy buffer fills.
        "x-accel-buffering": "no",
      });

      // Resume, if the client offered a cursor we can honour. `?since=` is
      // for clients that read the stream by hand; Last-Event-ID is what a
      // browser EventSource sends by itself.
      // Once EventSource has received a numbered frame, its automatic
      // reconnect carries a newer Last-Event-ID even though the original
      // URL may still contain an older manual `since` cursor. Prefer the
      // valid browser cursor or the stale query would replay forever.
      const since =
        cursorSeq(req.headers["last-event-id"]) ??
        cursorSeq(url.searchParams.get("since") ?? undefined);
      // The buffer only reaches so far back. If the client's cursor fell off
      // the end, saying so is the only honest answer — a partial replay
      // would leave a permanent hole in its state.
      const resumed =
        since !== null &&
        since <= lastSeq &&
        (replayBuffer.length === 0 ? since === lastSeq : replayBuffer[0].seq <= since + 1);
      res.write(
        `data: ${JSON.stringify({
          kind: "hello",
          cursor: `${STREAM_ID}:${lastSeq}`,
          // false means "I could not give you what you missed — hydrate".
          // A client that offered no cursor gets false too, which is exactly
          // what a cold start should do.
          resumed,
        })}\n\n`,
      );
      if (resumed) {
        for (const buffered of replayBuffer) {
          if (buffered.seq > since && buffered.frame && wants(client, buffered.kind)) res.write(buffered.frame);
        }
      }

      sseClients.add(client);
      // Keep this long-lived response out of socket idle-timeout handling
      // without weakening timeouts for every other API request.
      req.socket.setTimeout(0);
      // A comment keeps intermediaries from idling the connection, while a
      // data frame is visible to EventSource clients and resets their own
      // liveness watchdog. Heartbeats carry no id and never advance replay.
      const keepalive = setInterval(() => {
        // an expired session's stream ends at the next heartbeat
        if (client.sessionId && !sessions.isLive(client.sessionId)) {
          res.end();
          return;
        }
        try {
          res.write(`: keepalive\n\ndata: ${JSON.stringify({ kind: "ping" })}\n\n`);
        } catch {}
      }, SSE_HEARTBEAT_MS);
      req.on("close", () => {
        clearInterval(keepalive);
        sseClients.delete(client);
      });
      return;
    }

    // ── bots ──
    if (method === "GET" && path === "/api/bots") {
      const limit = pageSize(url.searchParams.get("messages"));
      if (limit === null) return json(res, 400, { error: "messages must be a non-negative whole number" });
      return json(res, 200, {
        bots: store.bots.map((bot) => ({ ...publicBot(bot), ...messagePage(bot.threadId, limit) })),
        groups: store.groups.map((g) => ({ ...publicGroupState(g), ...messagePage(g.threadId, limit) })),
        computerControl: Object.fromEntries(
          store.bots.map((bot) => {
            const snapshot = computerControl.snapshot(bot.id);
            return [bot.id, { held: snapshot.held, helpReason: snapshot.helpReason }];
          }),
        ),
      });
    }

    // scrollback: the page before a message the client already holds
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages$/);
    if (m && method === "GET") {
      const threadId = m[1];
      if (!store.botByThread(threadId) && !store.groupByThread(threadId)) {
        return json(res, 404, { error: "no such conversation" });
      }
      const limit = pageSize(url.searchParams.get("limit"));
      if (limit === null) return json(res, 400, { error: "limit must be a non-negative whole number" });
      const before = url.searchParams.get("before");
      const around = url.searchParams.get("around");
      if (before && around) return json(res, 400, { error: "before and around cannot be combined" });
      if (around) {
        const window = messageWindow(threadId, around, limit ?? DEFAULT_PAGE);
        if (!window) return json(res, 404, { error: "no such message" });
        return json(res, 200, window);
      }
      // An unknown cursor must not silently answer with the newest page —
      // the client would paginate in a circle and never reach the top.
      if (before && !store.messagesFor(threadId).some((msg) => msg.id === before)) {
        return json(res, 404, { error: "no such message" });
      }
      return json(res, 200, messagePage(threadId, limit ?? DEFAULT_PAGE, before));
    }

    // the pixels of one screen message, fetched only when something shows it
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/image$/);
    if (m && method === "GET") {
      // Same guard as the page route above, and for the same reason twice
      // over: an unknown id should 404 deliberately rather than by accident,
      // and `messagesFor` materialises and caches a ThreadState for whatever
      // it is handed. Without this, a client asking for images on ids that
      // do not exist grows the thread map for as long as it keeps asking.
      if (!store.botByThread(m[1]) && !store.groupByThread(m[1])) {
        return json(res, 404, { error: "no such conversation" });
      }
      const message = store.messagesFor(m[1]).find((msg) => msg.id === m![2]);
      if (!message?.png) return json(res, 404, { error: "no image on that message" });
      const bytes = Buffer.from(message.png, "base64");
      res.writeHead(200, {
        "content-type": message.mime ?? "image/png",
        "content-length": String(bytes.byteLength),
        // a settled message's image never changes
        "cache-control": "private, max-age=31536000, immutable",
      });
      return res.end(bytes);
    }

    // Download one local file only when this exact stored message grants it:
    // a bot must render a Markdown link to it, while a user message must carry
    // the exact standalone attachment tag written by the composer. The bot
    // branch derives conversation/workspace roots; the user branch is limited
    // to OpenMausBot's private attachment directory. This is deliberately not
    // a general path reader.
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/file$/);
    const streamsMessageImage = Boolean(
      m && method === "GET" && url.searchParams.get("preview") === "1",
    );
    if (m && (method === "POST" || streamsMessageImage)) {
      if (method === "POST" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const threadId = m[1]!;
      const directBot = store.botByThread(threadId);
      const group = directBot ? undefined : store.groupByThread(threadId);
      if (!directBot && !group) return json(res, 404, { error: "no such conversation" });

      const message = store.messagesFor(threadId).find((candidate) => candidate.id === m![2]);
      if (!message) return json(res, 404, { error: "no such message" });
      if (message.kind !== "text" || !message.text) {
        return json(res, 403, { error: "that message does not share this file" });
      }
      const body = method === "POST" ? await readBody(req) : null;
      const rawReference = streamsMessageImage ? url.searchParams.get("ref") : null;
      if (streamsMessageImage && (!rawReference || !/^\d+$/.test(rawReference))) {
        return json(res, 400, { error: "ref must identify a rendered image" });
      }
      const href = method === "POST"
        ? (typeof body.path === "string" ? body.path : "")
        : messageImageTargetAt(message.text, Number(rawReference));
      if (!href) return json(res, 400, { error: "path is required" });

      let roots: string[];
      let downloadName: string | undefined;
      if (message.role === "user") {
        downloadName = messageAttachmentName(message.text, href) ?? undefined;
        if (!downloadName) {
          return json(res, 403, { error: "that message does not share this file" });
        }
        roots = [ATTACHMENTS_DIR];
      } else {
        if (!messageReferencesFile(message.text, href)) {
          return json(res, 403, { error: "that bot message does not link to this file" });
        }
        const senderId = directBot?.id ?? message.from?.botId;
        // The persisted bot-role message is the author record. Membership is
        // intentionally not consulted: removing a bot must not break files it
        // already shared in channel history.
        if (!senderId) {
          return json(res, 403, { error: "the file's bot author could not be verified" });
        }
        let pinnedCwd: string | null | undefined;
        let configuredCwd: string | undefined;
        if (directBot) {
          pinnedCwd = store.taskByThread(directBot.id, threadId)?.cwd;
          configuredCwd = directBot.cwd;
        } else if (group) {
          const task = store.groupTaskByThread(group.id, threadId);
          pinnedCwd = task ? task.pinnedCwd : group.threadId === threadId ? group.pinnedCwd : undefined;
          configuredCwd = group.cwd;
        }

        roots = messageFileRoots({
          senderWorkspace: workspaceDir(senderId),
          attachments: ATTACHMENTS_DIR,
          pinnedCwd,
          configuredCwd,
        });
      }

      const file = await openMessageFile(href, roots);
      if (streamsMessageImage && !file.mime.startsWith("image/")) {
        await file.handle.close();
        return json(res, 415, { error: "only images can be previewed here" });
      }
      res.writeHead(200, {
        "content-type": file.mime,
        "content-length": String(file.bytes),
        ...(streamsMessageImage
          ? { "content-disposition": "inline" }
          : { "content-disposition": messageFileDisposition(messageFileDownloadName(downloadName, file.name)) }),
        "cache-control": streamsMessageImage ? "private, max-age=3600" : "private, no-store",
        "cdn-cache-control": "no-store",
        "cloudflare-cdn-cache-control": "no-store",
        pragma: "no-cache",
        vary: "Authorization",
        "x-content-type-options": "nosniff",
        ...(streamsMessageImage
          ? {
              "cross-origin-resource-policy": "same-origin",
              "referrer-policy": "no-referrer",
            }
          : {}),
      });
      if (file.bytes === 0) {
        await file.handle.close();
        return res.end();
      }
      const stream = file.handle.createReadStream({ start: 0, end: file.bytes - 1, autoClose: true });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
      return;
    }

    // ── image attachments ────────────────────────────────────────────────
    // Pasted/dropped images are stored as files and referenced by path in
    // the prompt (<attached-image path="…"/>); this pair of routes is the
    // save + serve. The POST takes raw bytes (base64 JSON would double the
    // payload), so it needs its own reader rather than readBody. A share
    // extension can add a UUID uploadId; retrying that UUID returns the same
    // committed path instead of creating an orphan duplicate.
    if (method === "POST" && path === "/api/attachments") {
      let uploadId: string | undefined;
      try {
        uploadId = validateAttachmentUploadId(url.searchParams.get("uploadId") ?? undefined);
      } catch (error) {
        req.resume();
        throw error;
      }
      const rawType = Array.isArray(req.headers["content-type"]) ? req.headers["content-type"][0] : req.headers["content-type"];
      const mime = rawType?.split(";")[0]?.trim().toLowerCase();
      if (!mime || !extensionForMime(mime)) {
        return json(res, 400, { error: "content-type must be an image type" });
      }
      const rawLength = Array.isArray(req.headers["content-length"])
        ? req.headers["content-length"][0]
        : req.headers["content-length"];
      const declaredLength = rawLength === undefined ? undefined : Number(rawLength);
      if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        req.resume();
        return json(res, 400, { error: "content-length must be a non-negative integer" });
      }
      if (declaredLength !== undefined && declaredLength > IMAGE_MAX_BYTES) {
        req.resume();
        return json(res, 413, { error: `image exceeds ${IMAGE_MAX_BYTES} bytes` });
      }
      const saved = await new Promise<SavedAttachment>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let settled = false;
        const fail = (status: number, msg: string) => {
          if (settled) return;
          settled = true;
          reject(Object.assign(new Error(msg), { status }));
        };
        req.on("data", (chunk: Buffer) => {
          if (settled) return;
          received += chunk.byteLength;
          if (received > IMAGE_MAX_BYTES) return fail(413, `image exceeds ${IMAGE_MAX_BYTES} bytes`);
          chunks.push(chunk);
        });
        req.on("end", async () => {
          if (settled) return;
          settled = true;
          try {
            resolve(await saveImageUpload(Buffer.concat(chunks), mime, uploadId));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
        req.on("error", (e) => fail(400, e instanceof Error ? e.message : String(e)));
      });
      return json(res, 201, saved);
    }

    // ── shared files ────────────────────────────────────────────────────
    // Companion apps and the desktop composer send documents as raw bytes
    // over the same authenticated connection as messages. saveFile writes each
    // incoming chunk directly to disk, atomically commits it, and removes
    // partial uploads on error. Its optional UUID uploadId is stable across
    // route retries, while the aggregate store quota rejects rather than
    // silently deleting files that old prompts may still reference.
    if (method === "POST" && path === "/api/files") {
      let uploadId: string | undefined;
      try {
        uploadId = validateAttachmentUploadId(url.searchParams.get("uploadId") ?? undefined);
      } catch (error) {
        req.resume();
        throw error;
      }
      const name = url.searchParams.get("name");
      if (!name) {
        req.resume();
        return json(res, 400, { error: "name is required" });
      }
      const rawType = Array.isArray(req.headers["content-type"])
        ? req.headers["content-type"][0]
        : req.headers["content-type"];
      const rawLength = Array.isArray(req.headers["content-length"])
        ? req.headers["content-length"][0]
        : req.headers["content-length"];
      const declaredLength = rawLength === undefined ? undefined : Number(rawLength);
      if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        req.resume();
        return json(res, 400, { error: "content-length must be a non-negative integer" });
      }
      if (declaredLength !== undefined && declaredLength > FILE_MAX_BYTES) {
        req.resume();
        return json(res, 413, { error: `file exceeds ${FILE_MAX_BYTES} bytes` });
      }
      try {
        // Returning from this iterator must not destroy the request socket:
        // the caller still needs to receive the useful 4xx response when the
        // streamed byte count crosses the limit.
        const chunks = req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>;
        const saved = await saveFile(chunks, name, rawType ?? "", { uploadId, expectedBytes: declaredLength });
        return json(res, 201, saved);
      } catch (error) {
        req.resume();
        throw error;
      }
    }

    // serving is name-locked to the attachments dir — readAttachment
    // refuses anything that is not a bare generated filename
    m = path.match(/^\/api\/attachments\/([\w.-]+)$/);
    if (m && method === "GET") {
      const attachment = readAttachment(m[1]!);
      if (!attachment) return json(res, 404, { error: "no such attachment" });
      res.writeHead(200, {
        "content-type": attachment.mime,
        "content-length": String(attachment.bytes.byteLength),
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
      return res.end(attachment.bytes);
    }

    // ── search across every transcript ──────────────────────────────────
    // A LIKE scan over the SQLite message store: local transcripts are
    // megabytes at most, so a scan answers in milliseconds and needs no
    // index to maintain. Hits resolve to the bot/room that owns the thread;
    // rows belonging to deleted conversations resolve to nothing and drop.
    if (method === "GET" && path === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit ? Math.min(Math.max(Number(rawLimit) || 0, 1), 100) : 40;
      const threadId = url.searchParams.get("threadId")?.trim() || undefined;
      if (threadId && !store.botByThread(threadId) && !store.groupByThread(threadId)) {
        return json(res, 404, { error: "no such conversation" });
      }
      // whether each hit sits on its thread's visible branch — a click on
      // one that does not has to switch versions first (and only then)
      const activePaths = new Map<string, Set<string>>();
      const onActivePath = (threadId: string, messageId: string) => {
        let ids = activePaths.get(threadId);
        if (!ids) activePaths.set(threadId, (ids = new Set(store.activePath(threadId).map((m) => m.id))));
        return ids.has(messageId);
      };
      const hits = searchMessages(q, limit, threadId)
        .map((hit) => {
          const bot = store.botByThread(hit.threadId);
          const group = bot ? undefined : store.groupByThread(hit.threadId);
          if (!bot && !group) return null;
          const active = onActivePath(hit.threadId, hit.messageId);
          if (bot) {
            const task = store.taskByThread(bot.id, hit.threadId);
            return { ...hit, botId: bot.id, name: bot.name, task: task?.title, onActivePath: active };
          }
          if (group) {
            const task = store.groupTaskByThread(group.id, hit.threadId);
            return { ...hit, groupId: group.id, name: group.name, task: task?.title, onActivePath: active };
          }
          return null;
        })
        .filter((hit): hit is NonNullable<typeof hit> => hit !== null);
      return json(res, 200, { hits });
    }

    // ── transcript export (the visible branch, human-readable) ──────────
    m = path.match(/^\/api\/threads\/([\w-]+)\/export$/);
    if (m && method === "GET") {
      const threadId = m[1];
      const bot = store.botByThread(threadId);
      const group = bot ? undefined : store.groupByThread(threadId);
      if (!bot && !group) return json(res, 404, { error: "no such conversation" });
      const format = url.searchParams.get("format") ?? "markdown";
      if (format !== "markdown" && format !== "json") {
        return json(res, 400, { error: "format must be markdown or json" });
      }
      const title = bot
        ? (store.taskByThread(bot.id, threadId)?.title || bot.name)
        : (store.groupTaskByThread(group!.id, threadId)?.title || group!.name);
      const filename = (title.replace(/[^\w\- ]+/g, "").trim() || "conversation").slice(0, 60);
      const messages = store.activePath(threadId);
      if (format === "json") {
        // pixels stripped — an export is for reading and archiving, and a
        // base64 desktop frame is neither
        const slim = messages.map(({ png: _png, mime: _mime, ...rest }) => rest);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="${filename}.json"`,
        });
        return res.end(JSON.stringify({ name: title, threadId, messages: slim }, null, 2));
      }
      const userName = cfg.profile?.name?.trim() || "User";
      const lines: string[] = [`# ${title}`, ""];
      for (const msg of messages) {
        const who = msg.role === "user"
          ? msg.via === "api" ? `${userName} (via the local API)` : userName
          : (msg.from?.name ?? bot?.name ?? "Bot");
        if (msg.kind === "text" && msg.text) lines.push(`**${who}:**`, "", msg.text, "");
        else if (msg.kind === "activity" && msg.tool) lines.push(`> ${msg.tool.name}`, "");
        else if (msg.kind === "screen") lines.push("> [screen capture]", "");
        else if (msg.kind === "options" && msg.card) {
          lines.push(`> ${msg.card.title}${msg.card.answered ? ` — answered: ${msg.card.answered}` : ""}`, "");
        }
      }
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}.md"`,
      });
      return res.end(lines.join("\n"));
    }

    // ── channels (persisted internally as groups) ───────────────────────
    if (method === "POST" && path === "/api/groups") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "channel must be a JSON object" });
      }
      const roster = checkedMemberIds(body.memberIds);
      if (!roster.ok) return json(res, 400, { error: roster.error });
      const { memberIds } = roster;
      if (body.name !== undefined && typeof body.name !== "string") {
        return json(res, 400, { error: "channel name must be a string" });
      }
      const name = body.name?.trim() || `${store.bot(memberIds[0])!.name} & co.`;
      if (name.length > 100) return json(res, 400, { error: "channel name must be at most 100 characters" });
      let section: string | undefined;
      if (body.section !== undefined && body.section !== null) {
        if (typeof body.section !== "string") return json(res, 400, { error: "context must be a string" });
        section = body.section.trim() || undefined;
        if (section && section.length > 60) {
          return json(res, 400, { error: "context must be at most 60 characters" });
        }
      }
      let setup:
        | { bulletin: string; defaultResponder: GroupDefaultResponder; completed: true }
        | undefined;
      if (body.setup !== undefined) {
        if (!body.setup || typeof body.setup !== "object" || Array.isArray(body.setup)) {
          return json(res, 400, { error: "setup must be an object" });
        }
        const requested = body.setup as { bulletin?: unknown; defaultResponder?: unknown };
        if (typeof requested.bulletin !== "string") {
          return json(res, 400, { error: "setup.bulletin must be a string" });
        }
        if (requested.bulletin.length > 12_000) {
          return json(res, 400, { error: "setup.bulletin must be at most 12000 characters" });
        }
        const responder = checkedGroupResponder(requested.defaultResponder, memberIds);
        if (!responder) return json(res, 400, { error: "invalid setup.defaultResponder" });
        setup = { bulletin: requested.bulletin, defaultResponder: responder, completed: true };
      }
      const group = store.createGroup(name, memberIds, false, section, setup);
      return json(res, 201, { group: { ...publicGroupState(group), messages: [] } });
    }
    if (method === "POST" && path === "/api/teams/export") {
      const body = await readBody(req);
      const profileName = cfg.profile?.name?.trim();
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : profileName
            ? `${profileName}'s Team`
            : "My OpenMaus Team";
      const memberIds = store.bots.filter((bot) => !bot.hidden).map((bot) => bot.id);
      if ((body.format === "backup" ? store.bots.length : memberIds.length) === 0) return json(res, 400, { error: "Create a bot before exporting your team" });
      try {
        if (body.format === "backup") {
          return json(res, 200, createTeamBackup(store, routines!.listRoutines(), name));
        }
        if (body.format === "package") {
          const document = createBotPackageExport({
            name,
            authorName: profileName,
            bots: store.bots,
            groups: store.groups,
            routines: routines!.listRoutines(),
          });
          return json(res, 200, {
            name: document.package.name,
            members: document.package.agents.length,
            markdown: renderBotPackageMarkdown(document),
          });
        }
        return json(
          res,
          200,
          createTeamManifest(
            {
              name,
              memberIds,
            },
            store.bots,
          ),
        );
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Team could not be exported" });
      }
    }
    if (method === "GET" && path === "/api/team-library/catalog") {
      try {
        return json(res, 200, await fetchTeamCatalog());
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : "The team library is unavailable" });
      }
    }
    m = path.match(/^\/api\/team-library\/teams\/([a-z0-9][a-z0-9-]*)$/);
    if (m && method === "GET") {
      try {
        return json(res, 200, await fetchLibraryTeam(m[1]));
      } catch (error) {
        const status = (error as { status?: number }).status === 404 ? 404 : 502;
        return json(res, status, { error: error instanceof Error ? error.message : "The team could not be loaded" });
      }
    }
    if (method === "POST" && path === "/api/team-library/github") {
      const body = await readBody(req);
      if (typeof body.url !== "string" || !body.url.trim()) {
        return json(res, 400, { error: "A GitHub URL is required" });
      }
      try {
        return json(res, 200, await fetchGithubTeam(body.url));
      } catch (error) {
        const status = (error as { status?: number }).status === 404 ? 404 : 400;
        return json(res, status, { error: error instanceof Error ? error.message : "The GitHub team could not be loaded" });
      }
    }
    if (method === "GET" && path === "/api/teams/scout") {
      // The scout reads a folder and answers with a suggestion — it creates
      // nothing. Bots and the room come into being only when the human sends
      // the suggested manifest through /api/teams/import, so "the agent
      // proposes, the person imports" is enforced by the route split itself.
      // The folder is whatever validateBotCwd accepts: the same local-user
      // trust boundary as pointing any bot's working folder at a path.
      // Deliberately offline — the community directory lives on its own
      // route below, so a slow network can never delay the suggestion.
      const validated = validateBotCwd(url.searchParams.get("cwd"));
      if (!validated.ok) return json(res, 400, { error: validated.error });
      if (!validated.cwd) return json(res, 400, { error: "scout needs a folder to read" });
      const profile = scoutProject(validated.cwd);
      return json(res, 200, { profile, suggestion: suggestTeam(profile) });
    }
    if (method === "GET" && path === "/api/teams/scout/directory") {
      // Community bots that fit the scouted folder — a separate, lazy call
      // so an unreachable directory degrades to "no extra candidates", never
      // to a broken scout.
      const validated = validateBotCwd(url.searchParams.get("cwd"));
      if (!validated.ok) return json(res, 400, { error: validated.error });
      if (!validated.cwd) return json(res, 400, { error: "scout needs a folder to read" });
      let directory: MatchedDirectoryBot[] = [];
      try {
        directory = matchDirectoryBots(scoutProject(validated.cwd), await fetchBotDirectory());
      } catch (error) {
        // an unreachable directory is a fact of life, not an error — but an
        // empty section should still be diagnosable from the server log
        console.warn("bot directory lookup failed:", error instanceof Error ? error.message : String(error));
      }
      return json(res, 200, { directory });
    }
    if (method === "POST" && path === "/api/teams/import") {
      // Import is additive-only. A manifest is untrusted input (catalog,
      // GitHub, a shared file), so it must be structurally unable to reach
      // records the user already has: every member becomes a NEW bot with a
      // fresh id — a manifest cannot name, update, or merge into an existing
      // bot or room. Repeated imports create freshly numbered copies.
      const importMode = url.searchParams.get("mode") ?? "add";
      if (importMode === "replace") {
        return json(res, 400, { error: "Replacing your team is no longer supported. Reopen Import in the updated app to add bots alongside your existing conversations." });
      }
      if (importMode !== "add" && importMode !== "project") {
        return json(res, 400, { error: "Team import mode must be add or project" });
      }
      // `project` adds the team AND opens a caller-owned room on a folder.
      // Legacy team manifests remain people-only. Full bot packages may add
      // their own new rooms, but neither format can point at an existing room
      // or choose a local folder; workspace access always comes from this
      // explicit caller parameter.
      let projectCwd: string | null = null;
      if (importMode === "project") {
        const requested = url.searchParams.get("cwd");
        if (requested !== null) {
          const validated = validateBotCwd(requested);
          if (!validated.ok) return json(res, 400, { error: validated.error });
          projectCwd = validated.cwd;
        }
      }
      const body = await readBody(req, MAX_TEAM_BACKUP_BYTES);
      if (body?.format === "openmaus.backup") {
        if (importMode !== "add") return json(res, 400, { error: "Import backups alongside your existing bots; project mode is only for templates" });
        try {
          const imported = importTeamBackup(store, routines!, body, await defaultSelection());
          const bots = imported.bots.map((bot) => publicBot(bot));
          const groups = imported.groups.map((group) => ({ ...publicGroupState(group), ...messagePage(group.threadId, undefined) }));
          for (const bot of bots) broadcast({ kind: "bot", bot });
          for (const group of groups) broadcast({ kind: "group", group });
          return json(res, 201, { ...imported, bots, groups });
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : "Backup could not be imported" });
        }
      }
      let packageDocument: ReturnType<typeof parseBotPackage> | null = null;
      let manifest: ReturnType<typeof parseTeamManifest> | null = null;
      try {
        if (isBotPackage(body)) packageDocument = parseBotPackage(body);
        else manifest = parseTeamManifest(body);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Invalid bot package" });
      }
      const pkg = packageDocument?.package;
      const importName = pkg?.name ?? manifest!.team.name;
      const sourceMembers = pkg
        ? pkg.agents.map((agent) => ({ member: packageAgentAsMember(agent), playbookKeys: agent.playbooks ?? [] }))
        : manifest!.team.members.map((member) => ({ member, playbookKeys: [] as string[] }));

      const importedBots: ReturnType<typeof store.createBot>[] = [];
      const createdGroups: GroupRecord[] = [];
      const createdRoutineIds: string[] = [];
      // Names already in use, hidden bots included: an archived bot can be
      // un-archived later, and a revived duplicate would be just as
      // ambiguous then.
      const takenNames = new Set(store.bots.map((bot) => bot.name.trim().toLowerCase()));
      const memberIds = new Map<string, string>();
      let group: GroupRecord | undefined;
      try {
        const selection = await defaultSelection();
        const existingSections = new Set(
          [...store.bots.map((bot) => bot.section), ...store.groups.map((candidate) => candidate.section)]
            .filter((section): section is string => Boolean(section?.trim()))
            .map((section) => section.toLowerCase()),
        );
        let packageSection = pkg?.name;
        if (packageSection) {
          const stem = packageSection;
          for (let suffix = 2; existingSections.has(packageSection.toLowerCase()); suffix++) {
            packageSection = `${stem} ${suffix}`;
          }
        }
        const playbookByKey = new Map((pkg?.playbooks ?? []).map((playbook) => [playbook.key, playbook]));
        for (const source of sourceMembers) {
          const member = source.member;
          // importedMemberProfile is the authority boundary: persona fields
          // only, colliding names numbered. seedMessages: false — an
          // imported bot must not open by greeting the user as though it
          // were new. composio: false — a shared persona never starts with
          // reach into the user's connected apps (absence would mean
          // allowed); the user can switch it on per bot after reading who
          // they got.
          const created = store.createBot(
            {
              ...importedMemberProfile(member, takenNames),
              modelSelection: selection,
              ...(packageSection ? { section: packageSection } : {}),
            },
            { seedMessages: false },
          );
          importedBots.push(created);
          const installedPlaybooks = source.playbookKeys.flatMap((key) => {
            const playbook = playbookByKey.get(key);
            return playbook ? [{ ...playbook }] : [];
          });
          store.patchBot(created.id, {
            composio: false,
            ...(installedPlaybooks.length ? { playbooks: installedPlaybooks } : {}),
            ...(pkg
              ? {
                  installedPackage: {
                    id: pkg.id,
                    name: pkg.name,
                    release: pkg.release,
                    requiredApps: pkg.requirements.apps.map((app) => ({ ...app })),
                  },
                }
              : {}),
          });
          memberIds.set(member.key, created.id);
        }

        // A package is an explicit structure import: its rooms are created
        // from package-local keys only, then normalized to fresh bot ids.
        for (const room of pkg?.rooms ?? []) {
          const ids = room.members.map((key) => memberIds.get(key)!);
          let created = store.createGroup(room.name, ids, false, packageSection);
          createdGroups.push(created);
          const defaultResponder = room.defaultResponder.kind === "agent"
            ? { kind: "member" as const, botId: memberIds.get(room.defaultResponder.agent)! }
            : { kind: room.defaultResponder.kind } as const;
          created = store.patchGroup(created.id, {
            bulletin: room.bulletin ?? "",
            defaultResponder,
            setupCompletedAt: Date.now(),
          }) ?? created;
        }

        for (const routine of pkg?.routines ?? []) {
          const created = routines!.create({
            name: routine.name,
            prompt: routine.prompt,
            botId: memberIds.get(routine.agent)!,
            runOn: routine.runOn,
            enabled: false,
            schedule: routine.schedule,
            durationMinutes: routine.durationMinutes,
            ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
          });
          createdRoutineIds.push(created.id);
        }

        if (pkg?.chiefOfStaff) {
          store.setChiefOfStaff(memberIds.get(pkg.chiefOfStaff)!);
        }

        // The room is created last, so a failure anywhere above leaves no
        // half-built project behind — the catch below deletes the bots and
        // there is no room pointing at them.
        if (!pkg && importMode === "project" && importedBots.length > 0) {
          const roomName = url.searchParams.get("room")?.trim() || manifest!.team.name;
          group = store.createGroup(roomName, importedBots.map((bot) => bot.id));
          createdGroups.push(group);
          if (projectCwd) {
            // `cwd` is the folder the room WANTS; the store pins it on the
            // first turn (pinGroupCwd). Setting the pin here would decide it
            // before anyone has worked, which is the store's call, not ours.
            group = store.patchGroup(group.id, { cwd: projectCwd }) ?? group;
          }
          broadcast({ kind: "group", group: publicGroupState(group) });
        }

        const publicBots = importedBots.map((bot) => publicBot(store.bot(bot.id)!));
        for (const bot of publicBots) broadcast({ kind: "bot", bot });

        return json(res, 201, {
          name: importName,
          bots: publicBots,
          group,
          groups: createdGroups.map((created) => ({ ...created, messages: [] })),
          routines: createdRoutineIds.flatMap((id) => routines!.listRoutines().filter((routine) => routine.id === id)),
        });
      } catch (error) {
        // A room of deleted members must not survive either — patchGroup can
        // throw (disk) after createGroup already saved.
        for (const routineId of createdRoutineIds) routines!.remove(routineId);
        for (const created of createdGroups) store.deleteGroup(created.id);
        for (const bot of importedBots) store.deleteBot(bot.id);
        throw error;
      }
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/setup$/);
    if (m && method === "PATCH") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      if (group.dm) return json(res, 400, { error: "direct-message channels do not have room setup" });
      const body = await readBody(req);
      if (body.action !== "complete" && body.action !== "skip") {
        return json(res, 400, { error: "action must be complete or skip" });
      }
      if (group.setupCompletedAt != null || group.setupSkippedAt != null) {
        return json(res, 200, { group: publicGroupState(group) });
      }
      if (store.messagesFor(group.threadId).length > 0) {
        return json(res, 409, { error: "room setup must be finished before the first message" });
      }

      const patch: Partial<Pick<GroupRecord, "cwd" | "defaultResponder" | "bulletin" | "setupCompletedAt" | "setupSkippedAt">> = {};
      if (body.action === "complete") {
        const checked = validateBotCwd(body.cwd ?? null);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        if (typeof body.bulletin !== "string") return json(res, 400, { error: "bulletin must be a string" });
        if (body.bulletin.length > 12_000) return json(res, 400, { error: "bulletin must be at most 12000 characters" });
        const value = body.defaultResponder as { kind?: unknown; botId?: unknown } | null;
        let responder: GroupDefaultResponder | null = null;
        if (value?.kind === "everyone") responder = { kind: "everyone" };
        else if (value?.kind === "mentions") responder = { kind: "mentions" };
        else if (value?.kind === "member" && typeof value.botId === "string" && group.memberIds.includes(value.botId)) {
          responder = { kind: "member", botId: value.botId };
        }
        if (!responder) return json(res, 400, { error: "invalid default responder" });
        patch.cwd = checked.cwd ?? undefined;
        patch.defaultResponder = responder;
        patch.bulletin = body.bulletin;
        patch.setupCompletedAt = Date.now();
      } else {
        patch.setupSkippedAt = Date.now();
      }
      const updated = store.patchGroup(m[1], patch);
      if (!updated) return json(res, 404, { error: "no such room" });
      return json(res, 200, { group: publicGroupState(updated) });
    }

    // ── channel tasks: separate conversations for the same team ────────
    const channelTaskBlocked = (group: GroupRecord) =>
      groupIsWorking(group) ||
      store.groupTasks(group.id).some((task) =>
        store.messagesFor(task.threadId).some(
          (message) =>
            message.kind === "options" &&
            message.card?.requestId &&
            !message.card.answered &&
            !message.card.dismissed,
        ),
      );

    // A scheduled goal starts in a detached task. Let the user open the
    // exact task that owns the live operation (or a durable approval card)
    // so they can observe or unblock it; switching to an unrelated task is
    // still forbidden until the room settles.
    const channelTaskSwitchBlocked = (group: GroupRecord, targetThreadId: string) => {
      const operationOwnsTarget = [...(groupTurnOperations.get(group.id) ?? [])]
        .some((operation) => !operation.cancelled && operation.threadId === targetThreadId);
      if (groupIsWorking(group) && !operationOwnsTarget) return true;
      const openApprovalThreads = store.groupTasks(group.id).flatMap((task) =>
        store.messagesFor(task.threadId).some(
          (message) =>
            message.kind === "options" &&
            message.card?.requestId &&
            !message.card.answered &&
            !message.card.dismissed,
        ) ? [task.threadId] : [],
      );
      return openApprovalThreads.length > 0 && !openApprovalThreads.includes(targetThreadId);
    };

    m = path.match(/^\/api\/groups\/([\w-]+)\/tasks$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such channel" });
      if (group.dm) return json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
      if (channelTaskBlocked(group)) {
        return json(res, 409, { error: "this channel is working or waiting on you — finish that turn first" });
      }
      if (phoneSecretSubmissions.hasGroup(group.id)) {
        return json(res, 409, { error: "this channel is securely saving a credential — try again when it finishes" });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const request = createGroupTaskRequestSchema.safeParse(body);
      if (!request.success) return json(res, 400, { error: "title must be text" });
      const task = store.createGroupTask(group.id, request.data.title);
      if (!task) return json(res, 500, { error: "couldn't create that task" });
      const fresh = groupWithThread(store.group(group.id)!);
      broadcast({ kind: "group", group: fresh });
      return json(res, 201, { group: fresh, task });
    }

    m = path.match(/^\/api\/groups\/([\w-]+)\/tasks\/([\w-]+)$/);
    if (m && method === "POST") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such channel" });
      if (group.dm) return json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
      if (phoneSecretSubmissions.hasGroup(group.id)) {
        return json(res, 409, { error: "this channel is securely saving a credential — try again when it finishes" });
      }
      if (channelTaskSwitchBlocked(group, m[2])) {
        return json(res, 409, { error: "this channel is working or waiting on you in another task" });
      }
      const switched = store.switchGroupTask(group.id, m[2]);
      if (!switched) return json(res, 404, { error: "no such channel task" });
      const fresh = groupWithThread(switched);
      broadcast({ kind: "group", group: fresh });
      const responseGroup = url.searchParams.get("messages") === "0"
        ? { ...publicGroupState(switched), tasks: store.groupTasks(switched.id) }
        : fresh;
      return json(res, 200, { group: responseGroup });
    }
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such channel" });
      if (group.dm) return json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
      if (channelTaskBlocked(group)) {
        return json(res, 409, { error: "this channel is working or waiting on you — finish that turn first" });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const task = store.renameGroupTask(m[1], m[2], String(body.title ?? ""));
      if (!task) return json(res, 404, { error: "no such channel task" });
      return json(res, 200, { task });
    }
    if (m && method === "DELETE") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such channel" });
      if (group.dm) return json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
      if (phoneSecretSubmissions.hasThread(m[2])) {
        return json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
      }
      if (channelTaskBlocked(group)) {
        return json(res, 409, { error: "this channel is working or waiting on you — finish that turn first" });
      }
      if (!store.groupTaskByThread(group.id, m[2])) return json(res, 404, { error: "no such channel task" });
      const stagedSkillCleanups = stagedSkillCleanupsForThread(m[2]);
      lastReply.delete(m[2]);
      const updated = store.deleteGroupTask(group.id, m[2]);
      if (!updated) return json(res, 400, { error: "a channel keeps at least one task" });
      rejectDeletedThreadSkillStages(stagedSkillCleanups);
      const fresh = groupWithThread(updated);
      broadcast({ kind: "group", group: fresh });
      return json(res, 200, { group: fresh });
    }

    m = path.match(/^\/api\/groups\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (auth.kind === "session" && !auth.scopes.includes("admin")) {
        const field = clientGroupPatchViolation(body);
        if (field) return json(res, 403, { error: `forbidden: this session may rename or mark a room, not change "${field}" (needs the admin scope)` });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const existing = store.group(m[1]);
      if (!existing) return json(res, 404, { error: "no such room" });
      if (body.memberIds !== undefined && phoneSecretSubmissions.hasGroup(existing.id)) {
        return json(res, 409, { error: "this channel is securely saving a credential — try again when it finishes" });
      }
      if (
        channelTaskBlocked(existing) &&
        (body.memberIds !== undefined || body.defaultResponder !== undefined || body.bulletin !== undefined)
      ) {
        return json(res, 409, { error: "this channel is working or waiting on you — finish that turn first" });
      }
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) {
        if (typeof body.name !== "string") return json(res, 400, { error: "room name must be a string" });
        const name = body.name.trim();
        if (!name) return json(res, 400, { error: "room name must not be empty" });
        if (name.length > 100) return json(res, 400, { error: "room name must be at most 100 characters" });
        patch.name = name;
      }
      if (body.bulletin !== undefined) {
        if (typeof body.bulletin !== "string") return json(res, 400, { error: "bulletin must be a string" });
        if (body.bulletin.length > 12_000) {
          return json(res, 400, { error: "bulletin must be at most 12000 characters" });
        }
        patch.bulletin = body.bulletin;
      }
      if (body.unread !== undefined) {
        if (typeof body.unread !== "boolean") return json(res, 400, { error: "unread must be true or false" });
        patch.unread = body.unread;
      }
      if (body.memberIds !== undefined) {
        // A DM is the pair it was opened for; only real rooms have a roster.
        if (existing.dm) return json(res, 400, { error: "direct-message channels cannot change members" });
        const roster = checkedMemberIds(body.memberIds);
        if (!roster.ok) return json(res, 400, { error: roster.error.replace("channel", "room") });
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
          return json(res, 409, {
            error: "pause or reassign this room's team-goal routine before removing its lead",
          });
        }
        patch.memberIds = roster.memberIds;
      }
      if (body.defaultResponder !== undefined) {
        const memberIds = (patch.memberIds as string[] | undefined) ?? existing.memberIds;
        const responder = checkedGroupResponder(body.defaultResponder, memberIds);
        if (!responder) return json(res, 400, { error: "invalid default responder" });
        patch.defaultResponder = responder;
      }
      if (body.cwd !== undefined) {
        if (existing.dm) return json(res, 400, { error: "direct-message channels cannot have a working folder" });
        if (existing.pinnedCwd !== undefined) {
          return json(res, 409, { error: "the room's working folder is fixed after its first turn" });
        }
        const checked = validateBotCwd(body.cwd);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        patch.cwd = checked.cwd ?? undefined;
      }
      // one pinned message per room; null/"" clears. The id is not
      // validated against the transcript here — a pin whose message was
      // edited away or deleted simply resolves to nothing in the UI.
      if (body.pinnedMessageId !== undefined) {
        if (body.pinnedMessageId === null || body.pinnedMessageId === "") patch.pinnedMessageId = undefined;
        else if (typeof body.pinnedMessageId === "string" && /^[\w-]+$/.test(body.pinnedMessageId)) {
          patch.pinnedMessageId = body.pinnedMessageId;
        } else return json(res, 400, { error: "pinnedMessageId must be a message id" });
      }
      // same contract as a bot's sidebar section: null/"" clears, 60 chars max
      if (body.section !== undefined) {
        if (body.section === null) patch.section = undefined;
        else if (typeof body.section !== "string") return json(res, 400, { error: "section must be a string" });
        else {
          const trimmed = body.section.trim();
          if (!trimmed) patch.section = undefined;
          else if (trimmed.length > 60) return json(res, 400, { error: "section must be at most 60 characters" });
          else patch.section = trimmed;
        }
      }
      const group = store.patchGroup(m[1], patch);
      if (!group) return json(res, 404, { error: "no such room" });
      return json(res, 200, { group: publicGroupState(group) });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/read$/);
    if (m && method === "POST") {
      const group = store.patchGroup(m[1], { unread: false });
      if (!group) return json(res, 404, { error: "no such room" });
      broadcast({ kind: "group", group: publicGroupState(group) });
      return json(res, 200, { group: publicGroupState(group) });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      if (phoneSecretSubmissions.hasGroup(group.id)) {
        return json(res, 409, { error: "this channel is securely saving a credential — try again when it finishes" });
      }
      if (groupIsWorking(group)) {
        return json(res, 409, { error: "this channel is working — stop that turn first" });
      }
      const threadIds = new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]);
      const stagedSkillCleanups = [...threadIds].flatMap(stagedSkillCleanupsForThread);
      for (const threadId of threadIds) lastReply.delete(threadId);
      routines!.disableForGroup(group.id);
      store.deleteGroup(group.id);
      rejectDeletedThreadSkillStages(stagedSkillCleanups);
      for (const threadId of threadIds) {
        for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
          try {
            unlinkSync(join(dir, `${threadId}.ndjson`));
          } catch {}
        }
      }
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such group" });
      if (body.mode !== undefined && body.mode !== "chat" && body.mode !== "goal") {
        return json(res, 400, { error: "mode must be chat or goal" });
      }
      const channelMode: "chat" | "goal" = body.mode === "goal" ? "goal" : "chat";
      if (group.dm && channelMode === "goal") {
        return json(res, 400, { error: "goal mode is available in team channels, not bot-to-bot channels" });
      }
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      const threadId = body.threadId ?? group.threadId;
      const ownsThread = group.dm
        ? group.threadId === threadId
        : Boolean(store.groupTaskByThread(group.id, threadId));
      if (!ownsThread) {
        return json(res, 409, { error: "the channel switched tasks before it could receive the message" });
      }
      const sendId = parseSendId(body.sendId);
      const replyTo = resolveReplyTarget(threadId, body.replyToId);
      // Who is this "user"? On a headless server loopback is the owner by
      // design, and a bot's shell is a loopback caller too. A request with
      // no paired session and no browser origin cannot be told from a
      // script, so its message is stamped rather than trusted as typed —
      // the room's readers, its posting budget and its transcript all look
      // at that stamp — and the send is logged where the operator can see
      // it. The desktop app never gets here: its owner capability is
      // checked before this handler runs.
      const browserOrigin = typeof req.headers.origin === "string" && req.headers.origin.trim() !== "";
      const via: "api" | undefined =
        auth.kind === "loopback" && !DESKTOP_MANAGED && !browserOrigin ? "api" : undefined;
      if (via) {
        console.warn(`room message from ${requestSource(req)} through the local API (no session, no browser origin) into "${group.name}"`);
      }
      const receipt = await sendSequencer.run(
        sendId ? `group:${group.id}:${threadId}:${sendId}` : undefined,
        sendFingerprint(text, replyTo?.id, channelMode),
        async () => {
          if (sendId) {
            const accepted = acceptedSendMatch(store.messagesFor(threadId), sendId, text, replyTo?.id, channelMode);
            if (accepted.kind === "conflict") {
              throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
            }
            if (accepted.kind === "match") {
              return { ok: true as const, threadId, message: accepted.message };
            }
            const queued = queuedChannelMessage(group.id, threadId, sendId);
            if (queued) {
              if (
                queued.text !== text ||
                queued.replyToId !== replyTo?.id ||
                queued.mode !== channelMode
              ) {
                throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
              }
              return { ok: true as const, queued: true as const, queueId: queued.id, threadId };
            }
          }
          const current = store.group(group.id);
          if (!current) throw Object.assign(new Error("no such group"), { status: 404 });
          if (current.threadId !== threadId) {
            throw Object.assign(new Error("the channel switched tasks before it could receive the message"), {
              status: 409,
            });
          }
          if (groupIsWorking(current)) {
            const queued = queueChannelMessage(current.id, threadId, text, {
              replyToId: replyTo?.id,
              sendId,
              mode: channelMode,
              via,
            });
            return { ok: true as const, queued: true as const, queueId: queued.id, threadId };
          }
          const message = startGroupTurn(current.id, text, replyTo, sendId, channelMode, undefined, { via });
          return { ok: true as const, threadId, message };
        },
      );
      return json(res, 202, receipt);
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/queue\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such group" });
      if (!cancelChannelMessage(group.id, m[2])) {
        return json(res, 404, { error: "no such queued message" });
      }
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      const rawBody = await readBody(req);
      if (rawBody !== null && (typeof rawBody !== "object" || Array.isArray(rawBody))) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const body = rawBody ?? {};
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      if (body.threadId !== undefined) {
        const ownsThread = group.dm
          ? body.threadId === group.threadId
          : Boolean(store.groupTaskByThread(group.id, body.threadId));
        if (!ownsThread) {
          return json(res, 409, { error: "the channel switched tasks before it could be interrupted" });
        }
      }
      const activeOperations = [...(groupTurnOperations.get(group.id) ?? [])]
        .filter((operation) => !operation.cancelled);
      if (
        body.threadId !== undefined &&
        activeOperations.length > 0 &&
        !activeOperations.some((operation) => operation.threadId === body.threadId)
      ) {
        return json(res, 409, { error: "this channel is working in another task" });
      }
      // Without an explicit task, Stop means the room's live operation—not
      // merely whichever task the UI was showing when a detached routine
      // began. There is normally one operation; cancel every active thread
      // defensively so no queued handoff survives a room-level stop.
      const targetThreadIds = body.threadId !== undefined
        ? [body.threadId]
        : activeOperations.length > 0
          ? [...new Set(activeOperations.map((operation) => operation.threadId))]
          : [group.threadId];
      const interruptTargets = targetThreadIds.map((threadId) => {
        const speaker = groupSpeakers.get(threadId);
        const busy = speaker
          ? store.bot(speaker.botId)
          : threadId === group.threadId && group.busyBotId
            ? store.bot(group.busyBotId)
            : undefined;
        return {
          threadId,
          instance: busy ? registry.get(busy.modelSelection.instanceId) : undefined,
        };
      });
      // Abort every queued operation before the first provider round trip;
      // otherwise one queued task could begin while Stop awaits interruption
      // of the task ahead of it.
      for (const { threadId } of interruptTargets) cancelGroupTurnOperations(group.id, threadId);
      for (const { threadId, instance } of interruptTargets) {
        revokeInternalCapabilitiesForThread(threadId);
        await instance?.adapter.interruptTurn(threadId).catch(() => {});
        closeOpenApprovals(threadId);
      }
      return json(res, 200, { ok: true });
    }

    // emoji reactions — works on any thread (1:1 or room)
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/reactions$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const emoji = String(body.emoji ?? "").slice(0, 8);
      if (!emoji) return json(res, 400, { error: "emoji required" });
      const patched = store.toggleReaction(m[1], m[2], emoji, typeof body.by === "string" ? body.by : "user");
      if (!patched) return json(res, 404, { error: "no such message" });
      return json(res, 200, { message: patched });
    }
    if (method === "POST" && path === "/api/sidebar-sections") {
      const parsed = createSidebarSectionSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "name and one to 100 valid botIds are required" });
      }
      const name = parsed.data.name.trim();
      if (name.length > 60) {
        return json(res, 400, { error: "name must be at most 60 characters" });
      }
      const botIds = [...new Set(parsed.data.botIds)];
      const result = store.setBotsSection(botIds, name);
      if (!result.ok) {
        if (result.reason === "chief-conflict") {
          return json(res, 409, {
            error: "A section can have only one Chief of Staff. Choose one Chief or use a section without one.",
          });
        }
        return json(res, 404, { error: "one or more bots are unavailable" });
      }
      // This files bots under a derived label; it does not create a durable
      // section resource, and an identical retry is an ordinary no-op.
      return json(res, 200, { section: name, bots: result.bots.map(wireBot) });
    }
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
      const generated = await generateAvatarImage(cfg.imageGen?.key ?? "", existing, parsed.data.prompt);
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
        try { unlinkSync(saved.path); } catch {}
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
          (key) => key !== "instanceId" && key !== "model" && key !== "effort",
        );
        if (unsupported) return json(res, 400, { error: `unsupported model field: ${unsupported}` });
      }
      const existing = store.bot(m[1]);
      if (!existing) return json(res, 404, { error: "no such bot" });
      if (existing.approvalGrant) {
        return json(res, 409, { error: "wait for the approval-level change to finish before changing models" });
      }
      const checked = checkedModelSelection(
        body,
        { selection: existing.modelSelection, busy: Boolean(existing.busy) },
        true,
      );
      if (!checked.ok) return json(res, checked.status, { error: checked.error });
      const existingApprovalMode = approvalModeFor(existing);
      if (
        (existingApprovalMode === "full" || existingApprovalMode === "custom") &&
        (!supportsApprovalMode(registry.cliTarget(checked.selection.instanceId)?.driverKind, existingApprovalMode) ||
          registry.cliTarget(checked.selection.instanceId)?.driverKind !== registry.cliTarget(existing.modelSelection.instanceId)?.driverKind)
      ) {
        return json(res, 400, {
          error: "Changing providers with elevated permissions requires choosing Ask or Auto first",
        });
      }
      // patchBot persists first and emits the canonical bot change, which the
      // store listener above turns into the slim wire-format SSE broadcast.
      const bot = store.patchBot(existing.id, { modelSelection: checked.selection });
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { bot: wireBot(bot) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/read$/);
    if (m && method === "POST") {
      const bot = store.patchBot(m[1], { unread: false });
      if (!bot) return json(res, 404, { error: "no such bot" });
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/always-allow$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const allowKey = typeof body.allowKey === "string" ? body.allowKey : "";
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
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
      const updated = store.patchBot(bot.id, {
        alwaysAllow: [...new Set([...(bot.alwaysAllow ?? []), allowKey])].slice(0, 200),
      })!;
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
      const beforeProfile = existingBot ? profileSnapshot(existingBot) : undefined;
      if (body.requireAvailableModel !== undefined && typeof body.requireAvailableModel !== "boolean") {
        return json(res, 400, { error: "requireAvailableModel must be true or false" });
      }
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
          existingBot ? { selection: existingBot.modelSelection, busy: Boolean(existingBot.busy) } : undefined,
          body.requireAvailableModel === true,
        );
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        normalizedSelection = checked.selection;
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
      if (
        (requestedApprovalMode === "full" || requestedApprovalMode === "custom") &&
        (body.approvalMode !== undefined || normalizedSelection !== undefined) &&
        (!targetSelection || !supportsApprovalMode(registry.cliTarget(targetSelection.instanceId)?.driverKind, requestedApprovalMode) ||
          (existingBot && normalizedSelection && registry.cliTarget(normalizedSelection.instanceId)?.driverKind !== registry.cliTarget(existingBot.modelSelection.instanceId)?.driverKind))
      ) {
        return json(res, 400, {
          error: "This provider does not support the selected approval level, or changing providers requires choosing Ask or Auto first",
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
      if (body.autoReview !== undefined) {
        if (body.autoReview !== "off" && body.autoReview !== "shadow" && body.autoReview !== "enforce") {
          return json(res, 400, { error: "autoReview must be off, shadow, or enforce" });
        }
        patch.autoReview = body.autoReview;
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
        const routineThread = routines!.activeBotRunForBot(existingBot.id)?.threadId;
        const groupThread = activeGroupTurnForBot(existingBot.id)?.threadId;
        const activeThread = routineThread || groupThread || existingBot.threadId;
        cancelDirectTurnDispatch(existingBot.id, activeThread);
        revokeInternalCapabilitiesForThread(activeThread);
        await registry
          .get(existingBot.modelSelection.instanceId)
          ?.adapter.interruptTurn(activeThread)
          .catch(() => {});
      }
      const chiefMovedSections =
        Boolean(existingBot?.chiefOfStaff) &&
        body.chiefOfStaff !== false &&
        section !== undefined &&
        sectionKey(existingBot?.section) !== sectionKey(section);
      let bot: BotRecord | null;
      if (profile.patch.soul !== undefined) {
        // A mixed settings request must not turn a runtime revocation into
        // a persist-first edit. Apply runtime fields with their existing
        // fail-closed semantics; atomically commit only the profile fields.
        const runtimePatch = { ...patch };
        for (const field of Object.keys(profile.patch)) delete runtimePatch[field];
        if (Object.keys(runtimePatch).length) store.patchBot(m[1], runtimePatch);
        bot = store.patchBotProfile(m[1], profile.patch);
      } else {
        bot = store.patchBot(m[1], patch);
      }
      if (!bot) return json(res, 404, { error: "no such bot" });
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
            const routineRun = routines!.activeBotRunForBot(bot.id);
            if (routineRun) {
              cancelDirectTurnDispatch(bot.id, routineRun.threadId);
              if (routineRun.threadId) {
                revokeInternalCapabilitiesForThread(routineRun.threadId);
              }
              await routines!.cancelRun(routineRun.id);
              return;
            }
            const instance = registry.get(bot.modelSelection.instanceId);
            const groupTurn = activeGroupTurnForBot(bot.id);
            if (groupTurn) {
              cancelGroupTurnOperations(groupTurn.group.id, groupTurn.threadId);
              revokeInternalCapabilitiesForThread(groupTurn.threadId);
              await instance?.adapter.interruptTurn(groupTurn.threadId).catch(() => {});
              closeOpenApprovals(groupTurn.threadId);
              return;
            }
            const directClaim = cancelDirectTurnDispatch(bot.id);
            const threadId = directClaim?.threadId ?? bot.threadId;
            revokeInternalCapabilitiesForThread(threadId);
            await instance?.adapter.interruptTurn(threadId).catch(() => {});
            closeOpenApprovals(threadId);
          }),
      );
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (computerProviderConfigTransitions.size > 0) {
        return json(res, 409, { error: "computer provider settings are being updated — wait before deleting this bot" });
      }
      if (boxLifecycleBusyBots.has(bot.id)) {
        return json(res, 409, { error: "wait for this bot's cloud computer action to finish before deleting the bot" });
      }
      const activeRoutine = routines!.activeRunForBot(bot.id);
      if (activeRoutine) {
        return json(res, 409, {
          error: "stop this bot's active routine before deleting the bot",
        });
      }
      const activeGroup = activeGroupTurnForBot(bot.id);
      if (activeGroup) {
        return json(res, 409, {
          error: `stop this bot's work in channel ${activeGroup.group.name} before deleting the bot`,
        });
      }
      // A direct turn that has already claimed the bot can provision a Box in
      // its background setup. Do not let deletion race that work while a Box
      // account is configured; the person can stop the turn and retry.
      if ((box.boxConfigured(cfg) || vpsSshAlias(cfg)) && (bot.busy || directTurnDispatchClaims.has(bot.id))) {
        return json(res, 409, { error: "stop this bot's work before checking and deleting its cloud computer" });
      }
      const botBoxRecovery = boxCreateRecoverySnapshot().filter((entry) => entry.botId === bot.id);
      if (botBoxRecovery.some((entry) => !entry.resolved)) {
        return json(res, 409, {
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
        return json(res, 409, { error: "this bot or one of its channels is securely saving a credential" });
      }
      try {
        if (localVmMode(cfg) === "per-bot") {
          const target = perBotLocalVmTarget(bot.id);
          if (localVmActiveThreads.has(target.key) || localVmLifecycleBusy.has(target.key)) {
            return json(res, 409, { error: "stop this bot's Local VM turn or setup action before deleting the bot" });
          }
          const vm = await containerComputerStatus(undefined, undefined, target);
          if (!vm.daemonUp && existsSync(target.workspaceDir)) {
            return json(res, 409, {
              error: "start the container runtime and delete this bot's Local VM before deleting the bot",
            });
          }
          if (vm.container !== "missing") {
            return json(res, 409, { error: "delete this bot's Local VM from its Computer panel before deleting the bot" });
          }
        }
        // VPS containers are also durable and may outlive a destination or
        // backend switch. Keep the bot as the discoverable owner until the
        // person explicitly removes that container from Settings.
        const vpsInventory = await vps.listManagedVpsComputers(cfg, managedBoxOwners());
        if (vpsInventory.configured && !vpsInventory.available) {
          return json(res, 503, {
            error: `${vpsInventory.problem ?? "VPS computer inventory is unavailable"}. Refresh Settings → Computers before deleting this bot`,
          });
        }
        if (vpsInventory.instances.some((instance) => instance.ownerBotId === bot.id)) {
          return json(res, 409, {
            error: "remove this bot's VPS computer from Settings → Computers before deleting the bot",
          });
        }
        // LIST is eventually consistent, and a remembered Box may also have
        // been renamed outside OpenMausBot. The create journal is stronger
        // ownership evidence: inspect every durable id directly before the bot
        // record that makes it discoverable can be removed. Missing credentials
        // or an unavailable provider must fail closed.
        for (const recovery of botBoxRecovery) {
          if (!recovery.boxId) {
            return json(res, 409, {
              error: "finish reconciling this bot's pending cloud computer creation before deleting it",
            });
          }
          const inspected = await box.inspectBoxIdentity(cfg, recovery.boxId);
          if (!inspected.available) {
            return json(res, 503, {
              error: `${inspected.problem ?? "a remembered cloud computer could not be verified"}. Restore its Box account before deleting this bot`,
            });
          }
          if (inspected.identity) {
            return json(res, 409, {
              error: "delete this bot's remembered cloud computer from Settings → Computers before deleting the bot",
            });
          }
          // A direct 404/410 is authoritative even while account LIST catches
          // up. Retire only this exact provider identity, then continue looking
          // for any older name-based resource the journal never recorded.
          retireDeletedBoxCreate(recovery.boxId);
        }
        // A Box survives destination/backend changes and contains browser
        // sessions and files. Resolve ownership from a fresh provider listing;
        // deleting the bot first would make that durable machine look orphaned.
        const cloudInventory = await box.listManagedBoxes(cfg, managedBoxOwners());
        if (cloudInventory.configured && !cloudInventory.available) {
          return json(res, 503, {
            error: `${cloudInventory.problem ?? "cloud computer inventory is unavailable"}. Refresh Settings → Computers before deleting this bot`,
          });
        }
        if (cloudInventory.instances.some((instance) => instance.ownerBotId === bot.id)) {
          return json(res, 409, {
            error: "delete this bot's cloud computer from Settings → Computers before deleting the bot",
          });
        }
        // Establish a durable cleanup intent before any teardown. A malformed
        // or unreadable journal therefore rejects the delete with the bot and
        // all of its live work untouched. The intent is aborted if a later
        // pre-delete side effect fails, and committed only after Store deletion.
        const browserCleanupRequest = browserCleanup.prepare("bot", bot.id);
        try {
          // a running turn dies with its bot
          const directClaim = cancelDirectTurnDispatch(bot.id);
          const directThreadId = directClaim?.threadId ?? bot.threadId;
          // Invalidate every bot-callable bearer before the first asynchronous
          // teardown step. A request that already passed its initial header
          // check is revalidated after its body arrives and must fail closed.
          revokeInternalCapabilitiesForThread(directThreadId);
          directTurnGenerationByBot.delete(bot.id);
          await registry.get(bot.modelSelection.instanceId)?.adapter.interruptTurn(directThreadId).catch(() => {});
          closeOpenApprovals(directThreadId);
          // Deletion removes the thread before a late turn.completed can fold
          // staged provider images into a message, so dispose them here.
          purgeGeneratedImagesForThread(directThreadId);
          stopScreenPoller(bot.id);
          activeVpsThreads.delete(bot.id);
          routines!.disableForBot(bot.id);
          webhooks.disableForBot(bot.id);
          calendarCalls!.removeBot(bot.id);
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
          store.deleteBot(bot.id);
        } catch (error) {
          if (browserCleanupRequest) browserCleanup.abort(browserCleanupRequest);
          throw error;
        }
        if (browserCleanupRequest) {
          const committedCleanup = browserCleanup.commit(browserCleanupRequest);
          const acknowledged = await browserCleanup.ensure(committedCleanup);
          requireBrowserCleanupAcknowledged(acknowledged, `Browser data for ${bot.name}`);
        }
        for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
          try {
            unlinkSync(join(dir, `${bot.threadId}.ndjson`));
          } catch {}
        }
        return json(res, 200, { ok: true });
      } finally {
        releaseComputerLifecycle();
        releasePhoneSecretMutation();
      }
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
        store.bots.some((bot) => !bot.hidden && sectionKey(bot.section) === section) ||
        store.groups.some((group) => sectionKey(group.section) === section);
      if (!exists) return json(res, 404, { error: "no such section" });

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

    // ── bot memory: MEMORY.md + memory/ topic files ─────────────────────
    // The files already belong to the user (plain markdown in the bot's
    // workspace); these routes only make them visible without a trip to
    // the filesystem. Reads never create the workspace — a bot that has
    // not run yet simply has nothing to show.
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { ...readMemoryFile(m[1]), topics: listMemoryTopics(m[1]) });
    }
    if (m && method === "PUT") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ text: z.string() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be a string" });
      if (Buffer.byteLength(parsed.data.text, "utf8") > MEMORY_FILE_MAX_BYTES) {
        return json(res, 400, {
          error: `memory is capped at ${MEMORY_FILE_MAX_BYTES / 1024}KB — move longer notes into memory/<topic>.md files`,
        });
      }
      writeMemoryFile(m[1], parsed.data.text);
      // truncated echoes back so the editor can warn about the load budget
      return json(res, 200, { ok: true, truncated: readMemoryFile(m[1]).truncated });
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
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card) return json(res, 404, { error: "no such card" });
      if (existing.card.requestId) {
        return json(res, 409, { error: "request cards must be answered through the approval endpoint" });
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      if (Object.keys(body).some((key) => key !== "answered" && key !== "dismissed")) {
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
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      // A retry carries its original task. That lets us return the canonical
      // receipt after a task switch, while a genuinely new send still has to
      // target the task that is active now.
      const threadId = body.threadId ?? bot.threadId;
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
              return { ok: true as const, queued: true as const, queueId: queued.id, threadId };
            }
          }

          const currentAtStart = store.bot(bot.id);
          if (!currentAtStart) throw Object.assign(new Error("no such bot"), { status: 404 });
          if (!store.taskByThread(currentAtStart.id, threadId)) {
            throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
          }
          if (currentAtStart.threadId !== threadId) {
            throw Object.assign(new Error("the bot switched tasks before it could receive the message"), {
              status: 409,
            });
          }

          // Claude can accept the message inside its live turn. If the write
          // loses a race with turn settlement, or the engine cannot steer, the
          // existing server-side queue records it atomically for the next turn.
          if (currentAtStart.busy) {
            const instance = registry.get(currentAtStart.modelSelection.instanceId);
            let steered = false;
            // A live text steer has no image side channel. Keep an attachment
            // message intact for the next ordinary turn, where central image
            // admission can hand it to the provider natively.
            const carriesImages = extractTurnImages(text).images.length > 0;
            if (!carriesImages && instance?.adapter.capabilities.queueing && instance.adapter.steer) {
              steered = await instance.adapter
                .steer(threadId, promptWithReply(text, replyTo, cfg.profile?.name?.trim() || "User"))
                .catch(() => false);
            }
            // steer() is awaited adapter work. The turn can settle, the task can
            // switch, or the whole bot can be deleted before its acknowledgement
            // arrives. Re-read every ownership invariant before appending even a
            // successful steer; otherwise that late acknowledgement writes a user
            // message into a task the bot no longer owns. A conflict leaves the
            // text in the client's composer/outbox to resend deliberately.
            const current = store.bot(bot.id);
            if (!current) throw Object.assign(new Error("no such bot"), { status: 404 });
            if (!store.taskByThread(bot.id, threadId)) {
              throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
            }
            if (current.threadId !== threadId) {
              throw Object.assign(new Error("the bot switched tasks before it could receive the message"), {
                status: 409,
              });
            }
            if (steered) {
              if (!current.busy) {
                throw Object.assign(
                  new Error("the running turn ended before the steered message could be recorded"),
                  { status: 409 },
                );
              }
              // A person steering a webhook turn is present, and auto mode may
              // follow them again. But this route is also reachable from the
              // bot's own shell on a headless server (loopback is the owner
              // there), and "continue" typed by the turn itself must not be
              // the thing that lifts the block written against it — so only
              // a request that proves a person (a paired session, or the
              // desktop's owner capability, which every mutation there has
              // already shown) clears the mark.
              if (auth.kind === "session" || DESKTOP_MANAGED) clearUnattended(current.id);
              const message = store.appendMessage(threadId, {
                role: "user",
                kind: "text",
                text,
                replyToId: replyTo?.id,
                sendId,
                steered: true,
              });
              return { ok: true as const, steered: true as const, threadId, message };
            }
            if (!current.busy) {
              const message = await startTurn(bot.id, text, { threadId, replyTo, sendId });
              return { ok: true as const, threadId, message };
            }
            const queued = queueSteeredMessage(current.id, threadId, text, {
              replyToId: replyTo?.id,
              sendId,
              prompt: promptWithReply(text, replyTo, cfg.profile?.name?.trim() || "User"),
            });
            return { ok: true as const, queued: true as const, queueId: queued.id, threadId };
          }
          const message = await startTurn(bot.id, text, { threadId, replyTo, sendId });
          return { ok: true as const, threadId, message };
        },
      );
      return json(res, 202, receipt);
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/queue\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const queueId = m[2];
      if (!cancelSteeredMessage(bot.id, queueId)) {
        return json(res, 404, { error: "no such queued message" });
      }
      return json(res, 200, { ok: true });
    }

    // edit a user message → fork the conversation there and rerun the turn.
    // Rewinding a live thread is refused, exactly like switching versions
    // below: interrupting mid-flight and branching under the dying turn is
    // how a conversation ends up with two tails. Stop, then edit.
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages\/([\w-]+)\/edit$/);
    if (m && method === "POST") {
      const messageId = m[2];
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      // everything from here down is synchronous, so two racing edits can
      // never both get past this check: startTurn flips busy before the
      // next request is handled
      if (bot.busy) return json(res, 409, { error: "the bot is working — stop it before editing" });
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
      const message = store.branchMessage(bot.threadId, messageId, text);
      if (!message) return json(res, 404, { error: "no such message" });
      store.patchBot(bot.id, { rewound: true });
      const replyTo = message.replyToId ? resolveReplyTarget(bot.threadId, message.replyToId) : undefined;
      await startTurn(bot.id, text, { userMessage: message, replyTo });
      return json(res, 202, { ok: true });
    }

    // switch which fork of the conversation is visible (no new turn)
    m = path.match(/^\/api\/bots\/([\w-]+)\/active-branch$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (bot.busy) return json(res, 409, { error: "the bot is working — stop it before switching versions" });
      if (phoneSecretSubmissions.hasThread(bot.threadId)) {
        return json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
      }
      const leaf = store.setActiveLeaf(bot.threadId, String(body.messageId ?? ""));
      if (!leaf) return json(res, 404, { error: "no such message" });
      // provider sessions still hold the other branch — next turn replays
      store.patchBot(bot.id, { rewound: true });
      return json(res, 200, { activeLeafId: leaf });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const behavior = requestBehavior(body.behavior);
      const reviewedSha256 = typeof body.reviewedSha256 === "string" ? body.reviewedSha256 : undefined;
      if (!behavior) return json(res, 400, { error: "behavior must be allow, deny, or answer" });
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
      if (resolvePeerComms(approvalBus, String(body.requestId), behavior)) {
        return json(res, 200, { ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" });
      }
      const outcome = await answerRequest(bot.threadId, bot.modelSelection.instanceId, String(body.requestId), behavior, body.message, { id: bot.id, name: bot.name });
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
      if (resolvePeerComms(approvalBus, requestId, behavior)) {
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
      const outcome = await answerRequest(threadId, owner?.modelSelection.instanceId ?? "", requestId, behavior, body.message, owner ? { id: owner.id, name: owner.name } : undefined);
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
      const expectedThreadId = body.threadId;
      if (expectedThreadId !== undefined && (typeof expectedThreadId !== "string" || !/^[\w-]+$/.test(expectedThreadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      const directClaim = directTurnDispatchClaims.get(bot.id);
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
      const instance = registry.get(bot.modelSelection.instanceId);
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
      const cancelledDirect = cancelDirectTurnDispatch(bot.id, expectedThreadId);
      const directThreadId = cancelledDirect?.threadId ?? bot.threadId;
      revokeInternalCapabilitiesForThread(directThreadId);
      await instance?.adapter.interruptTurn(directThreadId).catch(() => {});
      closeOpenApprovals(directThreadId);
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

    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (bot.busy) return json(res, 409, { error: "this bot is working — let it finish before starting a task" });
      if (phoneSecretSubmissions.hasBot(bot.id)) {
        return json(res, 409, { error: "this bot is securely saving a credential — try again when it finishes" });
      }
      const task = store.createTask(bot.id, typeof body.title === "string" ? body.title : undefined);
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
      // Switching the active thread while its provider turn is still running
      // loses ownership of the process and can make a later interrupt target
      // the wrong task. Keep this mutation atomic at the HTTP boundary; an
      // MCP client cannot make a safe check-then-switch across two requests.
      if (bot.busy) return json(res, 409, { error: "this bot is working — stop it before switching tasks" });
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
      const task = store.renameTask(m[1], m[2], String(body.title ?? ""));
      if (!task) return json(res, 404, { error: "no such task" });
      const fresh = botWithThread(store.bot(m[1])!);
      broadcast({ kind: "bot", bot: fresh });
      return json(res, 200, { task: wireTask(task) });
    }
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot || !store.taskByThread(bot.id, m[2])) {
        return json(res, 404, { error: "no such task" });
      }
      if (phoneSecretSubmissions.hasThread(m[2])) {
        return json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
      }
      if (bot?.busy && (bot.threadId === m[2] || routines!.isActiveThread(m[2]))) {
        return json(res, 409, { error: "this task is running — stop it first" });
      }
      const stagedSkillCleanups = stagedSkillCleanupsForThread(m[2]);
      const updated = store.deleteTask(m[1], m[2]);
      if (!updated) return json(res, 400, { error: "a bot keeps at least one task" });
      rejectDeletedThreadSkillStages(stagedSkillCleanups);
      const fresh = botWithThread(updated);
      broadcast({ kind: "bot", bot: fresh });
      return json(res, 200, { bot: fresh });
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
      const bot = store.bot(m[1]);
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
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
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
      }
      return json(res, 202, { installing: true });
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

    // ── the fleet-wide authorization decision log ──
    // Read-only like the inspector above: the rows were written at the
    // request.opened fold and in answerRequest; this only reads them back,
    // newest last, same order as thread events.
    if (method === "GET" && path === "/api/decisions") {
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        return json(res, 400, { error: "limit must be a positive whole number" });
      }
      return json(res, 200, { decisions: readDecisions(DATA_DIR, parsedLimit ?? 200) });
    }

    // ── provider instances (model picker) ──
    if (method === "GET" && path === "/api/instances") {
      // Rescan PATH first: this endpoint is how the app answers "what can I
      // run?", and the interesting case is a CLI installed since launch.
      // Windows never pushes PATH changes into a live process, so without
      // this the answer is frozen at boot and "check again" is a no-op.
      resetPathCache();
      return json(res, 200, { instances: await registry.describe() });
    }

    const instanceAction = /^\/api\/instances\/([\w.-]+)\/(refresh-models|install|auth\/start|auth\/complete|auth\/cancel)$/.exec(path);
    if (method === "POST" && instanceAction) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const instanceId = instanceAction[1];
      const action = instanceAction[2];
      try {
        if (action === "refresh-models") {
          if (!(await registry.refreshModels(instanceId))) return json(res, 404, { error: "unknown instance" });
          return json(res, 200, { instances: await registry.describe() });
        }
        if (action === "install") {
          if (!(await registry.installRuntime(instanceId))) return json(res, 404, { error: "managed installation is unavailable" });
          return json(res, 200, { instances: await registry.describe() });
        }
        if (action === "auth/start") {
          const auth = await registry.startAuthentication(instanceId);
          if (!auth) return json(res, 404, { error: "account setup is unavailable" });
          return json(res, 200, { auth });
        }
        if (action === "auth/complete") {
          const body = await readBody(req);
          const flowId = typeof body?.flowId === "string" ? body.flowId : "";
          const callbackUrl = typeof body?.callbackUrl === "string" ? body.callbackUrl : "";
          if (!flowId || !callbackUrl) return json(res, 400, { error: "flowId and callbackUrl are required" });
          if (!(await registry.completeAuthentication(instanceId, flowId, callbackUrl))) {
            return json(res, 404, { error: "account setup is unavailable" });
          }
          return json(res, 200, { ok: true });
        }
        if (!(await registry.cancelAuthentication(instanceId))) {
          return json(res, 404, { error: "account setup is unavailable" });
        }
        return json(res, 200, { ok: true });
      } catch (error) {
        const status = error && typeof error === "object" && (error as { status?: unknown }).status === 409
          ? 409
          : 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // ── CLI binary discovery for the Engines "detected" dropdown ──
    // ?name=claude → absolute paths of every `claude` on the augmented PATH,
    // in PATH order (first = what a bare name runs). Polled when the user
    // opens the Custom picker so a just-installed CLI appears without a restart.
    if (method === "GET" && path === "/api/cli-candidates") {
      const name = url.searchParams.get("name") ?? "";
      resetPathCache();
      return json(res, 200, { candidates: findCliCandidates(name) });
    }

    // ── pre-save CLI probe: does this path actually run? ──
    // POST {cli, driver} → spawn `<cli> --version` with the same PATH the
    // turn itself would use. A miss here (typo, missing exec bit, a binary
    // the GUI app can't see) means every turn would fail, so the UI asks
    // before saving rather than registering a dead engine.
    if (method === "POST" && path === "/api/cli-test") {
      // same gate as the local-VM lifecycle routes: this executes a local
      // binary, so a hostile page must not be able to submit it as a simple
      // text/plain cross-origin request
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      const cli = typeof body?.cli === "string" ? body.cli.trim() : "";
      if (!cli || /[\n\r]/.test(cli)) return json(res, 400, { error: "cli must be a non-empty path" });
      const driver = typeof body?.driver === "string" ? BUILT_IN_DRIVERS.find((d) => d.driverKind === body.driver) : undefined;
      // Probe the exact configured wrapper plus --version. testCliBinary uses
      // a credential-redacted environment, so fixed wrapper arguments cannot
      // turn this endpoint into an inherited-secret reader.
      const probe = await testCliBinary(cli, driver);
      return json(res, 200, probe);
    }

    // ── instance-scoped Claude Code update ──
    // No command or path comes from the request: the registry supplies the
    // executable already configured for this Claude instance. The JSON gate
    // keeps a hostile page from triggering a local process with a simple
    // cross-origin form request.
    const claudeUpdate = /^\/api\/instances\/([\w.-]+)\/claude-update$/.exec(path);
    if (method === "POST" && claudeUpdate) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      const target = registry.cliTarget(claudeUpdate[1]);
      if (!target) return json(res, 404, { error: "no such provider instance" });
      if (target.driverKind !== "claudeAgent") {
        return json(res, 400, { error: "only Claude Code instances can be updated here" });
      }
      if (!target.cli) return json(res, 409, { error: "this Claude instance has no configured executable" });
      if (claudeUpdatesInFlight.has(target.cli)) {
        return json(res, 409, { error: "this Claude installation is already updating" });
      }
      const active = store.bots.some((bot) =>
        bot.busy && registry.cliTarget(bot.modelSelection.instanceId)?.cli === target.cli
      );
      if (active) {
        return json(res, 409, { error: "wait for running Claude tasks to finish before updating" });
      }

      claudeUpdatesInFlight.add(target.cli);
      try {
        const result = await updateClaudeCli(target.cli, cliProbeEnvironment());
        resetPathCache();
        return json(res, 200, { ok: true, version: result.version });
      } catch (error) {
        return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        claudeUpdatesInFlight.delete(target.cli);
      }
    }

    // ── per-instance CLI path override (custom builds / versioned bins) ──
    // PATCH /api/instances/:id {cli: "/path/to/cli" | ""} — "" reverts to the
    // driver default. Kills in-flight turns like any provider reload.
    const instancePatch = /^\/api\/instances\/([\w.-]+)$/.exec(path);
    if (method === "PATCH" && instancePatch) {
      // same non-simple-request gate as the local-VM lifecycle routes
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (typeof body?.cli !== "string") return json(res, 400, { error: "cli must be a string" });
      if (/[\n\r]/.test(body.cli)) return json(res, 400, { error: "cli must not contain newlines" });
      if (providerConfigBusy) return json(res, 409, { error: "provider settings are already being updated" });
      providerConfigBusy = true;
      try {
        const result = withInstanceCli(cfg, instancePatch[1], body.cli);
        if (!result.ok) return json(res, 404, { error: `unknown instance "${instancePatch[1]}"` });
        // persist the whole instances map this rebuild produced — a fresh
        // saveConfig({instances}) merge would re-derive defaults identically,
        // but writing the resolved map keeps disk and runtime in lockstep
        saveConfig({ instances: result.config.instances });
        Object.assign(cfg, loadConfig());
        await reloadProviders();
        // rescan BEFORE describe(): the response's cliCandidates are computed
        // from the memoized PATH, so resetting after would answer this request
        // with the pre-reset cache
        resetPathCache();
        return json(res, 200, { instances: await registry.describe() });
      } finally {
        providerConfigBusy = false;
      }
    }

    // ── custom MCP servers (stdio, local, secrets write-only) ──
    if (method === "GET" && path === "/api/mcp/servers") {
      return json(res, 200, mcpServerResponse());
    }

    const mcpTest = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})\/test$/.exec(path);
    if (method === "POST" && mcpTest) {
      const raw = cfg.mcpServers?.[mcpTest[1]];
      if (raw === undefined) return json(res, 404, { error: "MCP server not found." });
      const parsed = parseStoredMcpServer(mcpTest[1], raw);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      if (mcpProbesInFlight >= MAX_CONCURRENT_MCP_PROBES) {
        return json(res, 429, { error: "Two MCP connection tests are already running." });
      }
      const controller = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", disconnect);
      mcpProbesInFlight += 1;
      try {
        return json(res, 200, await probeMcpServer(parsed.server, undefined, controller.signal));
      } finally {
        res.off("close", disconnect);
        mcpProbesInFlight -= 1;
      }
    }

    if (method === "POST" && path === "/api/mcp/servers") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      if (mcpConfigBusy) return json(res, 409, { error: "MCP servers are already being updated." });
      mcpConfigBusy = true;
      try {
        const body = await readBody(req);
        const name = typeof body?.name === "string" ? body.name : "";
        const current = cfg.mcpServers ?? {};
        if (Object.hasOwn(current, name)) return json(res, 409, { error: "An MCP server with that name already exists." });
        if (Object.keys(current).length >= MAX_MCP_SERVERS) {
          return json(res, 400, { error: `You can add at most ${MAX_MCP_SERVERS} MCP servers.` });
        }
        const parsed = parseMcpServerMutation(name, {
          command: body?.command,
          args: body?.args,
          env: body?.env,
          enabled: body?.enabled,
        });
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        persistMcpServers({ ...current, [name]: parsed.server });
        return json(res, 201, mcpServerResponse());
      } finally {
        mcpConfigBusy = false;
      }
    }

    const mcpServerRoute = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})$/.exec(path);
    if (mcpServerRoute && ["PUT", "PATCH", "DELETE"].includes(method)) {
      if (method !== "DELETE" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      if (mcpConfigBusy) return json(res, 409, { error: "MCP servers are already being updated." });
      mcpConfigBusy = true;
      try {
        const name = mcpServerRoute[1];
        const current = cfg.mcpServers ?? {};
        if (!Object.hasOwn(current, name)) return json(res, 404, { error: "MCP server not found." });
        if (method === "DELETE") {
          const next = { ...current };
          delete next[name];
          persistMcpServers(next);
          return json(res, 200, mcpServerResponse());
        }

        const existing = parseStoredMcpServer(name, current[name]);
        if (!existing.ok) return json(res, 400, { error: existing.error });
        const body = await readBody(req);
        if (method === "PATCH") {
          if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") {
            return json(res, 400, { error: "Only an enabled boolean can be changed here." });
          }
          persistMcpServers({ ...current, [name]: { ...existing.server, enabled: body.enabled } });
          return json(res, 200, mcpServerResponse());
        }

        const parsed = parseMcpServerMutation(name, body, existing.server);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        persistMcpServers({ ...current, [name]: parsed.server });
        return json(res, 200, mcpServerResponse());
      } finally {
        mcpConfigBusy = false;
      }
    }

    // ── app config (API keys — never echoed back, booleans only) ──
    if (method === "GET" && path === "/api/config") {
      const status = configStatus();
      if (auth.kind === "session" && !auth.scopes.includes("admin")) {
        // configured-or-not is fine; an SSH alias, an email, a browser
        // partition id are not a client's business
        return json(res, 200, {
          ...status,
          vps: { configured: status.vps.configured, sshAlias: "" },
          profile: { name: status.profile.name, email: "" },
          browserProfiles: status.browserProfiles.map((profile) => Object.fromEntries(Object.entries(profile).filter(([key]) => key !== "partitionId"))),
        });
      }
      return json(res, 200, status);
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      const patch = parseConfigPatch(body);
      if (!Object.keys(patch).length) return json(res, 400, { error: "nothing to save" });
      if (providerConfigBusy) return json(res, 409, { error: "provider settings are already being updated" });
      const disablingBuiltInBrowser = patch.features?.browser === false && builtInBrowserEnabled(cfg);
      const removedBrowserProfileIds = patch.browserProfiles === undefined
        ? []
        : (cfg.browserProfiles ?? [])
            .map((profile) => profile.id)
            .filter((id) => !patch.browserProfiles!.some((profile) => profile.id === id));
      if (patch.browserProfiles !== undefined) {
        const currentProfiles = new Map((cfg.browserProfiles ?? []).map((profile) => [profile.id, profile]));
        const nextProfiles = patch.browserProfiles.map((profile) => {
          const partitionId = currentProfiles.get(profile.id)?.partitionId;
          return partitionId ? { ...profile, partitionId } : profile;
        });
        const routingConflict = browserProfileReplacementConflict(cfg.browserProfiles ?? [], nextProfiles);
        if (routingConflict) return json(res, 409, { error: routingConflict });
        const currentIds = new Set((cfg.browserProfiles ?? []).map((profile) => profile.id));
        const pendingReuse = patch.browserProfiles.find(
          (profile) => !currentIds.has(profile.id) && browserCleanup.hasPendingProfile(profile.id),
        );
        if (pendingReuse) {
          return json(res, 409, {
            error: `the previous “${pendingReuse.name}” browser session is still being erased — wait before reusing it`,
          });
        }
      }
      if (patch.browserProfiles !== undefined) {
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        const activeReference = store.bots.find(
          (bot) => bot.busy && bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile),
        );
        if (activeReference) {
          return json(res, 409, {
            error: `stop ${activeReference.name}'s turn before removing its browser profile`,
          });
        }
      }
      if (patch.box?.token !== undefined) patch.box.token = patch.box.token.trim();
      const currentBoxToken = cfg.box?.token?.trim() ?? "";
      const nextBoxToken = patch.box?.token === undefined ? currentBoxToken : patch.box.token;
      const changingBoxToken = patch.box?.token !== undefined && nextBoxToken !== currentBoxToken;
      const currentVpsAlias = vpsSshAlias(cfg);
      const nextVpsAlias = patch.vps === undefined
        ? currentVpsAlias
        : vpsSshAlias({ ...cfg, vps: patch.vps });
      const changingVpsAlias = patch.vps !== undefined && nextVpsAlias !== currentVpsAlias;
      const transitioningProviders: RemoteComputerProvider[] = [
        ...(changingBoxToken ? ["box" as const] : []),
        ...(changingVpsAlias ? ["vps" as const] : []),
      ];
      providerConfigBusy = true;
      const changingLocalVmMode = patch.localVm?.mode !== undefined && patch.localVm.mode !== localVmMode(cfg);
      if (changingLocalVmMode) localVmModeChangeBusy = true;
      try {
        for (const provider of transitioningProviders) {
          const conflict = providerOperationConflict(provider);
          if (conflict) return json(res, 409, { error: conflict });
        }
        for (const provider of transitioningProviders) computerProviderConfigTransitions.add(provider);

        if (changingVpsAlias && currentVpsAlias) {
          const inventory = await vps.listManagedVpsComputers(
            { vps: { sshAlias: currentVpsAlias } },
            managedBoxOwners(),
          );
          if (!inventory.available) {
            return json(res, 503, {
              error: `${inventory.problem ?? "VPS computer inventory is unavailable"}. Keep the current SSH config alias and retry`,
            });
          }
          const resourceError = vpsAliasResourceChangeError(inventory.instances.length);
          if (resourceError) return json(res, 409, { error: resourceError });
        }

        const boxRecovery = changingBoxToken ? boxCreateRecoverySnapshot() : [];
        let currentBoxInventory: box.ManagedBoxInventory | null = null;
        let currentBoxResources: Array<{ boxId: string; name: string }> | null = null;
        const journalBoxResources: Array<{ boxId: string; name: string }> = [];
        if (changingBoxToken && currentBoxToken) {
          currentBoxInventory = await box.listManagedBoxes(
            { box: { token: currentBoxToken } },
            managedBoxOwners(),
          );
          if (!currentBoxInventory.available) {
            return json(res, 503, {
              error: `${currentBoxInventory.problem ?? "cloud computer inventory is unavailable"}. Keep the current Box account and retry`,
            });
          }
          const currentById = new Map(
            currentBoxInventory.instances.map((instance) => [instance.boxId, { boxId: instance.boxId, name: instance.name }]),
          );
          for (const recovery of boxRecovery) {
            if (!recovery.boxId) continue;
            const inspected = await box.inspectBoxIdentity({ box: { token: currentBoxToken } }, recovery.boxId);
            if (!inspected.available) {
              return json(res, 503, {
                error: `${inspected.problem ?? "a remembered cloud computer could not be verified"}. Keep the current Box account and retry`,
              });
            }
            if (!inspected.identity) {
              // Reconcile exact stale receipts while the current credential is
              // still available. Leaving one behind would make a later token
              // addition demand access to a Box the provider proved is gone.
              retireDeletedBoxCreate(recovery.boxId);
              continue;
            }
            const listed = currentById.get(inspected.identity.boxId);
            if (listed && listed.name !== inspected.identity.name) {
              return json(res, 503, { error: "ascii.dev returned conflicting cloud computer identities; keep the current Box account and retry" });
            }
            currentById.set(inspected.identity.boxId, inspected.identity);
            journalBoxResources.push(inspected.identity);
          }
          currentBoxResources = [...currentById.values()];
        }

        if (changingLocalVmMode) {
          if (localVmActiveThreads.size > 0 || localVmLifecycleBusy.size > 0 || localVmImageBusy) {
            return json(res, 409, { error: "stop Local VM turns and setup actions before changing the Local VM isolation mode" });
          }
          if (localVmMode(cfg) === "per-bot" && patch.localVm?.mode === "shared") {
            const existing = await perBotLocalVmCountForModeChange();
            if (existing === null) {
              return json(res, 409, {
                error: "start the container runtime and delete every per-bot VM before switching to shared mode",
              });
            }
            if (existing > 0) {
              return json(res, 409, {
                error: `delete the ${existing} per-bot Local VM${existing === 1 ? "" : "s"} before switching to shared mode`,
              });
            }
          }
        }
      // A project key is useful only if it can create/reuse the Session that
      // powers both the connections UI and the agent MCP. Validate it before
      // persisting, and save the non-secret ids needed to reuse that Session.
      const requestedComposioKey = patch.composio?.apiKey;
      if (requestedComposioKey !== undefined) {
        if (requestedComposioKey.trim()) {
          try {
            const prepared = await composio.prepareProjectSession(requestedComposioKey, cfg.composio);
            patch.composio = { ...patch.composio, ...prepared };
          } catch (error) {
            return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        } else {
          patch.composio = { ...patch.composio, apiKey: "", sessionId: "" };
        }
      }
      // check a box token against the provider before storing it: a
      // rejected token used to save happily and only surface as a 401 in
      // another panel later, with nothing the user could act on
      const newBoxToken = patch.box?.token;
      if (newBoxToken?.trim()) {
        const check = await box.verifyToken(newBoxToken);
        if (!check.ok) return json(res, 400, { error: check.message });
      }
      if (changingBoxToken && !currentBoxToken && boxRecovery.length > 0) {
        if (!nextBoxToken) {
          return json(res, 409, { error: "restore the Box account that owns the remembered cloud computers before clearing it" });
        }
        for (const recovery of boxRecovery) {
          if (!recovery.boxId) {
            return json(res, 409, { error: "finish reconciling pending cloud computer creation before changing the Box account" });
          }
          const inspected = await box.inspectBoxIdentity({ box: { token: nextBoxToken } }, recovery.boxId);
          if (!inspected.available) {
            return json(res, 503, {
              error: `${inspected.problem ?? "a remembered cloud computer could not be verified"}. Retry with the Box account that created it`,
            });
          }
          if (!inspected.identity || !(await box.boxNameMatchesBot(recovery.botId, inspected.identity.name))) {
            return json(res, 409, { error: "that Box token cannot access the remembered cloud computers from this installation" });
          }
        }
      }
      if (changingBoxToken && currentBoxInventory && currentBoxResources) {
        let replacementResources: Array<{ boxId: string; name: string }> | null = null;
        if (nextBoxToken) {
          const replacementInventory = await box.listManagedBoxes(
            { box: { token: nextBoxToken } },
            managedBoxOwners(),
            { adoptLegacy: false },
          );
          if (!replacementInventory.available) {
            return json(res, 503, {
              error: `${replacementInventory.problem ?? "cloud computer inventory is unavailable"}. Keep the current Box account and retry`,
            });
          }
          replacementResources = replacementInventory.instances.map((instance) => ({
            boxId: instance.boxId,
            name: instance.name,
          }));
          const replacementById = new Map(
            replacementResources.map((instance) => [instance.boxId, { boxId: instance.boxId, name: instance.name }]),
          );
          for (const identity of journalBoxResources) {
            const inspected = await box.inspectBoxIdentity({ box: { token: nextBoxToken } }, identity.boxId);
            if (!inspected.available) {
              return json(res, 503, {
                error: `${inspected.problem ?? "a remembered cloud computer could not be verified"}. Keep the current Box account and retry`,
              });
            }
            if (!inspected.identity || inspected.identity.name !== identity.name) {
              return json(res, 409, { error: "the replacement Box token does not access the same cloud computers" });
            }
            replacementById.set(inspected.identity.boxId, inspected.identity);
          }
          replacementResources = [...replacementById.values()];
        }
        const resourceError = boxAccountResourceChangeError(
          currentBoxResources,
          replacementResources,
        );
        if (resourceError) return json(res, 409, { error: resourceError });
      }
      // same rule for a voice key — and check it against the provider the
      // patch SELECTS, not the one already saved, or pasting a Cartesia key
      // while switching from ElevenLabs validates against the wrong service
      const newTts = patch.tts;
      if (newTts?.key?.trim()) {
        const check = await tts.verifyKey(newTts.key.trim());
        if (!check.ok) return json(res, 400, { error: check.message });
      }
      if (patch.browserProfiles !== undefined) {
        // Provider/credential validation above may await the network. A turn
        // can start during that window and claim a profile which looked idle
        // at the route's first check, so validate again at the mutation
        // boundary. Keep this check and the synchronous save/reference cleanup
        // below free of awaits.
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        const activeReference = store.bots.find(
          (bot) => bot.busy && bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile),
        );
        if (activeReference) {
          return json(res, 409, {
            error: `stop ${activeReference.name}'s turn before removing its browser profile`,
          });
        }
      }
      // Provider validation above awaits remote services. The transition flag
      // blocks new work, while this second observation catches any operation
      // that already held a claim at the initial boundary.
      for (const provider of transitioningProviders) {
        const conflict = providerOperationConflict(provider);
        if (conflict) return json(res, 409, { error: conflict });
      }
      const browserCleanupRequests: BrowserCleanupRequest[] = [];
      try {
        if (utilityParentPort) {
          for (const profileId of removedBrowserProfileIds) {
            const target = browserProfilePartitionTarget(cfg, profileId);
            if (!target) throw new Error(`browser profile cleanup target “${profileId}” is unavailable`);
            browserCleanupRequests.push(
              browserCleanup.prepare("profile", target.profileId, target.partitionId),
            );
          }
        }
      } catch (error) {
        for (const request of browserCleanupRequests) browserCleanup.abort(request);
        throw error;
      }
      let configWriteCommitted = false;
      const externalSecretStorage = url.searchParams.get("secretStorage") === "external";
      try {
        if (externalSecretStorage) {
          // The packaged Electron caller commits supplied credentials to the
          // OS-encrypted store before entering this route. Persist every
          // non-secret sibling in the same request, but replace each supplied
          // credential with an empty tombstone so an older plaintext value can
          // never survive the merge in config.json.
          const persisted = structuredClone(patch);
          if (persisted.xai?.key !== undefined) persisted.xai.key = "";
          if (persisted.composio?.apiKey !== undefined) persisted.composio.apiKey = "";
          if (persisted.box?.token !== undefined) persisted.box.token = "";
          if (persisted.opencodeGo?.apiKey !== undefined) persisted.opencodeGo.apiKey = "";
          if (persisted.tts?.key !== undefined) persisted.tts.key = "";
          if (persisted.imageGen?.key !== undefined) persisted.imageGen.key = "";
          saveConfig(persisted);
          configWriteCommitted = true;
          syncCredentialEnv(patch);
          Object.assign(cfg, loadConfig());
        } else {
          saveConfig(patch);
          configWriteCommitted = true;
          // loadConfig prefers env over the file for credentials, so the env
          // must follow the save — otherwise the value injected at boot would
          // shadow the new key until the next launch
          syncCredentialEnv(patch);
          Object.assign(cfg, loadConfig());
        }
      } catch (error) {
        if (configWriteCommitted) {
          for (const request of browserCleanupRequests) {
            const committed = browserCleanup.commit(request);
            void browserCleanup.ensure(committed);
          }
        } else {
          for (const request of browserCleanupRequests) browserCleanup.abort(request);
        }
        throw error;
      }
      let browserReferenceCleanupError: unknown = null;
      if (patch.browserProfiles !== undefined) {
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        try {
          for (const bot of store.bots) {
            if (bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile)) {
              // The profile list and every bot reference change in the same
              // config request. Non-renderer clients therefore cannot leave a
              // bot pointing at a deleted cookie partition.
              store.patchBot(bot.id, { browserProfile: undefined });
            }
          }
        } catch (error) {
          // Config is already durable. Keep the cleanup intent prepared (so
          // it cannot wipe ambiguous state and its id remains locked), but do
          // not let this secondary write failure skip revocation/reload below.
          browserReferenceCleanupError = error;
        }
      }
      // Provider keys change the fleet. Profile, language, voice, VPS, and
      // room timeout changes do not rebuild it: no driver reads them, and they
      // should not interrupt in-flight turns.
      const reloadKeys = Object.keys(patch).filter(
        (key) =>
          key !== "profile" &&
          key !== "language" &&
          key !== "tts" &&
          key !== "imageGen" &&
          key !== "vps" &&
          key !== "rooms" &&
          key !== "localVm" &&
          key !== "features" &&
          key !== "browserProfiles",
      );
      // Config is already durable. A provider credential or runtime change
      // invalidates every old child immediately, including when browser
      // cleanup below has to await Electron before reloadProviders begins.
      if (reloadKeys.length > 0) revokeAllInternalCapabilities();
      // The cleanup marker becomes committed only after both pieces of durable
      // application state agree. Commit/ACK failures are deferred until every
      // mandatory consequence of the config write has run: no journal I/O
      // failure may leave a two-hour bearer or stale provider fleet active.
      const finalized = await finalizeBrowserCleanupMutation({
        requests: browserCleanupRequests,
        referenceError: browserReferenceCleanupError,
        commit: (request) => browserCleanup.commit(request),
        ensure: (request) => browserCleanup.ensure(request),
        mandatory: async () => {
          let mandatoryError: unknown = null;
          if (disablingBuiltInBrowser) {
            try {
            } catch (error) {
              mandatoryError = error;
            }
          }
          if (reloadKeys.length > 0) {
            try {
              await reloadProviders();
            } catch (error) {
              if (!mandatoryError) mandatoryError = error;
            }
          }
          const status = configStatus();
          broadcast({ kind: "config", ...status });
          if (mandatoryError) throw mandatoryError;
          return status;
        },
      });
      // Normal desktop deletes wait for Electron's acknowledgement. If
      // Electron is restarting, the committed journal keeps retrying and the
      // id-reuse guard above prevents stale logins from resurfacing. Delaying
      // this assertion until after every mandatory post-commit effect keeps
      // the runtime aligned with the config even on a truthful 503 response.
      requireBrowserCleanupAcknowledged(
        finalized.acknowledgements.every(Boolean),
        removedBrowserProfileIds.length === 1 ? "The browser profile" : "The browser profiles",
      );
      return json(res, 200, finalized.value);
      } finally {
        for (const provider of transitioningProviders) computerProviderConfigTransitions.delete(provider);
        if (changingLocalVmMode) localVmModeChangeBusy = false;
        providerConfigBusy = false;
      }
    }

    // ── voice ─────────────────────────────────────────────────────────
    // Splitting text into utterances lives HERE, not in the renderer, for
    // the same reason approvalKey does — it is the piece most likely to be
    // tuned against real transcripts, and it belongs next to the transform
    // that produced it.
    if (method === "POST" && path === "/api/tts/prepare") {
      const body = await readBody(req);
      return json(res, 200, {
        ready: tts.voiceReady(cfg, typeof body.voiceId === "string" ? body.voiceId : undefined),
        utterances: toUtterances(String(body.text ?? "")),
      });
    }
    if (method === "GET" && path === "/api/tts/voices") {
      try {
        return json(res, 200, { voices: await tts.listVoices(cfg) });
      } catch (e) {
        return json(res, 200, { voices: [], error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (method === "POST" && path === "/api/tts/speak") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      // The normal client sends <=320-character utterances. A hard ceiling
      // prevents an arbitrary local request from turning the user's hosted
      // voice account into an unbounded, billable synthesis job.
      if (text.length > 500) return json(res, 413, { error: "voice utterances are limited to 500 characters" });
      try {
        const audio = await tts.speak(cfg, text, typeof body.voiceId === "string" ? body.voiceId : undefined);
        res.writeHead(200, {
          "content-type": audio.mime,
          "content-length": String(audio.bytes.byteLength),
          "cache-control": "no-store",
        });
        return res.end(Buffer.from(audio.bytes));
      } catch (e) {
        // "you haven't set this up yet" is not a provider failure — 409 so
        // the client can point at App Settings instead of showing a 502
        if (e instanceof tts.NoVoiceConfigured) return json(res, 409, { error: e.message });
        return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // ── connectors (Composio) ──
    if (method === "GET" && path === "/api/connectors/catalog") {
      const { cards, source } = await composio.listToolkits(cfg);
      return json(res, 200, { configured: composio.configured(cfg), mode: composio.connectionMode(cfg), source, cards });
    }
    if (method === "GET" && path === "/api/connectors/connected") {
      const availability = composio.connectorAvailability(cfg);
      if (availability !== "configured") {
        // `credentialStore` is what stops the panel treating this empty list
        // as authoritative: an unreadable store means we do not KNOW what is
        // connected, which is not the same as knowing nothing is.
        return json(res, 200, {
          configured: false,
          credentialStore: availability === "unreadable" ? "unavailable" : "ok",
          services: {},
        });
      }
      return json(res, 200, { configured: true, credentialStore: "ok", services: await composio.connectedServices(cfg) });
    }
    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      const availability = composio.connectorAvailability(cfg);
      if (availability !== "configured") {
        return json(res, 200, {
          configured: false,
          credentialStore: availability === "unreadable" ? "unavailable" : "ok",
          services: {},
        });
      }
      const status = await composio.connectionStatus(cfg, services.length ? services : composio.CURATED_SLUGS);
      return json(res, 200, { configured: true, services: status });
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      return json(res, 200, await composio.authorizeService(cfg, m[1], body.alias));
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
    if (m && method === "DELETE") return json(res, 200, await composio.removeAccount(cfg, m[1], m[2]));
    m = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (m && method === "DELETE") return json(res, 200, await composio.removeService(cfg, m[1]));

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
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return bot.cloudBackend === "vps"
        ? json(res, 200, { backend: "vps", ...(await vps.vpsComputerStatus(cfg, bot.id)) })
        : json(res, 200, { backend: "box", ...(await box.boxStatus(cfg, bot.id)) });
    }
    // Who is driving this bot's computer. GET is the panel's initial read;
    // POST take/release/dismiss-help are the person's three moves. The bot
    // has no verb here at all — its only voice is the internal help plea.
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/control$/);
    if (m) {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (method === "GET") return json(res, 200, computerControl.snapshot(bot.id));
      if (method === "POST") {
        // JSON-only for the same anti-form-POST reason as every other
        // computer mutation below.
        if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          return json(res, 415, { error: "content-type must be application/json" });
        }
        const body = await readBody(req);
        const action = String(body.action ?? "");
        const leaseResult =
          body.controlLeaseId === undefined
            ? null
            : controlLeaseIdSchema.safeParse(body.controlLeaseId);
        if (leaseResult && !leaseResult.success) {
          return json(res, 400, { error: "controlLeaseId is invalid" });
        }
        const controlLeaseId = leaseResult?.data;
        if (action === "take" && boxLifecycleBusyBots.has(bot.id)) {
          return json(res, 409, { error: "this bot's cloud computer is being changed — wait before taking control" });
        }
        if (action === "take" && controlLeaseId) {
          const result = computerControl.acquireLease(bot.id, controlLeaseId);
          return json(res, 200, {
            ...result.snapshot,
            owned: result.owned,
            acquired: result.acquired,
          });
        }
        if (action === "release" && controlLeaseId) {
          const result = computerControl.releaseLease(bot.id, controlLeaseId);
          return json(res, 200, { ...result.snapshot, released: result.released });
        }
        if (action === "take") return json(res, 200, computerControl.take(bot.id));
        if (action === "release") return json(res, 200, computerControl.release(bot.id));
        if (action === "dismiss-help") return json(res, 200, computerControl.dismissHelp(bot.id));
        return json(res, 400, { error: "action must be take, release, or dismiss-help" });
      }
      return json(res, 405, { error: "method not allowed" });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/viewer-close$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      return json(res, 200, bot.cloudBackend === "vps" ? vps.closeVpsDesktopTunnel(bot.id) : { closed: false });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/(provision|join|sleep|exec|screenshot|remove)$/);
    if (m && method === "POST") {
      const botId = m[1];
      const bot = store.bot(botId);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // Requiring JSON makes every computer mutation a non-simple browser
      // request (same reasoning as the Local VM lifecycle routes above): a
      // hostile page cannot submit it with a form, and its cross-origin JSON
      // request dies in the preflight this server never answers. Applied to
      // both backends — the Box branch runs commands too.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const remoteProvider: RemoteComputerProvider = bot.cloudBackend === "vps" ? "vps" : "box";
      if (computerProviderConfigTransitions.has(remoteProvider)) {
        return json(res, 409, { error: providerTransitionMessage(remoteProvider) });
      }
      if (boxLifecycleBusyBots.has(botId)) {
        return json(res, 409, { error: "this bot's cloud computer is being changed — wait for it to finish" });
      }
      if (bot.cloudBackend === "vps") {
        const releaseComputerLifecycle = claimBotComputerLifecycle(botId);
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
            return json(res, 200, await vps.vpsComputerJoin(cfg, botId));
          }
          if (m[2] === "screenshot") return json(res, 200, await vps.vpsComputerScreenshot(cfg, botId));
          const action = m[2] === "provision" ? "provision" : m[2] === "remove" ? "remove" : "stop";
          return json(res, 200, await vps.vpsComputerAction(action, cfg, botId));
        } finally {
          releaseComputerLifecycle();
        }
      }
      const activeBoxTurn = botHasActiveTurn(botId);
      if (["provision", "sleep"].includes(m[2]) && activeBoxTurn) {
        return json(res, 409, {
          error: "this bot's cloud computer is being used by an active turn — interrupt it first",
        });
      }
      // Input validity is independent of destination authorization. Preserve
      // the stable 400 contract for oversized commands without contacting the
      // provider; a valid Auto request still reaches the 409 gate below.
      let boxCommand: string | undefined;
      if (m[2] === "exec") {
        const body = await readBody(req);
        boxCommand = String(body?.command ?? "");
        if (boxCommand.length > MAX_REMOTE_COMMAND_LENGTH) {
          return json(res, 400, {
            error: `command is too long (maximum ${MAX_REMOTE_COMMAND_LENGTH} characters)`,
          });
        }
      }
      if (bot.computer !== "cloud") {
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
            return json(res, 200, await box.provisionBox(cfg, botId, bot.name));
          case "join":
            return json(res, 200, await (activeBoxTurn ? box.joinReadyBox(cfg, botId) : box.joinBox(cfg, botId)));
          case "sleep":
            return json(res, 200, await box.sleepBox(cfg, botId));
          case "exec":
            return json(res, 200, await box.execOnBox(cfg, botId, boxCommand ?? ""));
          case "screenshot":
            return json(res, 200, await box.screenshotBox(cfg, botId));
        }
      } finally {
        releaseComputerLifecycle();
      }
    }

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    const status = (e as any)?.status ?? 500;
    return json(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
};

const server = createServer(handleRequest);

calendarCalls.start();

// Resolve the edition before accepting requests so /api/edition is never a guess.
console.log(describeEdition(await loadEnterpriseLayer()));
console.log(describeBrand(loadBrand()));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`openmausbot server on http://127.0.0.1:${PORT}`);
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
      // Child MCP processes and the HTTP listener can remain alive while the
      // asynchronous shutdown jobs drain. Invalidate their turn bearers before
      // any cleanup function reaches an await.
      revokeAllInternalCapabilities();
      for (const idle of localVmIdles.values()) idle.cancel();
      vps.closeAllVpsDesktopTunnels();
      watchdog.stop();
      routines?.stop();
      calendarCalls?.stop();
      webhookIngress?.server.close();
      tunnelListener?.close();
    },
    () => registry.disposeAll(),
    () => flushAllProfileHistory(),
  ],
  // Cleanup jobs run concurrently. Release only after they settle (or reach
  // the shutdown deadline), immediately before the process exits, so no new
  // server can overlap with a still-mutating old one.
  exit: (code) => {
    releaseDataDirLeaseAtExit();
    process.exit(code);
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, gracefulShutdown);
}

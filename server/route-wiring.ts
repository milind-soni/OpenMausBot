// The route-factory wiring table — every route group handleRequest
// dispatches to, extracted verbatim from index.ts between the
// loopback-enforcement commentary and the handleRequest const. The
// create*Routes calls, their dep objects, and the section comments inside
// the span are unchanged; index.ts calls createRouteHandlers exactly
// where the table sat and rebinds the handlers from its result. Consts
// and factory products cross by value; the index.ts lets the table reads
// at request time (routines, calendarCalls, the desktop mutation tokens,
// workspaceAccess) cross as thunks; the lets the table writes or wraps in
// accessor objects (providerConfigBusy, the local-VM busy flags, the
// browser-engine install state) cross once each as { get, set }
// accessors whose wrappers the table reuses directly. Module functions
// only the table consumed (serverVersion, readBody, the flush family,
// closeMessageDb, the fleet-client helpers, the internal-capability and
// turn-admission helpers, resolveRequestAuth) are imported here directly.
import { flushDecisionLog } from "./decision-log.ts";
import { closeMessageDb } from "./message-db.ts";
import { flushUsageLedger } from "./usage-ledger.ts";
import { flushAllProfileHistory } from "./profile-versions.ts";
import { flushAllMemoryJournals } from "./memory-journal.ts";
import { entitled } from "./enterprise.ts";
import { fleetAvailable, fleetRequest, fleetSocketPath } from "./fleet-client.ts";
import { computerSelectionTurns } from "./internal-capabilities.ts";
import { claimTurnResource, turnComputerResources } from "./turn-admission.ts";
import { resolveRequestAuth } from "./request-auth.ts";
import { serverVersion } from "./environment.ts";
import { readBody } from "./http.ts";
import { createWorkspaceBackupRoutes } from "./workspace-backup-http.ts";
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
import { createBrowserLiveRoutes } from "./routes/browser-live.ts";
import { createFleetRoutes } from "./routes/fleet.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { WorkspaceAccess } from "./enterprise.ts";
import type { RoutineManager } from "./routines.ts";
import type { CalendarCallManager } from "./calendar-calls.ts";
import type { SessionRegistry } from "./sessions.ts";
import type { ProviderAuthSessions } from "./provider-auth-sessions.ts";
import type { WebhookManager } from "./webhooks.ts";
import type { SharedComputers } from "./shared-computers.ts";
import type { BrowserCleanupCoordinator } from "./browser-lifecycle-cleanup.ts";
import type { groupIsWorking } from "./group-coordination.ts";
import type { threadBusy } from "./turn-admission.ts";
import type { store, cfg, registry, workspaceRestore, workspaceMaintenance } from "./runtime.ts";
import type { createEmailSignIn } from "./account-signin.ts";
import type { createCustomDomainVerifier } from "./custom-domain.ts";
import type { createServeStatic } from "./http.ts";
import type { createComputerLifecycleWiring } from "./computer-lifecycle-wiring.ts";
import type { createTurnIntegrations } from "./turn-integrations.ts";
import type { createGroupTurnOperations } from "./group-turn-operations.ts";
import type { createEventsPipeline } from "./events-pipeline.ts";
import type { createGroupState } from "./group-state.ts";
import type { createTurnDispatch } from "./turn-dispatch.ts";
import type { createRoutineLifecycle } from "./routine-lifecycle.ts";
import type { createSkillLifecycle } from "./skill-lifecycle.ts";
import type { createTurnSecrets } from "./turn-secrets.ts";
import type { createConfigViews } from "./config-views.ts";
import type { createProviderFleet } from "./provider-fleet.ts";
import type { createPeerAgentComms } from "./peer-agent-comms.ts";
import type { createBotViews } from "./bot-views.ts";
import type { createCheckedInputs } from "./checked-inputs.ts";
import type { createCalendarRooms } from "./calendar-rooms.ts";
import type { createTeamSetupLifecycle } from "./team-setup-lifecycle.ts";
import type { createBotLifecycle } from "./bot-lifecycle.ts";
import type { createDelegationWatch } from "./delegation-watch.ts";

type TurnIntegrations = ReturnType<typeof createTurnIntegrations>;
type ComputerLifecycleWiring = ReturnType<typeof createComputerLifecycleWiring>;
type GroupTurnOperations = ReturnType<typeof createGroupTurnOperations>;
type EventsPipeline = ReturnType<typeof createEventsPipeline>;
type GroupState = ReturnType<typeof createGroupState>;
type TurnDispatch = ReturnType<typeof createTurnDispatch>;
type RoutineLifecycle = ReturnType<typeof createRoutineLifecycle>;
type SkillLifecycle = ReturnType<typeof createSkillLifecycle>;
type TurnSecrets = ReturnType<typeof createTurnSecrets>;
type ConfigViews = ReturnType<typeof createConfigViews>;
type ProviderFleet = ReturnType<typeof createProviderFleet>;
type PeerAgentComms = ReturnType<typeof createPeerAgentComms>;
type BotViews = ReturnType<typeof createBotViews>;
type CheckedInputs = ReturnType<typeof createCheckedInputs>;
type CalendarRooms = ReturnType<typeof createCalendarRooms>;
type TeamSetupLifecycle = ReturnType<typeof createTeamSetupLifecycle>;
type BotLifecycle = ReturnType<typeof createBotLifecycle>;
type DelegationWatch = ReturnType<typeof createDelegationWatch>;
type EmailSignIn = ReturnType<typeof createEmailSignIn>;
type CustomDomainVerifier = ReturnType<typeof createCustomDomainVerifier>;
type ServeStatic = ReturnType<typeof createServeStatic>;

/** Everything the route-factory wiring table reads from its host: consts
 * and factory products cross by value; the index.ts lets the table reads
 * at request time cross as thunks; the lets the table writes or wraps
 * cross once each as { get, set } accessors the table reuses directly. */
export interface RouteWiringDeps {
  DATA_DIR: string;
  PORT: number;
  SESSION_COOKIE: string;
  DESKTOP_MANAGED: boolean;
  HOSTED_WORKSPACE: boolean;
  STATIC_DIR: string | null;
  MAX_WORKSPACE_BOTS: PeerAgentComms["MAX_WORKSPACE_BOTS"];
  MAX_COMMS_DEPTH: PeerAgentComms["MAX_COMMS_DEPTH"];
  ASK_BOT_TIMEOUT_MS: EventsPipeline["ASK_BOT_TIMEOUT_MS"];
  MAX_THREADS_OPENED_PER_TURN: TurnDispatch["MAX_THREADS_OPENED_PER_TURN"];
  ROOM_POST_MAX_CHARS: CalendarRooms["ROOM_POST_MAX_CHARS"];
  LOCAL_VM_IDLE_MS: ComputerLifecycleWiring["LOCAL_VM_IDLE_MS"];
  sessions: SessionRegistry;
  store: typeof store;
  cfg: typeof cfg;
  registry: typeof registry;
  workspaceRestore: typeof workspaceRestore;
  workspaceMaintenance: typeof workspaceMaintenance;
  sharedComputers: SharedComputers;
  sharedComputerControl: ComputerLifecycleWiring["sharedComputerControl"];
  providerFleet: ProviderFleet;
  providerAuthSessions: ProviderAuthSessions;
  persistProviderInstance: ProviderFleet["persistProviderInstance"];
  reloadProviders: ProviderFleet["reloadProviders"];
  providerInstancesChanging: ProviderFleet["providerInstancesChanging"];
  personAskAt: Map<string, number>;
  directTurnGenerationByThread: Map<string, string>;
  webhooks: WebhookManager;
  emailSignIn: EmailSignIn;
  customDomainVerifier: CustomDomainVerifier;
  serveStatic: ServeStatic;
  publicUrl: () => string | null;
  customDomainStatus: () => { customDomain: string | null; publicUrl: string | null; fallbackUrl: string | null; supported: boolean; appPort: number; webhookPort: number; serverIpv4: string | null };
  webhookIngressStatus: () => { available: boolean; baseUrl: string; error?: string };
  noteTurnTrigger: (threadId: string, auth: RequestAuth) => void;
  messageSender: (auth: RequestAuth) => { name: string } | undefined;
  browserCleanup: BrowserCleanupCoordinator;
  groupIsWorking: typeof groupIsWorking;
  threadBusy: typeof threadBusy;
  routines(): RoutineManager | null;
  calendarCalls(): CalendarCallManager | null;
  desktopMutationToken(): string | undefined;
  companionMutationToken(): string | undefined;
  workspaceAccess(): WorkspaceAccess | null;
  providerConfigBusy: { get(): boolean; set(value: boolean): void };
  localVmImageBusy: { get(): boolean; set(value: boolean): void };
  localVmModeChangeBusy: { get(): boolean; set(value: boolean): void };
  localVmProvisionBusy: { get(): boolean; set(value: boolean): void };
  browserEngineInstall: { get(): Promise<void> | null; set(value: Promise<void> | null): void };
  browserEngineInstallError: { get(): string | null; set(value: string | null): void };
  computerControl: TurnIntegrations["computerControl"];
  browserRuntime: TurnIntegrations["browserRuntime"];
  browserLive: TurnIntegrations["browserLive"];
  browserIntegration: TurnIntegrations["browserIntegration"];
  currentBrowserSession: TurnIntegrations["currentBrowserSession"];
  controlLeaseIdSchema: TurnIntegrations["controlLeaseIdSchema"];
  forgetTemporaryBrowser: TurnIntegrations["forgetTemporaryBrowser"];
  cancelDirectTurnDispatch: TurnIntegrations["cancelDirectTurnDispatch"];
  localVmLifecycleBusy: ComputerLifecycleWiring["localVmLifecycleBusy"];
  localVmActiveThreads: ComputerLifecycleWiring["localVmActiveThreads"];
  boxLifecycleBusyBots: ComputerLifecycleWiring["boxLifecycleBusyBots"];
  vpsPreviewRequests: ComputerLifecycleWiring["vpsPreviewRequests"];
  orphanBoxLifecycleBusyIds: ComputerLifecycleWiring["orphanBoxLifecycleBusyIds"];
  computerProviderConfigTransitions: ComputerLifecycleWiring["computerProviderConfigTransitions"];
  checkpointRestoreLeases: ComputerLifecycleWiring["checkpointRestoreLeases"];
  teamComputerInUse: ComputerLifecycleWiring["teamComputerInUse"];
  botHasActiveTurn: ComputerLifecycleWiring["botHasActiveTurn"];
  botComputerControlSnapshot: ComputerLifecycleWiring["botComputerControlSnapshot"];
  inheritedTeamComputer: ComputerLifecycleWiring["inheritedTeamComputer"];
  computerPreviewBot: ComputerLifecycleWiring["computerPreviewBot"];
  computerPreviewSurface: ComputerLifecycleWiring["computerPreviewSurface"];
  botComputerControlKey: ComputerLifecycleWiring["botComputerControlKey"];
  selectableComputers: ComputerLifecycleWiring["selectableComputers"];
  localVmOwnerBusy: ComputerLifecycleWiring["localVmOwnerBusy"];
  localVmLeaseFor: ComputerLifecycleWiring["localVmLeaseFor"];
  localVmIdleFor: ComputerLifecycleWiring["localVmIdleFor"];
  localVmTargetForBot: ComputerLifecycleWiring["localVmTargetForBot"];
  localVmInventoryPayload: ComputerLifecycleWiring["localVmInventoryPayload"];
  teamComputers: ComputerLifecycleWiring["teamComputers"];
  teamComputersPayload: ComputerLifecycleWiring["teamComputersPayload"];
  managedBoxOwners: ComputerLifecycleWiring["managedBoxOwners"];
  claimTeamComputerLifecycle: ComputerLifecycleWiring["claimTeamComputerLifecycle"];
  claimBotComputerLifecycle: ComputerLifecycleWiring["claimBotComputerLifecycle"];
  claimBoxInventoryRequest: ComputerLifecycleWiring["claimBoxInventoryRequest"];
  claimManagedBoxMutation: ComputerLifecycleWiring["claimManagedBoxMutation"];
  claimManagedVpsMutation: ComputerLifecycleWiring["claimManagedVpsMutation"];
  assertTeamControlCanBeTaken: ComputerLifecycleWiring["assertTeamControlCanBeTaken"];
  assertTeamComputerChangeIdle: ComputerLifecycleWiring["assertTeamComputerChangeIdle"];
  providerOperationConflict: ComputerLifecycleWiring["providerOperationConflict"];
  providerTransitionMessage: ComputerLifecycleWiring["providerTransitionMessage"];
  activeVpsThreads: ComputerLifecycleWiring["activeVpsThreads"];
  autoVmClaims: ComputerLifecycleWiring["autoVmClaims"];
  interruptAllDirectThreads: ComputerLifecycleWiring["interruptAllDirectThreads"];
  interruptDirectThread: ComputerLifecycleWiring["interruptDirectThread"];
  runningTurnInstance: ComputerLifecycleWiring["runningTurnInstance"];
  askBotAndWait: ComputerLifecycleWiring["askBotAndWait"];
  sendSequencer: ComputerLifecycleWiring["sendSequencer"];
  activeGroupTurnForBot: GroupTurnOperations["activeGroupTurnForBot"];
  cancelGroupTurnOperations: GroupTurnOperations["cancelGroupTurnOperations"];
  broadcast: EventsPipeline["broadcast"];
  notify: EventsPipeline["notify"];
  groupSpeakers: EventsPipeline["groupSpeakers"];
  lastReply: EventsPipeline["lastReply"];
  watchdog: EventsPipeline["watchdog"];
  clearUnattended: EventsPipeline["clearUnattended"];
  isUnattended: EventsPipeline["isUnattended"];
  createChannel: GroupState["createChannel"];
  updateChannel: GroupState["updateChannel"];
  channelTaskBlocked: GroupState["channelTaskBlocked"];
  roomHandoffProblem: GroupState["roomHandoffProblem"];
  publicGroupState: GroupState["publicGroupState"];
  groupWithThread: GroupState["groupWithThread"];
  roomHandoffs: GroupState["roomHandoffs"];
  DEFAULT_PAGE: GroupState["DEFAULT_PAGE"];
  pageSize: GroupState["pageSize"];
  messagePage: GroupState["messagePage"];
  messageWindow: GroupState["messageWindow"];
  startGroupTurn: GroupState["startGroupTurn"];
  drainQueuedChannelSends: GroupState["drainQueuedChannelSends"];
  cancelTeamSetupResumesForThread: GroupState["cancelTeamSetupResumesForThread"];
  resolveReplyTarget: CalendarRooms["resolveReplyTarget"];
  lastHumanRoomMessageAt: CalendarRooms["lastHumanRoomMessageAt"];
  roomPostEligibility: CalendarRooms["roomPostEligibility"];
  maybeResumeConnectors: GroupState["maybeResumeConnectors"];
  connectorThread: GroupState["connectorThread"];
  connectorMessage: GroupState["connectorMessage"];
  secretMessage: GroupState["secretMessage"];
  resumeSecretCard: GroupState["resumeSecretCard"];
  localVmPayload: GroupState["localVmPayload"];
  existingPerBotLocalVmCount: GroupState["existingPerBotLocalVmCount"];
  perBotLocalVmCountForModeChange: GroupState["perBotLocalVmCountForModeChange"];
  roomPostBudgets: GroupState["roomPostBudgets"];
  approvalBus: CalendarRooms["approvalBus"];
  ensureCalendarCallRoom: CalendarRooms["ensureCalendarCallRoom"];
  commsBus: RoutineLifecycle["commsBus"];
  routineRequests: RoutineLifecycle["routineRequests"];
  routineTimeZone: RoutineLifecycle["routineTimeZone"];
  agentRoutine: RoutineLifecycle["agentRoutine"];
  resolveAndSendRoutine: RoutineLifecycle["resolveAndSendRoutine"];
  delegationWatch: DelegationWatch["delegationWatch"];
  activeRoutineRunForThread: DelegationWatch["activeRoutineRunForThread"];
  settleDirectFollowup: DelegationWatch["settleDirectFollowup"];
  drainDelegationWakes: DelegationWatch["drainDelegationWakes"];
  appendSkillRequestCard: SkillLifecycle["appendSkillRequestCard"];
  proposalPersistence: SkillLifecycle["proposalPersistence"];
  skillProposalPersistence: SkillLifecycle["skillProposalPersistence"];
  stagedSkillListing: SkillLifecycle["stagedSkillListing"];
  stagedSkillCleanupsForThread: SkillLifecycle["stagedSkillCleanupsForThread"];
  rejectDeletedThreadSkillStages: SkillLifecycle["rejectDeletedThreadSkillStages"];
  resolveSkillRequest: SkillLifecycle["resolveSkillRequest"];
  sendSkillResolution: SkillLifecycle["sendSkillResolution"];
  phoneSecretSubmissions: TurnSecrets["phoneSecretSubmissions"];
  phoneSecretSubmissionKey: TurnSecrets["phoneSecretSubmissionKey"];
  currentSecretState: TurnSecrets["currentSecretState"];
  provideSecretFromPhone: TurnSecrets["provideSecretFromPhone"];
  credentialDesktopHandoff: TurnSecrets["credentialDesktopHandoff"];
  wireBot: BotViews["wireBot"];
  wireTask: BotViews["wireTask"];
  publicBot: BotViews["publicBot"];
  publicBotQueuedMessages: BotViews["publicBotQueuedMessages"];
  storedAvatarExists: BotViews["storedAvatarExists"];
  previewSystemPrompt: BotViews["previewSystemPrompt"];
  botOverview: BotViews["botOverview"];
  delegatedFullAccess: BotViews["delegatedFullAccess"];
  fullAccessForSource: BotViews["fullAccessForSource"];
  grantDelegatedFullAccess: BotViews["grantDelegatedFullAccess"];
  peerReviewRequired: BotViews["peerReviewRequired"];
  checkedModelSelection: CheckedInputs["checkedModelSelection"];
  checkedTaskModelSwitch: CheckedInputs["checkedTaskModelSwitch"];
  configStatus: ConfigViews["configStatus"];
  configForAccess: ConfigViews["configForAccess"];
  mcpServerResponse: ConfigViews["mcpServerResponse"];
  mcpServerBody: ConfigViews["mcpServerBody"];
  persistMcpServers: ConfigViews["persistMcpServers"];
  describeInstances: ConfigViews["describeInstances"];
  handoffs: ReturnType<typeof createDelegationWatch>["handoffs"];
  authorizedInternalCapability: PeerAgentComms["authorizedInternalCapability"];
  internalCapabilityIsActive: PeerAgentComms["internalCapabilityIsActive"];
  createSidebarSectionSchema: PeerAgentComms["createSidebarSectionSchema"];
  createGroupTaskRequestSchema: PeerAgentComms["createGroupTaskRequestSchema"];
  LAZY_VM_CLAIM_GRACE_MS: number;
  startTurn: TurnDispatch["startTurn"];
  startOrQueueDirectMessage: TurnDispatch["startOrQueueDirectMessage"];
  startOrQueueOpenedThread: TurnDispatch["startOrQueueOpenedThread"];
  drainQueuedSends: TurnDispatch["drainQueuedSends"];
  profileRequests: TeamSetupLifecycle["profileRequests"];
  teamSetupTeams: TeamSetupLifecycle["teamSetupTeams"];
  teamSetupRequests: TeamSetupLifecycle["teamSetupRequests"];
  resolveAndSendTeamSetup: TeamSetupLifecycle["resolveAndSendTeamSetup"];
  resolveAndSendProfile: TeamSetupLifecycle["resolveAndSendProfile"];
  deleteBotWithLifecycle: BotLifecycle["deleteBotWithLifecycle"];
  drainConnectorResumes: GroupState["drainConnectorResumes"];
  drainSecretResumes: GroupState["drainSecretResumes"];
  drainTeamSetupResumes: GroupState["drainTeamSetupResumes"];
}

export function createRouteHandlers(deps: RouteWiringDeps) {
  const {
  DATA_DIR, PORT, SESSION_COOKIE, DESKTOP_MANAGED,
  HOSTED_WORKSPACE, STATIC_DIR, MAX_WORKSPACE_BOTS, MAX_COMMS_DEPTH,
  ASK_BOT_TIMEOUT_MS, MAX_THREADS_OPENED_PER_TURN, ROOM_POST_MAX_CHARS, LOCAL_VM_IDLE_MS,
  LAZY_VM_CLAIM_GRACE_MS, handoffs,
  sessions, store, cfg, registry,
  workspaceRestore, workspaceMaintenance, sharedComputers, sharedComputerControl,
  providerFleet, providerAuthSessions, persistProviderInstance, reloadProviders,
  providerInstancesChanging, personAskAt, directTurnGenerationByThread, webhooks,
  emailSignIn, customDomainVerifier, serveStatic, publicUrl,
  customDomainStatus, webhookIngressStatus, noteTurnTrigger, messageSender, browserCleanup,
  groupIsWorking, threadBusy, routines, calendarCalls,
  desktopMutationToken, companionMutationToken, workspaceAccess, providerConfigBusy,
  localVmImageBusy, localVmModeChangeBusy, localVmProvisionBusy, browserEngineInstall,
  browserEngineInstallError, computerControl, browserRuntime, browserLive,
  browserIntegration, currentBrowserSession, controlLeaseIdSchema, forgetTemporaryBrowser,
  cancelDirectTurnDispatch, localVmLifecycleBusy, localVmActiveThreads, boxLifecycleBusyBots,
  vpsPreviewRequests, orphanBoxLifecycleBusyIds, computerProviderConfigTransitions, checkpointRestoreLeases,
  teamComputerInUse, botHasActiveTurn, botComputerControlSnapshot, inheritedTeamComputer,
  computerPreviewBot, computerPreviewSurface, botComputerControlKey, selectableComputers,
  localVmOwnerBusy, localVmLeaseFor, localVmIdleFor, localVmTargetForBot,
  localVmInventoryPayload, teamComputers, teamComputersPayload, managedBoxOwners,
  claimTeamComputerLifecycle, claimBotComputerLifecycle, claimBoxInventoryRequest, claimManagedBoxMutation,
  claimManagedVpsMutation, assertTeamControlCanBeTaken, assertTeamComputerChangeIdle, providerOperationConflict,
  providerTransitionMessage, activeVpsThreads, autoVmClaims, interruptAllDirectThreads,
  interruptDirectThread, runningTurnInstance, askBotAndWait, sendSequencer,
  activeGroupTurnForBot, cancelGroupTurnOperations, broadcast, notify,
  groupSpeakers, lastReply, watchdog, clearUnattended,
  isUnattended, createChannel, updateChannel, channelTaskBlocked,
  roomHandoffProblem, publicGroupState, groupWithThread, roomHandoffs,
  DEFAULT_PAGE, pageSize, messagePage, messageWindow,
  startGroupTurn, drainQueuedChannelSends, cancelTeamSetupResumesForThread, resolveReplyTarget,
  lastHumanRoomMessageAt, roomPostEligibility, maybeResumeConnectors, connectorThread,
  connectorMessage, secretMessage, resumeSecretCard, localVmPayload,
  existingPerBotLocalVmCount, perBotLocalVmCountForModeChange, roomPostBudgets, approvalBus,
  ensureCalendarCallRoom, commsBus, routineRequests, routineTimeZone,
  agentRoutine, resolveAndSendRoutine, delegationWatch, activeRoutineRunForThread,
  settleDirectFollowup, drainDelegationWakes, appendSkillRequestCard, proposalPersistence,
  skillProposalPersistence, stagedSkillListing, stagedSkillCleanupsForThread, rejectDeletedThreadSkillStages,
  resolveSkillRequest, sendSkillResolution, phoneSecretSubmissions, phoneSecretSubmissionKey,
  currentSecretState, provideSecretFromPhone, credentialDesktopHandoff, wireBot,
  wireTask, publicBot, publicBotQueuedMessages, storedAvatarExists,
  previewSystemPrompt, botOverview, delegatedFullAccess, fullAccessForSource,
  grantDelegatedFullAccess, peerReviewRequired, checkedModelSelection, checkedTaskModelSwitch,
  configStatus, configForAccess, mcpServerResponse, mcpServerBody,
  persistMcpServers, describeInstances, authorizedInternalCapability, internalCapabilityIsActive,
  createSidebarSectionSchema, createGroupTaskRequestSchema, startTurn, startOrQueueDirectMessage,
  startOrQueueOpenedThread, drainQueuedSends, profileRequests, teamSetupTeams,
  teamSetupRequests, resolveAndSendTeamSetup, resolveAndSendProfile, deleteBotWithLifecycle,
  drainConnectorResumes, drainSecretResumes, drainTeamSetupResumes,
  } = deps;

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
      loopbackMutationToken: desktopMutationToken(), companionMutationToken: companionMutationToken(),
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
    idle: () => !providerFleet.providerFleetReloading && !providerAuthSessions.active && !browserEngineInstall.get() &&
      !routines()?.isTicking && !calendarCalls()?.isTicking &&
      !localVmImageBusy.get() && !localVmProvisionBusy.get() && !localVmModeChangeBusy.get() &&
      !localVmLifecycleBusy.size && !boxLifecycleBusyBots.size && !vpsPreviewRequests.size && !orphanBoxLifecycleBusyIds.size &&
      !computerProviderConfigTransitions.size && !checkpointRestoreLeases.size &&
      teamComputers.list().every(computer => !teamComputerInUse(computer)) &&
      store.bots.every((bot) => !botHasActiveTurn(bot.id) && !routines()?.activeRunForBot(bot.id) && !botComputerControlSnapshot(bot.id).held) &&
      store.groups.every((group) => !groupIsWorking(group)),
    pause: () => { routines()?.stop(); calendarCalls()?.stop(); watchdog.stop(); },
    resume: () => { routines()?.start(); calendarCalls()?.start(); watchdog.start(); },
    flush: async () => {
      await Promise.all([flushAllProfileHistory(), flushAllMemoryJournals(), flushUsageLedger(DATA_DIR), flushDecisionLog(DATA_DIR)]);
      // With writers gated and work idle, release our WAL connection for the
      // consistent snapshot. Store reopens it lazily after maintenance.
      closeMessageDb();
    },
  }, keepLocked),
});

const routinesRoutes = createRoutinesRoutes({ routines: () => routines()! });

// The /api/internal family: everything a spawned proxy reaches over
// localhost with its per-turn capability (see ./routes/internal.ts).
const internalRoutes = createInternalRoutes({
  store, cfg, registry, sharedComputers, computerControl, browserRuntime, commsBus, approvalBus,
  roomHandoffs, routineRequests, profileRequests, teamSetupRequests, routines,
  computerSelectionTurns, delegationWatch, turnComputerResources, autoVmClaims, personAskAt, roomPostBudgets,
  ASK_BOT_TIMEOUT_MS, MAX_COMMS_DEPTH, MAX_THREADS_OPENED_PER_TURN, MAX_WORKSPACE_BOTS, ROOM_POST_MAX_CHARS,
  askBotAndWait, agentRoutine, appendSkillRequestCard, botComputerControlSnapshot, startOrQueueOpenedThread,
  selectableComputers, computerPreviewSurface, browserIntegration, currentBrowserSession, createChannel, updateChannel,
  activeGroupTurnForBot, activeRoutineRunForThread, credentialDesktopHandoff, lastHumanRoomMessageAt,
  maybeResumeConnectors, notify, proposalPersistence, skillProposalPersistence, roomHandoffProblem,
  roomPostEligibility, routineTimeZone, stagedSkillListing, teamSetupTeams, threadBusy,
  authorizedInternalCapability, internalCapabilityIsActive, claimTurnResource, connectorThread,
  delegatedFullAccess, fullAccessForSource, grantDelegatedFullAccess, isUnattended, peerReviewRequired,
  LAZY_VM_CLAIM_GRACE_MS, startTurn,
});

// Route groups extracted from handleRequest's dispatch chain below; wired
// here, after the index.ts-local collaborators they close over exist.
const handleCalendarCalls = createCalendarCallRoutes({
  calendarCalls: () => calendarCalls()!,
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
  providerConfigBusy,
  providerAuthSessions,
  sessions,
  describeInstances,
  persistProviderInstance,
  providerInstancesChanging,
  activeGroupTurnForBot,
  configStatus,
  broadcast,
});
const handleMcp = createMcpRoutes({ sessions, mcpServerResponse, mcpServerBody, persistMcpServers });
const handleUsage = createUsageRoutes();
const handleConfig = createConfigRoutes({
  providerConfigBusy,
  localVmModeChangeBusy,
  localVmImageBusy: () => localVmImageBusy.get(),
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
  routines,
});
const handleBots = createBotRoutes({
  routines,
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
  routines,
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
  handoffs,
  routines,
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
  interruptDirectThread,
  cancelDirectTurnDispatch,
  activeGroupTurnForBot,
  cancelGroupTurnOperations,
  runningTurnInstance,
});
const handleBotTasks = createBotTasksRoutes({
  routines,
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
  workspaceAccess,
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
  routines,
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
  localVmImageBusy,
  localVmModeChangeBusy: () => localVmModeChangeBusy.get(),
  localVmProvisionBusy,
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
  browserEngineInstall,
  browserEngineInstallError,
  broadcast,
  configStatus,
});

const handleBrowserLive = createBrowserLiveRoutes({
  store,
  readBody,
  browserLive,
  browserIntegration,
  currentBrowserSession,
  sessions,
  HOSTED_WORKSPACE,
  workspaceAccess,
});

const handleFleet = createFleetRoutes({
  entitled,
  fleetSocketPath,
  fleetAvailable,
  fleetRequest,
  readBody,
});

  return {
    workspaceBackupRoutes, routinesRoutes, internalRoutes, handleCalendarCalls, handleMessages,
    handleInstances, handleMcp, handleUsage, handleConfig, handleTts, handleConnectors, handleWebhooks,
    handleTeams, handleBots, handleBotManagement, handleBotThreadOps, handleBotTasks, handleBotProfile,
    handleBotMemory, handlePreAuth, handleAuthSession, handleWorkspaceComms, handleComputers, handleBotCards,
    handleBotComputer, handleSystem, handleBrowserLive, handleFleet,
  };
}

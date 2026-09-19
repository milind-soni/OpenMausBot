// The turn engine's core, extracted verbatim from index.ts: admission,
// provider session setup, dispatch and completion settlement for direct
// (1:1) turns. index.ts wires this factory at the old startTurn
// declaration site; every call site there is unchanged.
//
// The turn body is decomposed into the named phase functions in
// ./start-turn/phases.ts; this file keeps the deps wiring and the exact
// sequence in which the phases run. Everything before the dispatch task
// is synchronous, exactly as it was inline: the busy flip and claim
// registration still happen before startTurn returns.
import * as checkpoints from "./checkpoints.ts";
import { type AppConfig } from "./config.ts";
import { type BotRecord, type GroupRecord, type Message, type Store } from "./store.ts";
import { containerComputerStatus, type LocalVmTarget } from "./container-computer.ts";
import type { TurnOwner, TurnResources } from "./turn-resources.ts";
import type { BundledSkill } from "./skill-library.ts";
import type { Notification } from "./notify.ts";
import type { RoutineManager, RoutineRun, RoutineRunOn, RoutineRunTrigger } from "./routines.ts";
import type { RoomHandoffs, RoomHandoff } from "./room-handoffs.ts";
import type { Handoffs } from "./delta-context.ts";
import type { IncidentKind } from "./incidents.ts";
import type { TurnWatchdog } from "./turn-watchdog.ts";
import type { DelegationWakeBudget } from "./delegations.ts";
import type { LocalVmLease } from "./local-vm-lease.ts";
import type { LocalVmIdleTimer } from "./local-vm-idle.ts";
import type { ProviderInstance } from "./contracts.ts";
import type { AutoVmClaimTable } from "./auto-vm-claims.ts";
import type { TeamComputerRecord } from "./team-computers.ts";
import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { ScreenCapture } from "./screen-frame-source.ts";
import type { BrowserRuntime } from "./browser-runtime.ts";
import type { PendingTurnCancellations, ProviderTurnGenerationRegistry } from "./turn-dispatch-guard.ts";
import type { SurfacePlan } from "./surface.ts";
import {
  admitDirectTurn,
  assembleTurnContext,
  assembleTurnIntegrations,
  bindUserMessage,
  buildCoordinationPrompts,
  buildTurnSystemPrompt,
  claimDirectTurn,
  dispatchProviderTurn,
  prepareTurnDispatch,
  resolveTurnProvider,
  settleDispatchFailure,
} from "./start-turn/phases.ts";

/** The settled-turn receipt the direct-followup machinery hands back. */
type DirectTurnOutcome = { ok: boolean; text: string };

type LocalVmTurnStatus = Awaited<ReturnType<typeof containerComputerStatus>>;

export interface StartTurnDeps {
  runtime: {
    store: Store;
    cfg: AppConfig;
    workspaceMaintenance: { assertAvailable(): void };
  };
  events: {
    broadcast(payload: Record<string, unknown>): void;
    notify(notification: Notification | null): void;
    watchdog: TurnWatchdog;
  };
  admission: {
    activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
    providerTransitionForTurn(bot: NonNullable<ReturnType<Store["bot"]>>, runOn?: RoutineRunOn, threadId?: string): string | null;
    turnSurfacePlan(bot: BotRecord, runOn?: RoutineRunOn, threadId?: string): SurfacePlan;
    turnProvider(bot: BotRecord, runOn?: RoutineRunOn, threadId?: string): "box" | "vps" | null;
    turnInstance(bot: BotRecord, runOn?: RoutineRunOn, threadId?: string): ProviderInstance | null;
    /** Thunks: the fleet is wired after this factory in index.ts. */
    providerFleet(): { providerFleetReloading: boolean };
    providerInstancesChanging(): Set<string>;
    checkpointRestoreLeases: Set<string>;
    boxLifecycleBusyBots: Set<string>;
    maxCommsDepth: number;
    isExternalContextMarker(value: string | undefined): boolean;
  };
  dispatch: {
    directTurnGenerationByThread: Map<string, string>;
    directFollowupTurns: ProviderTurnGenerationRegistry<DirectTurnOutcome>;
    directFollowupSettlers: Map<string, { threadId: string; settle?(): void }>;
    directCoordinationSettlers: Map<string, (outcome: DirectTurnOutcome) => void>;
    settleDirectCoordination(generation: string | undefined, outcome: DirectTurnOutcome): void;
    settleDirectFollowup(generation: string | undefined): void;
    directTurnClaimExists(botId: string, claimId: string, threadId: string): boolean;
    directTurnClaimIsCurrent(botId: string, claimId: string, threadId: string): boolean;
    markDirectTurnDispatching(botId: string, claimId: string, threadId: string): boolean;
    clearDirectTurnDispatch(threadId: string, claimId: string): void;
    pendingCancelledProviderHandshakes: PendingTurnCancellations;
    clearCancelledProviderHandshake(threadId: string, ownerId: string): void;
    retireProviderTurn(turnId: string): void;
    runningTurnEngines: Map<string, ProviderInstance>;
    DirectTurnSetupCancelled: new (message?: string) => Error;
  };
  fold: {
    turnUsage: Map<string, { input: number; output: number; cachedInput?: number }>;
    turnContext: Map<string, { tokens?: number; window?: number }>;
    personAskAt: Map<string, number>;
    retryDelegationsWaitingOn(botId: string): void;
    drains: {
      drainQueuedSends(): void;
      drainConnectorResumes(): void;
      drainSecretResumes(): void;
      drainTeamSetupResumes(): void;
      drainDelegationWakes(): void;
    };
  };
  cleanup: {
    releaseTurnResources(owner: TurnOwner | undefined): void;
    settlingResourceOwners: Map<string, string>;
    autoVmClaims: AutoVmClaimTable;
    releaseLocalVmThread(threadId: string): void;
    startScreenPoller(botId: string, threadId: string, captures: { computer?: ScreenCapture; browser?: ScreenCapture }, options?: { screenIsTheWork?: boolean }): void;
    stopScreenPoller(botId: string, threadId?: string): void;
    screenPollers: ReadonlyMap<string, { touched: boolean }>;
    turnResources: TurnResources;
    turnComputerResources: Map<string, { owner: TurnOwner; resource: string }>;
  };
  turnMarks: {
    markUnattended(botId: string, threadId: string): void;
    clearUnattended(threadId: string): void;
    markInternalTurn(threadId: string): void;
    clearInternalTurn(threadId: string): void;
    delegationWakeBudget: DelegationWakeBudget;
  };
  routines: {
    /** Thunk: index.ts assigns the RoutineManager after this factory runs. */
    routines(): RoutineManager | null;
    activeRoutineRunForThread(threadId: string): RoutineRun | null;
  };
  localVm: {
    localVmTargetForBot(botId: string): LocalVmTarget;
    localVmLeaseFor(target: LocalVmTarget): LocalVmLease;
    localVmIdleFor(target: LocalVmTarget): LocalVmIdleTimer;
    localVmThreadTargets: Map<string, LocalVmTarget>;
    localVmActiveThreads: Map<string, string>;
    localVmLifecycleBusy: Set<string>;
    localVmSeen: Set<string>;
    localVmOwnerBusy(botId: string): boolean;
    /** Thunks: these are mutable lets in index.ts, read at turn time. */
    localVmImageBusy(): boolean;
    localVmModeChangeBusy(): boolean;
    readyLocalVmForTurn(botId: string, target: LocalVmTarget): Promise<LocalVmTurnStatus>;
  };
  computers: {
    bindTurnComputer(owner: TurnOwner, resource: string, exclusive?: boolean): Promise<void>;
    attachTeamBox(computer: TeamComputerRecord, botId: string, owner: TurnOwner, canMount: boolean, remoteAgent: boolean): Promise<{
      integration: { kind: "box"; boxId: string; token: string; control: { url: string; token: string } };
      capture(): Promise<{ png: string; format: string }>;
    }>;
    controlIntegration(botId: string, threadId: string, generation: string): { url: string; token: string };
    browserRuntime: BrowserRuntime;
    browserIntegration(botId: string, profile: string | undefined, turn?: { threadId: string; generation: string }): Promise<{
      profile: string;
      session: string;
      spec: { command: string; args: string[]; env: Record<string, string> };
      integration: { command: string; args: string[]; env: Record<string, string> };
    } | null>;
    phoneIntegration(): { command: string; args: string[]; env: Record<string, string> };
    connectedAppsIntegration(botId: string, threadId: string, generation: string): Promise<{ command: string; args: string[]; env: Record<string, string> } | null>;
    agentsIntegration(botId: string, threadId: string, depth: number, skillAuthoring: boolean, generation: string, roomHandoffId?: string, roomCoordination?: boolean, ownThreadCreation?: boolean): { command: string; args: string[]; env: Record<string, string> };
    vpsThreadStarted(botId: string, threadId: string): void;
    vpsThreadEnded(botId: string, threadId: string): void;
  };
  prompts: {
    approvalModeForTurn(bot: BotRecord, peerInitiated?: boolean): ApprovalMode;
    roomHandoffProblem(node: Pick<RoomHandoff, "groupId" | "threadId" | "botId"> & Partial<Pick<RoomHandoff, "kind">>, parent?: Pick<RoomHandoff, "groupId" | "threadId" | "botId">): string | undefined;
    coordinationSystemInstructions(): string;
    outstandingAssignmentsPrompt(threadId: string): string;
    teamComputerPrompt(computer: TeamComputerRecord | undefined): string;
    inheritedTeamComputer(bot: Pick<BotRecord, "section" | "computer" | "cloudBackend">): TeamComputerRecord | undefined;
    teammateReportContext(requestId: string, readerBotId?: string): string;
    availableSkills(): BundledSkill[];
  };
  handoffs: { roomHandoffs: RoomHandoffs; turnHandoffs: Handoffs };
  titles: {
    generateThreadTitle(provider: { generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string> }, text: string): Promise<string | null>;
  };
  incidents: {
    reportIncident(input: { kind: IncidentKind; bot: BotRecord; threadId: string; detail: string }): void;
  };
}

/** Options for one direct turn; see startTurn. */
export type StartTurnOptions = {
  commsDepth?: number;
  userMessage?: Message;
  /** Admission must succeed before editing the active transcript branch. */
  editedMessageId?: string;
  /** The person who sent this, when not the desktop owner. */
  sender?: { name: string };
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
  /** Bot delivery (including self-opened jobs): whose words this line carries,
   * recorded on the message itself (Message.peerAsk). */
  peerAsk?: Message["peerAsk"];
  /** Resume an agent after the user completed an inline connection or credential card.
   * The prompt is control-plane context: it reaches the provider without
   * masquerading as another message authored by the user. */
  cardContinuation?: boolean;
  /** A single tool-requested surface change continues the same human ask. */
  computerSelectionContinuation?: boolean;
  /** Earlier text message this user turn is replying to. */
  replyTo?: Message;
  /** Stable identity supplied by the composer so a network retry cannot
   * dispatch the same user action twice. */
  sendId?: string;
  onDispatchError?: (message: string) => void;
  /** Queue receipts outlive the dispatch acknowledgment until this exact turn settles. */
  onTurnSettled?: () => void;
  coordination?: { id: string; resumed: boolean; settle: (outcome: { ok: boolean; text: string }) => void };
};

export function createStartTurn(deps: StartTurnDeps) {
  const {
    runtime: { store, cfg, workspaceMaintenance },
    events: { broadcast, notify, watchdog },
    admission: {
      activeGroupTurnForBot, providerTransitionForTurn, turnSurfacePlan, turnProvider, turnInstance,
      providerFleet, providerInstancesChanging, checkpointRestoreLeases, boxLifecycleBusyBots,
      maxCommsDepth: MAX_COMMS_DEPTH, isExternalContextMarker,
    },
    dispatch: {
      directTurnGenerationByThread, directFollowupTurns, directFollowupSettlers, directCoordinationSettlers,
      settleDirectCoordination, settleDirectFollowup, directTurnClaimExists, directTurnClaimIsCurrent,
      markDirectTurnDispatching, clearDirectTurnDispatch, pendingCancelledProviderHandshakes,
      clearCancelledProviderHandshake, retireProviderTurn, runningTurnEngines, DirectTurnSetupCancelled,
    },
    fold: {
      turnUsage, turnContext, personAskAt, retryDelegationsWaitingOn,
      drains: { drainQueuedSends, drainConnectorResumes, drainSecretResumes, drainTeamSetupResumes, drainDelegationWakes },
    },
    cleanup: { releaseTurnResources, settlingResourceOwners, autoVmClaims, releaseLocalVmThread, startScreenPoller, stopScreenPoller, screenPollers, turnResources, turnComputerResources },
    turnMarks: { markUnattended, clearUnattended, markInternalTurn, clearInternalTurn, delegationWakeBudget },
    routines: { routines, activeRoutineRunForThread },
    localVm: {
      localVmTargetForBot, localVmLeaseFor, localVmIdleFor, localVmThreadTargets, localVmActiveThreads,
      localVmLifecycleBusy, localVmSeen, localVmOwnerBusy, localVmImageBusy, localVmModeChangeBusy,
      readyLocalVmForTurn,
    },
    computers: {
      bindTurnComputer, attachTeamBox, controlIntegration, browserRuntime, browserIntegration,
      phoneIntegration, connectedAppsIntegration, agentsIntegration, vpsThreadStarted, vpsThreadEnded,
    },
    prompts: {
      approvalModeForTurn, roomHandoffProblem, coordinationSystemInstructions, outstandingAssignmentsPrompt,
      teamComputerPrompt, inheritedTeamComputer, teammateReportContext, availableSkills,
    },
    handoffs: { roomHandoffs, turnHandoffs: handoffs },
    titles: { generateThreadTitle },
    incidents: { reportIncident },
  } = deps;
  async function startTurn(
    botId: string,
    text: string,
    opts?: StartTurnOptions,
  ) {
    const admitted = admitDirectTurn({
      botId,
      opts,
      store,
      cfg,
      workspaceMaintenance,
      activeGroupTurnForBot,
      providerTransitionForTurn,
      providerFleet,
      checkpointRestoreLeases,
      boxLifecycleBusyBots,
      routines,
      activeRoutineRunForThread,
      markUnattended,
      clearUnattended,
      delegationWakeBudget,
    });
    opts = admitted.opts;
    const { threadId, bot, task, boundedCoordination } = admitted;
    const { plan, instance, providerText, turnImages, commsDepth, instanceId, model, effort, variant } =
      resolveTurnProvider({
        botId,
        text,
        opts,
        bot,
        threadId,
        store,
        cfg,
        generateThreadTitle,
        turnSurfacePlan,
        turnProvider,
        turnInstance,
        providerInstancesChanging,
        markInternalTurn,
        clearInternalTurn,
      });
    const userMessage = bindUserMessage({ text, opts, bot, task, threadId, commsDepth, store, personAskAt });
    const {
      transcript, rewound, externalContextMarker, agentsMounted, skillAuthoring,
      dispatchContext, decideContext, strictResume, plannedConfig, sessionConfig, persona,
    } = assembleTurnContext({
      opts,
      bot,
      task,
      threadId,
      instance,
      instanceId,
      commsDepth,
      model,
      effort,
      providerText,
      userMessage,
      store,
      cfg,
      roomHandoffs,
      teammateReportContext,
      isExternalContextMarker,
      maxCommsDepth: MAX_COMMS_DEPTH,
    });
    const { dispatchClaimId, resourceOwner } = claimDirectTurn({
      botId,
      text,
      opts,
      bot,
      threadId,
      commsDepth,
      userMessage,
      agentsMounted,
      handoffs,
      dispatchContext,
      store,
      directTurnGenerationByThread,
      directFollowupSettlers,
      directCoordinationSettlers,
      turnUsage,
      turnContext,
      inheritedTeamComputer,
    });

    void (async () => {
      try {
        const browserCaptureRef: { current: (() => Promise<{ png: string; format: string }>) | null } = { current: null };
        const {
          integrations, previewCapture, computerKind, worksInWorkspace, privateWorkspace,
          skillInstructions, packagePlaybooks, cwd, checkpointCwd, teamComputer,
        } = await assembleTurnIntegrations({
          bot,
          opts,
          threadId,
          plan,
          instance,
          providerText,
          skillAuthoring,
          dispatchClaimId,
          resourceOwner,
          store,
          cfg,
          broadcast,
          availableSkills,
          phoneIntegration,
          connectedAppsIntegration,
          bindTurnComputer,
          attachTeamBox,
          controlIntegration,
          vpsThreadStarted,
          vpsThreadEnded,
          turnResources,
          turnComputerResources,
          stopScreenPoller,
          screenPollers,
          startScreenPoller,
          browserCaptureRef,
          inheritedTeamComputer,
          autoVmClaims,
          releaseLocalVmThread,
          localVmTargetForBot,
          localVmLeaseFor,
          localVmIdleFor,
          localVmThreadTargets,
          localVmActiveThreads,
          localVmLifecycleBusy,
          localVmSeen,
          localVmOwnerBusy,
          localVmImageBusy,
          localVmModeChangeBusy,
          readyLocalVmForTurn,
        });
        const { tagged, coordinationPrompt, credentialPrompt, routinePrompt, profilePrompt, recallPrompt, learnPrompt } =
          buildCoordinationPrompts({
            bot,
            opts,
            threadId,
            userMessage,
            providerText,
      commsDepth,
      skillAuthoring,
      agentsMounted,
      boundedCoordination,
            dispatchClaimId,
            integrations,
            store,
            agentsIntegration,
          });
        // Wait immediately before dispatch: resources are already claimed, but
        // the engine cannot edit the project until the snapshot has settled.
        // snapshot() absorbs failures, so checkpointing may delay but never fail
        // a turn.
        if (checkpointCwd) await checkpoints.snapshot(bot.id, checkpointCwd, `turn ${threadId.slice(0, 8)}`);
        if (!directTurnClaimIsCurrent(bot.id, dispatchClaimId, threadId)) {
          throw new DirectTurnSetupCancelled("turn stopped before dispatch");
        }
        const { liveBot, setupMode, mountedComputer, browserCapture } = await prepareTurnDispatch({
          bot,
          opts,
          threadId,
          plan,
          instance,
          computerKind,
          teamComputer,
          integrations,
          dispatchClaimId,
          providerText,
          agentsMounted,
          store,
          cfg,
          browserIntegration,
          browserRuntime,
          pendingCancelledProviderHandshakes,
          markDirectTurnDispatching,
          DirectTurnSetupCancelled,
          watchdog,
        });
        browserCaptureRef.current = browserCapture;
        const prompt = buildTurnSystemPrompt({
          bot,
          opts,
          threadId,
          plan,
          instance,
          persona,
          liveBot,
          setupMode,
          mountedComputer,
          computerKind,
          integrations,
          cwd,
          worksInWorkspace,
          privateWorkspace,
          skillInstructions,
          packagePlaybooks,
          teamComputer,
          skillAuthoring,
          boundedCoordination,
          tagged,
          coordinationPrompt,
          credentialPrompt,
          routinePrompt,
          profilePrompt,
          recallPrompt,
          learnPrompt,
          store,
          cfg,
          roomHandoffs,
          roomHandoffProblem,
          coordinationSystemInstructions,
          outstandingAssignmentsPrompt,
          teamComputerPrompt,
          DirectTurnSetupCancelled,
        });
        await dispatchProviderTurn({
          bot,
          threadId,
          instance,
          instanceId,
          turnImages,
          commsDepth,
          model,
          effort,
          variant,
          dispatchContext,
          decideContext,
          strictResume,
          plannedConfig,
          sessionConfig,
          liveBot,
          handoffs,
          transcript,
          prompt,
          integrations,
          cwd,
          dispatchClaimId,
          resourceOwner,
          rewound,
          task,
          externalContextMarker,
          isExternalContextMarker,
          previewCapture,
          browserCapture,
          store,
          cfg,
          runningTurnEngines,
          directTurnGenerationByThread,
          directFollowupSettlers,
          directFollowupTurns,
          settleDirectCoordination,
          settleDirectFollowup,
          directTurnClaimExists,
          clearDirectTurnDispatch,
          retireProviderTurn,
          DirectTurnSetupCancelled,
          approvalModeForTurn,
          retryDelegationsWaitingOn,
          drainQueuedSends,
          drainConnectorResumes,
          drainSecretResumes,
          drainTeamSetupResumes,
          drainDelegationWakes,
          releaseTurnResources,
          settlingResourceOwners,
          startScreenPoller,
        });
      } catch (e) {
        settleDispatchFailure({
          error: e,
          bot,
          opts,
          threadId,
          dispatchClaimId,
          resourceOwner,
          store,
          notify,
          watchdog,
          directTurnGenerationByThread,
          settleDirectFollowup,
          clearDirectTurnDispatch,
          clearCancelledProviderHandshake,
          DirectTurnSetupCancelled,
          turnUsage,
          turnContext,
          retryDelegationsWaitingOn,
          drainQueuedSends,
          drainConnectorResumes,
          drainSecretResumes,
          drainTeamSetupResumes,
          drainDelegationWakes,
          releaseTurnResources,
          releaseLocalVmThread,
          vpsThreadEnded,
          handoffs,
          reportIncident,
        });
      }
    })();
    return userMessage;
  }
  return { startTurn };
}

export type StartTurn = ReturnType<typeof createStartTurn>;

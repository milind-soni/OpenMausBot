// The group/room turn engine — extracted verbatim from index.ts: the room
// responder loop (one speaker at a time, chained @mentions one hop deep),
// the goal coordinator/worker ladder, queued-channel-send draining, and the
// room post budget map. index.ts wires createGroupTurn just before the
// roomHandoffs construction (the earliest module-level consumer of
// runGroupMemberTurn); every dep named below that index.ts declares after
// that wiring site is passed as a thunk and called as dep().// This file is now the composition root: it keeps the GroupTurnDeps
// interface and createGroupTurn, and the moved bodies live in the
// ./group-turn/ family modules (room-context, member-turn, goal-run,
// start), each taking an explicit ctx of the deps its family reads.
import { containerComputerStatus, type LocalVmTarget } from "./container-computer.ts";
import { createGoalRun } from "./group-turn/goal-run.ts";
import { createMemberTurn } from "./group-turn/member-turn.ts";
import { createRoomContext, roomPostBudgets } from "./group-turn/room-context.ts";
import { createStartGroupTurn } from "./group-turn/start.ts";
import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import type { RoutineRunOn } from "./routines.ts";
import type { GroupGoalCoordinatorTurn } from "./event-fold.ts";
import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";
import type { PendingTurnCancellations } from "./turn-dispatch-guard.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";
import type { RoomHandoff, RoomHandoffs } from "./room-handoffs.ts";
import type { TurnOwner } from "./turn-resources.ts";
import type { TurnWatchdog } from "./turn-watchdog.ts";
import type { LocalVmLease } from "./local-vm-lease.ts";
import type { LocalVmIdleTimer } from "./local-vm-idle.ts";
import type { TeamComputerRecord } from "./team-computers.ts";
import type { ScreenCapture } from "./screen-frame-source.ts";
import type { EventBus } from "./harness/bus.ts";
import type { BundledSkill } from "./skill-library.ts";
import type { RoomTurnStallRegistry } from "./room-turn-timeout.ts";
import type { GroupTurnOperation, GroupTurnOrchestration } from "./group-turn/types.ts";

export type { GroupMemberTurnOutcome, GroupTurnOperation, GroupTurnOrchestration } from "./group-turn/types.ts";

type LocalVmTurnStatus = Awaited<ReturnType<typeof containerComputerStatus>>;

/** Everything the engine reads from its host. Names declared in index.ts
 * after the wiring site arrive as thunks (the late-bound family). */
export interface GroupTurnDeps {
  events: {
    bus: EventBus;
    watchdog(): TurnWatchdog;
    roomStallCompletions(): RoomTurnStallRegistry;
    shouldIgnoreProviderEvent(event: RuntimeEvent): boolean;
    retireProviderTurn(turnId: string): void;
    markCancelledProviderHandshake(threadId: string, ownerId: string): void;
    clearCancelledProviderHandshake(threadId: string, ownerId: string): void;
    pendingCancelledProviderHandshakes: PendingTurnCancellations;
    runningTurnEngines(): Map<string, ProviderInstance>;
    DirectTurnSetupCancelled: new (message?: string) => Error;
  };
  admission: {
    providerFleet(): { providerFleetReloading: boolean };
    providerInstancesChanging(): Set<string>;
    providerTransitionForTurn(bot: BotRecord, runOn?: RoutineRunOn, threadId?: string): string | null;
    turnInstance(bot: BotRecord, runOn?: RoutineRunOn, threadId?: string): ProviderInstance | null;
    boxLifecycleBusyBots(): Set<string>;
    roomTurnApprovalMode(bot: BotRecord, orchestration?: GroupTurnOrchestration): ApprovalMode;
    MAX_COMMS_DEPTH: number;
  };
  handoffs: {
    roomHandoffs(): RoomHandoffs;
    roomHandoffProblem(node: Pick<RoomHandoff, "groupId" | "threadId" | "botId"> & Partial<Pick<RoomHandoff, "kind">>, parent?: Pick<RoomHandoff, "groupId" | "threadId" | "botId">): string | undefined;
  };
  rooms: {
    groupQueues: Map<string, Promise<void>>;
    groupSpeakers(): Map<string, { botId: string; name: string; color: string }>;
    groupIsWorking(group: GroupRecord): boolean;
    roomSetupPending(group: GroupRecord): boolean;
    resolveReplyTarget(threadId: string, value: unknown): Message | undefined;
  };
  operations: {
    beginGroupTurnOperation(groupId: string, threadId: string, botIds?: Iterable<string>): GroupTurnOperation;
    finishGroupTurnOperation(groupId: string, operation: GroupTurnOperation): void;
    finishGroupGoalRun(groupId: string, operation: GroupTurnOperation, status: Exclude<GroupGoalRunStatus, "working">, detail: string): void;
    updateGroupGoalRunProgress(operation: GroupTurnOperation, detail: string): void;
    waitForGroupMemberBot(bot: BotRecord, operation: GroupTurnOperation, onWaiting: (detail: string) => void): Promise<"ready" | "unavailable" | "cancelled" | "timed_out">;
    waitForChatRoomMember(operation: GroupTurnOperation, threadId: string, bot: BotRecord): Promise<"run" | "skip" | "stop">;
    groupProviderHandshakeStarted(operation: GroupTurnOperation): void;
    groupProviderHandshakeSettled(operation: GroupTurnOperation): void;
    hasUnboundDiscardedGroupGoalTurn(threadId: string): boolean;
  };
  goalFold: {
    groupGoalCoordinatorTurns: Map<string, Set<GroupGoalCoordinatorTurn>>;
    addGroupGoalCoordinatorTurn(threadId: string, turn: GroupGoalCoordinatorTurn): void;
    removeGroupGoalCoordinatorTurn(threadId: string, turn: GroupGoalCoordinatorTurn): void;
    GROUP_GOAL_COORDINATOR_GUARD_MS: number;
    GROUP_GOAL_WAIT_MAX_MS(): number;
    GROUP_GOAL_MAX_WAIT_EXHAUSTIONS(): number;
  };
  cleanup: {
    releaseTurnResources(owner: TurnOwner | undefined): void;
    releaseLocalVmThread(threadId: string): void;
    startScreenPoller(botId: string, threadId: string, captures: { computer?: ScreenCapture; browser?: ScreenCapture }, options?: { screenIsTheWork?: boolean }): void;
    retryDelegationsWaitingOn(botId: string): void;
    drains: {
      drainQueuedSends(): void;
      drainConnectorResumes(): void;
      drainSecretResumes(): void;
      drainTeamSetupResumes(): void;
    };
  };
  localVm: {
    localVmLeaseFor(target: LocalVmTarget): LocalVmLease;
    localVmIdleFor(target: LocalVmTarget): LocalVmIdleTimer;
    localVmThreadTargets(): Map<string, LocalVmTarget>;
    localVmActiveThreads(): Map<string, string>;
    localVmLifecycleBusy(): Set<string>;
    localVmOwnerBusy(): (botId: string) => boolean;
    localVmImageBusy(): boolean;
    localVmModeChangeBusy(): boolean;
    readyLocalVmForTurn(botId: string, target: LocalVmTarget, isCurrent?: () => boolean): Promise<LocalVmTurnStatus>;
    localVmTargetForBot(botId: string): LocalVmTarget;
  };
  computers: {
    bindTurnComputer(owner: TurnOwner, resource: string, exclusive?: boolean): Promise<void>;
    attachTeamBox(computer: TeamComputerRecord, botId: string, owner: TurnOwner, canMount: boolean, remoteAgent: boolean): Promise<{
      integration: { kind: "box"; boxId: string; token: string; control: { url: string; token: string } };
      capture(): Promise<{ png: string; format: string }>;
    }>;
    controlIntegration(botId: string, threadId: string, generation: string, localVmTarget?: LocalVmTarget): { url: string; token: string };
    browserIntegration(botId: string, profile: string | undefined, turn?: { threadId: string; generation: string }): Promise<{
      profile: string;
      session: string;
      spec: { command: string; args: string[]; env: Record<string, string> };
      integration: { command: string; args: string[]; env: Record<string, string> };
    } | null>;
    phoneIntegration(): { command: string; args: string[]; env: Record<string, string> };
    connectedAppsIntegration(botId: string, threadId: string, generation: string): Promise<{ command: string; args: string[]; env: Record<string, string> } | null>;
    agentsIntegration(botId: string, threadId: string, depth: number, skillAuthoring: boolean, generation: string, roomHandoffId?: string, roomCoordination?: boolean, ownThreadCreation?: boolean): { command: string; args: string[]; env: Record<string, string> };
    inheritedTeamComputer(bot: Pick<BotRecord, "section" | "computer" | "cloudBackend">): TeamComputerRecord | undefined;
    teamComputerPrompt(computer: TeamComputerRecord | undefined): string;
  };
  prompts: {
    availableSkills(): BundledSkill[];
  };
  queue: {
    followupsReady(): boolean;
  };
}

export function createGroupTurn(deps: GroupTurnDeps) {
  const {
    events: {
      bus, watchdog, roomStallCompletions, shouldIgnoreProviderEvent, retireProviderTurn,
      markCancelledProviderHandshake, clearCancelledProviderHandshake, pendingCancelledProviderHandshakes,
      runningTurnEngines, DirectTurnSetupCancelled,
    },
    admission: {
      providerFleet, providerInstancesChanging, providerTransitionForTurn, turnInstance,
      boxLifecycleBusyBots, roomTurnApprovalMode, MAX_COMMS_DEPTH,
    },
    handoffs: { roomHandoffs, roomHandoffProblem },
    rooms: { groupQueues, groupSpeakers, groupIsWorking, roomSetupPending, resolveReplyTarget },
    operations: {
      beginGroupTurnOperation, finishGroupTurnOperation, finishGroupGoalRun, updateGroupGoalRunProgress,
      waitForGroupMemberBot, waitForChatRoomMember, groupProviderHandshakeStarted, groupProviderHandshakeSettled,
      hasUnboundDiscardedGroupGoalTurn,
    },
    goalFold: {
      groupGoalCoordinatorTurns, addGroupGoalCoordinatorTurn, removeGroupGoalCoordinatorTurn,
      GROUP_GOAL_COORDINATOR_GUARD_MS, GROUP_GOAL_WAIT_MAX_MS, GROUP_GOAL_MAX_WAIT_EXHAUSTIONS,
    },
    cleanup: {
      releaseTurnResources, releaseLocalVmThread, startScreenPoller, retryDelegationsWaitingOn,
      drains: { drainQueuedSends, drainConnectorResumes, drainSecretResumes, drainTeamSetupResumes },
    },
    localVm: {
      localVmLeaseFor, localVmIdleFor, localVmThreadTargets, localVmActiveThreads, localVmLifecycleBusy,
      localVmOwnerBusy, localVmImageBusy, localVmModeChangeBusy, readyLocalVmForTurn,
      localVmTargetForBot,
    },
    computers: {
      bindTurnComputer, attachTeamBox, controlIntegration, browserIntegration, phoneIntegration,
      connectedAppsIntegration, agentsIntegration, inheritedTeamComputer, teamComputerPrompt,
    },
    prompts: { availableSkills },
    queue: { followupsReady },
  } = deps;

  const roomContext = createRoomContext({ roomHandoffs, roomHandoffProblem });
  const { runGroupMemberTurn } = createMemberTurn({
    bus, watchdog, roomStallCompletions, shouldIgnoreProviderEvent, retireProviderTurn,
    markCancelledProviderHandshake, clearCancelledProviderHandshake, pendingCancelledProviderHandshakes,
    runningTurnEngines, DirectTurnSetupCancelled,
    providerFleet, providerInstancesChanging, providerTransitionForTurn, turnInstance,
    boxLifecycleBusyBots, roomTurnApprovalMode, MAX_COMMS_DEPTH,
    roomHandoffs, groupSpeakers, waitForChatRoomMember, hasUnboundDiscardedGroupGoalTurn,
    releaseTurnResources, releaseLocalVmThread, startScreenPoller, retryDelegationsWaitingOn,
    drainQueuedSends, drainConnectorResumes, drainSecretResumes, drainTeamSetupResumes,
    localVmLeaseFor, localVmIdleFor, localVmThreadTargets, localVmActiveThreads, localVmLifecycleBusy,
    localVmOwnerBusy, localVmImageBusy, localVmModeChangeBusy, readyLocalVmForTurn, localVmTargetForBot,
    bindTurnComputer, attachTeamBox, controlIntegration, browserIntegration, phoneIntegration,
    connectedAppsIntegration, agentsIntegration, inheritedTeamComputer, teamComputerPrompt,
    availableSkills,
    serializeRoomContext: roomContext.serializeRoomContext,
  });
  const { runGroupGoalOperation } = createGoalRun({
    waitForGroupMemberBot, finishGroupGoalRun, updateGroupGoalRunProgress,
    groupProviderHandshakeStarted, groupProviderHandshakeSettled,
    groupGoalCoordinatorTurns, addGroupGoalCoordinatorTurn, removeGroupGoalCoordinatorTurn,
    GROUP_GOAL_COORDINATOR_GUARD_MS, GROUP_GOAL_WAIT_MAX_MS, GROUP_GOAL_MAX_WAIT_EXHAUSTIONS,
    runGroupMemberTurn,
  });
  const { startGroupTurn, drainQueuedChannelSends } = createStartGroupTurn({
    groupQueues, groupIsWorking, roomSetupPending, resolveReplyTarget,
    beginGroupTurnOperation, finishGroupTurnOperation, waitForChatRoomMember,
    groupProviderHandshakeStarted, groupProviderHandshakeSettled, followupsReady,
    runGroupMemberTurn, runGroupGoalOperation,
  });

  return {
    runGroupMemberTurn,
    teammateReportContext: roomContext.teammateReportContext,
    roomPostBudgets,
    startGroupTurn,
    drainQueuedChannelSends,
  };
}

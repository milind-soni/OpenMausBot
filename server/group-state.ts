// The group state cluster -- the channel CRUD validators, the outstanding-
// assignments prompt, the deferred-resume queues, the Local VM turn prep,
// the room/goal turn engine wiring, the room-handoff registry with the
// store-to-SSE change fold, and the message-page projection -- extracted
// verbatim from index.ts. index.ts calls createGroupState at the region's
// original site (the "group coordination" banner, just after createBotViews)
// and rebinds the names from its result; the sub-factories wired here
// (createGroupCoordination, createDeferredResumes, createLocalVmTurnPrep,
// createGroupTurn, the RoomHandoffs registry) keep their original order.
// Names index.ts declares after that site -- broadcast, watchdog, the
// provider fleet, startTurn, and the calendar-room helpers among them --
// cross as thunks resolved at call time; routines, routineWiring and
// phoneSecretSubmissions are index.ts bindings declared later, so they read
// through accessors. createGroupTurnOperations, wired further up index.ts,
// consumed the hoisted publicGroupState by value and now takes a wrapper
// thunk over the name returned here.
import { join } from "node:path";
import { RoomHandoffs } from "./room-handoffs.ts";
import { DATA_DIR } from "./config.ts";
import { store } from "./runtime.ts";
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
import { setActiveCoordinationForThread, type createBotViews } from "./bot-views.ts";
import { checkedGroupResponder, checkedMemberIds } from "./checked-inputs.ts";
import { validateBotCwd } from "./bot-cwd.ts";
import { createDeferredResumes } from "./deferred-resumes.ts";
import { createLocalVmTurnPrep } from "./local-vm-turn-prep.ts";
import { createGroupTurn } from "./group-turn.ts";
import { roomHandoffHandlers } from "./room-handoff-wiring.ts";
import {
  createGroupTurnOperations,
  groupProviderHandshakeStarted,
  updateGroupGoalRunProgress,
} from "./group-turn-operations.ts";
import { botAtThreadCapacity, threadBusy } from "./turn-admission.ts";
import type { RoutineManager } from "./routines.ts";
import type { PhoneSecretSubmissionRegistry } from "./phone-secret.ts";
import type { GroupDefaultResponder, GroupRecord, Message } from "./store.ts";
import type { WireGroup } from "../shared/wire.ts";
import type { EventBus } from "./harness/bus.ts";
import type { TurnOwner } from "./turn-resources.ts";
import type { BundledSkill } from "./skill-library.ts";
import type { createTurnIntegrations } from "./turn-integrations.ts";
import type { createComputerLifecycle } from "./computer-lifecycle.ts";
import type { createEventsPipeline } from "./events-pipeline.ts";
import type { createTurnDispatch } from "./turn-dispatch.ts";
import type { createRoutineLifecycle } from "./routine-lifecycle.ts";
import type { createScreenPollers } from "./screen-pollers.ts";
import type { createDelegationWatch } from "./delegation-watch.ts";
import type { createTurnCleanup } from "./turn-cleanup.ts";

type TurnIntegrations = ReturnType<typeof createTurnIntegrations>;
type ComputerLifecycle = ReturnType<typeof createComputerLifecycle>;
type GroupTurnOperations = ReturnType<typeof createGroupTurnOperations>;
type BotViews = ReturnType<typeof createBotViews>;
type EventsPipeline = ReturnType<typeof createEventsPipeline>;
type TurnDispatch = ReturnType<typeof createTurnDispatch>;
type RoutineLifecycle = ReturnType<typeof createRoutineLifecycle>;
type ScreenPollers = ReturnType<typeof createScreenPollers>;
type DelegationWatch = ReturnType<typeof createDelegationWatch>;
type TurnCleanup = ReturnType<typeof createTurnCleanup>;

/** Everything the group state cluster reads from its host. The helpers slice
 * arrives by value from factories wired above the region's site; the
 * lateBound slice reads index.ts state that is reassigned or declared after
 * that site, resolved at call time. */
export interface GroupStateDeps {
  helpers: {
    bus: EventBus;
    MAX_COMMS_DEPTH: number;
    DirectTurnSetupCancelled: new (message?: string) => Error;
    retireProviderTurn: TurnIntegrations["retireProviderTurn"];
    shouldIgnoreProviderEvent: TurnIntegrations["shouldIgnoreProviderEvent"];
    markCancelledProviderHandshake: TurnIntegrations["markCancelledProviderHandshake"];
    clearCancelledProviderHandshake: TurnIntegrations["clearCancelledProviderHandshake"];
    pendingCancelledProviderHandshakes: TurnIntegrations["pendingCancelledProviderHandshakes"];
    providerTransitionForTurn: ComputerLifecycle["providerTransitionForTurn"];
    turnInstance: ComputerLifecycle["turnInstance"];
    boxLifecycleBusyBots: ComputerLifecycle["boxLifecycleBusyBots"];
    localVmLeaseFor: ComputerLifecycle["localVmLeaseFor"];
    localVmIdleFor: ComputerLifecycle["localVmIdleFor"];
    localVmTargetForBot: ComputerLifecycle["localVmTargetForBot"];
    localVmThreadTargets: ComputerLifecycle["localVmThreadTargets"];
    localVmActiveThreads: ComputerLifecycle["localVmActiveThreads"];
    localVmOwnerBusy: ComputerLifecycle["localVmOwnerBusy"];
    localVmLifecycleBusy: ComputerLifecycle["localVmLifecycleBusy"];
    LOCAL_VM_IDLE_MS: ComputerLifecycle["LOCAL_VM_IDLE_MS"];
    LOCAL_VM_DESKTOP_WAIT_MS: ComputerLifecycle["LOCAL_VM_DESKTOP_WAIT_MS"];
    noteLocalVmSeen: ComputerLifecycle["noteLocalVmSeen"];
    releaseLocalVmThread: ComputerLifecycle["releaseLocalVmThread"];
    attachTeamBox: ComputerLifecycle["attachTeamBox"];
    inheritedTeamComputer: ComputerLifecycle["inheritedTeamComputer"];
    teamComputerPrompt: ComputerLifecycle["teamComputerPrompt"];
    controlIntegration: TurnIntegrations["controlIntegration"];
    browserIntegration: TurnIntegrations["browserIntegration"];
    phoneIntegration: TurnIntegrations["phoneIntegration"];
    connectedAppsIntegration: TurnIntegrations["connectedAppsIntegration"];
    runningTurnEngines: ComputerLifecycle["runningTurnEngines"];
    agentsIntegration(botId: string, threadId: string, depth: number, skillAuthoring: boolean, generation: string, roomHandoffId?: string, roomCoordination?: boolean, ownThreadCreation?: boolean): { command: string; args: string[]; env: Record<string, string> };
    beginGroupTurnOperation: GroupTurnOperations["beginGroupTurnOperation"];
    finishGroupTurnOperation: GroupTurnOperations["finishGroupTurnOperation"];
    finishGroupGoalRun: GroupTurnOperations["finishGroupGoalRun"];
    waitForGroupMemberBot: GroupTurnOperations["waitForGroupMemberBot"];
    waitForChatRoomMember: GroupTurnOperations["waitForChatRoomMember"];
    groupProviderHandshakeSettled: GroupTurnOperations["groupProviderHandshakeSettled"];
    activeGroupTurnForBot: GroupTurnOperations["activeGroupTurnForBot"];
    releaseTurnResources: TurnCleanup["releaseTurnResources"];
    interruptDirectThread: TurnCleanup["interruptDirectThread"];
    startScreenPoller: ScreenPollers["startScreenPoller"];
    roomTurnApprovalMode: BotViews["roomTurnApprovalMode"];
    fullAccessForSource: BotViews["fullAccessForSource"];
    wireBot: BotViews["wireBot"];
    publicBotQueuedMessages: BotViews["publicBotQueuedMessages"];
    availableSkills(): BundledSkill[];
    generateThreadTitle(provider: { generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string> }, text: string): Promise<string | null>;
    bindTurnComputer(owner: TurnOwner, resource: string, exclusive?: boolean): Promise<void>;
    markTaskContextExternallyUpdated: DelegationWatch["markTaskContextExternallyUpdated"];
  };
  lateBound: {
    broadcast: EventsPipeline["broadcast"];
    watchdog(): EventsPipeline["watchdog"];
    roomStallCompletions(): EventsPipeline["roomStallCompletions"];
    groupSpeakers(): EventsPipeline["groupSpeakers"];
    markInternalTurn: EventsPipeline["markInternalTurn"];
    isUnattended: EventsPipeline["isUnattended"];
    markUnattended: EventsPipeline["markUnattended"];
    GROUP_GOAL_WAIT_MAX_MS(): EventsPipeline["GROUP_GOAL_WAIT_MAX_MS"];
    GROUP_GOAL_MAX_WAIT_EXHAUSTIONS(): EventsPipeline["GROUP_GOAL_MAX_WAIT_EXHAUSTIONS"];
    providerFleet(): { providerFleetReloading: boolean };
    providerInstancesChanging(): Set<string>;
    drainQueuedSends: TurnDispatch["drainQueuedSends"];
    retryDelegationsWaitingOn: TurnDispatch["retryDelegationsWaitingOn"];
    startTurn: TurnDispatch["startTurn"];
    followupsReady(): boolean;
    localVmImageBusy(): boolean;
    localVmModeChangeBusy(): boolean;
    setLocalVmProvisionBusy(value: boolean): void;
    roomSetupPending(group: GroupRecord): boolean;
    resolveReplyTarget(threadId: string, value: unknown): Message | undefined;
    routines(): RoutineManager | null;
    routineWiring(): RoutineLifecycle["routineWiring"];
    phoneSecretSubmissions(): PhoneSecretSubmissionRegistry;
  };
}

export function createGroupState(deps: GroupStateDeps) {
  const {
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
  } = deps.helpers;
  const {
    broadcast, watchdog, roomStallCompletions, groupSpeakers,
    markInternalTurn, isUnattended, markUnattended,
    GROUP_GOAL_WAIT_MAX_MS, GROUP_GOAL_MAX_WAIT_EXHAUSTIONS,
    providerFleet, providerInstancesChanging,
    drainQueuedSends, retryDelegationsWaitingOn, startTurn,
    followupsReady, localVmImageBusy, localVmModeChangeBusy, setLocalVmProvisionBusy,
    roomSetupPending, resolveReplyTarget,
    routines, routineWiring, phoneSecretSubmissions,
  } = deps.lateBound;

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
  if (body.memberIds !== undefined && phoneSecretSubmissions().hasGroup(existing.id)) {
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
    const removedGoalLead = routines()!.listRoutines().some(
      (routine) =>
        routine.enabled &&
        routine.target === "room-goal" &&
        routine.groupId === existing.id &&
        !roster.memberIds.includes(routine.botId),
    ) || routines()!.listRuns().some(
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
    setLocalVmProvisionBusy,
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
    bus, watchdog, roomStallCompletions,
    shouldIgnoreProviderEvent, retireProviderTurn, markCancelledProviderHandshake,
    clearCancelledProviderHandshake, pendingCancelledProviderHandshakes,
    runningTurnEngines: () => runningTurnEngines, DirectTurnSetupCancelled,
  },
  admission: {
    providerFleet, providerInstancesChanging,
    providerTransitionForTurn, turnInstance, boxLifecycleBusyBots: () => boxLifecycleBusyBots,
    roomTurnApprovalMode, MAX_COMMS_DEPTH,
  },
  handoffs: { roomHandoffs: () => roomHandoffs, roomHandoffProblem },
  rooms: { groupQueues, groupSpeakers, groupIsWorking, roomSetupPending, resolveReplyTarget },
  operations: {
    beginGroupTurnOperation, finishGroupTurnOperation, finishGroupGoalRun, updateGroupGoalRunProgress,
    waitForGroupMemberBot, waitForChatRoomMember, groupProviderHandshakeStarted, groupProviderHandshakeSettled,
    hasUnboundDiscardedGroupGoalTurn,
  },
  goalFold: {
    groupGoalCoordinatorTurns, addGroupGoalCoordinatorTurn, removeGroupGoalCoordinatorTurn,
    GROUP_GOAL_COORDINATOR_GUARD_MS, GROUP_GOAL_WAIT_MAX_MS,
    GROUP_GOAL_MAX_WAIT_EXHAUSTIONS,
  },
  cleanup: {
    releaseTurnResources, releaseLocalVmThread, startScreenPoller,
    retryDelegationsWaitingOn: (botId) => retryDelegationsWaitingOn(botId),
    drains: { drainQueuedSends: () => drainQueuedSends(), drainConnectorResumes, drainSecretResumes, drainTeamSetupResumes },
  },
  localVm: {
    localVmLeaseFor, localVmIdleFor, localVmThreadTargets: () => localVmThreadTargets,
    localVmActiveThreads: () => localVmActiveThreads, localVmLifecycleBusy: () => localVmLifecycleBusy,
    localVmOwnerBusy: () => localVmOwnerBusy, localVmImageBusy,
    localVmModeChangeBusy, readyLocalVmForTurn,
    localVmTargetForBot,
  },
  computers: {
    bindTurnComputer, attachTeamBox, controlIntegration, browserIntegration, phoneIntegration,
    connectedAppsIntegration, agentsIntegration, inheritedTeamComputer, teamComputerPrompt,
  },
  prompts: { availableSkills, generateThreadTitle },
  queue: { followupsReady },
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
}));
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
      routines()?.forgetRoutineRequestReceiptsForThread(change.threadId);
      // A deleted destination must not strand an approval in an internal
      // task. Keep each run's snapshot and expose its execution as fallback.
      for (const run of routines()?.listRuns() ?? []) {
        if (run.resultsThreadId === change.threadId || run.sourceThreadId === change.threadId) {
          routineWiring().syncRoutineRunToSource(run);
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

  return {
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
    DEFAULT_PAGE, pageSize, slimMessage, messagePage, messageWindow,
  };
}

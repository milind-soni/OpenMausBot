// The server-side event fold — upstream's ingestion worker, miniature —
// extracted verbatim from index.ts. The canonical stream is the source of
// truth; the persisted transcript and every client view are projections of
// it. This module owns the per-thread fold state and the stall watchdog and
// registers every bus subscriber that projects provider events into the
// store and the client broadcast. index.ts wires createEventFold at the old
// fold-state declaration site and calls wireEventFold() where the first
// subscriber was registered inline, so registration order is unchanged.
// The in-flight item/request message-id maps live in ./turn-fold.ts. The
// subscriber bodies live in ./event-fold/ family modules; wireEventFold keeps
// every bus.subscribe call, in the original registration order, and passes
// each family's callback in.
import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { CommsBus } from "./comms-visibility.ts";
import type { LocalVmTarget } from "./container-computer.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { discardDelegations } from "./delegations.ts";
import { reportIncident } from "./incident-report.ts";
import { approvalCardHandlers } from "./event-fold/approval-cards.ts";
import { runtimeEventRouter } from "./event-fold/runtime-router.ts";
import { turnCompletionHandlers } from "./event-fold/turn-completion.ts";
import { memoryBoundarySubscriber, recentWorkSubscriber, watchdogSubscriber } from "./event-fold/turn-lifecycle.ts";
import type { GroupGoalCoordinatorTurn } from "./event-fold/types.ts";
import type { EventBus } from "./harness/bus.ts";
import { revokeInternalCapabilitiesForThread } from "./internal-capabilities.ts";
import type { LocalVmIdleTimer } from "./local-vm-idle.ts";
import type { LocalVmLease } from "./local-vm-lease.ts";
import type { Notification } from "./notify.ts";
import { RepeatDetector, callKey } from "./repeat-detector.ts";
import { RoomTurnStallRegistry } from "./room-turn-timeout.ts";
import { registry, store } from "./runtime.ts";
import type { RoutineManager, RoutineRun, RoutineRunOn } from "./routines.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";
import { botForThread, directTurnBots, turnResourceOwners } from "./turn-admission.ts";
import type { ProviderTurnGenerationRegistry, RetiredTurnRegistry } from "./turn-dispatch-guard.ts";
import type { TurnOwner } from "./turn-resources.ts";
import { TurnWatchdog } from "./turn-watchdog.ts";
import type { UsageTrigger } from "./usage-ledger.ts";

export type { GroupGoalCoordinatorTurn };

/** The settled-turn receipt the direct-followup machinery hands back. */
type DirectTurnOutcome = { ok: boolean; text: string };

/** Everything the fold reads from its host. Grouped the same way
 * createStartTurn groups its deps; the lateBound family holds thunks for
 * consts index.ts declares after the fold is wired. */
export interface EventFoldDeps {
  bus: EventBus;
  events: {
    broadcast(payload: Record<string, unknown>): void;
    notify(notification: Notification | null): void;
  };
  fold: {
    groupSpeakers: Map<string, { botId: string; name: string; color: string }>;
    generatedImagesByTurn: Map<string, Array<NonNullable<Message["attachments"]>[number]>>;
    turnTriggers: Map<string, UsageTrigger>;
    retiredProviderTurns: RetiredTurnRegistry;
    groupGoalCoordinatorTurns: Map<string, Set<GroupGoalCoordinatorTurn>>;
    directTurnGenerationByThread: Map<string, string>;
    directFollowupTurns: ProviderTurnGenerationRegistry<DirectTurnOutcome>;
    settlingResourceOwners: Map<string, string>;
  };
  helpers: {
    shouldIgnoreProviderEvent(event: RuntimeEvent): boolean;
    isUnattended(botId?: string | null, threadId?: string): boolean;
    isInternalTurn(threadId: string): boolean;
    clearInternalTurn(threadId: string): void;
    approvalModeForTurn(bot: BotRecord, peerInitiated?: boolean): ApprovalMode;
    routineSourceOwner(run: Pick<RoutineRun, "botId" | "sourceThreadId" | "resultsThreadId">): { bot: BotRecord; group: GroupRecord | undefined; threadId: string } | null;
    routineSourceThread(run: RoutineRun): string | null;
    generatedImageTurnKey(threadId: string, turnId?: string): string;
    cancelDirectTurnDispatch(botId: string, expectedThreadId?: string): unknown;
    settleDirectCoordination(generation: string | undefined, outcome: DirectTurnOutcome): void;
    settleDirectFollowup(generation: string | undefined): void;
    finalizeDelegationWatch(threadId: string, ok: boolean, reply?: string, failureName?: string): boolean;
    activeRoutineRunForThread(threadId: string): RoutineRun | null;
    runningTurnInstance(bot: BotRecord, threadId: string, runOn?: RoutineRunOn): ReturnType<typeof registry.get>;
    releaseTurnResources(owner: TurnOwner | undefined): void;
    releaseLocalVmThread(threadId: string): void;
    localVmLeaseFor(target: LocalVmTarget): LocalVmLease;
    localVmIdleFor(target: LocalVmTarget): LocalVmIdleTimer;
    hasUnboundDiscardedGroupGoalTurn(threadId: string): boolean;
    groupGoalCoordinatorTurnForEvent(event: RuntimeEvent): GroupGoalCoordinatorTurn | undefined;
    removeGroupGoalCoordinatorTurn(threadId: string, turn: GroupGoalCoordinatorTurn): void;
    continueComputerSelection(threadId: string, generation: string | undefined, succeeded: boolean): boolean;
    pokeScreenPoller(threadId: string, touches: boolean, surface?: "browser" | "computer"): void;
    stopScreenPoller(botId: string, threadId?: string): void;
    finalScreenFrame(botId: string, threadId: string): Promise<{ png: string; mime: string } | null>;
    drainThreadDelegations(threadId: string): void;
    retryDelegationsWaitingOn(botId: string): void;
    drainQueuedSends(): void;
    drainConnectorResumes(): void;
    drainSecretResumes(): void;
    drainTeamSetupResumes(): void;
    drainDelegationWakes(): void;
  };
  lateBound: {
    routines(): RoutineManager | null;
    localVmThreadTargets(): Map<string, LocalVmTarget>;
    activeVpsThreads(): Map<string, string>;
    runningTurnEngines(): Map<string, NonNullable<ReturnType<typeof registry.get>>>;
    pendingDelegationWakes(): Map<string, { botId: string; targetName: string; failureReason?: string; routineRunId?: string; budgetAcquired?: boolean }>;
    commsBus(): CommsBus;
    screenPollers(): { has(threadId: string): boolean };
    SCREEN_SETTLE_TIMEOUT_MS(): number;
  };
}

export function createEventFold(deps: EventFoldDeps) {
  const { bus } = deps;
  const { broadcast, notify } = deps.events;
  const {
    groupSpeakers, generatedImagesByTurn, turnTriggers, retiredProviderTurns,
    groupGoalCoordinatorTurns, directTurnGenerationByThread, directFollowupTurns,
    settlingResourceOwners,
  } = deps.fold;
  const {
    shouldIgnoreProviderEvent, isUnattended, isInternalTurn, clearInternalTurn,
    approvalModeForTurn, routineSourceOwner, routineSourceThread, generatedImageTurnKey,
    cancelDirectTurnDispatch, settleDirectCoordination, settleDirectFollowup,
    finalizeDelegationWatch, activeRoutineRunForThread, runningTurnInstance,
    releaseTurnResources, releaseLocalVmThread, localVmLeaseFor, localVmIdleFor,
    hasUnboundDiscardedGroupGoalTurn, groupGoalCoordinatorTurnForEvent,
    removeGroupGoalCoordinatorTurn, continueComputerSelection, pokeScreenPoller,
    stopScreenPoller, finalScreenFrame, drainThreadDelegations, retryDelegationsWaitingOn,
    drainQueuedSends, drainConnectorResumes, drainSecretResumes, drainTeamSetupResumes,
    drainDelegationWakes,
  } = deps.helpers;
  const {
    routines, localVmThreadTargets, activeVpsThreads, runningTurnEngines,
    pendingDelegationWakes, commsBus, screenPollers, SCREEN_SETTLE_TIMEOUT_MS,
  } = deps.lateBound;

  // the last settled assistant text per thread, so a "finished" notification
  // can carry what the bot actually said
  const lastReply = new Map<string, string>();
  /** the model each thread's provider session announced in session.started,
   * so a fallback notice can name the model Auto is unavailable for */
  const sessionModelByThread = new Map<string, string>();
  /** threads already told that the provider's reviewer never started */
  const nativeReviewNoticed = new Set<string>();
  /** a driver kind as the chat should name it: "claudeAgent" → "Claude" */
  const providerLabel = (provider: string): string => {
    const bare = provider.replace(/Agent$/, "");
    return bare.charAt(0).toUpperCase() + bare.slice(1);
  };

  // The latest running token totals for the turn in flight on each thread.
  // Providers report cumulative-within-turn numbers; the final value is folded
  // into the task's tally when the turn settles.
  const turnUsage = new Map<string, { input: number; output: number; cachedInput?: number }>();
  /** What the window held on the latest model call of the turn in flight, banked beside the totals at turn.completed. */
  const turnContext = new Map<string, { tokens?: number; window?: number }>();

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
      const stalledResourceOwner = turnResourceOwners.get(turn.threadId);
      const stalledGeneration = directTurnGenerationByThread.get(turn.threadId);
      cancelDirectTurnDispatch(turn.botId, turn.threadId);
      // A stalled turn takes its Local VM claim with it — room and direct
      // threads alike. Without this, a direct turn that loses its terminal
      // event pins the desktop until the lease TTL: the next task's claim()
      // finds the owner busy again, so the lease's lazy idle clear never
      // runs. Direct threads reuse their thread id and shared mode stores
      // one singleton target, so capture the lease generation too — a late
      // release must never drop a replacement turn's freshly stamped claim.
      const stalledVmTarget = localVmThreadTargets().get(turn.threadId);
      const stalledVmGeneration = stalledVmTarget
        ? localVmLeaseFor(stalledVmTarget).generationOf(turn.threadId)
        : undefined;
      revokeInternalCapabilitiesForThread(turn.threadId);
      repeats.settle(turn.threadId);
      const bot = botForThread(turn.botId, turn.threadId);
      const routineRun = activeRoutineRunForThread(turn.threadId);
      const instance = bot
        ? runningTurnInstance(bot, turn.threadId, routineRun?.runOn)
        : routineRun?.runOn === "cloud" ? registry.instances().find((candidate) => candidate.driverKind === "boxAgent") : null;
      void instance?.adapter.interruptTurn(turn.threadId).catch(() => {});
      const minutes = Math.round(TURN_STALL_MS / 60_000);
      if (routineRun?.target === "bot") {
        routines()?.failThread(turn.threadId, `No activity for ${minutes} minutes — the routine was stopped`);
        pendingDelegationWakes().delete(turn.threadId);
        discardDelegations(commsBus(), turn.threadId);
      }
      store.appendMessage(turn.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `error: no activity for ${minutes} minutes — the turn was stopped`, ok: false },
      });
      // a routine's stall reports through its own failure path
      if (bot && routineRun?.target !== "bot") {
        reportIncident({ kind: "stalled", bot, threadId: turn.threadId, detail: `no activity for ${minutes} minutes — the turn was stopped` });
      }
      settleDirectFollowup(stalledGeneration);
      finalizeDelegationWatch(turn.threadId, false, "", "Delegated turn stalled and was stopped");
      turnUsage.delete(turn.threadId);
      turnContext.delete(turn.threadId);
      roomStallCompletions.stall(turn.threadId);
      // ACP interruption settles within five seconds; other adapters settle
      // sooner. Keep ownership during that grace period so another turn cannot
      // overlap the process we are stopping. The normal turn.completed fold
      // clears it first when the adapter responds.
      const releaseOwnership = () => {
        if (stalledGeneration && directTurnGenerationByThread.get(turn.threadId) !== stalledGeneration) return;
        if (stalledResourceOwner && turnResourceOwners.get(turn.threadId)?.generation !== stalledResourceOwner.generation) return;
        // A goal coordinator can stall before sendTurn reveals its provider
        // turn id. Reusing the room during that ambiguous pre-id window would
        // make old and replacement events indistinguishable. Keep ownership
        // until the guard binds or reaches its bounded expiry.
        if (hasUnboundDiscardedGroupGoalTurn(turn.threadId)) {
          const retry = setTimeout(releaseOwnership, 1_000);
          retry.unref?.();
          return;
        }
        // Target identity alone cannot fence a direct replacement: both
        // turns store the same shared-mode singleton. The generation
        // captured at stall time must still be the live claim's.
        if (
          stalledVmTarget &&
          localVmThreadTargets().get(turn.threadId) === stalledVmTarget &&
          localVmLeaseFor(stalledVmTarget).generationOf(turn.threadId) === stalledVmGeneration
        ) {
          localVmLeaseFor(stalledVmTarget).release(turn.threadId, stalledVmGeneration);
          releaseLocalVmThread(turn.threadId);
        }
        const group = store.groupByThread(turn.threadId);
        const speaker = groupSpeakers.get(turn.threadId);
        if (group && group.busyBotId === turn.botId && speaker?.botId === turn.botId) {
          groupSpeakers.delete(turn.threadId);
          store.patchGroup(group.id, { busyBotId: null, unread: true });
        }
        // A cleared UI busy flag must not strand this finished generation's
        // computer claim. The generation checks above protect replacements.
        releaseTurnResources(stalledResourceOwner);
        const currentBot = store.bot(turn.botId);
        if (currentBot?.busy) {
          stopScreenPoller(currentBot.id, turn.threadId);
          if (activeVpsThreads().get(currentBot.id) === turn.threadId) activeVpsThreads().delete(currentBot.id);
          if (store.taskByThread(currentBot.id, turn.threadId)) store.setTaskActivity(currentBot.id, turn.threadId, "idle");
          else store.setActivity(currentBot.id, "idle");
          directTurnBots.delete(turn.threadId);
          retryDelegationsWaitingOn(currentBot.id);
          // The grace fallback replaces a missing turn.completed event. Release
          // every kind of work that may have queued behind this bot, including
          // connector and credential continuations.
          drainQueuedSends();
          drainConnectorResumes();
          drainSecretResumes();
          drainTeamSetupResumes();
        }
      };
      const release = setTimeout(releaseOwnership, 6_000);
      release.unref?.();
    },
  });

  /** Register the ingestion subscribers, in the original registration
   * order. index.ts calls this once, at the site the first subscriber was
   * registered inline. Each bus.subscribe keeps its exact place here; the
   * family modules in ./event-fold/ own the bigger subscriber bodies and
   * return the very callbacks passed below. */
  function wireEventFold(): void {
    bus.subscribe(watchdogSubscriber({
      shouldIgnoreProviderEvent, watchdog, directFollowupTurns,
      settleDirectCoordination, settleDirectFollowup,
    }));
    bus.subscribe(memoryBoundarySubscriber({ shouldIgnoreProviderEvent, runningTurnEngines }));
    bus.subscribe(recentWorkSubscriber({ shouldIgnoreProviderEvent }));
    bus.subscribe(runtimeEventRouter({
      broadcast, groupSpeakers, generatedImagesByTurn, retiredProviderTurns,
      groupGoalCoordinatorTurns, shouldIgnoreProviderEvent, generatedImageTurnKey,
      localVmLeaseFor, localVmIdleFor, releaseLocalVmThread,
      removeGroupGoalCoordinatorTurn, groupGoalCoordinatorTurnForEvent,
      pokeScreenPoller, routines, localVmThreadTargets, lastReply,
      sessionModelByThread,
      approvals: approvalCardHandlers({
        shouldIgnoreProviderEvent, isUnattended, isInternalTurn, approvalModeForTurn,
        routineSourceOwner, routineSourceThread, notify, nativeReviewNoticed,
        sessionModelByThread, providerLabel, groupSpeakers,
        directTurnGenerationByThread, watchdog,
      }),
      completions: turnCompletionHandlers({
        turnUsage, turnContext, lastReply, turnTriggers, generatedImageTurnKey,
        generatedImagesByTurn, isInternalTurn, clearInternalTurn,
        releaseLocalVmThread, activeVpsThreads, releaseTurnResources,
        directTurnGenerationByThread, continueComputerSelection,
        retryDelegationsWaitingOn, drainQueuedSends, drainConnectorResumes,
        drainSecretResumes, drainTeamSetupResumes, drainDelegationWakes,
        routineSourceThread, routineSourceOwner, notify, screenPollers,
        settlingResourceOwners, finalScreenFrame, SCREEN_SETTLE_TIMEOUT_MS,
        groupSpeakers, finalizeDelegationWatch,
        routines,
      }),
    }));

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

    bus.subscribe((event: RuntimeEvent) => {
      if (shouldIgnoreProviderEvent(event)) return;
      if (event.type !== "turn.completed") return;
      // A turn that failed or was interrupted drops its queue rather than
      // firing it later: the user who hit Stop does not expect the delegations
      // that turn queued to run anyway, minutes later, on an unrelated turn.
      if (!event.ok) discardDelegations(commsBus(), event.threadId);
      else drainThreadDelegations(event.threadId);
      // A settling bot frees itself as a delegation TARGET too: handoffs that
      // found it busy earlier were kept queued — waiting until it's free or the
      // 24-hour expiry, not counting retries — on their own source threads, and
      // this is the moment they get re-evaluated.
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

    // Connector/secret/team-setup resume drains — unlike every subscriber
    // above, these project nothing into the store or broadcast; they only
    // restart the turn that was parked on a card once the thread settles.
    // Registered last, as it was the final bus registration in index.ts.
    bus.subscribe((event: RuntimeEvent) => {
      if (shouldIgnoreProviderEvent(event)) return;
      if (event.type === "turn.completed") {
        drainConnectorResumes();
        drainSecretResumes();
        drainTeamSetupResumes();
      }
    });
  }

  return {
    lastReply,
    sessionModelByThread,
    nativeReviewNoticed,
    providerLabel,
    turnUsage,
    turnContext,
    repeats,
    TURN_STALL_MS,
    ASK_BOT_TIMEOUT_MS,
    GROUP_GOAL_WAIT_MAX_MS,
    GROUP_GOAL_MAX_WAIT_EXHAUSTIONS,
    roomStallCompletions,
    watchdog,
    wireEventFold,
  };
}

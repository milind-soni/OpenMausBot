// The server-side event fold — upstream's ingestion worker, miniature —
// extracted verbatim from index.ts. The canonical stream is the source of
// truth; the persisted transcript and every client view are projections of
// it. This module owns the per-thread fold state and the stall watchdog and
// registers every bus subscriber that projects provider events into the
// store and the client broadcast. index.ts wires createEventFold at the old
// fold-state declaration site and calls wireEventFold() where the first
// subscriber was registered inline, so registration order is unchanged.
// The in-flight item/request message-id maps live in ./turn-fold.ts.
import type { ApprovalMode } from "../shared/approval-mode.ts";
import { saveImage } from "./attachments.ts";
import { approvalHeldNote, approvalHeldReason, autoVerdict, deliverFullAccessApproval } from "./auto-approve.ts";
import { DATA_DIR } from "./config.ts";
import type { CommsBus } from "./comms-visibility.ts";
import type { LocalVmTarget } from "./container-computer.ts";
import type { RuntimeEvent } from "./contracts.ts";
import type { Handoffs } from "./delta-context.ts";
import { appendDecision } from "./decision-log.ts";
import { discardDelegations } from "./delegations.ts";
import { RETRY_MAX_ATTEMPTS } from "./drivers/retry.ts";
import { decodeGeneratedImage } from "./generated-image.ts";
import { groupGoalCompletionTurnId, parseGroupGoalDecision } from "./group-goal-run.ts";
import type { EventBus } from "./harness/bus.ts";
import type { IncidentKind } from "./incidents.ts";
import { computerSelectionTurns, revokeInternalCapabilitiesForThread, revokeInternalCapabilityForProviderEvent } from "./internal-capabilities.ts";
import type { LocalVmIdleTimer } from "./local-vm-idle.ts";
import type { LocalVmLease } from "./local-vm-lease.ts";
import { endMemoryTurn } from "./memory-journal.ts";
import { modelContextWindow } from "./model-context-window.ts";
import { buildNotification, type Notification } from "./notify.ts";
import { turnOutcomeLine } from "./recent-work.ts";
import { RepeatDetector, callKey } from "./repeat-detector.ts";
import { RoomTurnStallRegistry } from "./room-turn-timeout.ts";
import { registry, store } from "./runtime.ts";
import type { RoutineManager, RoutineRun, RoutineRunOn } from "./routines.ts";
import { screenSurfaceForTool, screenTouchingTool } from "./screen-frame-gate.ts";
import { noteSpend } from "./spend.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";
import { botForThread, directTurnBots, turnResourceOwners } from "./turn-admission.ts";
import type { ProviderTurnGenerationRegistry, RetiredTurnRegistry } from "./turn-dispatch-guard.ts";
import { askMessageByRequest, toolMessageByItem } from "./turn-fold.ts";
import type { TurnOwner } from "./turn-resources.ts";
import { TurnWatchdog } from "./turn-watchdog.ts";
import { narrateTool } from "./tts/speech-text.ts";
import { appendUsage, type UsageTrigger } from "./usage-ledger.ts";
import { appendMemoryLog, memorySourceLabel } from "./workspace.ts";

/** The settled-turn receipt the direct-followup machinery hands back. */
type DirectTurnOutcome = { ok: boolean; text: string };

/** The central runtime fold uses this to hide a coordinator's private
 * decision envelope from both streaming UI and the durable transcript. */
export type GroupGoalCoordinatorTurn = {
  token: symbol;
  turnId?: string;
  assistantItems: string[];
  /** A timed-out provider may still emit after the goal operation returns.
   * Keep swallowing that abandoned turn until its real completion arrives. */
  discard: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

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
    reportIncident(input: { kind: IncidentKind; bot: BotRecord; threadId: string; detail: string }): void;
    vpsThreadEnded(botId: string, threadId: string): void;
  };
  lateBound: {
    routines(): RoutineManager | null;
    localVmThreadTargets(): Map<string, LocalVmTarget>;
    handoffs(): Handoffs;
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
    drainDelegationWakes, reportIncident, vpsThreadEnded,
  } = deps.helpers;
  const {
    routines, localVmThreadTargets, handoffs, runningTurnEngines,
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
      // Room targets carry an invocation identity; only those claims belong
      // to the room grace cleanup added here.
      const stalledVmTarget = groupSpeakers.has(turn.threadId) ? localVmThreadTargets().get(turn.threadId) : undefined;
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
        if (stalledVmTarget && localVmThreadTargets().get(turn.threadId) === stalledVmTarget) {
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
          vpsThreadEnded(currentBot.id, turn.threadId);
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
   * registered inline. */
  function wireEventFold(): void {
    bus.subscribe((event: RuntimeEvent) => {
      if (shouldIgnoreProviderEvent(event)) return;
      if (event.type === "request.opened") watchdog.setWaitingOnHuman(event.threadId, true);
      else if (event.type === "request.resolved") watchdog.setWaitingOnHuman(event.threadId, false);
      else if (event.type === "turn.completed") {
        watchdog.settle(event.threadId);
        revokeInternalCapabilityForProviderEvent(event);
        if (event.turnId && store.botByThread(event.threadId)) {
          const reply = store.messagesFor(event.threadId).findLast(message =>
            message.role === "bot" && message.kind === "text" && message.turnId === event.turnId);
          const outcome = { ok: event.ok, text: (reply?.text || event.stopReason || "The bot finished without a text reply").slice(0, 12_000) };
          const owner = directFollowupTurns.complete(event.threadId, event.turnId, outcome);
          if (owner) {
            settleDirectCoordination(owner.generation, outcome);
            settleDirectFollowup(owner.generation);
          }
        }
      } else if (event.type !== "session.exited") watchdog.touch(event.threadId);
    });

    // Memory journal turn boundary (server/memory-journal.ts). A bot's own
    // file-tool writes to MEMORY.md and memory/ have no hook to tap, so the
    // diff against the baseline taken at dispatch is made when the turn
    // settles — session.exited too, because a turn that died may still have
    // written. Fire-and-forget by construction: endMemoryTurn swallows its own
    // failures and never reaches the fold below.
    bus.subscribe((event: RuntimeEvent) => {
      if (shouldIgnoreProviderEvent(event)) return;
      if (event.type === "turn.completed" || event.type === "session.exited") {
        runningTurnEngines().delete(event.threadId);
        endMemoryTurn(event.threadId);
      }
    });

    // One line per finished turn in the bot's daily log (server/recent-work.ts):
    // what it said last, the tools it used, whether the turn failed. What a bot
    // did in one conversation was invisible from every other; the log is where
    // session_search finds it later, and it is never loaded whole into a
    // prompt. In a room the reply names its speaker; a room turn that never
    // replied has no one to credit and leaves no line.
    bus.subscribe((event: RuntimeEvent) => {
      if (shouldIgnoreProviderEvent(event)) return;
      if (event.type !== "turn.completed" || !event.turnId) return;
      try {
        const messages = store.messagesFor(event.threadId);
        const reply = messages.findLast((message) => message.role === "bot" && message.kind === "text" && message.turnId === event.turnId);
        const bot = store.botByThread(event.threadId) ?? (reply?.from ? store.bot(reply.from.botId) : undefined);
        if (!bot) return;
        const tools = messages
          .filter((message) => message.kind === "activity" && message.turnId === event.turnId && message.tool?.name)
          .map((message) => message.tool!.name);
        const line = turnOutcomeLine({ ok: event.ok, reply: reply?.text, stopReason: event.stopReason, tools });
        if (!line) return;
        appendMemoryLog(bot.id, line, {
          source: memorySourceLabel({
            room: store.groupByThread(event.threadId),
            task: store.taskByThread(bot.id, event.threadId),
            threadId: event.threadId,
          }),
        });
      } catch {
        // a missing note never fails a turn
      }
    });

    bus.subscribe((event: RuntimeEvent) => {
      if (shouldIgnoreProviderEvent(event)) return;
      const localVmTarget = localVmThreadTargets().get(event.threadId);
      if (localVmTarget) {
        localVmLeaseFor(localVmTarget).touch(event.threadId);
        localVmIdleFor(localVmTarget).touch();
      }
      if (event.type === "turn.completed" && !store.botByThread(event.threadId)) {
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
      const routineRun = privateImageEvent ? null : (routines()?.handleRuntimeEvent(event) ?? null);
      const ownerBot = store.botByThread(event.threadId);
      const bot = ownerBot ? botForThread(ownerBot.id, event.threadId) ?? undefined : undefined;
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
      if (bot) handoffs().onEvent(event);

      switch (event.type) {
        case "session.started":
          if (bot && event.sessionId && event.providerInstanceId) {
            store.setResumeCursor(bot.id, event.providerInstanceId, event.sessionId, event.threadId);
          }
          if (typeof event.model === "string" && event.model) sessionModelByThread.set(event.threadId, event.model);
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
                tool: { ...existing, name: toolName, ok: event.ok, output: event.output },
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
                pokeScreenPoller(event.threadId, touches, screenSurfaceForTool(toolName));
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
              tool: { name, spoken: narrateTool(name) ?? undefined, summary: event.summary, input: event.input },
            });
            if (event.itemId) toolMessageByItem.set(`${event.threadId}:${event.itemId}`, message.id);
          }
          break;
        case "request.opened": {
          // A structured ask carries the model's own options and has no
          // allow/deny answer, so it is a question no matter which channel the
          // provider routed it through — and, like every question, no approval
          // mode may ever answer it for the person.
          const permission = event.requestType === "permission" && !event.questions?.length;
          // A permission request here is one the provider left for a person: its
          // own mode already ran (Ask, Edits, Auto's reviewer, Custom's config).
          // OpenMausBot decides nothing about the action itself. Only Full access
          // answers, because that is exactly what the person granted. A QUESTION
          // always reaches the human — even Full access never invents an answer.
          const asker = bot ?? (speaker ? store.bot(speaker.botId) : undefined);
          const unattended = permission && asker && event.requestId ? isUnattended(asker.id, event.threadId) : false;
          const effectiveApprovalMode = asker ? approvalModeForTurn(asker, isInternalTurn(event.threadId)) : "ask";
          const verdict = permission && asker && event.requestId
            ? autoVerdict(effectiveApprovalMode, event.tool, { requiresExplicitApproval: event.requiresExplicitApproval })
            : null;
          // Auto's reviewer is the engine's own. Claude accepts `--permission-mode
          // auto` for any model and starts in Manual without a word when auto is
          // unavailable (Haiku 4.5, Sonnet 4.5, an org that disabled it), so the
          // bot asks about everything. Say once per session why, and what stops it.
          if (
            permission &&
            asker &&
            event.nativeReview === "inactive" &&
            effectiveApprovalMode === "auto" &&
            !nativeReviewNoticed.has(event.threadId)
          ) {
            nativeReviewNoticed.add(event.threadId);
            const model = sessionModelByThread.get(event.threadId);
            pushMessage({
              role: "bot",
              kind: "activity",
              tool: {
                name: `Approve for me: ${providerLabel(event.provider)}'s automatic reviewer is not available${model ? ` for ${model}` : ""}, so this bot asks before each action. Choose a model it supports, or Full access, to stop the prompts.`,
                ok: true,
              },
            });
          }
          if (verdict?.approve && asker && event.requestId) {
            const settled = verdict.approve;
            const instance = event.providerInstanceId
              ? registry.get(event.providerInstanceId)
              : registry.get(asker.modelSelection.instanceId);
            const requestId = event.requestId;
            const { tool, summary } = event;
            const sourceGeneration = directTurnGenerationByThread.get(event.threadId);
            const sourceSpeaker = groupSpeakers.get(event.threadId);
            const isCurrent = () => !shouldIgnoreProviderEvent(event) && (
              (sourceGeneration !== undefined && directTurnGenerationByThread.get(event.threadId) === sourceGeneration) ||
              (sourceSpeaker !== undefined && groupSpeakers.get(event.threadId) === sourceSpeaker)
            );
            // The chip is written only AFTER the provider takes the answer.
            // Claiming approval first and correcting later means a moment
            // where the transcript says "approved" over a request nothing
            // answered — and if the provider is gone entirely, forever.
            void (async () => {
              const outcome = await deliverFullAccessApproval(instance?.adapter, event.threadId, requestId, event.turnId, isCurrent);
              if (!isCurrent()) return;
              if (outcome !== "allowed-once") {
                watchdog.setWaitingOnHuman(event.threadId, false);
                if (outcome !== "unavailable") pushMessage({
                  role: "bot", kind: "activity",
                  tool: { name: outcome === "rejected"
                    ? "The provider rejected this action despite Full access."
                    : "error: could not deliver Full access to the provider; retry the task after reconnecting.", ok: false },
                });
                return;
              }
              pushMessage({
                role: "bot",
                kind: "activity",
                tool: { name: `${settled}: ${summary.slice(0, 120)}`, ok: true },
              });
              // Log only once the provider has actually taken the answer.
              appendDecision(DATA_DIR, {
                threadId: event.threadId,
                requestId,
                botId: asker.id,
                botName: asker.name,
                tool,
                summary,
                decision: "auto-approved",
                source: verdict.source,
              });
            })().catch(() => {
              // A receipt failure must neither crash the server nor manufacture
              // a new permission request after the provider took our answer.
              console.error("[full-access] Could not record the provider approval result.");
            });
            break;
          }
          const heldContext = { source: verdict?.source, permission };
          // A structured ask (Claude's AskUserQuestion) is a question whatever
          // the provider routed it as: it has no allow/deny answer, only the
          // model's own options. The card carries them so the person can choose.
          const questions = event.questions?.length ? event.questions : undefined;
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
              questionRequest: questions ? { version: 1, questions } : undefined,
              // the provider can keep an allow for its session; the app keeps
              // no grant of its own for a provider's tool
              allowSession: permission && event.allowSession && !event.requiresExplicitApproval ? true : undefined,
              // The text stays for cards saved before heldCode existed, and for
              // clients that do not know the key yet.
              held: approvalHeldReason(heldContext),
              heldCode: approvalHeldNote(heldContext),
              approvalScope: event.approvalScope,
            },
          });
          if (event.requestId) askMessageByRequest.set(`${event.threadId}:${event.requestId}`, message.id);
          // Every card that reaches a human is a decision too: "the provider
          // left this for you, in this mode". `question` marks the cards no
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
            unattended: unattended || undefined,
          });
          // Notify from HERE, not from a separate subscriber on request.opened:
          // this is the branch where a card actually reached a human. Anything
          // Full access answered took the early return above and never buzzes.
          if (asker) {
            const card = store.messagesFor(event.threadId).find((candidate) => candidate.id === message.id)?.card;
            if (card && !card.answered) {
              // the bot is not working now — it is waiting on a person
              if (bot) store.setTaskActivity(bot.id, event.threadId, "waiting-on-you");
              else if (asker.busy) store.setActivity(asker.id, "waiting-on-you");
              const notificationBot = (routineRun && routineSourceOwner(routineRun)?.bot) || asker;
              notify(buildNotification(
                permission ? "approval" : "question",
                notificationBot,
                (routineRun && routineSourceThread(routineRun)) || event.threadId,
                event.summary,
              ));
            }
          }
          break;
        }
        case "request.resolved": {
          // answered (by whoever): the turn is working again, unless it settled
          const waiting = bot ?? (speaker ? store.bot(speaker.botId) : undefined);
          if (bot && store.taskByThread(bot.id, event.threadId)?.activity === "waiting-on-you") {
            store.setTaskActivity(bot.id, event.threadId, "working");
          } else if (!bot && waiting?.activity === "waiting-on-you") store.setActivity(waiting.id, "working");
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
            tool: { name: `error: ${event.message.slice(0, 160)}`, ok: false, setup: event.setup, ...(event.terminal ? { terminal: true } : {}) },
          });
          // a setup error means the engine could not even start: the bot is
          // dead until something changes, not merely idle. The next successful
          // dispatch moves it to working; turn.completed (which follows a setup
          // failure) is told to leave "dead" alone.
          if (event.setup && bot) store.setTaskActivity(bot.id, event.threadId, "dead");
          break;
        case "thread.token-usage.updated":
          // running totals for the turn in flight; folded into the task's
          // tally at turn.completed (below) so retries never double-count
          turnUsage.set(event.threadId, { input: event.input, output: event.output, cachedInput: event.cachedInput });
          if (event.contextTokens !== undefined || event.contextWindow !== undefined) {
            turnContext.set(event.threadId, { tokens: event.contextTokens, window: event.contextWindow });
          }
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
          // A run that broke — not one the person stopped, and not a routine's,
          // which reports through its own failure path — is the Chief's to see.
          if (!event.ok && event.stopReason !== "interrupted" && !routines()?.runForThread(event.threadId)) {
            const broken = bot ?? (speaker ? store.bot(speaker.botId) : undefined);
            if (broken) reportIncident({ kind: "failed", bot: broken, threadId: event.threadId, detail: event.stopReason?.trim() || "the run ended without a result" });
          }
          const lastReported = turnUsage.get(event.threadId);
          turnUsage.delete(event.threadId);
          turnContext.delete(event.threadId);
          // group turns run on the room's thread — the speaking bot's task
          // tally is not the right home for a shared room's spend, so only
          // 1:1 task turns are tallied for now.
          if (bot) {
            const resourceOwner = turnResourceOwners.get(event.threadId);
            const generation = directTurnGenerationByThread.get(event.threadId);
            const isCurrent = () => directTurnGenerationByThread.get(event.threadId) === generation &&
              Boolean(store.taskByThread(bot.id, event.threadId));
            const settleDirectTurn = (resumeQueued = false) => {
              // Resource claims can outlive a deleted thread, but a stale capture
              // must never release a replacement generation's VM or busy state.
              const ownsResources = resourceOwner &&
                turnResourceOwners.get(event.threadId)?.generation === resourceOwner.generation;
              if (ownsResources) {
                vpsThreadEnded(bot.id, event.threadId);
                releaseLocalVmThread(event.threadId);
              }
              releaseTurnResources(resourceOwner);
              if (!isCurrent()) return;
              if (store.taskByThread(bot.id, event.threadId)?.activity !== "dead") {
                store.setTaskActivity(bot.id, event.threadId, "idle");
              }
              directTurnBots.delete(event.threadId);
              if (continueComputerSelection(event.threadId, generation, event.ok)) return;
              // Ordinary completion still drains from the existing bus subscribers.
              // An asynchronous screenshot finishes after those subscribers ran.
              if (resumeQueued) {
                retryDelegationsWaitingOn(bot.id);
                drainQueuedSends();
                drainConnectorResumes();
                drainSecretResumes();
                drainTeamSetupResumes();
                drainDelegationWakes();
              }
            };
            // bank what this turn spent before the bot broadcast carries the
            // task list to every window. The driver's own per-turn figure
            // (turn.completed.usage) is authoritative; a driver that only
            // streams the running indicator falls back to its last value.
            const tokens = event.usage ?? lastReported;
            // the context figure: what the last model call's prompt held, with
            // the window from the driver or, failing that, the model's family
            const lastContext = turnContext.get(event.threadId);
            turnContext.delete(event.threadId);
            const contextModel = store.taskByThread(bot.id, event.threadId)?.modelSelection?.model ?? bot.modelSelection.model;
            store.addTaskUsage(bot.id, event.threadId, {
              input: tokens?.input,
              output: tokens?.output,
              cachedInput: tokens?.cachedInput,
              costUsd: event.cost ?? null,
              context: { tokens: lastContext?.tokens, window: lastContext?.window ?? modelContextWindow(contextModel) },
            });
            // and write the same figures to the month's ledger, which outlives
            // the task and answers "what did we spend, by whom" for a period
            const settledTask = store.taskByThread(bot.id, event.threadId);
            const selection = settledTask?.modelSelection ?? bot.modelSelection;
            appendUsage(DATA_DIR, {
              botId: bot.id,
              botName: bot.name,
              threadId: event.threadId,
              instanceId: selection.instanceId,
              driverKind: registry.get(selection.instanceId)?.driverKind ?? "unknown",
              model: selection.model,
              input: tokens?.input ?? 0,
              output: tokens?.output ?? 0,
              ...(typeof tokens?.cachedInput === "number" ? { cachedInput: tokens.cachedInput } : {}),
              costUsd: event.cost ?? null,
              trigger: routineRun
                ? { kind: "routine", routineId: routineRun.routineId, label: routineRun.routineName }
                : internal
                  ? { kind: "bot", ...(settledTask?.openedBy?.botId ? { botId: settledTask.openedBy.botId } : {}) }
                  : turnTriggers.get(event.threadId) ?? { kind: "owner" },
            });
            noteSpend(DATA_DIR, event.cost ?? null);
            const routineReportThread = routineRun ? routineSourceThread(routineRun) : null;
            // A routine's result belongs to its reporting thread's unread state.
            // Its internal execution should not light up the sidebar as well.
            // Neither should a peer's hop: the exchange is already recorded in the
            // pair channel and chipped into both threads, which is the whole of
            // what the person needs to be able to find it.
            if (!routineReportThread && !internal) store.patchTask(bot.id, event.threadId, { unread: true });
            // A failed peer turn stays a chip too. The bot that delegated is woken
            // with the failure and answers the person in its own thread — buzzing
            // here as well would ring twice for one piece of news.
            if ((!routineRun || routineRun.status === "completed") && !internal && !computerSelectionTurns.get(event.threadId)?.selected) {
              // the frame carries the bot's avatar so every desktop client can
              // show the notification under that bot's own face
              const completionDetail = routineRun
                ? reply || routineRun.output || routineRun.routineName
                : reply;
              const notificationBot = (routineRun && routineSourceOwner(routineRun)?.bot) || bot;
              notify(buildNotification("done", notificationBot, routineReportThread ?? event.threadId, completionDetail, { avatarUrl: notificationBot.avatarUrl }));
            }
            if (screenPollers().has(event.threadId)) {
              if (resourceOwner) settlingResourceOwners.set(resourceOwner.threadId, resourceOwner.generation);
              // the last live frame becomes a settled inline screen message —
              // the screenshot-in-chat moment. One fresh capture first, so the
              // frame shows the turn's END state (the final tool's poke may
              // still be in flight).
              //
              // Keep the thread busy until its bounded final capture releases
              // the screen AND workspace. Otherwise an accepted follow-up races
              // these claims and fails as though another thread owned its folder.
              const settleLeafId = store.activePath(event.threadId).at(-1)?.id;
              let timeout: ReturnType<typeof setTimeout>;
              void Promise.race([
                finalScreenFrame(bot.id, event.threadId),
                new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), SCREEN_SETTLE_TIMEOUT_MS()); }),
              ]).then((frame) => {
                if (frame && isCurrent()) {
                  store.insertMessageAfter(event.threadId, settleLeafId, { role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
                }
              }).catch(() => {}).finally(() => {
                clearTimeout(timeout);
                settleDirectTurn(true);
              });
            } else {
              settleDirectTurn();
            }
          } else if (group && speaker) {
            // Room/goal turns run on a shared thread, but their spend still counts
            // against the workspace cap and the ledger. Book it under the speaker.
            const tokens = event.usage ?? lastReported;
            const speakingBot = store.bot(speaker.botId);
            const selection = speakingBot?.modelSelection;
            appendUsage(DATA_DIR, {
              botId: speaker.botId,
              botName: speaker.name,
              threadId: event.threadId,
              instanceId: selection?.instanceId ?? "unknown",
              driverKind: (selection && registry.get(selection.instanceId)?.driverKind) ?? "unknown",
              model: selection?.model ?? "unknown",
              input: tokens?.input ?? 0,
              output: tokens?.output ?? 0,
              ...(typeof tokens?.cachedInput === "number" ? { cachedInput: tokens.cachedInput } : {}),
              costUsd: event.cost ?? null,
              trigger: routineRun
                ? { kind: "routine", routineId: routineRun.routineId, label: routineRun.routineName }
                : turnTriggers.get(event.threadId) ?? { kind: "owner" },
            });
            noteSpend(DATA_DIR, event.cost ?? null);
          }
          if (speaker && group?.busyBotId === speaker.botId) {
            releaseTurnResources(turnResourceOwners.get(event.threadId));
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

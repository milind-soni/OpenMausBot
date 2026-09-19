// The turn-settling family — extracted verbatim from the main event router in
// event-fold.ts's wireEventFold. These handlers own the turn.retrying,
// runtime.error, thread.token-usage.updated and turn.completed cases: retry
// and error chips, running usage totals, and everything a completed turn
// banks, releases, drains and notifies. The router passes the per-event
// locals it resolved; the ctx below carries exactly the closure state and
// dep handles these cases read.
import { DATA_DIR } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { RETRY_MAX_ATTEMPTS } from "../drivers/retry.ts";
import type { EventFoldDeps } from "../event-fold.ts";
import { computerSelectionTurns } from "../internal-capabilities.ts";
import { modelContextWindow } from "../model-context-window.ts";
import { buildNotification } from "../notify.ts";
import type { RoutineRun } from "../routines.ts";
import { registry, store } from "../runtime.ts";
import { noteSpend } from "../spend.ts";
import type { BotRecord, GroupRecord, Message } from "../store.ts";
import { directTurnBots, turnResourceOwners } from "../turn-admission.ts";
import { appendUsage } from "../usage-ledger.ts";

type TurnRetryingEvent = Extract<RuntimeEvent, { type: "turn.retrying" }>;
type RuntimeErrorEvent = Extract<RuntimeEvent, { type: "runtime.error" }>;
type TokenUsageUpdatedEvent = Extract<RuntimeEvent, { type: "thread.token-usage.updated" }>;
type TurnCompletedEvent = Extract<RuntimeEvent, { type: "turn.completed" }>;
type GroupSpeaker = { botId: string; name: string; color: string };
type PushMessage = (m: Omit<Message, "id" | "at">) => Message;

interface TurnCompletedLocals {
  event: TurnCompletedEvent;
  bot: BotRecord | undefined;
  group: GroupRecord | undefined;
  speaker: GroupSpeaker | undefined;
  routineRun: RoutineRun | null;
  completedTurnId: string | undefined;
  pushMessage: PushMessage;
}

interface TurnCompletionCtx {
  turnUsage: Map<string, { input: number; output: number; cachedInput?: number }>;
  turnContext: Map<string, { tokens?: number; window?: number }>;
  lastReply: Map<string, string>;
  turnTriggers: EventFoldDeps["fold"]["turnTriggers"];
  generatedImageTurnKey: EventFoldDeps["helpers"]["generatedImageTurnKey"];
  generatedImagesByTurn: EventFoldDeps["fold"]["generatedImagesByTurn"];
  isInternalTurn: EventFoldDeps["helpers"]["isInternalTurn"];
  clearInternalTurn: EventFoldDeps["helpers"]["clearInternalTurn"];
  releaseLocalVmThread: EventFoldDeps["helpers"]["releaseLocalVmThread"];
  vpsThreadEnded: EventFoldDeps["helpers"]["vpsThreadEnded"];
  releaseTurnResources: EventFoldDeps["helpers"]["releaseTurnResources"];
  directTurnGenerationByThread: EventFoldDeps["fold"]["directTurnGenerationByThread"];
  continueComputerSelection: EventFoldDeps["helpers"]["continueComputerSelection"];
  retryDelegationsWaitingOn: EventFoldDeps["helpers"]["retryDelegationsWaitingOn"];
  drainQueuedSends: EventFoldDeps["helpers"]["drainQueuedSends"];
  drainConnectorResumes: EventFoldDeps["helpers"]["drainConnectorResumes"];
  drainSecretResumes: EventFoldDeps["helpers"]["drainSecretResumes"];
  drainTeamSetupResumes: EventFoldDeps["helpers"]["drainTeamSetupResumes"];
  drainDelegationWakes: EventFoldDeps["helpers"]["drainDelegationWakes"];
  routineSourceThread: EventFoldDeps["helpers"]["routineSourceThread"];
  routineSourceOwner: EventFoldDeps["helpers"]["routineSourceOwner"];
  notify: EventFoldDeps["events"]["notify"];
  screenPollers: EventFoldDeps["lateBound"]["screenPollers"];
  settlingResourceOwners: EventFoldDeps["fold"]["settlingResourceOwners"];
  finalScreenFrame: EventFoldDeps["helpers"]["finalScreenFrame"];
  SCREEN_SETTLE_TIMEOUT_MS: EventFoldDeps["lateBound"]["SCREEN_SETTLE_TIMEOUT_MS"];
  groupSpeakers: EventFoldDeps["fold"]["groupSpeakers"];
  finalizeDelegationWatch: EventFoldDeps["helpers"]["finalizeDelegationWatch"];
  reportIncident: EventFoldDeps["helpers"]["reportIncident"];
  routines: EventFoldDeps["lateBound"]["routines"];
}

export interface TurnCompletionHandlers {
  turnRetrying(locals: { event: TurnRetryingEvent; pushMessage: PushMessage }): void;
  runtimeError(locals: { event: RuntimeErrorEvent; bot: BotRecord | undefined; pushMessage: PushMessage }): void;
  threadTokenUsageUpdated(locals: { event: TokenUsageUpdatedEvent }): void;
  turnCompleted(locals: TurnCompletedLocals): void;
}

export function turnCompletionHandlers({
  turnUsage, turnContext, lastReply, turnTriggers, generatedImageTurnKey,
  generatedImagesByTurn, isInternalTurn, clearInternalTurn, releaseLocalVmThread,
  vpsThreadEnded, releaseTurnResources, directTurnGenerationByThread,
  continueComputerSelection, retryDelegationsWaitingOn, drainQueuedSends,
  drainConnectorResumes, drainSecretResumes, drainTeamSetupResumes,
  drainDelegationWakes, routineSourceThread, routineSourceOwner, notify,
  screenPollers, settlingResourceOwners, finalScreenFrame,
  SCREEN_SETTLE_TIMEOUT_MS, groupSpeakers, finalizeDelegationWatch,
  reportIncident, routines,
}: TurnCompletionCtx): TurnCompletionHandlers {
  return {
    turnRetrying({ event, pushMessage }: { event: TurnRetryingEvent; pushMessage: PushMessage }) {
      // the driver is about to relaunch the turn after a transient failure;
      // the activity chip keeps the bot visibly busy through the backoff
      pushMessage({
        role: "bot",
        kind: "activity",
        tool: { name: `retrying — attempt ${event.attempt + 1}/${RETRY_MAX_ATTEMPTS} in ${Math.round(event.delayMs / 1000)}s — ${event.reason}`, ok: true },
      });
    },
    runtimeError({ event, bot, pushMessage }: { event: RuntimeErrorEvent; bot: BotRecord | undefined; pushMessage: PushMessage }) {
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
    },
    threadTokenUsageUpdated({ event }: { event: TokenUsageUpdatedEvent }) {
      // running totals for the turn in flight; folded into the task's
      // tally at turn.completed (below) so retries never double-count
      turnUsage.set(event.threadId, { input: event.input, output: event.output, cachedInput: event.cachedInput });
      if (event.contextTokens !== undefined || event.contextWindow !== undefined) {
        turnContext.set(event.threadId, { tokens: event.contextTokens, window: event.contextWindow });
      }
    },
    turnCompleted({ event, bot, group, speaker, routineRun, completedTurnId, pushMessage }: TurnCompletedLocals) {
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
      const lastContext = turnContext.get(event.threadId);
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
    },
  };
}

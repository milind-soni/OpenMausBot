// The approval/question card family — extracted verbatim from the main event
// router in event-fold.ts's wireEventFold. These handlers own the
// request.opened and request.resolved cases: Full-access auto-answers, the
// cards a human sees, and the message patches when a card is answered. The
// router passes the per-event locals it resolved (bot, speaker, routineRun,
// pushMessage); the ctx below carries exactly the closure state and dep
// handles these cases read.
import { approvalHeldNote, approvalHeldReason, autoVerdict, deliverFullAccessApproval } from "../auto-approve.ts";
import { DATA_DIR } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { appendDecision } from "../decision-log.ts";
import type { EventFoldDeps } from "../event-fold.ts";
import { buildNotification } from "../notify.ts";
import type { RoutineRun } from "../routines.ts";
import { registry, store } from "../runtime.ts";
import type { BotRecord, Message } from "../store.ts";
import { askMessageByRequest } from "../turn-fold.ts";
import type { TurnWatchdog } from "../turn-watchdog.ts";

type RequestOpenedEvent = Extract<RuntimeEvent, { type: "request.opened" }>;
type RequestResolvedEvent = Extract<RuntimeEvent, { type: "request.resolved" }>;
type GroupSpeaker = { botId: string; name: string; color: string };
type PushMessage = (m: Omit<Message, "id" | "at">) => Message;

export interface RequestOpenedLocals {
  event: RequestOpenedEvent;
  bot: BotRecord | undefined;
  speaker: GroupSpeaker | undefined;
  routineRun: RoutineRun | null;
  pushMessage: PushMessage;
}

export interface RequestResolvedLocals {
  event: RequestResolvedEvent;
  bot: BotRecord | undefined;
  speaker: GroupSpeaker | undefined;
}

interface ApprovalCardsCtx {
  shouldIgnoreProviderEvent: EventFoldDeps["helpers"]["shouldIgnoreProviderEvent"];
  isUnattended: EventFoldDeps["helpers"]["isUnattended"];
  isInternalTurn: EventFoldDeps["helpers"]["isInternalTurn"];
  approvalModeForTurn: EventFoldDeps["helpers"]["approvalModeForTurn"];
  routineSourceOwner: EventFoldDeps["helpers"]["routineSourceOwner"];
  routineSourceThread: EventFoldDeps["helpers"]["routineSourceThread"];
  notify: EventFoldDeps["events"]["notify"];
  nativeReviewNoticed: Set<string>;
  sessionModelByThread: Map<string, string>;
  providerLabel: (provider: string) => string;
  groupSpeakers: EventFoldDeps["fold"]["groupSpeakers"];
  directTurnGenerationByThread: EventFoldDeps["fold"]["directTurnGenerationByThread"];
  watchdog: TurnWatchdog;
}

export interface ApprovalCardHandlers {
  requestOpened(locals: RequestOpenedLocals): void;
  requestResolved(locals: RequestResolvedLocals): void;
}

export function approvalCardHandlers({
  shouldIgnoreProviderEvent, isUnattended, isInternalTurn, approvalModeForTurn,
  routineSourceOwner, routineSourceThread, notify, nativeReviewNoticed,
  sessionModelByThread, providerLabel, groupSpeakers, directTurnGenerationByThread,
  watchdog,
}: ApprovalCardsCtx): ApprovalCardHandlers {
  return {
    requestOpened({ event, bot, speaker, routineRun, pushMessage }: RequestOpenedLocals) {
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
        return;
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
    },
    requestResolved({ event, bot, speaker }: RequestResolvedLocals) {
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
    },
  };
}

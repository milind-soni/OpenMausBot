// The main runtime event router — extracted verbatim from event-fold.ts's
// wireEventFold. This single subscriber projects every provider event into
// the store and the client broadcast: the goal-coordinator envelope gate, the
// streamed assistant/tool items, and the switch that hands the approval/card
// cases and the turn-settling cases to their family modules. event-fold.ts
// assembles the ctx below from the fold's closure state and deps and passes
// the returned callback straight to bus.subscribe.
import { saveImage } from "../attachments.ts";
import { handoffs } from "../delta-handoffs.ts";
import type { RuntimeEvent } from "../contracts.ts";
import type { EventFoldDeps } from "../event-fold.ts";
import { decodeGeneratedImage } from "../generated-image.ts";
import { groupGoalCompletionTurnId, parseGroupGoalDecision } from "../group-goal-run.ts";
import { screenSurfaceForTool, screenTouchingTool } from "../screen-frame-gate.ts";
import { narrateTool } from "../tts/speech-text.ts";
import { botForThread } from "../turn-admission.ts";
import { toolMessageByItem } from "../turn-fold.ts";
import { store } from "../runtime.ts";
import type { Message } from "../store.ts";
import type { ApprovalCardHandlers } from "./approval-cards.ts";
import type { TurnCompletionHandlers } from "./turn-completion.ts";

interface RuntimeRouterCtx {
  broadcast: EventFoldDeps["events"]["broadcast"];
  groupSpeakers: EventFoldDeps["fold"]["groupSpeakers"];
  generatedImagesByTurn: EventFoldDeps["fold"]["generatedImagesByTurn"];
  retiredProviderTurns: EventFoldDeps["fold"]["retiredProviderTurns"];
  groupGoalCoordinatorTurns: EventFoldDeps["fold"]["groupGoalCoordinatorTurns"];
  shouldIgnoreProviderEvent: EventFoldDeps["helpers"]["shouldIgnoreProviderEvent"];
  generatedImageTurnKey: EventFoldDeps["helpers"]["generatedImageTurnKey"];
  localVmLeaseFor: EventFoldDeps["helpers"]["localVmLeaseFor"];
  localVmIdleFor: EventFoldDeps["helpers"]["localVmIdleFor"];
  releaseLocalVmThread: EventFoldDeps["helpers"]["releaseLocalVmThread"];
  removeGroupGoalCoordinatorTurn: EventFoldDeps["helpers"]["removeGroupGoalCoordinatorTurn"];
  groupGoalCoordinatorTurnForEvent: EventFoldDeps["helpers"]["groupGoalCoordinatorTurnForEvent"];
  pokeScreenPoller: EventFoldDeps["helpers"]["pokeScreenPoller"];
  routines: EventFoldDeps["lateBound"]["routines"];
  localVmThreadTargets: EventFoldDeps["lateBound"]["localVmThreadTargets"];
  lastReply: Map<string, string>;
  sessionModelByThread: Map<string, string>;
  approvals: ApprovalCardHandlers;
  completions: TurnCompletionHandlers;
}

export function runtimeEventRouter({
  broadcast, groupSpeakers, generatedImagesByTurn, retiredProviderTurns,
  groupGoalCoordinatorTurns, shouldIgnoreProviderEvent, generatedImageTurnKey,
  localVmLeaseFor, localVmIdleFor, releaseLocalVmThread, removeGroupGoalCoordinatorTurn,
  groupGoalCoordinatorTurnForEvent, pokeScreenPoller, routines, localVmThreadTargets,
  lastReply, sessionModelByThread, approvals, completions,
}: RuntimeRouterCtx): (event: RuntimeEvent) => void {
  return (event: RuntimeEvent) => {
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
    if (bot) handoffs.onEvent(event);
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
      case "request.opened":
        approvals.requestOpened({ event, bot, speaker, routineRun, pushMessage });
        break;
      case "request.resolved":
        approvals.requestResolved({ event, bot, speaker });
        break;
      case "turn.retrying":
        completions.turnRetrying({ event, pushMessage });
        break;
      case "runtime.error":
        completions.runtimeError({ event, bot, pushMessage });
        break;
      case "thread.token-usage.updated":
        completions.threadTokenUsageUpdated({ event });
        break;
      case "turn.completed":
        completions.turnCompleted({ event, bot, group, speaker, routineRun, completedTurnId, pushMessage });
        break;
    }
  };
}

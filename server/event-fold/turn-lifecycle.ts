// The turn-lifecycle observers — extracted verbatim from event-fold.ts's
// wireEventFold. Each factory returns the exact callback event-fold.ts passes
// to bus.subscribe, so the subscribe calls and their registration order stay
// in createEventFold. The first subscriber settles the stall watchdog and the
// direct-followup registries; the other two are the memory-journal turn
// boundary and the recent-work log line.
import type { RuntimeEvent } from "../contracts.ts";
import type { EventFoldDeps } from "../event-fold.ts";
import { revokeInternalCapabilityForProviderEvent } from "../internal-capabilities.ts";
import { endMemoryTurn } from "../memory-journal.ts";
import { turnOutcomeLine } from "../recent-work.ts";
import { store } from "../runtime.ts";
import type { TurnWatchdog } from "../turn-watchdog.ts";
import { appendMemoryLog, memorySourceLabel } from "../workspace.ts";

/** Everything the watchdog subscriber reads from its host. */
interface WatchdogSubscriberCtx {
  shouldIgnoreProviderEvent: EventFoldDeps["helpers"]["shouldIgnoreProviderEvent"];
  watchdog: TurnWatchdog;
  directFollowupTurns: EventFoldDeps["fold"]["directFollowupTurns"];
  settleDirectCoordination: EventFoldDeps["helpers"]["settleDirectCoordination"];
  settleDirectFollowup: EventFoldDeps["helpers"]["settleDirectFollowup"];
}

export function watchdogSubscriber({
  shouldIgnoreProviderEvent, watchdog, directFollowupTurns,
  settleDirectCoordination, settleDirectFollowup,
}: WatchdogSubscriberCtx) {
  return (event: RuntimeEvent): void => {
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
  };
}

// Memory journal turn boundary (server/memory-journal.ts). A bot's own
// file-tool writes to MEMORY.md and memory/ have no hook to tap, so the
// diff against the baseline taken at dispatch is made when the turn
// settles — session.exited too, because a turn that died may still have
// written. Fire-and-forget by construction: endMemoryTurn swallows its own
// failures and never reaches the fold below.
interface MemoryBoundarySubscriberCtx {
  shouldIgnoreProviderEvent: EventFoldDeps["helpers"]["shouldIgnoreProviderEvent"];
  runningTurnEngines: EventFoldDeps["lateBound"]["runningTurnEngines"];
}

export function memoryBoundarySubscriber({ shouldIgnoreProviderEvent, runningTurnEngines }: MemoryBoundarySubscriberCtx) {
  return (event: RuntimeEvent): void => {
    if (shouldIgnoreProviderEvent(event)) return;
    if (event.type === "turn.completed" || event.type === "session.exited") {
      runningTurnEngines().delete(event.threadId);
      endMemoryTurn(event.threadId);
    }
  };
}

// One line per finished turn in the bot's daily log (server/recent-work.ts):
// what it said last, the tools it used, whether the turn failed. What a bot
// did in one conversation was invisible from every other; the log is where
// session_search finds it later, and it is never loaded whole into a
// prompt. In a room the reply names its speaker; a room turn that never
// replied has no one to credit and leaves no line.
interface RecentWorkSubscriberCtx {
  shouldIgnoreProviderEvent: EventFoldDeps["helpers"]["shouldIgnoreProviderEvent"];
}

export function recentWorkSubscriber({ shouldIgnoreProviderEvent }: RecentWorkSubscriberCtx) {
  return (event: RuntimeEvent): void => {
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
  };
}

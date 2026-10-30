// What a person's Stop does to a direct thread: the Stop button (POST /api/bots/:id/interrupt), a typed "stop"
// while the bot works (acceptDirectSend), and the pills for teammates a stop leaves running.
import type { HandoffView } from "../coordinator.ts";
import type { Handoffs } from "../delta-context.ts";
import { isStopCommand } from "../room-holds.ts";
import type { RoutineManager } from "../routines.ts";
import type { Message, Store } from "../store.ts";
import type { UsageTrigger } from "../usage-ledger.ts";

export interface PersonStopDeps {
  store: Pick<Store, "appendMessage" | "bot" | "botByThread" | "groupByThread" | "taskByThread">;
  routines(): Pick<RoutineManager, "activeBotRunForBot" | "cancelRun"> | null;
  handoffs(): Pick<Handoffs, "stoppedByPerson">;
  interruptDirectThread(botId: string, threadId: string): Promise<void>;
  clearUnattended(threadId: string): void;
  /** Remembers that the person stopped the turn running in this thread, so it ends as their stop. */
  markStopped(threadId: string): void;
  /** Ends a goal running in this one-on-one chat, so the interrupted turn is its last. */
  stopGoal(threadId: string): void;
}

export interface TypedStop {
  botId: string;
  threadId: string;
  text: string;
  trigger: UsageTrigger;
  personPresent: boolean;
  /** A message an app sent on the person's behalf is never a stop. */
  fromApp: boolean;
  /** The rest of the person's message row, as the busy branch would have recorded it. */
  row: Pick<Message, "replyToId" | "sendId" | "sender" | "via" | "callId">;
}

export function createPersonStop(deps: PersonStopDeps) {
  const { store } = deps;

  async function stopThreadForPerson(botId: string, threadId: string): Promise<void> {
    const routines = deps.routines();
    const routine = routines?.activeBotRunForBot(botId);
    if (routine?.threadId === threadId) {
      await routines!.cancelRun(routine.id);
      return;
    }
    deps.handoffs().stoppedByPerson(threadId);
    deps.markStopped(threadId);
    deps.stopGoal(threadId);
    await deps.interruptDirectThread(botId, threadId);
  }

  /** Only a message made of stop words, from a person, acts as Stop: it is recorded, and never reaches the turn it ends. */
  async function stopOnTypedCommand(input: TypedStop): Promise<{ ok: true; threadId: string; message: Message } | null> {
    const { botId, threadId, text, trigger } = input;
    if (input.fromApp || (trigger.kind !== "user" && trigger.kind !== "owner") || !isStopCommand(text)) return null;
    if (input.personPresent) deps.clearUnattended(threadId);
    const message = store.appendMessage(threadId, { role: "user", kind: "text", text, ...input.row });
    await stopThreadForPerson(botId, threadId);
    return { ok: true as const, threadId, message };
  }

  /** Stop left teammates mid-turn: one pill each links to the conversation where Stop reaches that turn. */
  function noteTeammatesLeftRunning(threadId: string, running: HandoffView[]): void {
    if (!store.botByThread(threadId) && !store.groupByThread(threadId)) return;
    for (const node of running) {
      const name = store.bot(node.botId)?.name ?? "A teammate";
      const task = store.taskByThread(node.botId, node.threadId);
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Stopped here — ${name} is still working; open to stop it too`, ok: true },
        ...(task ? { threadRef: { botId: node.botId, threadId: node.threadId, title: task.title } } : {}),
      });
    }
  }

  return { stopThreadForPerson, stopOnTypedCommand, noteTeammatesLeftRunning };
}

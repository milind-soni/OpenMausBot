// What a person's Stop does to a direct thread: the Stop button (POST /api/bots/:id/interrupt), a typed "stop"
// while the bot works (acceptDirectSend), and "Restart turn" from the send menu. A stop ends what the request handed out too.
import type { Handoffs } from "../delta-context.ts";
import { addressesEveryone, isStopCommand } from "../room-holds.ts";
import type { RoutineManager } from "../routines.ts";
import { serverLine } from "../server-lines.ts";
import type { Message, Store } from "../store.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import type { ResolvedSender } from "../../shared/wire.ts";
import type { Actor } from "./run-owner.ts";

export interface PersonStopDeps {
  store: Pick<Store, "appendMessage" | "bot" | "botByThread" | "groupByThread" | "taskByThread" | "tasks">;
  routines(): Pick<RoutineManager, "activeBotRunForBot" | "cancelRun"> | null;
  handoffs(): Pick<Handoffs, "stoppedByPerson">;
  interruptDirectThread(botId: string, threadId: string): Promise<void>;
  /** Read before the interrupt: what frees the thread once it is interrupted, when no turn's end will. */
  stopping(botId: string, threadId: string): () => void;
  clearUnattended(threadId: string): void;
  /** Remembers that the person stopped the turn running in this thread, so it ends as their stop. */
  markStopped(threadId: string, by?: ResolvedSender): void;
  /** Ends a goal running in this one-on-one chat, so the interrupted turn is its last. */
  stopGoal(threadId: string): void;
  /** A turn runs, or teammates are at work, for this thread. */
  working(botId: string, threadId: string): boolean;
  /** The bot waits for the person's answer here: a parked question or an open card. */
  asking(threadId: string): boolean;
  language(threadId: string): string | undefined;
  /** Where several people write, the sentence someone who may not stop this thread's run reads. */
  stopRefusal?(threadId: string, by: Actor): string | null;
}

export interface TypedStop {
  botId: string;
  threadId: string;
  text: string;
  trigger: UsageTrigger;
  personPresent: boolean;
  /** A message an app sent on the person's behalf is never a stop. */
  fromApp: boolean;
  /** This thread's turn is running now. */
  busy: boolean;
  /** The rest of the person's message row, as the busy branch would have recorded it. */
  row: Pick<Message, "replyToId" | "sendId" | "sender" | "via" | "callId">;
  /** Who typed it. */
  by?: Actor;
}

export function createPersonStop(deps: PersonStopDeps) {
  const { store } = deps;

  async function stopThreadForPerson(botId: string, threadId: string, by?: ResolvedSender): Promise<void> {
    const routines = deps.routines();
    const routine = routines?.activeBotRunForBot(botId);
    const free = deps.stopping(botId, threadId);
    if (routine?.threadId === threadId) await routines!.cancelRun(routine.id);
    else {
      deps.handoffs().stoppedByPerson(threadId);
      deps.markStopped(threadId, by);
      deps.stopGoal(threadId);
      await deps.interruptDirectThread(botId, threadId);
    }
    free();
  }

  /** Only a message made of stop words, from a person, acts as Stop: it is recorded, and never reaches the turn it ends. With no
   * work to stop it goes to the bot as any line does ("stop" may mean the reminders it just set up), unless it is the Team map's
   * @everyone: that goes to every bot, working or not, and starts no engine. */
  async function stopOnTypedCommand(input: TypedStop): Promise<{ ok: true; threadId: string; message: Message } | null> {
    const { botId, threadId, text, trigger, busy } = input;
    if (input.fromApp || (trigger.kind !== "user" && trigger.kind !== "owner") || !isStopCommand(text, store.bot(botId)?.name)) return null;
    const everyone = addressesEveryone(text);
    if (!busy && !everyone && (input.row.via || deps.asking(threadId) || !deps.working(botId, threadId))) return null;
    const refusal = (id: string) => deps.stopRefusal?.(id, input.by ?? { admin: false }) ?? null;
    const refused = everyone ? null : refusal(threadId);
    if (refused) throw Object.assign(new Error(refused), { status: 403, code: "stop_not_yours" });
    if (input.personPresent) deps.clearUnattended(threadId);
    const message = store.appendMessage(threadId, { role: "user", kind: "text", text, ...input.row });
    const stopping = (everyone ? store.tasks(botId).map((task) => task.threadId) : [threadId]).filter((id) => ((id === threadId && busy) || deps.working(botId, id)) && refusal(id) === null);
    for (const id of stopping) await stopThreadForPerson(botId, id, input.row.sender);
    if (!stopping.length) store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: serverLine(deps.language(threadId), "server.stop.nothingRunning"), ok: true } });
    return { ok: true as const, threadId, message };
  }

  /** "Restart turn": the message already waits in the queue, ahead of all but the person's own earlier messages, and the
   * queue survives Stop, so stopping the running turn starts it over with that message. Like a typed stop, only a
   * person's own send may end the turn. */
  async function restartForPerson(botId: string, threadId: string, trigger: UsageTrigger): Promise<void> {
    if (trigger.kind !== "user" && trigger.kind !== "owner") return;
    await stopThreadForPerson(botId, threadId);
  }

  return { stopThreadForPerson, stopOnTypedCommand, restartForPerson };
}

// What a bot's turn is told about its teammates' open work: the assignments it still waits on, and, for a Chief, the
// questions teammates it manages wait on the person for.
import { chiefLevel } from "../chief-level.ts";
import type { HandoffView } from "../coordinator.ts";
import { escapeNotes } from "../peer-provenance.ts";
import { canManage } from "../peer-roster.ts";
import type { BotRecord, Store } from "../store.ts";

type WaitingQuestion = { bot: string; threadId: string; thread: string; question: string };

export interface TeammatePromptDeps {
  store: Pick<Store, "bots" | "bot">;
  outstandingDirect(threadId: string): readonly HandoffView[];
  openPersonCard(threadId: string): { kind: "approval" | "question" | "review"; question?: string } | undefined;
  queuedStatus(node: HandoffView): string;
  isUnattended(botId: string, threadId: string): boolean;
  fullAccess(botId: string, threadId: string): boolean;
  /** The work in this thread was started by an outside event. */
  startedOutside(threadId: string): boolean;
  guestDriven(threadId: string): boolean;
  confined(threadId: string): boolean;
  readableFrom(threadId: string): (other: string) => boolean;
  waitingForPerson(chief: BotRecord, teammates: readonly BotRecord[], readable: (threadId: string) => boolean): WaitingQuestion[];
}

export function createTeammatePrompts(deps: TeammatePromptDeps) {
  const { store } = deps;

  function outstanding(threadId: string): string {
    const pending = deps.outstandingDirect(threadId);
    if (!pending.length) return "";
    const listed = pending.map((node) => {
      const card = node.status === "queued" ? undefined : deps.openPersonCard(node.threadId);
      return { requestId: node.id, bot: store.bot(node.botId)?.name ?? "Teammate", threadId: node.threadId, assignment: node.text.slice(0, 1_000),
        status: node.status === "queued" ? deps.queuedStatus(node)
          : card?.kind === "question" ? "stopped on its question in that teammate's thread; once you have the answer, send it there with coordinate_bots, or tell the person to open it"
          : card ? "stopped on a card waiting for the person's approval in that teammate's thread; tell the person to open it" : "working on it now",
        ...(card?.kind === "question" && card.question ? { question: escapeNotes(card.question).slice(0, 400) } : {}) };
    });
    return ` Assignments you already sent are still outstanding, and nothing in this conversation cancelled them: ${JSON.stringify(listed)}. Do not resend them, do not poll or wait for them, and do not tell the user they were lost. Each result returns to this conversation on its own and resumes you then. To change or add to one, send the change to the same teammate with coordinate_bots, with its threadId as thread: it goes into that work, answering the question it waits on or reaching the turn running it. Answer the message above with that work still in flight.`;
  }

  const unattendedWork = (botId: string, threadId: string): boolean => deps.isUnattended(botId, threadId) || deps.startedOutside(threadId);

  /** Security invariant: only a turn the person is behind speaks for them. A webhook, routine or guest turn must not answer their questions. */
  const actsForPerson = (bot: BotRecord, threadId: string): boolean =>
    chiefLevel(bot) && !unattendedWork(bot.id, threadId) && !deps.guestDriven(threadId) && !deps.confined(threadId);

  /** A Chief's turns list the questions teammates it manages wait on the person for, so it can answer one for them or send
   * the person to the thread that asks. */
  function questions(bot: BotRecord, threadId: string): string {
    if (!actsForPerson(bot, threadId)) return "";
    const teammates = store.bots.filter((teammate) => teammate.id !== bot.id && !teammate.hidden && canManage(bot, teammate));
    const waiting = deps.waitingForPerson(bot, teammates, deps.readableFrom(threadId))
      .map((one) => ({ ...one, thread: escapeNotes(one.thread).slice(0, 120), question: escapeNotes(one.question).slice(0, 400) }));
    if (!waiting.length) return "";
    return ` Teammates you manage wait on the person's answer to these questions: ${JSON.stringify(waiting)}. When the person gives you an answer or asks you to answer one${deps.fullAccess(bot.id, threadId) ? ", or you know the answer for certain" : ""}, send it to that teammate with coordinate_bots with its threadId as thread: it answers the question there for the person, who can still change it. Otherwise tell the person which thread asks; never guess an answer.`;
  }

  return { outstanding, unattendedWork, actsForPerson, questions };
}

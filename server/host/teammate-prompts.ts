// What a bot's turn is told about its teammates' open work: the assignments it still waits on, and, for a Chief, the
// questions teammates it manages wait on the person for.
import type { PersonWait } from "../../shared/person-wait.ts";
import { chiefLevel } from "../chief-level.ts";
import type { HandoffView } from "../coordinator.ts";
import { escapeNotes } from "../peer-provenance.ts";
import { canManage } from "../peer-roster.ts";
import type { BotRecord, Store } from "../store.ts";
import { SAY_LONG_WAIT, waitedLong, waitedWords, waitNow } from "./long-waits.ts";

type WaitingQuestion = { bot: string; threadId: string; thread: string; question: string; since: number };

export interface TeammatePromptDeps {
  store: Pick<Store, "bots" | "bot">;
  outstandingDirect(threadId: string): readonly HandoffView[];
  openPersonCard(threadId: string): Pick<PersonWait, "kind" | "label"> | undefined;
  queuedStatus(node: HandoffView): string;
  isUnattended(botId: string, threadId: string): boolean;
  fullAccess(botId: string, threadId: string): boolean;
  /** The work in this thread was started by an outside event. */
  startedOutside(threadId: string): boolean;
  /** Whether the person the turn in `chiefThreadId` acts for is the one a question in `threadId` of `botId` waits on. */
  asksActingPerson(chiefThreadId: string): (threadId: string, botId: string) => boolean;
  guestDriven(threadId: string): boolean;
  confined(threadId: string): boolean;
  readableFrom(threadId: string): (other: string) => boolean;
  waitingForPerson(chief: BotRecord, teammates: readonly BotRecord[], readable: (threadId: string, botId: string) => boolean): WaitingQuestion[];
  now?(): number;
}

/** What a coordinate_bots call tells the bot to do next. */
export function coordinateResultMessage(reply: "none" | "poll" | "resume", answeredOnly: boolean): string {
  if (reply === "none") return "Sent one way. Nothing comes back and nothing resumes you; continue your turn.";
  if (answeredOnly) return "Answered for the person. Nothing from this call comes back or resumes you; continue your turn and tell the person what you answered.";
  return reply === "poll"
    ? "Handed to the coordinator. Read each result with assignment_status (id: a receipt's requestId, or rootId for the whole call), long-polling with wait_ms."
    : "End your turn after sending all work. These actual teammates will reply and resume you automatically. Do not poll or wait.";
}

/** Security invariant: on a team a Chief answers a teammate's question only for the person it is for, and only in a turn that person drives.
 * A room's turn names its person only through its generation. */
export function createAsksActingPerson(deps: {
  team: boolean;
  requester(threadId: string, generation?: string): string | null;
  askedPerson(botId: string, threadId: string): string | null;
}) {
  return (chiefThreadId: string, generation?: string): ((threadId: string, botId: string) => boolean) => {
    if (!deps.team) return () => true;
    const person = deps.requester(chiefThreadId, generation);
    return (threadId, botId) => person !== null && deps.askedPerson(botId, threadId) === person;
  };
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
          : card ? "stopped on a card waiting for the person in that teammate's thread; tell the person to open it" : "working on it now",
        ...(card?.kind === "question" && card.label ? { question: escapeNotes(card.label).slice(0, 400) } : {}) };
    });
    return ` Assignments you already sent are still outstanding, and nothing in this conversation cancelled them: ${JSON.stringify(listed)}. Do not resend them, do not poll or wait for them, and do not tell the user they were lost. Each result returns to this conversation on its own and resumes you then. To change or add to one, send the change to the same teammate with coordinate_bots, with its threadId as thread: it goes into that work, answering the question it waits on or reaching the turn running it. Answer the message above with that work still in flight.`;
  }

  const unattendedWork = (botId: string, threadId: string): boolean => deps.isUnattended(botId, threadId) || deps.startedOutside(threadId);

  /** Security invariant: a webhook, routine or guest turn has no person behind it, so it neither hears nor says what waits on them. */
  const personBehind = (botId: string, threadId: string): boolean =>
    !unattendedWork(botId, threadId) && !deps.guestDriven(threadId) && !deps.confined(threadId);

  /** Security invariant: only a turn the person is behind speaks for them. */
  const actsForPerson = (bot: BotRecord, threadId: string): boolean => chiefLevel(bot) && personBehind(bot.id, threadId);

  /** A Chief's turns list the questions teammates it manages wait on the person for, so it can answer one for them or send
   * the person to the thread that asks. */
  function questions(bot: BotRecord, threadId: string): string {
    if (!actsForPerson(bot, threadId)) return "";
    const teammates = store.bots.filter((teammate) => teammate.id !== bot.id && !teammate.hidden && canManage(bot, teammate));
    const now = deps.now?.() ?? waitNow();
    const readable = deps.readableFrom(threadId), asked = deps.asksActingPerson(threadId);
    const waiting = deps.waitingForPerson(bot, teammates, (other, botId) => readable(other) && asked(other, botId))
      .map(({ since, ...one }) => ({ ...one, thread: escapeNotes(one.thread).slice(0, 120), question: escapeNotes(one.question).slice(0, 400),
        ...(waitedLong(since, now) ? { waited: waitedWords(since, now) } : {}) }));
    if (!waiting.length) return "";
    const said = waiting.some((one) => one.waited) ? ` Those with "waited" have waited more than a day. ${SAY_LONG_WAIT}` : "";
    return ` Teammates you manage wait on the person's answer to these questions: ${JSON.stringify(waiting)}. When the person gives you an answer or asks you to answer one${deps.fullAccess(bot.id, threadId) ? ", or you know the answer for certain" : ""}, send it to that teammate with coordinate_bots with its threadId as thread: it answers the question there for the person, who can still change it. Otherwise tell the person which thread asks; never guess an answer.${said}`;
  }

  return { outstanding, unattendedWork, personBehind, actsForPerson, questions };
}

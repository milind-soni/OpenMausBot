// Security invariant: a confined turn is judged from records that stay. A run, a hand-off or a turn ends; the words that
// came in from outside stay in the conversation, so once work traces to outside that conversation, and everything it
// starts, retries, wakes, queues or schedules, stays outside. A person's line in such a conversation runs confined too:
// its engine reads those words as context, whoever typed last.
import { CLOUD_OUTSIDE_KEY, outsideDriven } from "../cloud-sharing.ts";
import type { HandoffView } from "../coordinator.ts";
import type { RoutineRun } from "../routines.ts";
import { serverLine } from "../server-lines.ts";
import type { Store } from "../store.ts";

/** What a turn hears when it tries to carry outside work into a conversation that is not outside. */
export const OUTSIDE_STAYS_HERE = "This work came in from outside, so it stays in this conversation and can't reach that one. Finish it here and say plainly what a person would need to do.";

const ROUTINE_FROM_BEFORE = "This routine was made before this update. Open it and save it once to run it with full access.";
const ROUTINE_FROM_OUTSIDE = "A webhook's run made or changed this routine, so it runs without full access. Open it and save it once to run it with full access.";
const CONVERSATION_FROM_BEFORE = "This conversation is from before My Cloud was only yours, so this bot works in it without a shell. Start a new conversation to use it fully.";
const CONVERSATION_FROM_OUTSIDE = "Work from outside came into this conversation, so this bot works in it without a shell. Start a new conversation to use it fully.";

const MAX_HOPS = 32;

export interface OutsideLineageDeps {
  /** A Cloud home of any kind; off a Cloud nothing is confined, the record only stops a level travelling. */
  home: boolean;
  team: boolean;
  /** A Cloud only its owner has ever used. */
  solo(): boolean;
  store: Pick<Store, "botByThread" | "taskByThread" | "patchTask" | "messagesFor" | "groupByThread" | "appendMessage">;
  /** This conversation's running turn was started confined. */
  confinedNow(threadId: string): boolean;
  activeRun(threadId: string): RoutineRun | null;
  writer(routineId: string): string | undefined;
  starters(threadId: string): (string | undefined)[];
  /** Someone but the owner opened it, on a personal Cloud. */
  guestOpened(threadId: string): boolean;
  ownerPerson(person: string | undefined): boolean;
  // Read lazily: index.ts builds the coordinator after this module.
  node(id: string): HandoffView | undefined;
  active(): HandoffView[];
  language(threadId: string): string | undefined;
}

export function createOutsideLineage(deps: OutsideLineageDeps) {
  const { store } = deps;

  const marked = (threadId: string): boolean => {
    const bot = store.botByThread(threadId);
    return Boolean(bot && store.taskByThread(bot.id, threadId)?.outside);
  };
  /** Once only, and for good: nothing clears it. A room's thread has no record of its own: a payload posted into it is. */
  const mark = (threadId: string): void => {
    const bot = store.botByThread(threadId);
    if (bot && !store.taskByThread(bot.id, threadId)?.outside) store.patchTask(bot.id, threadId, { outside: true });
  };

  /** The conversations that handed this work on, however deep. */
  function handedFrom(nodeId: string | undefined): string[] {
    const sources: string[] = [];
    let node = nodeId ? deps.node(nodeId) : undefined;
    for (let steps = 0; node && steps < MAX_HOPS; steps++) {
      if (node.id !== nodeId) sources.push(node.threadId);
      if (node.id === node.rootId) break;
      node = deps.node(node.parentId ?? node.rootId);
    }
    return sources;
  }

  /** A webhook or app event drove this conversation: its record, its run, a payload posted into it, or a conversation that handed it the work. */
  const outsideDrivenThread = (threadId: string): boolean => outsideDriven(threadId, {
    marked,
    webhookRun: (id) => deps.activeRun(id)?.triggerSource === "webhook",
    webhookPosted: (id) => store.messagesFor(id).some((line) => line.webhookPost),
    handedFrom: (id) => deps.active().filter((node) => node.threadId === id).flatMap((node) => handedFrom(node.id)),
  });

  /** A guest-driven turn runs in Ask whatever the bot's own level, with no shell. On a Cloud only its owner ever used, only what came in from outside is. */
  function cloudGuestDriven(threadId: string): boolean {
    if (!deps.home) return false;
    if (deps.confinedNow(threadId)) return true;
    const run = deps.activeRun(threadId);
    const writer = run ? deps.writer(run.routineId) : undefined;
    const madeFromOutside = writer === CLOUD_OUTSIDE_KEY || deps.starters(threadId).includes(CLOUD_OUTSIDE_KEY);
    if (deps.team) return madeFromOutside || outsideDrivenThread(threadId);
    if (deps.solo()) return madeFromOutside;
    if (deps.guestOpened(threadId)) return true;
    if (writer && !deps.ownerPerson(writer)) return true;
    if (!store.groupByThread(threadId)) return false;
    const person = store.messagesFor(threadId).findLast((line) => line.role === "user" && !line.peerAsk && line.sender?.id)?.sender?.id;
    return person !== undefined && !deps.ownerPerson(person);
  }

  /** Work a guest's turn hands a teammate is the guest's too, however deep. */
  const cloudGuestDrivenHandoff = (nodeId: string | undefined): boolean => deps.home && handedFrom(nodeId).some(cloudGuestDriven);

  /** Where the confinement rests on the conversation's own records, a thread opened from it would start with none, at the bot's own level. */
  const outsideWorkStaysHere = (threadId: string): boolean => cloudGuestDriven(threadId) && (deps.team || deps.solo());

  /** The one rule for every reach: confined work goes nowhere that is not confined already. */
  const mayReach = (fromThreadId: string, toThreadId: string): boolean => !cloudGuestDriven(fromThreadId) || cloudGuestDriven(toThreadId);

  /** A routine's runs are confined as this conversation is, so a confined turn may start it. */
  const routineRunsConfined = (routineId: string): boolean => {
    const writer = deps.writer(routineId);
    if (writer === CLOUD_OUTSIDE_KEY) return true;
    return !deps.team && !deps.solo() && !deps.ownerPerson(writer);
  };

  /** Everything this conversation starts stays what it is. */
  const carry = (fromThreadId: string, toThreadId: string): void => {
    if (outsideDrivenThread(fromThreadId) || outsideWorkStaysHere(fromThreadId)) mark(toThreadId);
  };

  /** A level comes down a hand-off only from work a person or their routine started. */
  const handsNoLevel = (threadId: string): boolean => outsideDrivenThread(threadId) || cloudGuestDriven(threadId);

  function confinedWhy(threadId: string): string {
    const run = deps.activeRun(threadId);
    const writer = run ? deps.writer(run.routineId) : undefined;
    if (run && writer === CLOUD_OUTSIDE_KEY) return ROUTINE_FROM_OUTSIDE;
    if (deps.team && outsideDrivenThread(threadId)) return CONVERSATION_FROM_OUTSIDE;
    return run && !deps.ownerPerson(writer) ? ROUTINE_FROM_BEFORE : CONVERSATION_FROM_BEFORE;
  }

  function guestEngineRefusal(threadId: string): string {
    const why = confinedWhy(threadId);
    return why !== CONVERSATION_FROM_BEFORE ? `This bot's AI can't run it that way. ${why}`
      : "This conversation is from before the Cloud was only yours, and this bot's AI can't work in it. Start a new conversation.";
  }

  /** A person's own line in a conversation outside work reached: once, in their words, why the bot works without its shell here. */
  function personLineConfined(threadId: string): void {
    if (!deps.team || !outsideDrivenThread(threadId)) return;
    const line = serverLine(deps.language(threadId), "server.outside.confinedHere");
    if (store.messagesFor(threadId).some((message) => message.kind === "activity" && message.tool?.name === line)) return;
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: line, ok: true } });
  }

  /** At every start: what ran without a record of its own, or was still in flight, keeps its lineage. */
  function settle(runs: readonly RoutineRun[], eventChat: (run: RoutineRun) => string | undefined): void {
    for (const run of runs) {
      if (run.triggerSource !== "webhook" || !run.threadId) continue;
      // Off a Cloud a wait's follow-up runs in the person's own chat.
      if (deps.home || run.eventSource !== "wait") mark(run.threadId);
      const chat = eventChat(run);
      if (chat) mark(chat);
    }
    for (const node of deps.active()) {
      if (handedFrom(node.id).some((threadId) => outsideDrivenThread(threadId))) mark(node.threadId);
    }
  }

  return {
    mark, carry, settle, mayReach, handsNoLevel, routineRunsConfined,
    outsideDrivenThread, cloudGuestDriven, cloudGuestDrivenHandoff, outsideWorkStaysHere,
    confinedWhy, guestEngineRefusal, personLineConfined,
  };
}

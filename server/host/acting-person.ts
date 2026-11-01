// Who a turn acts for on a Team Cloud: the person whose own words provably began its work, so it may use that person's
// own apps and MCP servers (server/host/team-connections-host.ts decides with it). Read only from the harness's records,
// never from model text:
//   - their own line started this turn in a one-on-one conversation, or began the run a room member answers (a run that
//     joined several queued lines, only when every one of them is theirs);
//   - work handed on (delegated, assigned or consulted work, or a thread a bot opened for it) acts for whoever the turn
//     that handed it on acted for at that moment, kept with the handed-on work so a restart keeps it.
// A turn acts for nobody once another person's words joined it after it began: a line of theirs in the conversation, or
// their answer to one of its cards. A routine, a webhook, an outside app and a bot's own work act for nobody.
import { readFileSync } from "node:fs";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { answeredByPerson } from "../cloud-lending.ts";
import type { WorkOrigin } from "../peer-provenance.ts";

export const HANDED_PEOPLE_FILE = "handed-people.json";

const PERSON = /^p_[\w-]{22}$/;
const WORK = /^[\w-]{1,128}$/;
/** As long as the coordinator keeps finished work, and no more entries than a busy team hands on in that time. */
const KEEP_MS = 30 * 24 * 60 * 60_000;
const MAX_ENTRIES = 20_000;

type Card = { answered?: string; answeredText?: string; dismissed?: boolean; autoApplied?: boolean; answeredBy?: { kind: string; person?: string } };
export type ActingLine = {
  id: string; at: number; role: string; peerAsk?: unknown; steered?: boolean; queueId?: string; sender?: { id?: string }; card?: Card;
};
/** A one-on-one conversation's latest request (index.ts directRequestOwners). */
export type DirectRequest = {
  generation: string; generations: ReadonlySet<string>; messageId?: string; stopped?: boolean; automation?: unknown; origin?: WorkOrigin;
};
/** Handed-on work a room member does: whom it acts for, and since when the room's words count against it. */
export type HandedRun = { person: string; since: number };
/** A room run (index.ts GroupTurnOperation, server/host/cloud-lending-turns.ts): the person's line it answers, the queued
 * lines it joined, or the handed-on work it does. */
export type RoomRun = { requestMessageId?: string; cancelled: boolean; queuedQueueIds?: readonly string[]; handedFor?: HandedRun };

const fileSchema = z.object({
  v: z.literal(1),
  work: z.record(z.string().regex(WORK), z.object({ person: z.string().regex(PERSON), at: z.number().int().nonnegative() })),
});

/** Whom each piece of handed-on work acts for, recorded once as it is handed on. A missing or damaged file holds nobody:
 * it never grants anything by being absent. */
export class HandedPeople {
  readonly #file: string;
  readonly #now: () => number;
  readonly #work = new Map<string, { person: string; at: number }>();

  constructor(file: string, now: () => number = Date.now) {
    this.#file = file;
    this.#now = now;
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) for (const [id, entry] of Object.entries(parsed.data.work)) this.#work.set(id, entry);
    } catch {
      // none yet, or unreadable: nobody
    }
  }

  /** Work handed on by a turn that acted for `person`; once, so handing the same work on again changes nothing. */
  record(workId: string, person: string | null): void {
    if (!person || !PERSON.test(person) || !WORK.test(workId) || this.#work.has(workId)) return;
    const now = this.#now();
    this.#work.set(workId, { person, at: now });
    for (const [id, entry] of this.#work) if (now - entry.at > KEEP_MS) this.#work.delete(id);
    while (this.#work.size > MAX_ENTRIES) this.#work.delete(this.#work.keys().next().value!);
    try {
      writeFileAtomic(this.#file, `${JSON.stringify({ v: 1, work: Object.fromEntries(this.#work) })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`handed-on work: could not save ${this.#file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get(workId: string): { person: string; at: number } | undefined {
    return this.#work.get(workId);
  }
}

/** A person's own line: theirs as the server recorded it, never a bot's relayed one. */
const linePerson = (line: ActingLine | undefined): string | undefined =>
  line?.role === "user" && !line.peerAsk && line.sender?.id && PERSON.test(line.sender.id) ? line.sender.id : undefined;

/** No one else's words joined the work since `since`: no line of another person's (and no line sent into a running turn
 * by someone the server can't name), and no answer of theirs to a card. */
export function onlyTheirs(thread: readonly ActingLine[], person: string, since: number): boolean {
  return !thread.some((line) => line.at >= since && (
    (line.role === "user" && !line.peerAsk && (line.sender?.id ? line.sender.id !== person : line.steered === true))
    || (answeredByPerson(line.card) && line.card!.answeredBy?.kind === "session" && line.card!.answeredBy.person !== person)));
}

/** A handed-on origin names the person the work acts for, and only a person's own request can. */
export function withPerson(origin: WorkOrigin, person: string | null | undefined): WorkOrigin {
  if (origin.kind !== "user") return origin;
  const { person: _previous, ...rest } = origin;
  return person && PERSON.test(person) ? { ...rest, person } : rest;
}

export interface ActingPeopleDeps {
  store: { groupByThread(threadId: string): unknown; messagesFor(threadId: string): readonly ActingLine[] };
  direct(threadId: string): DirectRequest | undefined;
  roomRun(generation: string): RoomRun | undefined;
  handed: HandedPeople;
}

export function createActingPeople(deps: ActingPeopleDeps) {
  /** The person this turn generation acts for (the conversation's latest when none is named), or null. */
  const requester = (threadId: string, generation?: string): string | null => {
    const thread = deps.store.messagesFor(threadId);
    if (deps.store.groupByThread(threadId)) {
      const run = generation === undefined ? undefined : deps.roomRun(generation);
      if (!run || run.cancelled) return null;
      if (run.requestMessageId) {
        const line = thread.find((message) => message.id === run.requestMessageId);
        const person = linePerson(line);
        if (!line || !person) return null;
        const joined = new Set(run.queuedQueueIds ?? []);
        const since = thread.reduce((first, message) => (message.queueId !== undefined && joined.has(message.queueId) ? Math.min(first, message.at) : first), line.at);
        return onlyTheirs(thread, person, since) ? person : null;
      }
      const handed = run.handedFor;
      return handed && onlyTheirs(thread, handed.person, handed.since) ? handed.person : null;
    }
    const request = deps.direct(threadId);
    const turn = generation ?? request?.generation;
    if (!request || !turn || request.stopped || !request.generations.has(turn) || request.automation !== undefined) return null;
    if (request.messageId) {
      const line = thread.find((message) => message.id === request.messageId);
      const person = linePerson(line);
      if (line && person) return onlyTheirs(thread, person, line.at) ? person : null;
    }
    // Work handed on into a conversation of its own: nobody else may have written in it at all.
    const handed = request.origin?.kind === "user" ? request.origin.person : undefined;
    return handed && onlyTheirs(thread, handed, 0) ? handed : null;
  };
  return {
    requester,
    /** Work this turn hands on now acts for whoever this turn acts for; the first hand-on of a turn that started its
     * work is kept for that turn too, so it still acts for them if a restart runs it again. */
    handOn(turn: { threadId: string; generation: string }, work: { id: string; rootId: string }): void {
      const person = requester(turn.threadId, turn.generation);
      deps.handed.record(work.id, person);
      if (work.rootId === turn.generation) deps.handed.record(work.rootId, person);
    },
    /** A handed-on origin with the person its work was handed on for, if any. */
    handedOrigin(origin: WorkOrigin, workId: string): WorkOrigin {
      return withPerson(origin, deps.handed.get(workId)?.person);
    },
    /** What a room member doing handed-on work acts for: the room's words since it was handed on count against it. */
    handedRun(workId: string): HandedRun | undefined {
      const entry = deps.handed.get(workId);
      return entry ? { person: entry.person, since: entry.at } : undefined;
    },
  };
}

export type ActingPeople = ReturnType<typeof createActingPeople>;

type HandedBack = { ok: boolean; text: string; evidence?: unknown; cards?: { question: string; ids: string[] }; privateQuestion?: boolean };
type Place = { child: string | null; parent: string | null };

/** Work in one person's private chat, for a requester whose chat is not that one: its words stay with that person. */
export const keptPrivate = (place: Place): boolean => Boolean(place.child) && place.parent !== place.child;
const lastLineAsks = (text: string) => /^needs input:/i.test(text.trimEnd().split(/\r?\n/).at(-1)?.trim() ?? "");

/** What work that ran in one person's private chat hands back to a place others read: where its result is, never the
 * result, which may hold what their own apps brought back or their private notes (a private chat never reaches a room:
 * server/host/room-access.ts). A question it ends on stays a question, with its words left in their chat. Work handed
 * back into the same person's private chat keeps everything. */
export function privateHandBack<T extends HandedBack>(outcome: T, place: Place & { bot: string; person: string }): T {
  if (!keptPrivate(place)) return outcome;
  const where = `${place.bot}'s chat with ${place.person}`;
  const question = `${place.bot} has a question for ${place.person}, in ${where}.`;
  const { evidence: _evidence, ...rest } = outcome;
  const asks = lastLineAsks(outcome.text);
  return {
    ...rest,
    text: asks ? `NEEDS INPUT: ${question}` : `${outcome.ok ? "Done" : "It stopped before it finished"}. The result is in ${where}.`,
    ...(outcome.cards ? { cards: { ...outcome.cards, question } } : {}),
    ...(asks || outcome.cards ? { privateQuestion: true } : {}),
  } as T;
}

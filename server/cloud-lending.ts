// Who may use a Mac lent to an OMB Cloud home (docs/cloud-pro.md, "Let my
// Cloud use this Mac"). A Cloud home is one person's server, but not every
// turn on it is theirs: a guest the owner paired, a webhook's payload, or a
// line someone else slipped into a running turn must never reach the Mac.
//
// A turn may use the lent Mac only when the harness can prove it acts for the
// owner:
// - a conversation the owner started from one of their own devices (a live
//   session with admin scope), or
// - a scheduled run of a routine whose instructions the owner wrote (created
//   or edited from one of those devices), or a run the owner started by hand;
// and the conversation was opened by them and holds nobody else's words,
// ever: a resumed session carries everything said in it, so one line (or
// card answer) from a guest, a teammate bot or a local process, before or
// during the turn, takes that conversation out of lending. The owner starts a new one to lend again.
// Webhook runs, guests, rooms, a bot's delegated or peer turn, and anything
// unprovable never can.
// Everything here is pure; server/index.ts supplies the records.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import type { RoutineRunTrigger } from "./routines.ts";

type Card = { requestId?: string; answered?: string; answeredText?: string; dismissed?: boolean; answeredBy?: { kind: string; person?: string } };
type Line = { id: string; role: string; peerAsk?: unknown; sender?: { id?: string }; card?: Card };

export interface CloudLendingTurn {
  /** The harness's record of the request that started this turn. */
  request: { messageId?: string; generations: ReadonlySet<string>; stopped?: boolean; automation?: RoutineRunTrigger } | undefined;
  generation: string;
  thread: readonly Line[];
  /** Who opened this conversation (and the room it is in), where recorded.
   * Whoever opened it chose its title, so it must be the owner too. */
  starters?: readonly (string | undefined)[];
  /** The conversation holds a report of work someone else directed (a
   * routine the owner did not write). */
  reportsFromOthers?: boolean;
  /** Whether a person key is one of the owner's own devices right now. */
  ownerPerson: (person: string | undefined) => boolean;
  /** Who answered a card (the recorded answerer, or whoever is answering it
   * right now); undefined when that is not a known person. */
  cardAnswerer: (card: Card) => string | undefined;
  /** The routine run executing on this turn's thread, when there is one. */
  routineRun: () => { triggerSource: RoutineRunTrigger; ownerStarted: boolean; ownerAuthored: boolean } | null;
}

const personOf = (line: Line | undefined) => line?.role === "user" && !line.peerAsk ? line.sender?.id : undefined;

/** Why a turn may not use the lent Mac, or null when it may. */
export type CloudLendingRefusal = "unproven" | "not-owner" | "someone-else";

export function cloudHomeTurnMayLend(turn: CloudLendingTurn): boolean {
  return cloudHomeLendingRefusal(turn) === null;
}

export function cloudHomeLendingRefusal(turn: CloudLendingTurn): CloudLendingRefusal | null {
  const { request } = turn;
  if (!request?.messageId || request.stopped || !request.generations.has(turn.generation)) return "unproven";
  const index = turn.thread.findIndex(line => line.id === request.messageId);
  if (index < 0) return "unproven";
  let owner: boolean;
  if (request.automation === undefined) {
    owner = turn.ownerPerson(personOf(turn.thread[index]));
  } else {
    const run = turn.routineRun();
    owner = request.automation !== "webhook" && Boolean(run) && run!.triggerSource !== "webhook" &&
      run!.ownerAuthored && (run!.triggerSource !== "manual" || run!.ownerStarted);
  }
  if (!owner) return "not-owner";
  // A conversation someone else opened (and named) is theirs, whoever writes in it.
  if (turn.starters?.some((person) => person !== undefined && !turn.ownerPerson(person))) return "someone-else";
  if (turn.reportsFromOthers) return "someone-else";
  // Nothing anyone else wrote (a guest, a teammate bot, a local process) may
  // be anywhere in this conversation, before or after the request, as a line
  // (sent, queued, steered or handed in) or as the answer to a card. A
  // routine's own prompt line names nobody; its provenance was proven above.
  const clean = ownerOnlyConversation(turn.thread, turn.ownerPerson, turn.cardAnswerer,
    request.automation !== undefined ? request.messageId : undefined);
  return clean ? null : "someone-else";
}

/** A conversation only the owner has written in: every user line is theirs
 * and every card someone answered was answered by them (`exempt`: one line,
 * a routine's own prompt, that names nobody). The same test decides which of
 * a bot's other conversations may feed a turn on a Cloud home (recall, the
 * recent-work brief, memory capture, the daily log). */
export function ownerOnlyConversation(
  thread: readonly Line[],
  ownerPerson: (person: string | undefined) => boolean,
  cardAnswerer: (card: Card) => string | undefined,
  exempt?: string,
): boolean {
  return thread.every(line =>
    (line.role !== "user" || line.id === exempt || ownerPerson(personOf(line))) &&
    (!answeredByPerson(line.card) || ownerPerson(cardAnswerer(line.card!))));
}

/** A card someone answered: a person's verdict or words. The harness's own
 * settlements (automatic approvals, a turn that ended) are marked dismissed
 * or unavailable and carry nobody's words. */
function answeredByPerson(card: Card | undefined): boolean {
  if (!card) return false;
  return (Boolean(card.answered) && card.answered !== "unavailable" && card.dismissed !== true) || Boolean(card.answeredText);
}

type RoutineShape = {
  prompt?: string; target?: unknown; botId?: string; groupId?: string; attachments?: { id: string; path: string }[];
  schedule?: unknown; runOn?: string;
};

/** What a routine run does and when, reduced to what its author decides:
 * the instructions, where and on what it runs, and its schedule. The
 * scheduler never rewrites these (it does rewrite a routine's results thread
 * on each run, so that is guarded by who edits the routine instead: see the
 * routines PATCH route). An edit by anyone else changes the fingerprint. */
export function routineFingerprint(routine: RoutineShape): string {
  const attachments = (routine.attachments ?? []).map(attachment => [attachment.id, attachment.path]);
  return createHash("sha256").update(JSON.stringify([
    routine.prompt ?? "", routine.target ?? null, routine.botId ?? "", routine.groupId ?? null, attachments,
    routine.schedule ?? null, routine.runOn ?? null,
  ])).digest("hex");
}

const authorsFile = z.object({
  version: z.literal(1),
  routines: z.record(z.string().max(128), z.string().regex(/^[a-f0-9]{64}$/)),
  /** Whoever last wrote each routine (a person key), owner or not. */
  writers: z.record(z.string().max(128), z.string().regex(/^p_[\w-]{22}$/)).optional(),
}).strict();

/** Which routines the owner wrote, as the fingerprint of what they wrote.
 * Persisted beside the routines (owner-only). A missing or damaged file
 * means none: it never grants anything by being absent. */
export function createCloudRoutineAuthors(file: string) {
  let routines: Record<string, string> = {};
  let writers: Record<string, string> = {};
  try {
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_000_000) {
        const parsed = authorsFile.parse(JSON.parse(readFileSync(file, "utf8")));
        routines = parsed.routines;
        writers = parsed.writers ?? {};
      }
    }
  } catch { routines = {}; writers = {}; }
  const save = () => writeFileAtomic(file, JSON.stringify({ version: 1, routines, writers }), { mode: 0o600 });
  return {
    /** The owner wrote this routine as it stands now. */
    record(id: string, routine: RoutineShape) { routines = { ...routines, [id]: routineFingerprint(routine) }; save(); },
    /** The owner's authorship ends; whoever wrote it last is still named. */
    forget(id: string) { if (Object.hasOwn(routines, id)) { const next = { ...routines }; delete next[id]; routines = next; save(); } },
    /** Someone (a person key) created or edited this routine. */
    wrote(id: string, person: string) { if (writers[id] !== person) { writers = { ...writers, [id]: person }; save(); } },
    /** Who last wrote this routine, when that is known. */
    writer(id: string): string | undefined { return Object.hasOwn(writers, id) ? writers[id] : undefined; },
    /** The routine is gone: nothing about it is kept. */
    remove(id: string) {
      if (!Object.hasOwn(routines, id) && !Object.hasOwn(writers, id)) return;
      const nextRoutines = { ...routines }; delete nextRoutines[id]; routines = nextRoutines;
      const nextWriters = { ...writers }; delete nextWriters[id]; writers = nextWriters;
      save();
    },
    /** Whether this routine, as it stands (or as a run snapshotted it), is
     * exactly what the owner wrote. */
    authored(id: string, routine: RoutineShape) { return Object.hasOwn(routines, id) && routines[id] === routineFingerprint(routine); },
  };
}

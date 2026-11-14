// On a Cloud home a routine runs at the level of the conversation it was made in. A routine a bot made where only the
// owner spoke is the owner's, so its runs keep the bot's own level. Lending and memory also need that conversation to
// hold no report of anyone else's routine (the routine fingerprint).
import type { RoutineRequestCardData } from "../shared/routine-request.ts";
import { answeredByPerson, type ownerOnlyConversation } from "./cloud-lending.ts";
import type { asSchedule } from "./routine-requests.ts";

type Card = Parameters<typeof ownerOnlyConversation>[0][number]["card"] & { routineRequest?: RoutineRequestCardData };
type Line = Omit<Parameters<typeof ownerOnlyConversation>[0][number], "card"> & { card?: Card; webhookPost?: unknown };

/** Who spoke: whoever opened it, every person's line and every card a person answered is the owner's, and nothing came
 * in by webhook. What bots posted there (receipts, routine reports) does not count. With `desktopLines`, a line with no
 * sender (a conversation copied from the owner's desktop) is the owner's too. */
export function ownerSpokeOnly(thread: readonly Line[], starters: readonly (string | undefined)[], ownerPerson: (person: string | undefined) => boolean,
  cardAnswerer: (card: NonNullable<Card>) => string | undefined, desktopLines = false): boolean {
  const spoke = (line: Line) => line.role !== "user" || (!line.peerAsk && (line.sender?.id ? ownerPerson(line.sender.id) : desktopLines));
  return starters.every((person) => person === undefined || ownerPerson(person)) && !thread.some((line) => line.webhookPost) &&
    thread.every((line) => spoke(line) && (!answeredByPerson(line.card) || ownerPerson(cardAnswerer(line.card!))));
}

export interface OwnersRoutinesInput {
  routines: readonly { id: string; sourceThreadId?: string }[];
  nobodyKey: string;
  writer(id: string): string | undefined;
  recorded(id: string): boolean;
  thread(threadId: string): readonly Line[];
  starters(threadId: string): readonly (string | undefined)[];
  /** A key proven the owner's, as lending and memory require. */
  ownerPerson(person: string | undefined): boolean;
  reportFromOthers(line: Line): boolean;
  cardAnswerer(card: NonNullable<Card>): string | undefined;
  /** What the routine runs now, and what its creating card showed, in one comparable form. */
  shape(id: string): string | undefined;
  cardShape(line: Line): string | undefined;
}

/** The conversation up to the card that made this routine, when only the owner spoke there and it still runs what that card showed. */
function madeInChat(routine: OwnersRoutinesInput["routines"][number], input: OwnersRoutinesInput, desktopLines: boolean): readonly Line[] | null {
  if (!routine.sourceThreadId) return null;
  const thread = input.thread(routine.sourceThreadId);
  const made = thread.findIndex((line) => line.card?.routineRequest?.resultId === routine.id && line.card.routineRequest.operation.action === "create");
  if (made < 0 || thread[made]!.card?.answered !== "allow") return null;
  const shape = input.shape(routine.id), upTo = thread.slice(0, made + 1);
  return shape !== undefined && shape === input.cardShape(thread[made]!) &&
    ownerSpokeOnly(upTo, input.starters(routine.sourceThreadId), input.ownerPerson, input.cardAnswerer, desktopLines) ? upTo : null;
}

/** Nobody's routines that a bot made in a conversation only the owner spoke in, and that still run exactly what that card showed;
 * `proven` when that conversation held no report of anyone else's routine before the card either. */
export function ownersRoutinesMadeInChat(input: OwnersRoutinesInput): Array<{ id: string; proven: boolean }> {
  return input.routines.flatMap((routine) => {
    if (input.writer(routine.id) !== input.nobodyKey || input.recorded(routine.id)) return [];
    const upTo = madeInChat(routine, input, false);
    return upTo ? [{ id: routine.id, proven: !upTo.some(input.reportFromOthers) }] : [];
  });
}

/** When a Cloud first becomes shared, the routines made while only its owner existed stay the owner's: those a bot made in a
 * conversation only the owner spoke in (copied desktop lines included) that no webhook drove. Any other is left to confinement. */
export function routinesKeptAtSharing(input: OwnersRoutinesInput & { outsideThread(threadId: string): boolean }): string[] {
  return input.routines.filter((routine) => {
    const writer = input.writer(routine.id);
    return (writer === undefined || writer === input.nobodyKey) && routine.sourceThreadId !== undefined &&
      !input.outsideThread(routine.sourceThreadId) && madeInChat(routine, input, true) !== null;
  }).map((routine) => routine.id);
}

/** What a routine runs, for comparing against what a person or a card saw; never the moving schedule anchor. */
export function approvalShape(shape: { prompt?: string; botId?: string; runOn?: string; schedule?: unknown; target?: string; groupId?: string | null; attachments?: { id: string; path: string }[] }): string {
  const schedule = shape.schedule && typeof shape.schedule === "object" ? { ...(shape.schedule as Record<string, unknown>) } : null;
  if (schedule) delete schedule.anchorAt;
  return JSON.stringify([shape.prompt ?? "", shape.botId ?? "", shape.runOn ?? "maus", schedule, shape.target ?? "bot", shape.groupId ?? null,
    (shape.attachments ?? []).map((attachment) => [attachment.id, attachment.path])]);
}

/** What a bot's create card showed, in approvalShape's form, its schedule read as the card's own `asSchedule` read it. */
export function createdShape(line: { card?: { routineRequest?: RoutineRequestCardData } }, schedule: typeof asSchedule): string | undefined {
  const request = line.card?.routineRequest;
  if (request?.operation.action !== "create") return undefined;
  const definition = request.operation.routine;
  return approvalShape({ prompt: definition.instructions, botId: request.operation.forBot?.botId ?? request.botId, runOn: definition.runOn, schedule: schedule(definition.schedule, 0) });
}

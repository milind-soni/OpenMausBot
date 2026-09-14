// The board's own logic, with no React in it.
//
// Everything here answers a question about the cards a client has already
// fetched: which team is showing, what each column holds, what a drag does to
// the order, and what a card is trying to tell you about itself. Keeping it
// pure means the interesting cases — a card with no owner, a card whose bot
// was deleted, a drop between two neighbours — are testable without a DOM,
// and the components stay a description of what to draw.
//
// The rules mirror the server's, deliberately: the board arrives already
// filtered by team, but a `?team=` request races a bot being reassigned, so
// the client re-applies the same predicate rather than trusting a snapshot.
import { t } from "@/lib/i18n";
import { addDays, startOfDay } from "@/lib/routine-calendar";

/** Where a card shows on the board, left to right. The order is the board's
 * layout, so it lives here rather than in each component. */
export const WORK_COLUMNS = ["backlog", "todo", "in_progress", "blocked", "done", "cancelled"] as const;

export type WorkColumn = (typeof WORK_COLUMNS)[number];

export interface BoardAgent {
  id: string;
  name: string;
  section?: string;
  activity?: string;
  busy?: boolean;
  hidden?: boolean;
}

export interface BoardCard {
  id: string;
  boardId?: string;
  title: string;
  brief?: string;
  status: WorkColumn;
  order: number;
  ownerBotId?: string;
  threadId?: string;
  routineId?: string;
  origin?: "manual" | "routine";
  artifacts?: Array<{ kind: string; ref: string; label?: string }>;
  createdAt: number;
  updatedAt: number;
  /** The day this card is for, as the start of that local day. Absent on
   * cards made before the board had days — those belong to their creation
   * day, which `cardDay` resolves. */
  day?: number;
  /** When the work should be finished by. Display only: nothing starts or
   * moves because of it, which is what makes it safe to set. */
  dueAt?: number;
  startedAt?: number;
  /** When the last run finished. Absent while a run is going, so the card can
   * tell "still counting" from "took this long" without guessing. */
  finishedAt?: number;
  lastError?: string;
  /** The server found an unanswered ask on this card's thread: the bot asked
   * something and is stopped until a person answers it. */
  waiting?: boolean;
  /** What the server reported about the card's owner, already reduced to the
   * team the card belongs to. Absent when the card has no owner. */
  agent?: BoardAgent | null;
}

/** The day a card belongs to, as the start of that local day.
 *
 * A card made for a date carries that date; anything else belongs to the day
 * it was made. Falling back to `createdAt` is what makes the day filter safe
 * to turn on for a board that already has cards on it — every existing card
 * lands on a real day instead of vanishing into a "no date" limbo, and none of
 * them need migrating.
 *
 * Local midnight, not UTC: "today" is the viewer's today, and a card made at
 * 00:30 belongs to the day the person was living in when they made it. */
export function cardDay(card: BoardCard): number {
  return startOfDay(card.day ?? card.createdAt);
}

/** Only the cards belonging to one day. `day` is the start of that local day;
 * `null` means every day, which is how a caller asks for the whole board when
 * it does not have a day to narrow to. */
export function filterByDay(cards: BoardCard[], day: number | null): BoardCard[] {
  if (day === null) return cards;
  return cards.filter((card) => cardDay(card) === day);
}

/** The three days the switcher always offers, relative to now: yesterday,
 * today and tomorrow, as the start of each local day.
 *
 * These are named rather than chosen because they are the days a person
 * actually moves between while working. Every other date is reached through
 * the calendar, which is what keeps this row to three chips instead of
 * growing a button per day that has ever held a card. */
export function relativeDays(now: number): { yesterday: number; today: number; tomorrow: number } {
  const today = startOfDay(now);
  return { yesterday: addDays(today, -1), today, tomorrow: addDays(today, 1) };
}

/** How many cards sit on each day, for the picker to show what a date holds
 * before someone switches to it. Days with nothing are simply absent. */
export function cardsByDay(cards: BoardCard[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const card of cards) {
    const day = cardDay(card);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}

/** Whether a card is late: it carries a due time that has passed and the work
 * has not reached a terminal column.
 *
 * Display only. Nothing about the board's behaviour changes because a card is
 * late — no turn starts, nothing moves — which is the whole reason a due date
 * is safe to add. */
export function isOverdue(card: BoardCard, now: number): boolean {
  if (typeof card.dueAt !== "number") return false;
  if (card.status === "done" || card.status === "cancelled") return false;
  return card.dueAt < now;
}

/** Whether a card's day is today. Local, like `cardDay`: a card made for
 * today means the viewer's today, and a viewer an hour from midnight must not
 * be told their own card is for tomorrow. */
export function isToday(card: BoardCard, now: number): boolean {
  return cardDay(card) === startOfDay(now);
}

/** What a card's day means to the person reading it, in one short phrase:
 * "Today", "Tomorrow", "Yesterday", or a plain date further out.
 *
 * Relative words only for the three days a person actually thinks in, because
 * "Today" is instantly readable where "14 Sep" makes the reader work out what
 * day it is first. Past that the date is unambiguous and the relative word
 * would not be. Pure, with `t` and the clock injected so the boundaries are
 * testable without waiting for midnight. */
export function dayLabel(day: number, now: number, translate: typeof t = t): string {
  const delta = Math.round((startOfDay(day) - startOfDay(now)) / 86_400_000);
  if (delta === 0) return translate("taskBoard.day.today");
  if (delta === 1) return translate("taskBoard.day.tomorrow");
  if (delta === -1) return translate("taskBoard.day.yesterday");
  return new Date(day).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Whether a day is in the past, relative to now. The board shows past days
 * for reference and refuses to change them — a day that has happened is a
 * record, and editing it would rewrite what happened. */
export function isPastDay(day: number, now: number): boolean {
  return startOfDay(day) < startOfDay(now);
}

/** Which team a card belongs to, as the server computes it.
 *
 * A card reaches a team through its owner's section, and a card with no
 * visible owner falls to the unsectioned team. It must never belong to two
 * teams at once, so this is the single place that decides. */
export function cardSection(card: BoardCard): string {
  const owner = card.agent;
  if (!owner || owner.hidden) return "";
  return owner.section?.trim() ?? "";
}

/** The team a filter string names. `null` is "no filter", which is not the
 * same as `""` — the empty key is the unsectioned team, a real selection. */
export function filterByTeam(cards: BoardCard[], team: string | null): BoardCard[] {
  if (team === null) return cards;
  return cards.filter((card) => cardSection(card) === team);
}

/** Cards grouped into their columns, each column ordered for display.
 *
 * Order is `order` ascending, which is what a drop writes; ties fall back to
 * the newest first so a card created at the same order still lands somewhere
 * stable instead of wherever the sort happens to put it. */
export function columnsOf(cards: BoardCard[]): Record<WorkColumn, BoardCard[]> {
  const columns = Object.fromEntries(WORK_COLUMNS.map((column) => [column, [] as BoardCard[]])) as Record<
    WorkColumn,
    BoardCard[]
  >;
  for (const card of cards) {
    // A card whose status this client does not know about is not lost: it
    // lands in the first column rather than vanishing from every column.
    (columns[card.status] ?? columns.backlog).push(card);
  }
  for (const column of WORK_COLUMNS) {
    columns[column].sort((a, b) => a.order - b.order || b.createdAt - a.createdAt);
  }
  return columns;
}

/** The order value a drop between two neighbours should write.
 *
 * Sparse on purpose: a drop writes one number rather than renumbering the
 * column, so the neighbours' own orders stay untouched. */
export function orderBetween(before: BoardCard | undefined, after: BoardCard | undefined): number {
  if (!before && !after) return 0;
  if (!before) return (after as BoardCard).order - 1;
  if (!after) return before.order + 1;
  return (before.order + after.order) / 2;
}

/** A card's position in its column after `dragged` is dropped where `beforeId`
 * now sits. Returns the patch to send, or null when nothing would change — a
 * drop onto itself must not produce a write. */
export function dropPatch(
  column: BoardCard[],
  draggedId: string,
  beforeId: string | null,
): { order: number } | null {
  const dragged = column.find((card) => card.id === draggedId);
  if (!dragged) return null;
  const rest = column.filter((card) => card.id !== draggedId);
  const at = beforeId === null ? rest.length : rest.findIndex((card) => card.id === beforeId);
  if (at === -1) return null;
  const order = orderBetween(at > 0 ? rest[at - 1] : undefined, rest[at]);
  return order === dragged.order ? null : { order };
}

/** Where a card arriving from ANOTHER column lands among the cards already
 * there. `dropPatch` cannot answer this: it looks the dragged card up in the
 * column, and a card that just crossed columns is not in it yet. */
export function placeIn(column: BoardCard[], beforeId: string | null): number {
  const at = beforeId === null ? column.length : column.findIndex((card) => card.id === beforeId);
  const index = at === -1 ? column.length : at;
  return orderBetween(index > 0 ? column[index - 1] : undefined, column[index]);
}

/** What a card is trying to say about the work right now, in one phrase.
 *
 * The order matters: a failure outranks a running agent, because a card that
 * stopped and said why is more informative than one that merely looks busy. */
export function cardStatusLabel(card: BoardCard): string {
  if (card.lastError) return t("taskBoard.card.failed");
  if (card.waiting) return t("taskBoard.card.waiting");
  if (card.agent?.busy) return t("taskBoard.card.working");
  switch (card.status) {
    case "backlog":
      return t("taskBoard.card.backlog");
    case "todo":
      return t("taskBoard.card.todo");
    case "in_progress":
      return t("taskBoard.card.inProgress");
    case "blocked":
      return t("taskBoard.card.blocked");
    case "done":
      return t("taskBoard.card.done");
    case "cancelled":
      return t("taskBoard.card.cancelled");
  }
}

/** The colour a status chip uses, as the rest of the app names its tones. */
export function statusTone(card: BoardCard): "success" | "warning" | "danger" | "accent" | "idle" {
  if (card.lastError || card.status === "blocked") return "danger";
  if (card.status === "done") return "success";
  if (card.status === "cancelled") return "idle";
  // A question outranks "working": the work has stopped until it is answered,
  // and a card that only looked busy would hide the thing being asked for.
  if (card.waiting) return "warning";
  if (card.agent?.busy || card.status === "in_progress") return "accent";
  return "warning";
}

/** How a card is marked on the board, as one of a small set of states.
 *
 * These are the three things a person scanning the board needs to tell apart
 * without opening anything: a bot that needs an answer, work in flight, and
 * something that went wrong. Everything else is ordinary and gets no mark. */
export type CardMark = "question" | "working" | "error" | "none";

export function cardMark(card: BoardCard): CardMark {
  // An error outranks a question: a card that stopped and said why is telling
  // the person more than one that is merely waiting. `blocked` is not an error
  // — it is a status the board already labels, and painting it red would make
  // the red outline mean two different things.
  if (card.lastError) return "error";
  if (card.waiting) return "question";
  if (card.agent?.busy) return "working";
  return "none";
}

/** Whether Run can be pressed, and why not when it cannot.
 *
 * The board is where the person looking at the button is, so a disabled
 * button always says what is missing rather than being inert. */
export function runAvailability(card: BoardCard):
  | { canRun: true }
  | { canRun: false; reason: string } {
  if (!card.ownerBotId) return { canRun: false, reason: t("taskBoard.run.needsAgent") };
  if (!card.agent) return { canRun: false, reason: t("taskBoard.run.agentGone") };
  if (card.agent.busy) return { canRun: false, reason: t("taskBoard.run.alreadyWorking") };
  return { canRun: true };
}

/** Whether Stop can be pressed. Stopping a card that never started would
 * reach the bot's unrelated work, so the card must have a thread of its own
 * and something must actually be running on it. */
export function stopAvailability(card: BoardCard): boolean {
  return Boolean(card.threadId) && Boolean(card.agent);
}

/** How long the card's run took, or has been running for so far.
 *
 * Two real bugs lived in the previous version. It kept counting after the
 * turn ended, because a settled card still carried `startedAt`; and when
 * there was no run at all it fell back to "time since the card last changed"
 * and formatted that as if it were elapsed work, so a card nobody had started
 * showed a duration that meant nothing.
 *
 * So: a live run counts up from its start; a finished run reports the length
 * it took and stops; a card with no run shows nothing rather than a number
 * that would be read as one. `format` is passed in for testability. */
export function elapsedLabel(card: BoardCard, now: number, format: (ms: number) => string): string | null {
  if (!card.startedAt) return null;
  // `finishedAt` is what makes the clock stop; without it the run is still
  // going and `now` is as far as it has got.
  const end = card.finishedAt ?? now;
  return format(Math.max(0, end - card.startedAt));
}

/** Whether the card's own run is still going, which is what decides between a
 * counted-up time and a fixed duration. Kept beside `elapsedLabel` so the two
 * cannot disagree about which one is being shown. */
export function runIsLive(card: BoardCard): boolean {
  return typeof card.startedAt === "number" && card.finishedAt === undefined;
}
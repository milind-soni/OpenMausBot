// The Team Board's rules, with no storage: which moves an item may make and who may make them, what a valid item is,
// and which waiting items become ready. Every function returns new items and never changes the ones it is given.
import {
  BOARD_LABEL_KEY, BOARD_LIMITS, BOARD_OPEN_STATES, type BoardItem, type BoardItemState,
} from "../../shared/board.ts";

export type BoardErrorCode = "board_bad_input" | "board_bad_move" | "board_not_found" | "board_full" | "board_exists" | "board_cycle";

export class BoardError extends Error {
  readonly status: number;
  readonly code: BoardErrorCode;
  constructor(status: number, code: BoardErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badInput = (message: string) => new BoardError(400, "board_bad_input", message);
const badMove = (message: string) => new BoardError(409, "board_bad_move", message);

/** Who asks for a move. `dispatcher`: the server itself, giving work to bots and taking it back when a turn ends. */
export type BoardActor = { kind: "person"; person: string } | { kind: "bot"; botId: string } | { kind: "dispatcher" };

export type BoardMove =
  | { move: "take"; botId: string }
  | { move: "done"; result?: string }
  | { move: "failed"; result?: string }
  | { move: "ask"; question: string; person?: string }
  /** The holder sets the item aside until `at`; the dispatcher's `wake` starts it again then, with `note`. */
  | { move: "later"; at: number; note: string }
  | { move: "wake" }
  /** With `later`, the holder is started again when it is free rather than by the person's own line. */
  | { move: "resume"; later?: { at: number; note: string } }
  | { move: "release" }
  | { move: "cancel"; result?: string }
  | { move: "reopen" };

export const isOpen = (state: BoardItemState): boolean => BOARD_OPEN_STATES.includes(state);

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

export function boardTitle(raw: unknown): string {
  if (typeof raw !== "string" || !oneLine(raw)) throw badInput("Give the item a title.");
  const title = oneLine(raw);
  if (title.length > BOARD_LIMITS.titleMax) throw badInput(`A title is at most ${BOARD_LIMITS.titleMax} characters.`);
  return title;
}

export function boardLabels(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badInput("labels must be an object of short texts.");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > BOARD_LIMITS.labelsMax) throw badInput(`An item has at most ${BOARD_LIMITS.labelsMax} labels.`);
  const labels: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!BOARD_LABEL_KEY.test(key)) throw badInput(`The label "${key.slice(0, 40)}" needs a key of at most ${BOARD_LIMITS.labelKeyMax} lowercase letters, digits, _ or -.`);
    if (typeof value !== "string") throw badInput(`The label "${key}" needs a text value.`);
    const text = oneLine(value);
    if (text.length > BOARD_LIMITS.labelValueMax) throw badInput(`The label "${key}" is at most ${BOARD_LIMITS.labelValueMax} characters.`);
    labels[key] = text;
  }
  return labels;
}

export function boardResult(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw badInput("result must be text.");
  if (raw.length > BOARD_LIMITS.resultMax) throw badInput(`A result is at most ${BOARD_LIMITS.resultMax} characters.`);
  return raw.trim() || undefined;
}

/** Whether `threadId` needing `needs` closes a loop: some need, through its own needs, already needs `threadId`. */
export function closesCycle(items: readonly BoardItem[], threadId: string, needs: readonly string[]): boolean {
  const byId = new Map(items.map((item) => [item.threadId, item]));
  const seen = new Set<string>();
  const stack = [...needs];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === threadId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.needs ?? []));
  }
  return false;
}

/** The needs of `threadId`, checked against the board: other items of the same room, at most ten, with no loop. */
export function boardNeeds(raw: unknown, items: readonly BoardItem[], self: { threadId: string; groupId: string }): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) throw badInput("needs must be a list of item thread ids.");
  const needs = [...new Set(raw as string[])];
  if (needs.length > BOARD_LIMITS.needsMax) throw badInput(`An item needs at most ${BOARD_LIMITS.needsMax} others.`);
  for (const id of needs) {
    if (id === self.threadId) throw badInput("An item cannot need itself.");
    const need = items.find((item) => item.threadId === id);
    if (!need || need.groupId !== self.groupId) throw badInput("Each need must be an item in the same room.");
  }
  if (closesCycle(items, self.threadId, needs)) throw new BoardError(409, "board_cycle", "Those needs would make items wait for each other forever.");
  return needs;
}

export function needsMet(item: Pick<BoardItem, "needs">, items: readonly BoardItem[]): boolean {
  return item.needs.every((id) => items.find((other) => other.threadId === id)?.state === "done");
}

/** Where a new item, or one whose needs changed while not yet taken, starts. */
export const startState = (item: Pick<BoardItem, "needs">, items: readonly BoardItem[]): "waiting" | "ready" =>
  needsMet(item, items) ? "ready" : "waiting";

const holds = (item: BoardItem, actor: BoardActor) => actor.kind === "bot" && item.holder?.botId === actor.botId;
const madeIt = (item: BoardItem, actor: BoardActor) => actor.kind === "bot" && item.createdBy.kind === "bot" && item.createdBy.id === actor.botId;

/** Who may make each move, from which states. */
function allowed(item: BoardItem, move: BoardMove["move"], actor: BoardActor): boolean {
  const { state } = item;
  const person = actor.kind === "person";
  const dispatcher = actor.kind === "dispatcher";
  switch (move) {
    case "take": return dispatcher && state === "ready";
    case "done": return state === "working" ? person || dispatcher || holds(item, actor) : person && isOpen(state);
    case "failed": return state === "working" && (dispatcher || holds(item, actor));
    case "ask": return state === "working" && holds(item, actor);
    case "later": return state === "working" && holds(item, actor);
    case "wake": return state === "working" && dispatcher && item.later !== undefined;
    case "resume": return state === "needs_person" && dispatcher;
    case "release": return state === "working" ? dispatcher || holds(item, actor) : state === "needs_person" && (person || dispatcher);
    case "cancel": return isOpen(state) && (person || madeIt(item, actor));
    case "reopen": return !isOpen(state) && person;
  }
}

const settle = (item: BoardItem, state: BoardItemState, result: string | undefined, now: number): BoardItem => {
  const { holder: _holder, question: _question, later: _later, ...rest } = item;
  return { ...rest, state, ...(result !== undefined ? { result } : {}), updatedAt: now };
};

/** The item after `move`, or a 409 `board_bad_move` when this actor may not make it from where the item is. */
export function applyMove(item: BoardItem, move: BoardMove, actor: BoardActor, items: readonly BoardItem[], now: number): BoardItem {
  if (!allowed(item, move.move, actor)) throw badMove(`This item is ${item.state.replace("_", " ")}: it cannot be moved to ${move.move} now.`);
  switch (move.move) {
    case "take": {
      const { question: _question, result: _result, later: _later, ...rest } = item;
      return { ...rest, state: "working", holder: { botId: move.botId, since: now }, attempts: item.attempts + 1, updatedAt: now };
    }
    case "done":
    case "failed":
    case "cancel":
      return settle(item, move.move === "cancel" ? "cancelled" : move.move, boardResult(move.result), now);
    case "ask": {
      const text = typeof move.question === "string" ? move.question.trim() : "";
      if (!text) throw badInput("Say what you want to ask.");
      if (text.length > BOARD_LIMITS.questionMax) throw badInput(`A question is at most ${BOARD_LIMITS.questionMax} characters.`);
      const { later: _later, ...rest } = item;
      return { ...rest, state: "needs_person", question: { text, askedAt: now, ...(move.person ? { person: move.person } : {}) }, updatedAt: now };
    }
    case "later": {
      const note = typeof move.note === "string" ? move.note.trim() : "";
      if (!note) throw badInput("Say what to look at again.");
      if (note.length > BOARD_LIMITS.questionMax) throw badInput(`A note is at most ${BOARD_LIMITS.questionMax} characters.`);
      if (!Number.isFinite(move.at) || move.at <= now) throw badInput("Pick a time ahead.");
      const count = item.laterCount ?? 0;
      if (count >= BOARD_LIMITS.latersMax) throw badMove(`This item was already set aside ${BOARD_LIMITS.latersMax} times, the most it may be.`);
      return { ...item, later: { at: move.at, note }, laterCount: count + 1, updatedAt: now };
    }
    case "wake": {
      const { later: _later, ...rest } = item;
      return { ...rest, holder: { botId: item.holder!.botId, since: now }, updatedAt: now };
    }
    case "resume": {
      const { question: _question, later: _later, ...rest } = item;
      return { ...rest, state: "working", holder: { botId: item.holder!.botId, since: now }, ...(move.later ? { later: { ...move.later } } : {}), updatedAt: now };
    }
    case "release": {
      const { holder: _holder, question: _question, later: _later, ...rest } = item;
      return { ...rest, state: "ready", updatedAt: now };
    }
    case "reopen": {
      const { holder: _holder, question: _question, result: _result, later: _later, laterCount: _laterCount, ...rest } = item;
      return { ...rest, state: startState(item, items), attempts: 0, updatedAt: now };
    }
  }
}

/** Waiting items whose every need is now done, made ready. A failed or cancelled need readies nothing. */
export function promote(items: readonly BoardItem[], now: number): BoardItem[] {
  return items.map((item) => item.state === "waiting" && needsMet(item, items) ? { ...item, state: "ready" as const, updatedAt: now } : item);
}

/** The board without the items in `gone`, each other item's needs of them dropped, and what that readies made ready. */
export function withoutItems(items: readonly BoardItem[], gone: ReadonlySet<string>, now: number): BoardItem[] {
  const kept = items.filter((item) => !gone.has(item.threadId)).map((item) => item.needs.some((id) => gone.has(id))
    ? { ...item, needs: item.needs.filter((id) => !gone.has(id)), updatedAt: now } : item);
  return promote(kept, now);
}

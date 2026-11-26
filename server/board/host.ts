// The Team Board's items, kept in `board.json`: made, moved, changed and removed here, each change saved before it is
// told to `onChange` listeners. An item whose room or thread is gone is dropped the next time the board is read.
import { join } from "node:path";

import type { BoardItem, BoardItemCreator, BoardItemState } from "../../shared/board.ts";
import { BOARD_LIMITS } from "../../shared/board.ts";
import {
  applyMove, boardLabels, boardNeeds, boardResult, boardTitle, BoardError, isOpen, promote, startState, withoutItems,
  type BoardActor, type BoardMove,
} from "./state.ts";
import { BOARD_FILE, readBoardFile, writeBoardFile, type BoardFile } from "./store.ts";

export interface BoardDeps {
  dataDir: string;
  file?: string;
  now?: () => number;
  /** False once the room or its thread is gone. */
  alive(groupId: string, threadId: string): boolean;
  /** The bots in the room, or null for no such room. */
  roomBots(groupId: string): readonly string[] | null;
  log?(text: string): void;
}

export interface NewBoardItem {
  groupId: string;
  title: unknown;
  needs?: unknown;
  labels?: unknown;
  forBotId?: unknown;
  createdBy: BoardItemCreator;
  /** An existing room thread to make the item of; without it `openThread` makes one. */
  threadId?: string;
}

export interface BoardPatch {
  move?: BoardMove;
  title?: unknown;
  labels?: unknown;
  needs?: unknown;
  forBotId?: unknown;
  result?: unknown;
}

export interface BoardChange {
  groupId: string;
  threadId: string;
  item: BoardItem | null;
}

export interface BoardFilter {
  groupId?: string;
  state?: BoardItemState;
}

export function createBoard(deps: BoardDeps) {
  const file = deps.file ?? join(deps.dataDir, BOARD_FILE);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((text: string) => console.error(text));
  let board: BoardFile | null = null;
  const listeners = new Set<(change: BoardChange) => void>();

  const loaded = (): BoardFile => (board ??= readBoardFile(file));
  const copy = (item: BoardItem): BoardItem => ({ ...item, needs: [...item.needs], labels: { ...item.labels } });

  /** Saves the board `next` makes of the current items, then tells listeners each item that changed. */
  function commit(next: (items: readonly BoardItem[]) => BoardItem[]): void {
    const current = loaded();
    const items = next(current.items);
    writeBoardFile(file, { items, repeats: current.repeats });
    board = { items, repeats: current.repeats };
    const before = new Map(current.items.map((item) => [item.threadId, item]));
    const changes: BoardChange[] = [];
    for (const item of items) {
      if (before.get(item.threadId) !== item) changes.push({ groupId: item.groupId, threadId: item.threadId, item: copy(item) });
      before.delete(item.threadId);
    }
    for (const gone of before.values()) changes.push({ groupId: gone.groupId, threadId: gone.threadId, item: null });
    for (const change of changes) {
      for (const listener of listeners) {
        try { listener(change); } catch (error) { log(`board: a listener failed: ${String(error)}`); }
      }
    }
  }

  /** The items whose room thread is still here; the others are dropped from the file. */
  function live(): readonly BoardItem[] {
    const items = loaded().items;
    const gone = new Set(items.filter((item) => !deps.alive(item.groupId, item.threadId)).map((item) => item.threadId));
    if (gone.size) {
      try { commit((current) => withoutItems(current, gone, now())); } catch (error) { log(`board: could not drop items of gone threads: ${String(error)}`); }
    }
    return loaded().items.filter((item) => !gone.has(item.threadId));
  }

  function found(threadId: string): BoardItem {
    const item = live().find((candidate) => candidate.threadId === threadId);
    if (!item) throw new BoardError(404, "board_not_found", "No board item on that thread.");
    return item;
  }

  function botFor(groupId: string, raw: unknown): string | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !raw) throw new BoardError(400, "board_bad_input", "forBotId must be a bot id.");
    if (!deps.roomBots(groupId)?.includes(raw)) throw new BoardError(400, "board_bad_input", "That bot is not in this room.");
    return raw;
  }

  /** One move, then the fields of `change`, as one change; items it readies change with it. */
  function patch(threadId: string, change: BoardPatch, actor: BoardActor): BoardItem {
    const items = live();
    let item = found(threadId);
    const at = now();
    if (change.move) item = applyMove(item, change.move, actor, items, at);
    if (change.title !== undefined) item = { ...item, title: boardTitle(change.title) };
    if (change.labels !== undefined) item = { ...item, labels: boardLabels(change.labels) };
    if (change.forBotId !== undefined) {
      const { forBotId: _forBotId, ...rest } = item;
      const bot = change.forBotId === null ? undefined : botFor(item.groupId, change.forBotId);
      item = { ...rest, ...(bot ? { forBotId: bot } : {}) };
    }
    if (change.needs !== undefined) {
      if (item.state !== "waiting" && item.state !== "ready") throw new BoardError(409, "board_bad_move", "Change what an item needs only before a bot takes it.");
      const needs = boardNeeds(change.needs, items, item);
      item = { ...item, needs, state: startState({ needs }, items) };
    }
    if (change.result !== undefined) {
      if (isOpen(item.state)) throw new BoardError(409, "board_bad_move", "An item gets a result when it is done, failed or cancelled.");
      const { result: _result, ...rest } = item;
      const result = boardResult(change.result);
      item = { ...rest, ...(result ? { result } : {}) };
    }
    const changed = { ...item, updatedAt: at };
    commit((current) => promote(current.map((other) => other.threadId === threadId ? changed : other), at));
    return copy(loaded().items.find((other) => other.threadId === threadId) ?? changed);
  }

  return {
    /** Items oldest first. */
    list(filter: BoardFilter = {}): BoardItem[] {
      return live().filter((item) => (!filter.groupId || item.groupId === filter.groupId) && (!filter.state || item.state === filter.state))
        .sort((a, b) => a.createdAt - b.createdAt).map(copy);
    },

    get(threadId: string): BoardItem | null {
      const item = live().find((candidate) => candidate.threadId === threadId);
      return item ? copy(item) : null;
    },

    /** Checks everything first, then opens the thread (when `input.threadId` is absent), then saves the item. */
    create(input: NewBoardItem, openThread?: (title: string) => string): BoardItem {
      const items = live();
      if (!deps.roomBots(input.groupId)) throw new BoardError(404, "board_not_found", "No such room.");
      if (input.threadId && !deps.alive(input.groupId, input.threadId)) throw new BoardError(404, "board_not_found", "No such thread in that room.");
      if (input.threadId && items.some((item) => item.threadId === input.threadId)) throw new BoardError(409, "board_exists", "That thread is already a board item.");
      if (items.filter((item) => item.groupId === input.groupId && isOpen(item.state)).length >= BOARD_LIMITS.openPerRoom) {
        throw new BoardError(409, "board_full", `This room already has ${BOARD_LIMITS.openPerRoom} open items, the most it may. Finish or cancel some first.`);
      }
      const title = boardTitle(input.title);
      const labels = boardLabels(input.labels);
      const forBotId = botFor(input.groupId, input.forBotId);
      const needs = boardNeeds(input.needs, items, { threadId: input.threadId ?? "", groupId: input.groupId });
      if (!input.threadId && !openThread) throw new BoardError(400, "board_bad_input", "Name the thread the item is on.");
      const threadId = input.threadId ?? openThread!(title);
      const at = now();
      const item: BoardItem = {
        threadId, groupId: input.groupId, title, state: startState({ needs }, items), needs, labels,
        ...(forBotId ? { forBotId } : {}), attempts: 0, createdBy: { ...input.createdBy }, createdAt: at, updatedAt: at,
      };
      commit((current) => [...current, item]);
      return copy(item);
    },

    patch,

    move(threadId: string, move: BoardMove, actor: BoardActor): BoardItem {
      return patch(threadId, { move }, actor);
    },

    /** Removes the item only: its thread stays. Items that needed it no longer do. */
    remove(threadId: string): BoardItem | null {
      const item = live().find((candidate) => candidate.threadId === threadId);
      if (!item) return null;
      commit((current) => withoutItems(current, new Set([threadId]), now()));
      return copy(item);
    },

    /** Every saved change, one item at a time; `item: null` when it was removed. Returns the unsubscribe. */
    onChange(listener: (change: BoardChange) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type Board = ReturnType<typeof createBoard>;

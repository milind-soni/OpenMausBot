// The Team Board's dispatcher: the server, not the bots, hands each ready item to a free member bot of its room and starts
// that bot's turn in the item's thread. A bot runs one room turn at a time and only when idle everywhere, so work is
// scheduled per bot: a bot that is busy, or already holds an item it is working on, gets nothing new. The bot settles the
// item with board_update; a turn that ends without settling it hands the item back (the "lease" is the turn itself), and
// the third such end fails it. Nothing starts in the first minutes after the server starts: the runtime re-runs a room
// turn a restart cut, and owns those minutes.
import { BOARD_LIMITS, type BoardItem } from "../../shared/board.ts";
import { startDueTimer, type DueTimer } from "../due-timer.ts";
import type { Board } from "./host.ts";

/** No dispatch, and no lease check, this long after the server starts. */
export const BOARD_QUIET_MS = 2 * 60_000;
/** A working item whose thread is idle this long after its bot took it lost its turn. */
export const BOARD_LEASE_MS = 20_000;
/** A bot whose model is missing is passed over this long. */
export const BOARD_MODEL_SKIP_MS = 10 * 60_000;
/** An item whose start the server refused waits this long before it is tried again. */
export const BOARD_START_RETRY_MS = 60_000;
/** How often the dispatcher looks again while something waits on a bot or a turn. */
export const BOARD_RETRY_MS = 15_000;

/** What the bot is told: the item handed to it, or the item it set aside (or a person answered) coming back. */
export type BoardBrief = { kind: "take"; item: BoardItem; botId: string } | { kind: "wake"; item: BoardItem; botId: string; note: string };

export interface BoardDispatchDeps {
  board: Pick<Board, "list" | "get" | "move" | "onChange">;
  /** A Team Cloud with `features.teamBoard` on. */
  on(): boolean;
  now?: () => number;
  /** The room's member bots, in the room's order; null for no such room. */
  roomBots(groupId: string): readonly string[] | null;
  /** The bot may start a room turn in this thread now: it exists, is not hidden, held, paused or busy anywhere. */
  botFree(botId: string, groupId: string, threadId: string): boolean;
  threadWorking(groupId: string, threadId: string): boolean;
  /** A spend or usage cap that refuses unattended work for this bot now, and when it lifts. */
  capped(botId: string): { resetsAt: number } | null;
  modelReady(botId: string): boolean;
  brief(brief: BoardBrief): string;
  /** Starts the bot's turn in the item's thread as unattended work; throws when the server refuses to start it. */
  start(item: BoardItem, botId: string, text: string): void;
  /** The result of an item whose turn ended without settling it `BOARD_LIMITS.triesMax` times. */
  stoppedResult(item: BoardItem): string;
  /** Multiplies every wait above; only tests set it. */
  timeScale?: number;
  log?(text: string): void;
}

export function createBoardDispatcher(deps: BoardDispatchDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((text: string) => console.error(text));
  const scale = deps.timeScale && deps.timeScale > 0 ? deps.timeScale : 1;
  const quietUntil = now() + BOARD_QUIET_MS * scale;
  const leaseMs = BOARD_LEASE_MS * scale;
  /** Bots passed over until then (a missing model). */
  const skipBot = new Map<string, number>();
  /** Items whose start was refused, until then. */
  const holdItem = new Map<string, number>();
  /** Every dispatch waits until then: a spend or usage cap refused unattended work. */
  let cappedUntil = 0;
  let timer: DueTimer | null = null;
  let running = false;
  // A change only asks for a look: the run itself makes changes, so it never runs inside a listener.
  deps.board.onChange(() => timer?.poke());

  const due = (at: number | undefined, t: number) => at !== undefined && at > t;
  /** The item's bot is on it now: working, not set aside. */
  const active = (item: BoardItem) => item.state === "working" && item.later === undefined;
  const holdsActive = (items: readonly BoardItem[], botId: string) => items.some((item) => active(item) && item.holder?.botId === botId);

  function move(item: BoardItem, change: Parameters<Board["move"]>[1]): BoardItem | null {
    try {
      return deps.board.move(item.threadId, change, { kind: "dispatcher" });
    } catch (error) {
      log(`board: could not ${change.move} item ${item.threadId}: ${String(error)}`);
      return null;
    }
  }

  /** A turn on the item ended, or never started, without settling it: back to ready, or failed after the last try. */
  function lost(item: BoardItem): void {
    if (item.attempts >= BOARD_LIMITS.triesMax) move(item, { move: "failed", result: deps.stoppedResult(item) });
    else move(item, { move: "release" });
  }

  /** Whether all dispatch must wait on a cap for this bot; the pause is the whole board's, and no attempt is counted. */
  function stoppedByCap(botId: string, t: number): boolean {
    const cap = deps.capped(botId);
    if (!cap) return false;
    cappedUntil = Math.max(cap.resetsAt, t + BOARD_RETRY_MS);
    log(`board: a spend or usage cap holds every item until ${new Date(cappedUntil).toISOString()}`);
    return true;
  }

  function startTurn(item: BoardItem, botId: string, text: string, t: number): void {
    try {
      deps.start(item, botId, text);
    } catch (error) {
      log(`board: the turn for item ${item.threadId} did not start: ${String(error)}`);
      holdItem.set(item.threadId, t + BOARD_START_RETRY_MS * scale);
      const current = deps.board.get(item.threadId);
      if (current && current.state === "working") lost(current);
    }
  }

  /** Working items whose turn is over: the thread is idle well after the bot took the item. */
  function reconcile(t: number): void {
    for (const item of deps.board.list({ state: "working" })) {
      if (!active(item) || !item.holder || t - item.holder.since < leaseMs) continue;
      if (deps.threadWorking(item.groupId, item.threadId)) continue;
      lost(item);
    }
  }

  /** Items set aside whose time came, each back to its own bot once that bot is free. False when a cap stopped all work. */
  function wake(t: number): boolean {
    for (const item of deps.board.list({ state: "working" })) {
      if (!item.later || !item.holder || item.later.at > t || due(holdItem.get(item.threadId), t)) continue;
      const botId = item.holder.botId;
      // Its bot left the room: anyone of the room may take it again.
      if (!(deps.roomBots(item.groupId) ?? []).includes(botId)) { move(item, { move: "release" }); continue; }
      if (!deps.botFree(botId, item.groupId, item.threadId) || holdsActive(deps.board.list({ state: "working" }), botId)) continue;
      if (deps.threadWorking(item.groupId, item.threadId)) continue;
      if (stoppedByCap(botId, t)) return false;
      if (!deps.modelReady(botId)) continue;
      const note = item.later.note;
      const woken = move(item, { move: "wake" });
      if (woken) startTurn(woken, botId, deps.brief({ kind: "wake", item: woken, botId, note }), t);
    }
    return true;
  }

  /** Each ready item, oldest first, to its own bot or the first free member bot holding no other item. */
  function dispatch(t: number): void {
    for (const item of deps.board.list({ state: "ready" })) {
      if (due(holdItem.get(item.threadId), t) || deps.threadWorking(item.groupId, item.threadId)) continue;
      const members = deps.roomBots(item.groupId) ?? [];
      const candidates = item.forBotId ? members.filter((id) => id === item.forBotId) : members;
      for (const botId of candidates) {
        if (due(skipBot.get(botId), t)) continue;
        if (!deps.botFree(botId, item.groupId, item.threadId) || holdsActive(deps.board.list({ state: "working" }), botId)) continue;
        if (stoppedByCap(botId, t)) return;
        if (!deps.modelReady(botId)) {
          skipBot.set(botId, t + BOARD_MODEL_SKIP_MS * scale);
          log(`board: no model for bot ${botId}; passed over for ${Math.round(BOARD_MODEL_SKIP_MS * scale / 60_000)} min`);
          continue;
        }
        const taken = move(item, { move: "take", botId });
        if (taken) startTurn(taken, botId, deps.brief({ kind: "take", item: taken, botId }), t);
        break;
      }
    }
  }

  async function tick(): Promise<void> {
    if (running || !deps.on()) return;
    running = true;
    try {
      const t = now();
      if (t < quietUntil) return;
      reconcile(t);
      if (t < cappedUntil) return;
      if (!wake(t)) return;
      dispatch(t);
    } finally {
      running = false;
    }
  }

  /** When the dispatcher must look next: now while anything is ready or a turn may have ended, else the soonest wake. */
  function next(): number | null {
    if (!deps.on()) return null;
    const t = now();
    const open = deps.board.list().filter((item) => item.state === "ready" || item.state === "working");
    if (!open.length) return null;
    if (t < quietUntil) return quietUntil;
    let soonest = Infinity;
    for (const item of open) {
      const at = item.state === "ready" ? Math.max(cappedUntil, holdItem.get(item.threadId) ?? 0)
        : item.later ? Math.max(item.later.at, cappedUntil) : (item.holder?.since ?? t) + leaseMs;
      soonest = Math.min(soonest, at);
    }
    return Number.isFinite(soonest) ? soonest : null;
  }

  return {
    start(): void {
      if (timer) return;
      timer = startDueTimer({ run: () => tick(), next, now, retryMs: BOARD_RETRY_MS * scale, onError: (error) => log(`board: dispatch failed: ${String(error)}`) });
    },
    stop(): void {
      timer?.stop();
      timer = null;
    },
    /** Something changed that may free a bot or end a turn: look again soon. */
    poke(): void {
      timer?.poke();
    },
    tick,
    get isTicking(): boolean { return running; },
    /** When a sleeping Cloud must wake: the soonest item set aside, or the end of a cap's pause while work is ready. */
    nextDueAt(): number | null {
      if (!deps.on()) return null;
      const items = deps.board.list();
      const due = items.flatMap((item) => item.state === "working" && item.later ? [Math.max(item.later.at, cappedUntil)]
        : item.state === "ready" && cappedUntil > now() ? [cappedUntil] : []);
      return due.length ? Math.min(...due) : null;
    },
    /** A person wrote in the item's thread, and that line goes to its bot: the item is worked on again. */
    personReplied(threadId: string): BoardItem | null {
      const item = deps.board.get(threadId);
      return item?.state === "needs_person" && item.holder ? move(item, { move: "resume" }) : null;
    },
    /** A person's answer reached the thread from their inbox, which starts no turn: the item goes back to its bot with
     * that answer as soon as the bot is free. */
    answered(threadId: string, note: string): BoardItem | null {
      const item = deps.board.get(threadId);
      if (item?.state !== "needs_person" || !item.holder) return null;
      const resumed = move(item, { move: "resume", later: { at: now(), note } });
      timer?.poke();
      return resumed;
    },
  };
}

export type BoardDispatcher = ReturnType<typeof createBoardDispatcher>;

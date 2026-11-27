// What the one-time move to My Cloud waits for before it freezes this computer (routes/move-freeze.ts), and the same
// for any server that runs it. Only work under way here holds the move, and it is always named:
//
//   a turn answering now     a bot's turn running and not parked on the person or a computer (turn-watchdog.ts
//                            `answering`): waited for as long as it answers; the watchdog stops one that goes silent
//   other work under way     any other turn of a bot's (paused on an approval, starting, queued in a room), a routine
//                            run running, a room's turn, a hand-off starting, queued, running or resuming on a bot and
//                            conversation that exist here, a model sign-in until it expires: each waited for at most
//                            WAIT_CEILING_MS from when the move first saw it, then the move goes ahead
//   never waited for         a hand-off parked on the person (a question or a card) or waiting on teammates, a routine
//                            run waiting on the person, a hand-off or run whose bot or conversation is gone
//
// Parked work goes with its conversation: the move carries every chat row, the person's cards and questions included,
// and they still work on My Cloud; only this computer's note of who waits on whom stays here, so a bot there goes on
// when the person answers in its chat or tells it to, not by itself.
import type { HandoffView } from "./coordinator.ts";

/** What the move waits for: a bot's or room's name, or, with no name, what it is. */
export interface MoveWait { name: string; what: "bot" | "room" | "sign-in" }

/** The longest the move waits on any one thing that is not a turn answering now. */
export const WAIT_CEILING_MS = 30 * 60_000;

/** A hand-off on its way. "waiting" (on the person, or on teammates whose own work is counted by itself) never is. */
const UNDER_WAY: ReadonlySet<HandoffView["status"]> = new Set(["source", "queued", "running", "resume"]);

export interface MoveWaitsDeps {
  bots(): ReadonlyArray<{ id: string; name: string }>;
  rooms(): ReadonlyArray<{ id: string; name: string }>;
  /** A turn of this bot's answering now (turn-watchdog.ts `answering`). */
  answering(botId: string): boolean;
  /** Any turn of this bot's under way here: answering, paused, starting, or queued in a room. */
  turn(botId: string): boolean;
  /** The routines' runs; only a running one counts. */
  runs(): ReadonlyArray<{ id: string; botId: string; groupId?: string; status: string }>;
  /** A turn of this room's running or being set up. */
  roomWorking(roomId: string): boolean;
  /** The coordinator's live hand-offs. */
  handoffs(): readonly HandoffView[];
  /** The hand-off's bot and conversation still exist here, as the coordinator checks them before each turn. */
  exists(node: HandoffView): boolean;
  signingIn(): boolean;
  now?(): number;
}

interface Held { key: string; wait: MoveWait; answering?: true }

/** What the move waits for now, or null when it may freeze this computer. Each call times every thing it finds, so a
 * thing found once and still there a ceiling later no longer holds the move, unless it is a turn answering now. */
export function createMoveWaits(deps: MoveWaitsDeps): () => MoveWait | null {
  const seen = new Map<string, number>();
  return () => {
    const now = (deps.now ?? Date.now)();
    const bots = new Map(deps.bots().map((bot) => [bot.id, bot]));
    const rooms = new Map(deps.rooms().map((room) => [room.id, room]));
    const found: Held[] = [];
    for (const bot of bots.values()) {
      const wait: MoveWait = { name: bot.name, what: "bot" };
      if (deps.answering(bot.id)) found.push({ key: `answering:${bot.id}`, wait, answering: true });
      else if (deps.turn(bot.id)) found.push({ key: `turn:${bot.id}`, wait });
    }
    for (const run of deps.runs()) {
      if (run.status !== "running") continue;
      const bot = bots.get(run.botId), room = run.groupId === undefined ? undefined : rooms.get(run.groupId);
      if (bot) found.push({ key: `run:${run.id}`, wait: { name: bot.name, what: "bot" } });
      else if (room) found.push({ key: `run:${run.id}`, wait: { name: room.name, what: "room" } });
    }
    for (const room of rooms.values()) if (deps.roomWorking(room.id)) found.push({ key: `room:${room.id}`, wait: { name: room.name, what: "room" } });
    for (const node of deps.handoffs()) {
      const bot = bots.get(node.botId);
      if (bot && UNDER_WAY.has(node.status) && deps.exists(node)) found.push({ key: `handoff:${node.id}`, wait: { name: bot.name, what: "bot" } });
    }
    if (deps.signingIn()) found.push({ key: "sign-in", wait: { name: "", what: "sign-in" } });

    const keys = new Set(found.map((held) => held.key));
    for (const key of seen.keys()) if (!keys.has(key)) seen.delete(key);
    for (const key of keys) if (!seen.has(key)) seen.set(key, now);
    const holding = found.filter((held) => held.answering || now - seen.get(held.key)! < WAIT_CEILING_MS);
    return (holding.find((held) => held.answering) ?? holding[0])?.wait ?? null;
  };
}

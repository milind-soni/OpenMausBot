import { existsSync } from "node:fs";
import { join } from "node:path";

import { recentBotsFirst, reorderStable } from "../shared/bot-order.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { BotRecord } from "./store.ts";

const BOTS_PLACED = join(DATA_DIR, "bots-placed");
const BOTS_FILE = join(DATA_DIR, "bots.json");

/** Placement is a whole-list event: every bot gets one stamp, so the list as it stands is kept and only later activity moves a bot. */
export function stampPlaced(bots: BotRecord[]): void {
  const now = Date.now();
  for (const bot of bots) bot.placedAt = now;
}

/** Re-derives the fleet order from activity and placement, in place (schedulers and other consumers hold the array). In memory only: never saves. */
export function applyRecentBotOrder(bots: BotRecord[]): boolean {
  // Once per bot, not per comparison; a reduce because spreading a huge task list into Math.max throws RangeError.
  const active = new Map(bots.map((bot) => [bot, (bot.tasks ?? []).reduce((max, task) => Math.max(max, task.lastThreadOrderAt ?? task.createdAt), 0)] as const));
  const next = recentBotsFirst(bots, (bot) => active.get(bot)!, (bot) => bot.placedAt ?? 0);
  if (next.every((bot, index) => bot === bots[index])) return false;
  bots.splice(0, bots.length, ...next);
  return true;
}

/** A person put these bots in place: the listed ones take the order given (reorderStable) and the whole list, as it now stands, is placed. */
export function placeBots(bots: BotRecord[], ids: string[]): void {
  bots.splice(0, bots.length, ...reorderStable(bots, ids));
  stampPlaced(bots);
}

/** One-time, marker-guarded: every existing (maybe hand-dragged) bot counts as placed now, so updating reshuffles no one. */
export function placeExistingBots(bots: BotRecord[], botsLoaded: boolean, save: () => void): void {
  if (!existsSync(BOTS_PLACED) && (botsLoaded || !existsSync(BOTS_FILE))) {
    stampPlaced(bots);
    save();
    writeFileAtomic(BOTS_PLACED, "Existing bot order is kept; new activity moves a bot to the front.\n", { mode: 0o600 });
  }
  applyRecentBotOrder(bots);
}

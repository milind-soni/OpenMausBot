import { useSyncExternalStore } from "react";
import { BOT_LIMIT_CODE, BOT_PAUSED_CODE, botsTowardLimit } from "../../shared/bot-limit";

/** Which plan limit the popup is about: making bots, work handed out past what runs at once, or a paused bot. */
export type BotLimitReason = "bots" | "tasks" | "paused";

let open: BotLimitReason | null = null;
const listeners = new Set<() => void>();
function setOpen(next: BotLimitReason | null): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export const botLimitShown = () => open !== null;
export const botLimitReason = () => open;
export const showBotLimit = (reason: BotLimitReason = "bots") => setOpen(reason);
export const closeBotLimit = () => setOpen(null);

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useBotLimitOpen(): boolean {
  return useSyncExternalStore(subscribe, botLimitShown);
}

export function useBotLimitReason(): BotLimitReason | null {
  return useSyncExternalStore(subscribe, botLimitReason);
}

/** What a config frame's refusal means for the popup: `seen` is the last refusal noted, null before the first frame, so one
 * from before the page opened never opens it. */
export function planRefusal(seen: number | undefined | null, turns: { refusedAt?: number; refused?: "tasks" | "paused" } | undefined):
  { seen: number | undefined; show: BotLimitReason | null } {
  const at = turns?.refusedAt;
  if (seen === null || at === undefined || at === seen) return { seen: seen === null ? at : seen, show: null };
  return { seen: at, show: turns?.refused ?? "tasks" };
}

/** The bots a Starter Cloud's awake limit counts: the limit's own, its chief of staff aside, which never sleeps. */
export function awakeCandidates<T extends Parameters<typeof botsTowardLimit>[0][number] & { chiefOfStaff?: boolean }>(bots: readonly T[]): T[] {
  return bots.filter((bot) => botsTowardLimit([bot]) === 1 && !bot.chiefOfStaff);
}

type LimitFacts = { config?: { botLimit?: number } | null; bots: Parameters<typeof botsTowardLimit>[0] };

/** How many more bots this plan makes; null when it has no such limit. */
export function botRoom(state: LimitFacts): number | null {
  const limit = state.config?.botLimit;
  return limit === undefined ? null : Math.max(0, limit - botsTowardLimit(state.bots));
}

/** A create button pressed with no room: the popup instead of a form to fill in. */
export function stoppedAtBotLimit(state: LimitFacts): boolean {
  if (botRoom(state) !== 0) return false;
  showBotLimit();
  return true;
}

export function isBotLimitRefusal(error: unknown): boolean {
  return (error as { body?: { code?: unknown } } | null | undefined)?.body?.code === BOT_LIMIT_CODE;
}

export function isBotPausedRefusal(error: unknown): boolean {
  return (error as { body?: { code?: unknown } } | null | undefined)?.body?.code === BOT_PAUSED_CODE;
}

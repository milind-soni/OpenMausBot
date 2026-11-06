import { useSyncExternalStore } from "react";
import { BOT_LIMIT_CODE, botsTowardLimit } from "../../shared/bot-limit";

let open = false;
const listeners = new Set<() => void>();
function setOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export const botLimitShown = () => open;
export const showBotLimit = () => setOpen(true);
export const closeBotLimit = () => setOpen(false);

export function useBotLimitOpen(): boolean {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, botLimitShown);
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

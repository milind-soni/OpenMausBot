import type { Bot, Group, TaskUsage } from "@/state/store";
import { contextShare } from "./usage";

export const CONTEXT_WARNING_PERCENT = 80;

/** The header pill's reading: every thread whose last settled turn filled part of a known window keeps it in view. */
export interface ThreadContextReading {
  tokens: number;
  window?: number;
  percent?: number;
}

export function threadContextWarning(usage: TaskUsage | undefined): ThreadContextReading | null {
  const share = usage ? contextShare(usage) : null;
  if (!share) return null;
  return {
    tokens: share.tokens,
    ...(share.window !== undefined ? { window: share.window } : {}),
    ...(share.percent !== undefined ? { percent: share.percent } : {}),
  };
}

export function roomContextWarnings(group: Pick<Group, "memberContext">, members: readonly Bot[]):
  Array<{ bot: Bot; percent: number; requested: boolean }> {
  return members.flatMap((bot) => {
    const reading = group.memberContext?.[bot.id];
    if (!reading || !(reading.window > 0)) return [];
    const percent = Math.min(999, Math.round((reading.tokens / reading.window) * 100));
    return percent >= CONTEXT_WARNING_PERCENT ? [{ bot, percent, requested: reading.compactRequested === true }] : [];
  });
}

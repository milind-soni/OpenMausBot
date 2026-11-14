import type { Bot, Group, Message, TaskUsage } from "@/state/store";
import { contextShare } from "./usage";

export const CONTEXT_WARNING_PERCENT = 80;

export function compactedSinceReading(messages: readonly Pick<Message, "role" | "kind">[]): boolean {
  const compaction = messages.findLastIndex((message) => message.kind === "compaction");
  if (compaction < 0) return false;
  const reply = messages.findLastIndex((message) => message.role === "bot" && message.kind === "text");
  return compaction > reply;
}

export function threadContextWarning(usage: TaskUsage | undefined, messages: readonly Pick<Message, "role" | "kind">[]): { percent: number } | null {
  const share = usage ? contextShare(usage) : null;
  if (share?.percent === undefined || share.percent < CONTEXT_WARNING_PERCENT) return null;
  if (compactedSinceReading(messages)) return null;
  return { percent: share.percent };
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

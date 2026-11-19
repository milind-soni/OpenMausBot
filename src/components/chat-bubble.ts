import { localDay } from "@/lib/transcript-derivations";
import type { Message } from "@/state/store";

export const plainBotBubble = "chat-text w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink";

export function needsStamp(prev: Message | undefined, first: Message): boolean {
  return !prev || localDay(prev.at) !== localDay(first.at);
}

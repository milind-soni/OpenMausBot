import { visibleMessages } from "@/state/snapshot-navigation";
import type { Bot } from "@/state/store";

// Electron 43 uses ⌘⇧R for force reload, so Start fresh uses K instead.
export const START_FRESH_KEYS = {
  mac: ["⌘", "⇧", "K"],
  win: ["Ctrl", "Shift", "K"],
} as const;

type KeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented" | "isComposing">;

export function isStartFreshShortcut(event: KeyEvent): boolean {
  return !event.defaultPrevented && !event.isComposing
    && (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey
    && event.key.toLowerCase() === "k";
}

export type StartFreshRefusal = "busy" | "empty" | "fresh";

export function startFreshRefusal(bot: Pick<Bot, "busy" | "messages" | "activeLeafId">): StartFreshRefusal | null {
  if (bot.busy) return "busy";
  const messages = visibleMessages(bot);
  if (messages.length === 0) return "empty";
  return messages.at(-1)?.compaction?.fresh === true ? "fresh" : null;
}

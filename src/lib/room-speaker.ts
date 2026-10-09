// Who a room row should name. A bot's text bubbles carry the name, including
// the first bubble after the person speaks and after chips that do not
// themselves show one (a hidden tool run, a digest, a comm line). A tool run
// or card keeps the name only when no text bubble of that bot follows it.

import type { ActivityTranscriptItem } from "./activity-runs";
import { localDay } from "./transcript-derivations";

function isBotText(message: { role: string; kind: string; text?: string; attachments?: readonly unknown[]; from?: { botId: string } }): message is { role: "bot"; kind: "text"; text?: string; attachments?: readonly unknown[]; from: { botId: string }; at: number } {
  return message.role === "bot" && message.kind === "text" && Boolean(message.from?.botId) && Boolean(message.text?.trim() || message.attachments?.length);
}

function laterTextOwns(items: readonly ActivityTranscriptItem[], index: number, botId: string, at: number): boolean {
  for (let cursor = index + 1; cursor < items.length; cursor += 1) {
    const next = items[cursor];
    if (!next || next.kind !== "message") continue;
    const message = next.message;
    if (message.role === "user") return false;
    if (isBotText(message)) {
      return message.from.botId === botId && localDay(message.at) === localDay(at);
    }
  }
  return false;
}

/** The first text bubble of a bot's group, and again after another speaker or a new day. */
export function botTextShowsSpeaker(items: readonly ActivityTranscriptItem[], index: number): boolean {
  const item = items[index];
  if (!item || item.kind !== "message" || !isBotText(item.message)) return false;
  const message = item.message;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const prev = items[cursor];
    if (!prev || prev.kind !== "message") continue;
    const earlier = prev.message;
    if (earlier.role === "user") return true;
    if (isBotText(earlier)) {
      if (earlier.from.botId !== message.from.botId) return true;
      return localDay(earlier.at) !== localDay(message.at);
    }
  }
  return true;
}

/** A folded tool run names its bot only when the following text will not. */
export function runShowsSpeaker(items: readonly ActivityTranscriptItem[], index: number, showToolCalls: boolean): boolean {
  if (!showToolCalls) return false;
  const item = items[index];
  if (!item || item.kind !== "run") return false;
  const first = item.messages[0];
  const botId = first?.from?.botId;
  if (!botId || !first) return false;
  if (laterTextOwns(items, index, botId, first.at)) return false;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const prev = items[cursor];
    if (!prev) continue;
    if (prev.kind === "run") {
      const speaker = prev.messages[0]?.from?.botId;
      if (speaker === botId && localDay(prev.messages[0]!.at) === localDay(first.at)) return false;
      if (speaker && speaker !== botId) return true;
      continue;
    }
    const earlier = prev.message;
    if (earlier.role === "user") return true;
    if (isBotText(earlier)) {
      if (earlier.from.botId !== botId) return true;
      return localDay(earlier.at) !== localDay(first.at);
    }
  }
  return true;
}

export { laterTextOwns };

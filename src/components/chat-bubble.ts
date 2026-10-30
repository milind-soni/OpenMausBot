import { cn } from "@/lib/cn";
import { failedTurnCause } from "@/lib/failed-turn";
import { isStatusActivity } from "@/lib/activity-runs";
import { peerLine, peerRequest } from "@/lib/peer-message";
import { localDay } from "@/lib/transcript-derivations";
import type { TranscriptItem } from "@/lib/activity-runs";
import type { Message } from "@/state/store";
import { isCancelledTranscriptRow } from "../../shared/client-cancel";
import { isPureLeakedSystemHarnessMessage } from "../../shared/system-message-guard.ts";

/** Simple mode's message text: 15/22, the size whose cap height matches the design. */
export const SIMPLE_BUBBLE_TEXT = "text-[15px] leading-[22px]";

const SIMPLE_BUBBLE_SHAPE = `min-w-9 rounded-[18px] px-3 py-[7px] ${SIMPLE_BUBBLE_TEXT}`;

/** Simple mode's bot bubble: the one surface tone. */
export const SIMPLE_BOT_BUBBLE = `${SIMPLE_BUBBLE_SHAPE} bg-card text-ink`;

/** Simple mode's own bubble; the bot's colour, when on, comes from its inline style. */
export const SIMPLE_USER_BUBBLE = `${SIMPLE_BUBBLE_SHAPE} bg-bubble-user font-normal`;

/** At most 560 wide, 80% of the column, and always 82px short of it, so a reply never meets the far edge. */
export const SIMPLE_BUBBLE_MAX = "max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct),calc(100%-82px))]";

/** A plain-text bot bubble drawn outside the transcript's own Bubble: a widget's text fallback or a row that failed. */
export function plainBotBubble(simple: boolean): string {
  return simple
    ? cn("chat-text w-fit whitespace-pre-wrap", SIMPLE_BUBBLE_MAX, SIMPLE_BOT_BUBBLE)
    : "chat-text w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink";
}

/** Simple mode's transcript spaces rows 16px apart (ChatView's data-simple-rows); a row in the same group pulls up 12px, to 4px. */
export const SIMPLE_STACKED = "-mt-3";

/** Where a Simple bubble meets its group's neighbours: those corners tighten to 6px on the bubble's own side. */
export interface BubbleJoin {
  above: boolean;
  below: boolean;
}

export function joinedCorners(side: "start" | "end", join: BubbleJoin): string {
  return cn(
    join.above && (side === "start" ? "rounded-ss-[6px]" : "rounded-se-[6px]"),
    join.below && (side === "start" ? "rounded-es-[6px]" : "rounded-ee-[6px]"),
  );
}

/** Which bubble group a transcript row belongs to in Simple mode: this bot's words, the person's own words, or none. */
export function bubbleGroup(message: Message, botId: string): "bot" | "user" | null {
  if (message.kind !== "text" || message.publishedPage || message.automation || message.helperFollowup) return null;
  if (message.role === "user") return peerLine(message) ? null : "user";
  if (message.role !== "bot" || peerRequest(message, botId)) return null;
  return isPureLeakedSystemHarnessMessage(message.text) && !message.attachments?.length ? null : "bot";
}

export function isBotTextRow(message: Message, botId: string): boolean {
  return bubbleGroup(message, botId) === "bot";
}

/** A transcript row that draws nothing: a reaction, MausBot's follow-up (drawn under its intro), or a tool step or work
 * summary while tool calls are hidden. */
export function quietRow(message: Message, showToolCalls: boolean): boolean {
  if (message.reaction || message.helperFollowup) return true;
  if (message.kind === "digest") return !showToolCalls;
  if (message.kind !== "activity" || showToolCalls) return false;
  if (message.dataResult || message.comm || message.threadRef || message.relay || isStatusActivity(message)) return false;
  return !(message.tool && failedTurnCause(message.tool.name) !== null);
}

export interface TranscriptSlot {
  /** The bubble group this row joins, or null for a row that is no bubble (a card, a chip, a separator line). */
  group: "bot" | "user" | null;
  /** The row draws nothing, so it neither joins nor breaks a group. */
  hidden: boolean;
  /** Something stands between this row and the one above it: a day stamp, the unread line, a caption. */
  breakBefore: boolean;
  /** Something follows this row before the next one: an offer card. */
  breakAfter: boolean;
  /** A time stamp or the unread line stands above the row. */
  stamped?: boolean;
  /** The bot whose own row this is, so its cards sit close under its bubbles. */
  sender?: string | null;
}

/** Each row's joins to its neighbours: a bubble joins the nearest drawn row on either side when that row is a bubble
 * of the same group and nothing stands between them. */
export function bubbleJoins(slots: readonly TranscriptSlot[]): BubbleJoin[] {
  const shown = slots.map((slot, index) => ({ slot, index })).filter(({ slot }) => !slot.hidden);
  const joins: BubbleJoin[] = slots.map(() => ({ above: false, below: false }));
  for (let at = 1; at < shown.length; at++) {
    const upper = shown[at - 1]!;
    const lower = shown[at]!;
    if (!upper.slot.group || upper.slot.group !== lower.slot.group || upper.slot.breakAfter || lower.slot.breakBefore) continue;
    joins[upper.index]!.below = true;
    joins[lower.index]!.above = true;
  }
  return joins;
}

/** Simple mode: a card sits 12px under its own bot's bubble, and a bubble 12px under its card, instead of the 16px
 * between senders. Two bubbles join instead, and a stamp between rows keeps the full gap. */
export function cardTucks(slots: readonly TranscriptSlot[]): boolean[] {
  const tucks = slots.map(() => false);
  let previous: TranscriptSlot | null = null;
  slots.forEach((slot, index) => {
    if (slot.hidden) return;
    tucks[index] = Boolean(previous && slot.sender && slot.sender === previous.sender && !slot.stamped && !previous.breakAfter && !(slot.group && previous.group));
    previous = slot;
  });
  return tucks;
}

/** Simple mode stamps the time again after a quiet spell, not only when the day changes. */
export const STAMP_GAP_MS = 15 * 60_000;

export function needsStamp(prev: Message | undefined, first: Message, simple: boolean): boolean {
  return !prev || localDay(prev.at) !== localDay(first.at) || (simple && first.at - prev.at >= STAMP_GAP_MS);
}

/** How Simple mode lays out a transcript's rows: which bubbles join, and which cards tuck under their bot's bubble. */
export function simpleRowLayout(items: readonly TranscriptItem[], { botId, showToolCalls, unreadIds }: {
  botId: string; showToolCalls: boolean; unreadIds: ReadonlySet<string> | null;
}): { joins: BubbleJoin[]; tucks: boolean[] } {
  const rowsOf = (item: TranscriptItem) => item.kind === "message" ? [item.message] : item.messages;
  const dividerAt = unreadIds ? items.findIndex((item) => rowsOf(item).some((row) => unreadIds.has(row.id))) : -1;
  const slots = items.map((item, i): TranscriptSlot => {
    const previous = items[i - 1];
    const stamped = needsStamp(previous && rowsOf(previous).at(-1), rowsOf(item)[0]!, true) && i > 0 || i === dividerAt;
    if (item.kind !== "message") return { group: null, hidden: !showToolCalls, breakBefore: stamped || i === 0, breakAfter: false, stamped };
    const m = item.message;
    const group = isCancelledTranscriptRow(m) ? null : bubbleGroup(m, botId);
    const hidden = !group && (quietRow(m, showToolCalls) || (m.role === "bot" && m.kind === "text" && !m.publishedPage && !peerRequest(m, botId) && isPureLeakedSystemHarnessMessage(m.text) && !m.attachments?.length));
    const sender = m.role === "bot" && !peerLine(m) && !peerRequest(m, botId) ? botId : null;
    return { group, hidden, breakBefore: stamped || i === 0 || Boolean(m.automation), breakAfter: Boolean(m.setupOffer), stamped, sender };
  });
  return { joins: bubbleJoins(slots), tucks: cardTucks(slots) };
}

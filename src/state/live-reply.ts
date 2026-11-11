// A bot's reply as it streams: each thread's assistant text deltas, keyed by the message id the server streams them
// under and held outside the app reducer, so a delta re-renders only the transcript that shows that thread. A streamed
// item stays drawn until the transcript holds the message saved under the same id, so the saved bubble replaces it in
// the same commit.
import { createContext, useEffect, useMemo, useSyncExternalStore } from "react";

import type { RuntimeEvent } from "../../shared/runtime-events";
import { isClientCancellation } from "../../shared/client-cancel";
import { redactSecretsInText } from "../../shared/redact";
import type { Message } from "@/state/store";

export interface LiveReplyItem {
  key: string;
  /** The message id the server streamed it under; absent from a server older than item ids. */
  itemId?: string;
  turnId?: string;
  text: string;
  at: number;
  /** The engine finished the item; its saved message is on its way. */
  done: boolean;
  /** The message the server saved the item as. */
  savedAs?: string;
}

interface ThreadReplies {
  items: readonly LiveReplyItem[];
  /** Deltas were missed (a stream gap or a Stop): later ones of the same item would draw a reply without its start. */
  skipping: boolean;
}

/** True around a reply still streaming in: its actions wait for it to finish. */
export const StreamingReplyContext = createContext(false);

const LIVE_ID = "live:";
const MAX_THREADS = 200;
const MAX_SEEN_EVENTS = 4096;
const MAX_STREAMED = 500;
const EMPTY: readonly LiveReplyItem[] = [];
const threads = new Map<string, ThreadReplies>();
const listeners = new Map<string, Set<() => void>>();
const seenEvents = new Set<string>();
const streamed = new Set<string>();
/** Set when the stream restarted without the frames it missed; a thread then draws deltas only after its next item or
 * turn boundary, since any item open across the gap lost its start. */
let gapped = false;
const boundarySinceGap = new Set<string>();

function put(threadId: string, next: ThreadReplies): void {
  const current = threads.get(threadId);
  if (current && current.items === next.items && current.skipping === next.skipping) return;
  threads.delete(threadId);
  if (next.items.length || next.skipping) threads.set(threadId, next);
  if (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value!);
  if ((current?.items ?? EMPTY) === next.items) return;
  for (const listener of Array.from(listeners.get(threadId) ?? [])) listener();
}

function firstSeen(eventId: string): boolean {
  if (seenEvents.has(eventId)) return false;
  seenEvents.add(eventId);
  if (seenEvents.size > MAX_SEEN_EVENTS) seenEvents.delete(seenEvents.values().next().value!);
  return true;
}

const isSaved = (item: LiveReplyItem) => item.savedAs !== undefined;
const sameTurn = (item: LiveReplyItem, turnId: string | undefined) => !turnId || !item.turnId || item.turnId === turnId;
const kept = (items: readonly LiveReplyItem[], keep: (item: LiveReplyItem) => boolean) => {
  const next = items.filter(keep);
  return next.length === items.length ? items : next;
};
const isTurnEnd = (event: RuntimeEvent) =>
  event.type === "turn.completed" || event.type === "cap.exhausted" || event.type === "session.exited" ||
  (event.type === "runtime.error" && event.terminal === true);

/** One live runtime frame. A frame seen before (a resumed stream replaying it) changes nothing. */
export function noteLiveReplyEvent(event: RuntimeEvent): void {
  const { threadId } = event;
  const current = threads.get(threadId) ?? { items: EMPTY, skipping: false };
  const { items } = current;
  if (event.type === "content.delta") {
    if (event.streamKind !== "assistant_text" || !event.delta || !firstSeen(event.eventId) || current.skipping) return;
    if (gapped && !boundarySinceGap.has(threadId)) return;
    const at = event.itemId ? items.findIndex((item) => item.itemId === event.itemId) : legacyOpen(items, event.turnId);
    const growing = items[at];
    if (growing) {
      if (!growing.done) put(threadId, { ...current, items: items.map((item, index) => index === at ? { ...item, text: item.text + event.delta } : item) });
      return;
    }
    // The server opens a message only once the one before it is over: an earlier one still open never completes.
    const fresh: LiveReplyItem = { key: event.itemId ?? event.eventId, ...(event.itemId ? { itemId: event.itemId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}), text: event.delta, at: Date.now(), done: false };
    put(threadId, { ...current, items: [...kept(items, (item) => item.done), fresh] });
  } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
    if (!firstSeen(event.eventId)) return;
    if (gapped) boundarySinceGap.add(threadId);
    const at = event.itemId ? items.findIndex((item) => item.itemId === event.itemId) : legacyOpen(items, event.turnId);
    const next = at >= 0 && !items[at]!.done ? items.map((item, index) => index === at ? { ...item, text: event.text, done: true } : item) : items;
    put(threadId, { items: next, skipping: false });
  } else if (event.type === "item.started" && event.itemType === "tool") {
    if (gapped) boundarySinceGap.add(threadId);
  } else if (event.type === "turn.started" || isTurnEnd(event)) {
    if (gapped) boundarySinceGap.add(threadId);
    put(threadId, { items: kept(items, isSaved), skipping: false });
  }
}

/** A server older than item ids sends none: its words build the last open item of the turn until one completes. */
function legacyOpen(items: readonly LiveReplyItem[], turnId: string | undefined): number {
  const last = items.length - 1;
  const open = items[last];
  return open && !open.itemId && !open.done && sameTurn(open, turnId) ? last : -1;
}

/** A message frame: the reply saved from the item that streamed under its `itemId` (or, from an older server, the
 * first finished item of its turn) is now that message. */
export function noteLiveReplyMessage(threadId: string, message: (Pick<Message, "id" | "role" | "kind" | "turnId"> & { itemId?: string }) | undefined): void {
  if (!message || message.role !== "bot" || message.kind !== "text") return;
  const current = threads.get(threadId);
  if (!current || current.items.some((item) => item.savedAs === message.id)) return;
  const index = message.itemId
    ? current.items.findIndex((item) => item.itemId === message.itemId)
    : current.items.findIndex((item) => !item.itemId && item.done && item.savedAs === undefined && sameTurn(item, message.turnId));
  if (index < 0) return;
  streamed.add(message.id);
  if (streamed.size > MAX_STREAMED) streamed.delete(streamed.values().next().value!);
  const items = current.items.map((item, at) => at === index ? { ...item, savedAs: message.id } : item);
  put(threadId, { ...current, items });
}

/** The person pressed Stop: what streamed so far goes, and the rest of that item is not drawn. */
export function stopLiveReply(threadId: string): void {
  const current = threads.get(threadId);
  if (!current) {
    put(threadId, { items: EMPTY, skipping: true });
    return;
  }
  put(threadId, { items: kept(current.items, isSaved), skipping: true });
}

/** The live stream restarted without the frames it missed: no thread's open item can be completed from here. */
export function forgetLiveReplies(): void {
  gapped = true;
  boundarySinceGap.clear();
  for (const [threadId, current] of Array.from(threads)) {
    put(threadId, { ...current, items: kept(current.items, isSaved) });
  }
}

/** Drops the items the transcript now draws as saved messages. */
export function settleLiveReplies(threadId: string, keys: readonly string[]): void {
  const current = threads.get(threadId);
  if (!current || !keys.length) return;
  put(threadId, { ...current, items: kept(current.items, (item) => !keys.includes(item.key)) });
}

export function liveReplies(threadId: string | null | undefined): readonly LiveReplyItem[] {
  return (threadId && threads.get(threadId)?.items) || EMPTY;
}

/** Whether the thread draws a streamed reply, or one waiting for its saved message to take its place. */
export function hasLiveReply(threadId: string | null | undefined): boolean {
  return liveReplies(threadId).some((item) => liveReplyText(item).trim() !== "");
}

/** A saved message that replaced a streamed bubble: it is already on screen, so it does not play in. */
export function streamedReply(messageId: string): boolean {
  return messageId.startsWith(LIVE_ID) || streamed.has(messageId);
}

export function isLiveReply(message: Pick<Message, "id">): boolean {
  return message.id.startsWith(LIVE_ID);
}

/** What a streaming item shows. The last word waits for the space after it, so a secret is masked whole or not shown. */
export function liveReplyText(item: Pick<LiveReplyItem, "text" | "done">): string {
  const end = item.done ? item.text.length : Math.max(item.text.lastIndexOf(" "), item.text.lastIndexOf("\n")) + 1;
  const text = item.text.slice(0, end);
  return isClientCancellation(text) ? "" : redactSecretsInText(text);
}

function subscribe(threadId: string | null | undefined, listener: () => void): () => void {
  if (!threadId) return () => {};
  let set = listeners.get(threadId);
  if (!set) listeners.set(threadId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(threadId);
  };
}

export function useLiveReplies(threadId: string | null | undefined): readonly LiveReplyItem[] {
  return useSyncExternalStore(
    (listener) => subscribe(threadId, listener),
    () => liveReplies(threadId),
    () => EMPTY,
  );
}

export function useHasLiveReply(threadId: string | null | undefined): boolean {
  return useSyncExternalStore(
    (listener) => subscribe(threadId, listener),
    () => hasLiveReply(threadId),
    () => false,
  );
}

const rowCache = new WeakMap<LiveReplyItem, { text: string; message: Message }>();

/** The transcript rows the live items draw, after `transcript`'s own: an item whose saved message `transcript` holds
 * draws nothing, so the two never show together. */
export function liveReplyRows(items: readonly LiveReplyItem[], transcript: readonly (Pick<Message, "id"> & { itemId?: string })[], from?: Message["from"]): { rows: Message[]; settled: string[] } {
  const rows: Message[] = [];
  const settled: string[] = [];
  for (const item of items) {
    if (transcript.some((message) => (item.itemId !== undefined && message.itemId === item.itemId) || message.id === item.savedAs)) {
      settled.push(item.key);
      continue;
    }
    const text = liveReplyText(item);
    if (!text.trim()) continue;
    let row = rowCache.get(item);
    if (!row || row.text !== text || row.message.from !== from) {
      row = { text, message: { id: `${LIVE_ID}${item.key}`, role: "bot", kind: "text", text, at: item.at, ...(item.turnId ? { turnId: item.turnId } : {}), ...(from ? { from } : {}) } as Message };
      rowCache.set(item, row);
    }
    rows.push(row.message);
  }
  return { rows, settled };
}

/** `transcript` with the thread's streaming reply after it. */
export function useLiveTranscript(threadId: string, transcript: Message[], speaker?: Message["from"]): Message[] {
  const items = useLiveReplies(threadId);
  const { botId, name, color } = speaker ?? {};
  const from = useMemo(() => botId && name && color ? { botId, name, color } : undefined, [botId, name, color]);
  const live = useMemo(() => {
    if (!items.length) return { rows: transcript, settled: [] };
    const drawn = liveReplyRows(items, transcript, from);
    return { rows: drawn.rows.length ? [...transcript, ...drawn.rows] : transcript, settled: drawn.settled };
  }, [items, transcript, from]);
  useEffect(() => settleLiveReplies(threadId, live.settled), [threadId, live.settled]);
  return live.rows;
}

/** Tests only. */
export function resetLiveReplies(): void {
  threads.clear();
  seenEvents.clear();
  streamed.clear();
  gapped = false;
  boundarySinceGap.clear();
}

import { useEffect } from "react";

import { firstUnreadMessageId } from "@/lib/unread-divider";
import { api } from "./api";
import { optimisticMessageId } from "./optimistic-send";
import { visibleMessages } from "./snapshot-navigation";
import type { Action, AppState, Message } from "./store";

export const MESSAGE_PAGE_SIZE = 200;

type Reduce = (state: AppState, action: Action) => AppState;
type Page = { messages: Message[]; hasMore?: boolean };

export const awaitsTranscript = (owner: { messages: readonly Message[]; hasMore?: boolean }) => Boolean(owner.hasMore) && owner.messages.length === 0;

export function deferAwaitingTranscripts(state: AppState): AppState {
  const snapshotRevision = state.snapshotRevision + 1;
  const deferredTranscripts = Object.fromEntries([...state.bots, ...state.groups]
    .filter(awaitsTranscript).map((owner) => [owner.threadId, snapshotRevision]));
  return { ...state, snapshotRevision, deferredTranscripts };
}

function settleTranscript(state: AppState, threadId: string, reduce: Reduce): AppState {
  const { [threadId]: _loaded, ...deferredTranscripts } = state.deferredTranscripts;
  const { [threadId]: _spinner, ...loadingOlder } = state.loadingOlder;
  const { [threadId]: frames = [], ...backgroundThreadEvents } = state.backgroundThreadEvents;
  let next: AppState = { ...state, deferredTranscripts, loadingOlder, backgroundThreadEvents };
  const waiting = state.deferredUnreadDivider;
  if (waiting?.threadId === threadId) {
    const bot = state.bots.find((candidate) => candidate.threadId === threadId);
    const messages = bot ? visibleMessages(bot) : state.groups.find((group) => group.threadId === threadId)?.messages ?? [];
    const messageId = firstUnreadMessageId(messages, waiting.lastReadMessageId);
    next = { ...next, deferredUnreadDivider: null, unreadDivider: messageId ? { threadId, messageId } : null };
  }
  for (const frame of frames) next = reduce(next, frame);
  return next;
}

export function settleIfDeferred(state: AppState, threadId: string | undefined, reduce: Reduce): AppState {
  return threadId && state.deferredTranscripts[threadId] ? settleTranscript(state, threadId, reduce) : state;
}

export function switchedTranscript(state: AppState, botId: string, threadId: string, reduce: Reduce): AppState {
  const bot = state.bots.find((candidate) => candidate.id === botId);
  if (!bot || !awaitsTranscript(bot)) return settleTranscript(state, threadId, reduce);
  const snapshotRevision = state.snapshotRevision + 1;
  return { ...state, snapshotRevision, deferredTranscripts: { ...state.deferredTranscripts, [threadId]: snapshotRevision } };
}

export function openedThread(state: AppState, threadId: string, unread: boolean, messages: readonly Message[], lastReadMessageId?: string): Pick<AppState, "unreadDivider" | "deferredUnreadDivider"> {
  if (unread && state.deferredTranscripts[threadId] !== undefined) return { unreadDivider: null, deferredUnreadDivider: { threadId, lastReadMessageId } };
  if (!unread) return { unreadDivider: state.unreadDivider?.threadId === threadId ? state.unreadDivider : null, deferredUnreadDivider: null };
  const messageId = firstUnreadMessageId(messages, lastReadMessageId);
  return { unreadDivider: messageId ? { threadId, messageId } : null, deferredUnreadDivider: null };
}

export function heldPatch(state: AppState, action: Action): AppState | null {
  if (action.type !== "messagePatched" || !state.deferredTranscripts[action.threadId]) return null;
  const owner = [...state.bots, ...state.groups].find((candidate) => candidate.threadId === action.threadId);
  if (!owner || owner.messages.some((message) => message.id === action.message.id)) return null;
  return { ...state, backgroundThreadEvents: { ...state.backgroundThreadEvents,
    [action.threadId]: [...(state.backgroundThreadEvents[action.threadId] ?? [])
      .filter((frame) => frame.type !== "messagePatched" || frame.message.id !== action.message.id), action].slice(-256) } };
}

export function transcriptLoaded(state: AppState, action: Extract<Action, { type: "transcriptLoaded" }>, reduce: Reduce): AppState {
  if (state.deferredTranscripts[action.threadId] !== action.revision ||
      (state.transcriptGeneration[action.threadId] ?? 0) !== action.generation) return state;
  const received = new Set(action.messages.map((message) => message.id));
  const accepted = new Map(action.messages.flatMap((message) => message.sendId ? [[optimisticMessageId(message.sendId), message.id] as const] : []));
  const merge = <T extends { threadId: string; messages: Message[]; activeLeafId?: string | null }>(owner: T): T => {
    if (owner.threadId !== action.threadId) return owner;
    const live = new Map(owner.messages.map((message) => [message.id, message]));
    const leaf = owner.activeLeafId ? accepted.get(owner.activeLeafId) : undefined;
    return { ...owner, hasMore: action.hasMore, ...(leaf ? { activeLeafId: leaf } : {}),
      messages: [...action.messages.map((message) => live.get(message.id) ?? message),
        ...owner.messages.filter((message) => !received.has(message.id) && !accepted.has(message.id))] };
  };
  return settleTranscript({ ...state, bots: state.bots.map(merge), groups: state.groups.map(merge) }, action.threadId, reduce);
}

export function olderMessages(state: AppState, action: Extract<Action, { type: "olderMessages" }>, reduce: Reduce): AppState {
  const { [action.threadId]: _done, ...loadingOlder } = state.loadingOlder;
  const deferral = state.deferredTranscripts[action.threadId];
  if ((state.transcriptGeneration[action.threadId] ?? 0) !== action.generation ||
      (deferral !== undefined && deferral !== action.revision)) return { ...state, loadingOlder };
  const prepend = <T extends { messages: Message[]; threadId: string; hasMore?: boolean }>(owner: T): T => {
    if (owner.threadId !== action.threadId) return owner;
    const held = new Set(owner.messages.map((message) => message.id));
    // A page that raced an edit can overlap held rows; the held copy is newer.
    return { ...owner, messages: [...action.messages.filter((message) => !held.has(message.id)), ...owner.messages], hasMore: action.hasMore };
  };
  const paged = { ...state, loadingOlder, bots: state.bots.map(prepend), groups: state.groups.map(prepend) };
  return action.messages.length ? settleIfDeferred(paged, action.threadId, reduce) : paged;
}

export function requestOlderMessages(state: AppState, threadId: string, inFlight: Set<string>, dispatch: (action: Action) => void, onError: (error: unknown) => void): void {
  if (state.deferredTranscripts[threadId] || inFlight.has(threadId)) return;
  const owner = [...state.bots, ...state.groups].find((candidate) => candidate.threadId === threadId);
  const before = owner?.messages[0]?.id;
  const generation = state.transcriptGeneration[threadId] ?? 0;
  if (!before) {
    dispatch({ type: "olderMessages", threadId, generation, messages: [], hasMore: false });
    return;
  }
  inFlight.add(threadId);
  api<Page>(`/api/threads/${threadId}/messages?limit=${MESSAGE_PAGE_SIZE}&before=${encodeURIComponent(before)}`)
    .finally(() => inFlight.delete(threadId))
    .then((page) => dispatch({ type: "olderMessages", threadId, generation, messages: page.messages ?? [], hasMore: Boolean(page.hasMore) }))
    .catch((error) => {
      dispatch({ type: "olderMessages", threadId, generation, messages: [], hasMore: true });
      onError(error);
    });
}

export function useDeferredTranscript(state: AppState, dispatch: (action: Action) => void): void {
  const owner = state.bots.find((bot) => bot.id === state.selectedId) ?? state.groups.find((group) => group.id === state.selectedId);
  const threadId = owner?.threadId;
  const revision = threadId ? state.deferredTranscripts[threadId] : undefined;
  const generation = threadId ? state.transcriptGeneration[threadId] ?? 0 : 0;
  useEffect(() => {
    if (!threadId || revision === undefined) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const load = () => {
      void api<Page>(`/api/threads/${threadId}/messages?limit=${MESSAGE_PAGE_SIZE}`, { signal: controller.signal }).then((page) => {
        if (!controller.signal.aborted) dispatch({ type: "transcriptLoaded", threadId, revision, generation, messages: page.messages, hasMore: Boolean(page.hasMore) });
      }).catch((error) => {
        if (controller.signal.aborted) return;
        if (attempt === 0) dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
        retry = setTimeout(load, Math.min(30_000, 1000 * 2 ** attempt++));
      });
    };
    load();
    return () => { controller.abort(); clearTimeout(retry); };
  }, [threadId, revision, generation, dispatch]);
}

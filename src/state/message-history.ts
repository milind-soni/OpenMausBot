import { readTranscriptPosition } from "@/lib/transcript-follow";
import { placeUnreadDivider } from "@/lib/unread-divider";
import { api } from "./api";
import { visibleMessages } from "./snapshot-navigation";
import type { Action, AppState, Message } from "./store";

export const MESSAGE_PAGE_SIZE = 200;
type OlderMessages = Extract<Action, { type: "olderMessages" }>;
type LoadOlderMessages = Extract<Action, { type: "loadOlderMessages" }>;
type TrimHeldMessages = Extract<Action, { type: "trimHeldMessages" }>;
type HeldOwner = { id: string; messages: Message[]; threadId: string; hasMore?: boolean; activeLeafId?: string | null; pinnedMessageId?: string };

export function reduceOlderMessages(state: AppState, action: OlderMessages): AppState {
  const { [action.threadId]: _done, ...loadingOlder } = state.loadingOlder;
  if ((state.transcriptGeneration[action.threadId] ?? 0) !== action.generation) return { ...state, loadingOlder };
  const prepend = <T extends HeldOwner>(owner: T): T => {
    // A page asked for before rows that have since been let go would leave a gap: the reader pages again instead.
    if (action.before !== undefined && owner.messages[0]?.id !== action.before) return owner;
    const page = new Set(action.messages.map((message) => message.id));
    const held = new Set(owner.messages.filter((message) => page.has(message.id)).map((message) => message.id));
    return {
      ...owner,
      messages: [...action.messages.filter((message) => !held.has(message.id)), ...owner.messages],
      hasMore: action.hasMore,
    };
  };
  const bots = state.bots.map((bot) => (bot.threadId === action.threadId ? prepend(bot) : bot));
  const groups = state.groups.map((group) => (group.threadId === action.threadId ? prepend(group) : group));
  const owner = [...bots, ...groups].find((candidate) => candidate.threadId === action.threadId);
  const unreadDivider = placeUnreadDivider(state.unreadDivider, action.threadId, owner ? visibleMessages(owner) : [], action.hasMore);
  return { ...state, loadingOlder, bots, groups, unreadDivider };
}

/** Rows a conversation keeps once the reader has left it, and the most it keeps to put a reader's place back. */
export const HELD_AFTER_LEAVING = MESSAGE_PAGE_SIZE;
export const HELD_FOR_PLACE = 3 * MESSAGE_PAGE_SIZE;

/** The newest rows of `owner`, from `keepFromId` when that is close enough to the end, never cutting off its pinned
 * message or the leaf of the branch it shows. */
export function trimmedHeld<T extends HeldOwner>(owner: T, keepFromId?: string): T {
  const total = owner.messages.length;
  let from = total - HELD_AFTER_LEAVING;
  if (from <= 0) return owner;
  for (const id of [keepFromId, owner.activeLeafId, owner.pinnedMessageId]) {
    const at = id ? owner.messages.findIndex((message) => message.id === id) : -1;
    if (at < 0 || at >= from) continue;
    if (id !== keepFromId && total - at > HELD_FOR_PLACE) return owner;
    if (total - at <= HELD_FOR_PLACE) from = at;
  }
  return from > 0 ? { ...owner, messages: owner.messages.slice(from), hasMore: true } : owner;
}

/** The conversation the chat draws: the selected room or bot, or the first bot when the selection names neither. */
const shownThread = (state: AppState, threadId: string) => state.activeView === "chat" &&
  (state.groups.find((group) => group.id === state.selectedId) ?? state.bots.find((bot) => bot.id === state.selectedId) ?? state.bots[0])?.threadId === threadId;

export function reduceTrimHeldMessages(state: AppState, { threadId, keepFromId }: TrimHeldMessages): AppState {
  if (shownThread(state, threadId)) return state;
  let changed = false;
  const trim = <T extends HeldOwner>(owner: T): T => {
    if (owner.threadId !== threadId) return owner;
    const next = trimmedHeld(owner, keepFromId);
    changed ||= next !== owner;
    return next;
  };
  const bots = state.bots.map(trim);
  const groups = state.groups.map(trim);
  return changed ? { ...state, bots, groups } : state;
}

/** The most rows a conversation nobody has on screen gathers from live frames before it is trimmed again. */
export const HELD_IN_BACKGROUND = HELD_FOR_PLACE + HELD_AFTER_LEAVING;

/** After a row lands in a conversation nobody has on screen: past `HELD_IN_BACKGROUND` rows it is trimmed as when the
 * reader left it, keeping the row the reader was at. */
export function capHeldInBackground(state: AppState, action: Action): AppState {
  if (action.type !== "messageAdded") return state;
  const owner = [...state.bots, ...state.groups].find((candidate) => candidate.threadId === action.threadId);
  if (!owner || owner.messages.length <= HELD_IN_BACKGROUND || shownThread(state, action.threadId)) return state;
  const place = readTranscriptPosition(`${owner.id}:${owner.threadId}`);
  return reduceTrimHeldMessages(state, { type: "trimHeldMessages", threadId: action.threadId, keepFromId: place?.atEnd ? undefined : place?.rowId });
}

/** Holds fewer rows than one page while the server has more: a snapshot's tail, or a conversation switched to. */
export const shortHeld = <T extends { messages: Message[]; hasMore?: boolean }>(owner: T | undefined): owner is T =>
  Boolean(owner?.hasMore) && owner!.messages.length < MESSAGE_PAGE_SIZE;

/** Opening a conversation held as a short tail asks for the page before it at once, through the older-rows path. */
export function loadShortHeldOnOpen(state: AppState, ownerId: string, inFlight: Set<string>,
  dispatch: (action: Action) => void, showError: (error: unknown) => void): void {
  const owner = [...state.bots, ...state.groups].find((candidate) => candidate.id === ownerId);
  if (!shortHeld(owner) || state.loadingOlder[owner.threadId]) return;
  const load = { type: "loadOlderMessages", threadId: owner.threadId } as const;
  dispatch(load);
  loadOlderPage(load, state, inFlight, dispatch, showError);
}

export function loadOlderPage(action: LoadOlderMessages, current: AppState, inFlight: Set<string>,
  dispatch: (action: Action) => void, showError: (error: unknown) => void): void {
  if (inFlight.has(action.threadId)) return;
  inFlight.add(action.threadId);
  const owner = [...current.bots, ...current.groups].find((candidate) => candidate.threadId === action.threadId);
  const before = owner?.messages[0]?.id;
  const generation = current.transcriptGeneration[action.threadId] ?? 0;
  if (!before) {
    inFlight.delete(action.threadId);
    dispatch({ type: "olderMessages", threadId: action.threadId, generation, messages: [], hasMore: false });
    return;
  }
  void api<{ messages: Message[]; hasMore?: boolean }>(
    `/api/threads/${action.threadId}/messages?limit=${MESSAGE_PAGE_SIZE}&before=${encodeURIComponent(before)}`,
  ).finally(() => inFlight.delete(action.threadId)).then((page) => dispatch({
    type: "olderMessages", threadId: action.threadId, generation, before, messages: page.messages ?? [], hasMore: Boolean(page.hasMore),
  })).catch((error) => {
    dispatch({ type: "olderMessages", threadId: action.threadId, generation, before, messages: [], hasMore: true });
    showError(error);
  });
}

export async function loadFullThread(threadId: string): Promise<{ messages: Message[]; activeLeafId: string | null }> {
  const messages: Message[] = [];
  let before: string | undefined;
  let activeLeafId: string | null = null;
  for (;;) {
    const page = await api<{ messages: Message[]; hasMore?: boolean; activeLeafId: string | null }>(
      `/api/threads/${threadId}/messages?limit=${MESSAGE_PAGE_SIZE}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    );
    messages.unshift(...page.messages);
    activeLeafId = page.activeLeafId;
    if (!page.hasMore || !page.messages.length) break;
    before = page.messages[0]!.id;
  }
  return { messages, activeLeafId };
}

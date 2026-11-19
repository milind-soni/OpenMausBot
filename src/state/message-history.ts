import { placeUnreadDivider } from "@/lib/unread-divider";
import { api } from "./api";
import { foldSnapshotOntoStreamed } from "./room-frames";
import { visibleMessages } from "./snapshot-navigation";
import type { Action, AppState, Bot, Group, Message } from "./store";

export const MESSAGE_PAGE_SIZE = 200;
type OlderMessages = Extract<Action, { type: "olderMessages" }>;
type LoadOlderMessages = Extract<Action, { type: "loadOlderMessages" }>;

export function reduceHistoryReady(state: AppState, action: Extract<Action, { type: "historyReady" }>): AppState {
  const merge = <T extends Bot | Group>(owner: T): T => {
    if (owner.threadId !== action.threadId || !owner.needsHistory) return owner;
    const merged = foldSnapshotOntoStreamed(owner.messages, new Set(action.held), action.messages);
    const overlap = owner.messages.findIndex(m => m.id === merged[0]?.id);
    const prefix = overlap > 0 ? owner.messages.slice(0, overlap) : [];
    return { ...owner, messages: [...prefix, ...merged], hasMore: prefix.length ? owner.hasMore : action.hasMore,
      activeLeafId: "activeLeafId" in owner && owner.activeLeafId !== action.leaf ? owner.activeLeafId : action.activeLeafId, needsHistory: false };
  };
  const bots = state.bots.map(merge), groups = state.groups.map(merge);
  const owner = [...bots, ...groups].find(candidate => candidate.threadId === action.threadId);
  const unreadDivider = owner ? placeUnreadDivider(state.unreadDivider, owner.threadId, visibleMessages(owner), Boolean(owner.hasMore)) : state.unreadDivider;
  return { ...state, bots, groups, unreadDivider };
}

export function reduceOlderMessages(state: AppState, action: OlderMessages): AppState {
  const { [action.threadId]: _done, ...loadingOlder } = state.loadingOlder;
  if ((state.transcriptGeneration[action.threadId] ?? 0) !== action.generation) return { ...state, loadingOlder };
  const prepend = <T extends { messages: Message[]; threadId: string; hasMore?: boolean; needsHistory?: boolean }>(owner: T): T => {
    const held = new Set(owner.messages.map((message) => message.id));
    return {
      ...owner,
      messages: [...action.messages.filter((message) => !held.has(message.id)), ...owner.messages],
      hasMore: action.hasMore,
      ...(action.tailLoaded ? { needsHistory: false } : {}),
    };
  };
  const bots = state.bots.map((bot) => {
    if (bot.threadId !== action.threadId) return bot;
    const loaded = prepend(bot);
    return action.tailLoaded && bot.needsHistory && bot.activeLeafId === undefined
      ? { ...loaded, activeLeafId: action.activeLeafId }
      : loaded;
  });
  const groups = state.groups.map((group) => (group.threadId === action.threadId ? prepend(group) : group));
  const owner = [...bots, ...groups].find((candidate) => candidate.threadId === action.threadId);
  const unreadDivider = placeUnreadDivider(state.unreadDivider, action.threadId, owner ? visibleMessages(owner) : [], action.hasMore);
  return { ...state, loadingOlder, bots, groups, unreadDivider };
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
    type: "olderMessages", threadId: action.threadId, generation, messages: page.messages ?? [], hasMore: Boolean(page.hasMore),
  })).catch((error) => {
    dispatch({ type: "olderMessages", threadId: action.threadId, generation, messages: [], hasMore: true });
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

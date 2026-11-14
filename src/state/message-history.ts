import { placeUnreadDivider } from "@/lib/unread-divider";
import { api } from "./api";
import { visibleMessages } from "./snapshot-navigation";
import type { Action, AppState, Message } from "./store";

export const MESSAGE_PAGE_SIZE = 200;
type OlderMessages = Extract<Action, { type: "olderMessages" }>;
type LoadOlderMessages = Extract<Action, { type: "loadOlderMessages" }>;

export function reduceOlderMessages(state: AppState, action: OlderMessages): AppState {
  const { [action.threadId]: _done, ...loadingOlder } = state.loadingOlder;
  if ((state.transcriptGeneration[action.threadId] ?? 0) !== action.generation) return { ...state, loadingOlder };
  const prepend = <T extends { messages: Message[]; threadId: string; hasMore?: boolean }>(owner: T): T => {
    const held = new Set(owner.messages.map((message) => message.id));
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

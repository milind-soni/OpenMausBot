import { api } from "./api";
import { loadFullThread } from "./message-history";
import { optimisticMessageId, optimisticUserMessage } from "./optimistic-send";
import type { Action, AppState, BotAnnouncement, Group, Message } from "./store";

export interface ForkPanelState {
  kind: "bot" | "group";
  ownerId: string;
  threadId: string;
  messages: Message[];
  activeLeafId: string | null;
  loading: boolean;
  loadId: string;
  loadFailed: boolean;
}

export type ForkPanelAction =
  | { type: "forkMessage"; kind: "bot" | "group"; ownerId: string; threadId: string; messageId: string }
  | { type: "openForkPanel"; kind: "bot" | "group"; ownerId: string; threadId: string; loadId?: string }
  | { type: "forkPanelLoaded"; threadId: string; loadId: string; messages: Message[]; activeLeafId: string | null }
  | { type: "forkPanelLoadFailed"; threadId: string; loadId: string }
  | { type: "forkPanelMessage"; threadId: string; message: Message; patch?: true }
  | { type: "forkPanelActive"; threadId: string; activeLeafId: string }
  | { type: "closeForkPanel" };

export function reduceForkPanel(state: AppState, action: ForkPanelAction): AppState {
  switch (action.type) {
    case "forkMessage": return state;
    case "openForkPanel":
      return { ...state, settingsOpen: false, computerOpen: false, inspectorOpen: false, activityOpen: false,
        forkPanel: { kind: action.kind, ownerId: action.ownerId, threadId: action.threadId, messages: [], activeLeafId: null,
          loading: true, loadId: action.loadId ?? "", loadFailed: false } };
    case "forkPanelLoaded": {
      const panel = state.forkPanel;
      if (panel?.threadId !== action.threadId || panel.loadId !== action.loadId) return state;
      const live = new Map(panel.messages.map((message) => [message.id, message]));
      const loaded = new Set(action.messages.map((message) => message.id));
      const messages = [...action.messages.map((message) => live.get(message.id) ?? message),
        ...panel.messages.filter((message) => !loaded.has(message.id))];
      return { ...state, forkPanel: { ...panel, messages, activeLeafId: panel.activeLeafId ?? action.activeLeafId,
        loading: false, loadFailed: false } };
    }
    case "forkPanelLoadFailed":
      return state.forkPanel?.threadId === action.threadId && state.forkPanel.loadId === action.loadId
        ? { ...state, forkPanel: { ...state.forkPanel, loading: false, loadFailed: true } } : state;
    case "forkPanelMessage": {
      const panel = state.forkPanel;
      if (panel?.threadId !== action.threadId) return state;
      const optimisticId = action.message.sendId ? optimisticMessageId(action.message.sendId) : null;
      const replacedOptimistic = optimisticId && panel.messages.some((message) => message.id === optimisticId);
      const existing = panel.messages.some((message) => message.id === action.message.id);
      const messages = existing || replacedOptimistic
        ? panel.messages.map((message) => message.id === action.message.id || message.id === optimisticId ? action.message : message)
        : action.patch && !panel.loading ? panel.messages : [...panel.messages, action.message];
      const activeLeafId = replacedOptimistic && panel.activeLeafId === optimisticId ? action.message.id
        : !action.patch && !panel.loading && !existing && (action.message.parentId ?? null) === panel.activeLeafId
          ? action.message.id : panel.activeLeafId;
      return { ...state, forkPanel: { ...panel, messages, activeLeafId } };
    }
    case "forkPanelActive":
      return state.forkPanel?.threadId === action.threadId
        ? { ...state, forkPanel: { ...state.forkPanel, activeLeafId: action.activeLeafId } } : state;
    case "closeForkPanel":
      return state.forkPanel ? { ...state, forkPanel: null } : state;
  }
}

type ForkSend = Extract<Action, { type: "send" | "sendGroup" }>;
export function addForkOptimistic(state: AppState, action: ForkSend): AppState {
  const panel = state.forkPanel;
  const kind = action.type === "send" ? "bot" : "group";
  const ownerId = action.type === "send" ? action.botId : action.groupId;
  const selectedThreadId = action.type === "send"
    ? state.bots.find((bot) => bot.id === ownerId)?.threadId
    : state.groups.find((group) => group.id === ownerId)?.threadId;
  if (!panel || panel.kind !== kind || panel.ownerId !== ownerId || !action.sendId ||
    (action.threadId ?? selectedThreadId) !== panel.threadId || panel.messages.some((message) => message.sendId === action.sendId)) return state;
  const message = optimisticUserMessage(action.text, action.sendId, action.replyToId, panel.activeLeafId,
    action.type === "sendGroup" ? action.mode ?? "chat" : undefined);
  return { ...state, forkPanel: { ...panel, messages: [...panel.messages, message], activeLeafId: message.id } };
}

export function removeForkOptimistic(state: AppState, action: Extract<Action, { type: "optimisticMessageRemoved" }>): AppState {
  const panel = state.forkPanel;
  const optimisticId = optimisticMessageId(action.sendId);
  if (panel?.threadId !== action.threadId || !panel.messages.some((message) => message.id === optimisticId)) return state;
  const optimistic = panel.messages.find((message) => message.id === optimisticId)!;
  return { ...state, forkPanel: { ...panel,
    messages: panel.messages.filter((message) => message.id !== optimisticId),
    activeLeafId: panel.activeLeafId === optimisticId
      ? action.restoreLeafId ?? optimistic.parentId ?? null : panel.activeLeafId } };
}

type ForkEffect = Extract<Action, { type: "forkMessage" | "openForkPanel" }>;
export function runForkEffect(action: ForkEffect, dispatch: (action: Action) => void,
  rawDispatch: (action: Action) => void, showError: (error: unknown) => void): void {
  if (action.type === "forkMessage") {
    const owner = action.kind === "bot" ? "bots" : "groups";
    void api<{ bot?: BotAnnouncement; group?: Partial<Group> & { id: string }; task: { threadId: string } }>(
      `/api/${owner}/${action.ownerId}/tasks/${action.threadId}/forks`,
      { method: "POST", body: JSON.stringify({ messageId: action.messageId }) },
    ).then((result) => {
      if (result.bot) dispatch({ type: "botPatched", bot: result.bot });
      if (result.group) dispatch({ type: "groupPatched", group: result.group });
      dispatch({ type: "openForkPanel", kind: action.kind, ownerId: action.ownerId, threadId: result.task.threadId });
    }).catch(showError);
    return;
  }
  const owner = action.kind === "bot" ? "bots" : "groups";
  void api(`/api/${owner}/${action.ownerId}/read`, { method: "POST", body: JSON.stringify({ threadId: action.threadId }) }).catch(() => {});
  const loadId = action.loadId ?? "";
  void loadFullThread(action.threadId).then(({ messages, activeLeafId }) => {
    rawDispatch({ type: "forkPanelLoaded", threadId: action.threadId, loadId, messages, activeLeafId });
  }).catch((error) => {
    rawDispatch({ type: "forkPanelLoadFailed", threadId: action.threadId, loadId });
    showError(error);
  });
}

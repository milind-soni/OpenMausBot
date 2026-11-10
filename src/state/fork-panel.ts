import { api } from "./api";
import { loadFullThread } from "./message-history";
import type { Action, AppState, BotAnnouncement, Group, Message } from "./store";

export interface ForkPanelState {
  kind: "bot" | "group";
  ownerId: string;
  threadId: string;
  messages: Message[];
  activeLeafId: string | null;
  loading: boolean;
}

export type ForkPanelAction =
  | { type: "forkMessage"; kind: "bot" | "group"; ownerId: string; threadId: string; messageId: string }
  | { type: "openForkPanel"; kind: "bot" | "group"; ownerId: string; threadId: string }
  | { type: "forkPanelLoaded"; threadId: string; messages: Message[]; activeLeafId: string | null }
  | { type: "forkPanelMessage"; threadId: string; message: Message; patch?: true }
  | { type: "forkPanelActive"; threadId: string; activeLeafId: string }
  | { type: "closeForkPanel" };

export function reduceForkPanel(state: AppState, action: ForkPanelAction): AppState {
  switch (action.type) {
    case "forkMessage": return state;
    case "openForkPanel":
      return { ...state, settingsOpen: false, computerOpen: false, inspectorOpen: false, activityOpen: false,
        forkPanel: { kind: action.kind, ownerId: action.ownerId, threadId: action.threadId, messages: [], activeLeafId: null, loading: true } };
    case "forkPanelLoaded":
      if (state.forkPanel?.threadId !== action.threadId) return state;
      return { ...state, forkPanel: { ...state.forkPanel, messages: [...action.messages, ...state.forkPanel.messages.filter((message) => !action.messages.some((loaded) => loaded.id === message.id))], activeLeafId: state.forkPanel.activeLeafId ?? action.activeLeafId, loading: false } };
    case "forkPanelMessage": {
      const panel = state.forkPanel;
      if (panel?.threadId !== action.threadId) return state;
      const messages = panel.messages.some((message) => message.id === action.message.id)
        ? panel.messages.map((message) => message.id === action.message.id ? action.message : message)
        : action.patch ? panel.messages : [...panel.messages, action.message];
      return { ...state, forkPanel: { ...panel, messages, activeLeafId: action.patch ? panel.activeLeafId : action.message.id } };
    }
    case "forkPanelActive":
      return state.forkPanel?.threadId === action.threadId
        ? { ...state, forkPanel: { ...state.forkPanel, activeLeafId: action.activeLeafId } } : state;
    case "closeForkPanel":
      return state.forkPanel ? { ...state, forkPanel: null } : state;
  }
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
  void loadFullThread(action.threadId).then(({ messages, activeLeafId }) => {
    rawDispatch({ type: "forkPanelLoaded", threadId: action.threadId, messages, activeLeafId });
  }).catch(showError);
}

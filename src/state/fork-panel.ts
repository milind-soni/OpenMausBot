import { emptyPane, paneIds, placePane, presetLayout, type PaneEdge, type PanePreset, MAIN_PANE, replacePane, resizePane, type PaneLayout, type SplitDirection } from "./pane-layout";
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
  focusComposer?: boolean;
}

export type PaneTarget = Pick<ForkPanelState, "kind" | "ownerId" | "threadId">;

export function loadingPanel({ kind, ownerId, threadId, focusComposer }: PaneTarget & { focusComposer?: boolean }, loadId: string): ForkPanelState {
  return { kind, ownerId, threadId, focusComposer, loadId, messages: [], activeLeafId: null, loading: true, loadFailed: false };
}

export interface WorkspacePanes {
  layout: PaneLayout;
  focused: string;
  panels: Record<string, ForkPanelState>;
}

export function threadPanel(state: Pick<AppState, "forkPanel" | "workspacePanes">, id?: string) {
  if (!id) return null;
  return state.workspacePanes?.panels[id] ?? (state.forkPanel?.threadId === id ? state.forkPanel : null);
}

export function cardMessages(state: AppState, botId: string, groupId?: string, threadId?: string): Message[] | undefined {
  const panel = threadPanel(state, threadId);
  if (threadId && panel?.threadId === threadId && panel.kind === (groupId ? "group" : "bot") && panel.ownerId === (groupId ?? botId)) {
    return panel.messages;
  }
  const host = groupId ? state.groups.find((group) => group.id === groupId) : state.bots.find((bot) => bot.id === botId);
  return !threadId || host?.threadId === threadId ? host?.messages : undefined;
}

export function updatePanel(state: AppState, panel: ForkPanelState): AppState {
  const panes = state.workspacePanes;
  if (panes?.panels[panel.threadId]) return { ...state, workspacePanes: {
    ...panes, panels: { ...panes.panels, [panel.threadId]: panel },
  } };
  return { ...state, forkPanel: panel };
}

export type ForkPanelAction =
  | { type: "restorePaneLayout"; panes: WorkspacePanes }
  | { type: "presetPanes"; preset: PanePreset }
  | { type: "movePane"; source: string; target: string; edge: PaneEdge | "fill" }
  | { type: "focusPane"; id: string }
  | { type: "resizePane"; divider: string; ratio: number }
  | { type: "closePane"; id: string; promote?: string }
  | { type: "closeWorkspacePanes" }
  | { type: "forkMessage"; kind: "bot" | "group"; ownerId: string; threadId: string; messageId?: string; branchLeafId?: string; onSuccess?: () => void; onError?: (message: string) => void }
  | { type: "openForkPanel"; kind: "bot" | "group"; ownerId: string; threadId: string; loadId?: string; focusComposer?: boolean; split?: SplitDirection | "replace"; target?: string; edge?: PaneEdge | "fill" }
  | { type: "forkPanelLoaded"; threadId: string; loadId: string; messages: Message[]; activeLeafId: string | null }
  | { type: "forkPanelLoadFailed"; threadId: string; loadId: string }
  | { type: "forkPanelMessage"; threadId: string; message: Message; patch?: true }
  | { type: "forkPanelActive"; threadId: string; activeLeafId: string }
  | { type: "closeForkPanel" };

export function workspaceLayout(state: Pick<AppState, "workspacePanes" | "forkPanel">): PaneLayout {
  return state.workspacePanes?.layout ?? (state.forkPanel
    ? { direction: "beside", ratio: 0.5, first: MAIN_PANE, second: state.forkPanel.threadId } : MAIN_PANE);
}

function workspacePanels(state: AppState): WorkspacePanes["panels"] {
  return state.workspacePanes?.panels ?? (state.forkPanel ? { [state.forkPanel.threadId]: state.forkPanel } : {});
}

export function reduceForkPanel(state: AppState, action: ForkPanelAction): AppState {
  switch (action.type) {
    case "forkMessage": return state;
    case "restorePaneLayout": return { ...state, forkPanel: null, workspacePanes: action.panes };
    case "presetPanes": {
      const layout = presetLayout(workspaceLayout(state), action.preset);
      if (!layout) return state;
      const panels = workspacePanels(state);
      const previous = state.workspacePanes?.focused;
      const focused = previous && paneIds(layout).includes(previous) ? previous : MAIN_PANE;
      return { ...state, forkPanel: null, workspacePanes: { layout, focused, panels } };
    }
    case "movePane": {
      const previous = workspaceLayout(state);
      if (!paneIds(previous).includes(action.source)) return state;
      const layout = placePane(previous, action.source, action.target, action.edge);
      return layout ? { ...state, forkPanel: null, workspacePanes: { panels: workspacePanels(state), layout, focused: action.source } } : state;
    }
    case "closeWorkspacePanes": return { ...state, workspacePanes: null };
    case "focusPane": {
      const panes = state.workspacePanes;
      return panes && panes.focused !== action.id ? { ...state, workspacePanes: { ...panes, focused: action.id } } : state;
    }
    case "resizePane": {
      const panes = state.workspacePanes;
      return panes ? { ...state, workspacePanes: { ...panes, layout: resizePane(panes.layout, action.divider, action.ratio) } } : state;
    }
    case "closePane": {
      const panes = state.workspacePanes;
      if (!panes) return state;
      let layout = replacePane(panes.layout, action.id, null);
      if (layout && action.promote) layout = replacePane(layout, action.promote, MAIN_PANE);
      if (!layout || layout === MAIN_PANE) return { ...state, workspacePanes: null };
      const panels = { ...panes.panels };
      delete panels[action.promote ?? action.id];
      const focused = panes.focused === action.id || panes.focused === action.promote ? MAIN_PANE : panes.focused;
      return { ...state, workspacePanes: { layout, panels, focused } };
    }
    case "openForkPanel": {
      const panel = loadingPanel(action, action.loadId ?? "");
      const closed = { ...state, settingsOpen: false, computerOpen: false, inspectorOpen: false, activityOpen: false };
      if (!action.split && !action.edge && !state.workspacePanes) return { ...closed, forkPanel: panel, workspacePanes: null };
      const panes = state.workspacePanes;
      const anchor = action.target ?? panes?.focused ?? MAIN_PANE;
      const panels = { ...workspacePanels(state), [action.threadId]: panel };
      let layout = workspaceLayout(state);
      if (!panes?.panels[action.threadId]) {
        if (!paneIds(layout).includes(anchor)) return state;
        if (action.split === "replace" && !emptyPane(anchor)) {
          if (anchor === MAIN_PANE) return state;
          delete panels[anchor];
          layout = replacePane(layout, anchor, action.threadId)!;
        } else {
          const vacancy = !action.split && !action.edge ? paneIds(layout).find(emptyPane) : undefined;
          const target = vacancy ?? anchor;
          const edge = action.edge ?? (emptyPane(target) ? "fill" : action.split === "below" ? "bottom" : "right");
          const next = placePane(layout, action.threadId, target, edge);
          if (!next) return state;
          layout = next;
        }
      }
      return { ...closed, forkPanel: null, workspacePanes: { layout, focused: action.threadId, panels } };
    }
    case "forkPanelLoaded": {
      const panel = threadPanel(state, action.threadId);
      if (panel?.threadId !== action.threadId || panel.loadId !== action.loadId) return state;
      const live = new Map(panel.messages.map((message) => [message.id, message]));
      const loaded = new Set(action.messages.map((message) => message.id));
      const messages = [...action.messages.map((message) => live.get(message.id) ?? message),
        ...panel.messages.filter((message) => !loaded.has(message.id))];
      return updatePanel(state, { ...panel, messages, activeLeafId: panel.activeLeafId ?? action.activeLeafId,
        loading: false, loadFailed: false });
    }
    case "forkPanelLoadFailed": {
      const panel = threadPanel(state, action.threadId);
      return panel && panel.loadId === action.loadId ? updatePanel(state, { ...panel, loading: false, loadFailed: true }) : state;
    }
    case "forkPanelMessage": {
      const panel = threadPanel(state, action.threadId);
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
      return updatePanel(state, { ...panel, messages, activeLeafId });
    }
    case "forkPanelActive": {
      const panel = threadPanel(state, action.threadId);
      return panel ? updatePanel(state, { ...panel, activeLeafId: action.activeLeafId }) : state;
    }
    case "closeForkPanel":
      return state.forkPanel ? { ...state, forkPanel: null } : state;
  }
}

type ForkSend = Extract<Action, { type: "send" | "sendGroup" }>;
export function addForkOptimistic(state: AppState, action: ForkSend): AppState {
  const kind = action.type === "send" ? "bot" : "group";
  const ownerId = action.type === "send" ? action.botId : action.groupId;
  const owners = kind === "bot" ? state.bots : state.groups;
  const panel = threadPanel(state, action.threadId ?? owners.find((owner) => owner.id === ownerId)?.threadId);
  if (!panel || panel.kind !== kind || panel.ownerId !== ownerId || !action.sendId ||
    panel.messages.some((message) => message.sendId === action.sendId)) return state;
  const message = optimisticUserMessage(action.text, action.sendId, action.replyToId, panel.activeLeafId,
    action.type === "sendGroup" ? action.mode ?? "chat" : undefined);
  return updatePanel(state, { ...panel, messages: [...panel.messages, message], activeLeafId: message.id });
}

export function removeForkOptimistic(state: AppState, action: Extract<Action, { type: "optimisticMessageRemoved" }>): AppState {
  const panel = threadPanel(state, action.threadId);
  const optimisticId = optimisticMessageId(action.sendId);
  if (panel?.threadId !== action.threadId || !panel.messages.some((message) => message.id === optimisticId)) return state;
  const optimistic = panel.messages.find((message) => message.id === optimisticId)!;
  return updatePanel(state, { ...panel,
    messages: panel.messages.filter((message) => message.id !== optimisticId),
    activeLeafId: panel.activeLeafId === optimisticId
      ? action.restoreLeafId ?? optimistic.parentId ?? null : panel.activeLeafId });
}

type ForkEffect = Extract<Action, { type: "forkMessage" | "openForkPanel" }>;
export function runForkEffect(action: ForkEffect, dispatch: (action: Action) => void,
  rawDispatch: (action: Action) => void, showError: (error: unknown) => void): void {
  if (action.type === "forkMessage") {
    const owner = action.kind === "bot" ? "bots" : "groups";
    const latest = action.messageId === undefined;
    // The visible branch may still be waiting for its separate active-branch request.
    const body = latest ? { latest: true, branchLeafId: action.branchLeafId } : { messageId: action.messageId };
    void api<{ bot?: BotAnnouncement; group?: Partial<Group> & { id: string }; task: { threadId: string } }>(
      `/api/${owner}/${action.ownerId}/tasks/${action.threadId}/forks`,
      { method: "POST", body: JSON.stringify(body) },
    ).then((result) => {
      if (result.bot) dispatch({ type: "botPatched", bot: result.bot });
      if (result.group) dispatch({ type: "groupPatched", group: result.group });
      dispatch({ type: "openForkPanel", kind: action.kind, ownerId: action.ownerId, threadId: result.task.threadId, focusComposer: latest });
      action.onSuccess?.();
    }).catch((error) => {
      if (action.onError) action.onError(error instanceof Error ? error.message : String(error));
      else showError(error);
    });
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

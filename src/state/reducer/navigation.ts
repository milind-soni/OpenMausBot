// View/selection/overlay routing cases. Case bodies moved verbatim from the reducer switch;
// reducer.ts dispatches each contiguous run to reduceNavigation below.

import type { Action } from "../action";
import type { AppState } from "../reducer";
import { overlaysReducer, VIEW_SWITCH_OVERLAYS, withoutOverlays } from "../overlays";
import { updateBot, withMascotMotion } from "./helpers";

export type NavigationAction = Extract<Action, { type: "showRoutines" | "showChat" | "showTeamMap" | "select" | "openOverlay" | "closeOverlay" | "closeAllOverlays" | "notice" | "revealThread" | "focusMessage" | "focusMessageConsumed" | "newTask" | "switchTask" }>;

export function reduceNavigation(state: AppState, action: NavigationAction): AppState {
  switch (action.type) {
    case "showRoutines":
      return {
        ...state,
        activeView: "routines",
        routinesFocus: { section: action.section, view: action.view, botId: action.botId, routineId: action.routineId, nonce: state.routinesFocus.nonce + 1 },
        overlays: withoutOverlays(state.overlays, VIEW_SWITCH_OVERLAYS),
      };
    case "showChat":
      return state.activeView === "chat" ? state : { ...state, activeView: "chat" };
    case "showTeamMap":
      return {
        ...state,
        activeView: "team-map",
        overlays: withoutOverlays(state.overlays, VIEW_SWITCH_OVERLAYS),
      };
    case "select": {
      if (state.groups.some((g) => g.id === action.id)) {
        return {
          ...state,
          activeView: "chat",
          selectedId: action.id,
          overlays: {
            ...state.overlays,
            botSettingsSection: action.id !== state.selectedId ? "overview" : state.overlays.botSettingsSection,
          },
          groups: state.groups.map((g) => (g.id === action.id ? { ...g, unread: false } : g)),
        };
      }
      return updateBot(
        withMascotMotion(
          {
            ...state,
            activeView: "chat",
            selectedId: action.id,
            overlays: {
              ...state.overlays,
              botSettingsSection: action.id !== state.selectedId ? "overview" : state.overlays.botSettingsSection,
            },
          },
          action.id,
          "switch",
        ),
        action.id,
        (b) => ({ ...b, unread: Boolean(b.tasks?.some((task) => task.threadId !== b.threadId && task.unread)), tasks: b.tasks?.map((task) => task.threadId === b.threadId ? { ...task, unread: false } : task) }),
      );
    }
    case "openOverlay": {
      if (action.kind === "settings") {
        // A targeted settings link opens that bot without navigating to chat
        // or marking its conversations read, even when another panel is open.
        if (action.botId !== undefined && !state.bots.some((bot) => bot.id === action.botId && !bot.hidden)) return state;
        const selectedId = action.botId ?? state.selectedId;
        return {
          ...state,
          selectedId,
          overlays: overlaysReducer(state.overlays, action, selectedId !== state.selectedId),
        };
      }
      return { ...state, overlays: overlaysReducer(state.overlays, action) };
    }
    case "closeOverlay": {
      return { ...state, overlays: overlaysReducer(state.overlays, action) };
    }
    case "closeAllOverlays":
      return { ...state, overlays: { ...state.overlays, open: [] } };
    case "notice":
      return { ...state, notice: action.notice };
    case "revealThread":
      return { ...state, revealThread: { threadId: action.threadId, nonce: (state.revealThread?.nonce ?? 0) + 1 } };
    case "focusMessage":
      return {
        ...state,
        focusMessage: {
          threadId: action.threadId,
          messageId: action.messageId,
          nonce: (state.focusMessage?.nonce ?? 0) + 1,
          consumed: false,
        },
      };
    case "focusMessageConsumed":
      if (!state.focusMessage || state.focusMessage.nonce !== action.nonce) return state;
      return { ...state, focusMessage: { ...state.focusMessage, consumed: true } };
    case "newTask":
      return { ...state, selectedId: action.botId, activeView: "chat" };
    case "switchTask": {
      // Older background frames are already represented by the next server
      // snapshot. Only frames racing that request need replaying over it.
      const { [action.threadId]: _old, ...backgroundThreadEvents } = state.backgroundThreadEvents;
      return { ...state, backgroundThreadEvents, selectedId: action.botId, activeView: "chat" };
    }
  }
  return action satisfies never;
}

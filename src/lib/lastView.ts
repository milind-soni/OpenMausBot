// Remembers where the user was — the open Buddy chat or room and the open
// main screen — so Studio reopens there after a restart. Only ids and screen
// names are stored; message content stays with the server.

export type LastScreen = "chat" | "schedules" | "projects" | "tasks" | "preview" | "apps" | "settings";

export interface LastView {
  selectedId: string;
  screen: LastScreen;
  settingsTab?: string;
}

export interface ViewState {
  selectedId: string;
  schedulesOpen: boolean;
  projectsOpen: boolean;
  taskBoardOpen: boolean;
  previewOpen: boolean;
  appsOpen: boolean;
  appSettingsOpen: boolean;
  appSettingsTab?: string;
}

export const LAST_VIEW_KEY = "gbs-last-view";

const SCREENS: readonly LastScreen[] = ["chat", "schedules", "projects", "tasks", "preview", "apps", "settings"];

export function viewOf(state: ViewState): LastView {
  const screen: LastScreen = state.appSettingsOpen
    ? "settings"
    : state.schedulesOpen
      ? "schedules"
      : state.projectsOpen
        ? "projects"
        : state.taskBoardOpen
          ? "tasks"
          : state.previewOpen
            ? "preview"
            : state.appsOpen
              ? "apps"
              : "chat";
  return {
    selectedId: state.selectedId,
    screen,
    ...(screen === "settings" && state.appSettingsTab ? { settingsTab: state.appSettingsTab } : {}),
  };
}

export function parseLastView(raw: string | null): LastView | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { selectedId, screen, settingsTab } = value as Record<string, unknown>;
    if (typeof selectedId !== "string" || !SCREENS.includes(screen as LastScreen)) return null;
    return {
      selectedId,
      screen: screen as LastScreen,
      ...(typeof settingsTab === "string" ? { settingsTab } : {}),
    };
  } catch {
    return null;
  }
}

/** Initial state flags for a restored view. Unknown chat ids are resolved later by hydrate. */
export function restoreView<T extends ViewState>(state: T, view: LastView | null): T {
  if (!view) return state;
  return {
    ...state,
    selectedId: view.selectedId,
    schedulesOpen: view.screen === "schedules",
    projectsOpen: view.screen === "projects",
    taskBoardOpen: view.screen === "tasks",
    previewOpen: view.screen === "preview",
    appsOpen: view.screen === "apps",
    appSettingsOpen: view.screen === "settings",
    appSettingsTab: view.screen === "settings" ? view.settingsTab : state.appSettingsTab,
  };
}

export function readLastView(): LastView | null {
  try {
    return parseLastView(localStorage.getItem(LAST_VIEW_KEY));
  } catch {
    return null;
  }
}

export function saveLastView(view: LastView): void {
  if (!view.selectedId && view.screen === "chat") return;
  try {
    localStorage.setItem(LAST_VIEW_KEY, JSON.stringify(view));
  } catch {}
}

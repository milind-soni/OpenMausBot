import type { Action, AppState, Group } from "@/state/store";
import { openFeedThread, roomFeedShows } from "./room-feed";

type Viewer = string | null | undefined;
const key = (viewer: string | null, roomId: string) => `omb.lastRoomThread:${JSON.stringify([viewer, roomId])}`;

export function rememberRoomThread(viewer: Viewer, roomId: string, threadId: string | null): void {
  if (viewer === undefined) return;
  try {
    if (threadId === null) localStorage.removeItem(key(viewer, roomId));
    else localStorage.setItem(key(viewer, roomId), threadId);
  } catch {}
}

function lastRoomThread(viewer: Viewer, roomId: string): string | null {
  if (viewer === undefined) return null;
  try { return localStorage.getItem(key(viewer, roomId)); } catch { return null; }
}

export function openRoomRow(dispatch: (action: Action) => void, group: Group,
  state: Pick<AppState, "config" | "activeView" | "selectedId" | "forkPanel">, viewer: Viewer): void {
  const feed = roomFeedShows(state.config, group);
  const panel = state.forkPanel;
  const available = (id: string) => group.tasks?.some((task) => task.threadId === id && task.archivedAt === undefined);
  if (feed && state.activeView === "chat" && state.selectedId === group.id && panel?.kind === "group" && panel.ownerId === group.id && available(panel.threadId)) return;
  dispatch({ type: "select", id: group.id });
  const last = feed && lastRoomThread(viewer, group.id);
  if (!last) return;
  if (available(last)) dispatch(openFeedThread(group.id, last));
  else if (group.tasks) rememberRoomThread(viewer, group.id, null);
}

import { roomFeedEnabled } from "@/lib/feature-flags";
import { roomNeedsSetup } from "@/lib/room-setup";
import { SIDEBAR_INLINE } from "@/lib/use-media-query";
import type { Action, AppState, Group } from "@/state/store";

export type FeedRoom = Pick<Group, "dm"> & { messages?: readonly unknown[] };
type ThreadOwner = { id: string; threadId: string; dm?: boolean; tasks?: ReadonlyArray<{ threadId: string }> };

const wideWindow = () => typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia(SIDEBAR_INLINE).matches;
const remoteClient = () => typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
export const settingUp = (group: FeedRoom) => !remoteClient() && Array.isArray(group.messages) && roomNeedsSetup(group as Group);

/** A room shows its threads as one feed, with the open one beside it, while Settings → Features → Room feed is on and
 * the window is wide enough for the thread beside it. A bot-to-bot room keeps its one conversation, and a new room
 * its setup. */
export function roomFeedShows(config: AppState["config"] | undefined, group: FeedRoom | undefined, wide = wideWindow()): boolean {
  return Boolean(group) && roomFeedEnabled(config) && !group!.dm && wide && !settingUp(group!);
}

export const openFeedThread = (groupId: string, threadId: string, focusComposer = false): Action =>
  ({ type: "openForkPanel", kind: "group", ownerId: groupId, threadId, ...(focusComposer ? { focusComposer } : {}) });

/** A room's thread asked for from anywhere in the app opens beside its feed rather than becoming the room's current
 * thread, which is everyone's. A new thread there starts from the feed's composer. Null: nothing more to do. */
export function feedThreadAction(action: Action, state: Pick<AppState, "config" | "groups">): Action | null {
  if (action.type !== "switchGroupTask" && action.type !== "newGroupTask") return action;
  if (!roomFeedShows(state.config, state.groups.find((group) => group.id === action.groupId))) return action;
  if (action.type === "switchGroupTask") return openFeedThread(action.groupId, action.threadId);
  document.querySelector<HTMLTextAreaElement>("[data-room-feed-composer] textarea:not([disabled])")?.focus();
  return null;
}

/** With the room feed on, a thread opened from the Inbox opens beside whatever is on screen, and the Inbox stays.
 * False where today's way applies: a phone, a room's bot-to-bot chat, a thread no room or bot here holds, or the one
 * already shown in the chat. */
export function openThreadBeside(dispatch: (action: Action) => void, threadId: string,
  state: Pick<AppState, "config" | "activeView" | "selectedId"> & { bots: readonly ThreadOwner[]; groups: readonly (ThreadOwner & FeedRoom)[] }): boolean {
  if (!roomFeedEnabled(state.config) || !wideWindow()) return false;
  const owns = (owner: ThreadOwner) => (owner.tasks ?? []).some((task) => task.threadId === threadId);
  const group = state.groups.find(owns), bot = group ? undefined : state.bots.find(owns);
  const owner = group ?? bot;
  if (!owner || group?.dm) return false;
  const inChat = state.activeView === "chat" && state.selectedId === owner.id && owner.threadId === threadId;
  if (inChat && !(group && roomFeedShows(state.config, group))) return false;
  dispatch({ type: "openForkPanel", kind: group ? "group" : "bot", ownerId: owner.id, threadId });
  return true;
}

/** A feed room's line in the sidebar: the title of its thread that moved last, since its current thread need not be. */
export function feedPreview(group: Pick<Group, "tasks">): string | undefined {
  const said = (group.tasks ?? []).filter((task) => task.archivedAt === undefined && task.lastThreadOrderAt !== undefined);
  return said.sort((a, b) => (b.lastThreadOrderAt ?? 0) - (a.lastThreadOrderAt ?? 0))[0]?.title;
}

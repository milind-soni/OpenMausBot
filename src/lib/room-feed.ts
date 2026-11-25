import { roomFeedEnabled } from "@/lib/feature-flags";
import { roomNeedsSetup } from "@/lib/room-setup";
import { SIDEBAR_INLINE } from "@/lib/use-media-query";
import { api, type Action, type AppState, type Group } from "@/state/store";

export type FeedRoom = Pick<Group, "dm"> & { messages?: readonly unknown[] };
type ThreadOwner = { id: string; threadId: string; dm?: boolean; tasks?: ReadonlyArray<{ threadId: string }> };

const wideWindow = () => typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia(SIDEBAR_INLINE).matches;
const remoteClient = () => typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
export const settingUp = (group: FeedRoom) => !remoteClient() && Array.isArray(group.messages) && roomNeedsSetup(group as Group);

/** A room shows its threads as one feed, with the open one beside it, where its server has the feed and the window is
 * wide enough for the thread beside it. A bot-to-bot room keeps its one conversation, and a new room its setup. */
export function roomFeedShows(config: AppState["config"] | undefined, group: FeedRoom | undefined, wide = wideWindow()): boolean {
  return Boolean(group) && roomFeedEnabled(config) && !group!.dm && wide && !settingUp(group!);
}

export const openFeedThread = (groupId: string, threadId: string, focusComposer = false): Action =>
  ({ type: "openForkPanel", kind: "group", ownerId: groupId, threadId, ...(focusComposer ? { focusComposer } : {}) });

/** The room whose feed composer a "+" asked for before the feed was on screen. */
let composerWanted: string | null = null;

/** Puts the cursor in the room's feed composer, if that feed is on screen. */
export function focusFeedComposer(groupId: string): boolean {
  if (typeof document === "undefined") return false;
  const feed = [...document.querySelectorAll<HTMLElement>("[data-room-feed]")].find((element) => element.dataset.roomFeed === groupId);
  const box = feed?.querySelector<HTMLTextAreaElement>("[data-room-feed-composer] textarea:not([disabled])");
  if (!box) return false;
  box.focus();
  if (composerWanted === groupId) composerWanted = null;
  return true;
}

/** Whether a "+" asked for this room's feed composer while the feed was not yet on screen; asking clears it. */
export function takeFeedComposerWanted(groupId: string): boolean {
  const wanted = composerWanted === groupId;
  if (wanted) composerWanted = null;
  return wanted;
}

/** A room's thread asked for from anywhere in the app opens beside its feed rather than becoming the room's current
 * thread, which is everyone's. A new thread (the room's "+") starts from the feed's composer: the room comes on screen
 * first when it is not, with the cursor in that composer. Null: nothing more to do. */
export function feedThreadAction(action: Action, state: Pick<AppState, "config" | "groups">): Action | null {
  if (action.type !== "switchGroupTask" && action.type !== "newGroupTask") return action;
  if (!roomFeedShows(state.config, state.groups.find((group) => group.id === action.groupId))) return action;
  if (action.type === "switchGroupTask") return openFeedThread(action.groupId, action.threadId);
  if (focusFeedComposer(action.groupId)) return null;
  composerWanted = action.groupId;
  return { type: "select", id: action.groupId };
}

/** A room's thread opened from a page that then shows the room (`showRoom` selects it): with the feed, the room comes
 * first so the thread stays open beside it. */
export function openRoomThreadThen(dispatch: (action: Action) => void, state: Pick<AppState, "config" | "groups">, groupId: string, threadId: string,
  showRoom: (groupId: string) => void): void {
  if (!roomFeedShows(state.config, state.groups.find((group) => group.id === groupId))) {
    dispatch({ type: "switchGroupTask", groupId, threadId });
    showRoom(groupId);
    return;
  }
  showRoom(groupId);
  dispatch(openFeedThread(groupId, threadId));
}

/** A room thread opened from the Inbox opens with its room's feed, beside it (or in its place when the two don't fit),
 * and the Inbox stays. False where the usual way applies: a bot's thread (it opens in the chat), a phone, a room that
 * doesn't show as its feed, or a thread no room here holds. */
export function openThreadBeside(dispatch: (action: Action) => void, threadId: string,
  state: Pick<AppState, "config" | "activeView" | "selectedId"> & { groups: readonly (ThreadOwner & FeedRoom)[] }): boolean {
  const group = state.groups.find((owner) => (owner.tasks ?? []).some((task) => task.threadId === threadId));
  if (!group || !roomFeedShows(state.config, group)) return false;
  if (state.activeView !== "chat" || state.selectedId !== group.id) dispatch({ type: "select", id: group.id });
  dispatch({ type: "openForkPanel", kind: "group", ownerId: group.id, threadId });
  return true;
}

/** A feed room's line in the sidebar: the title of its thread that moved last, since its current thread need not be. */
export function feedPreview(group: Pick<Group, "tasks">): string | undefined {
  const said = (group.tasks ?? []).filter((task) => task.archivedAt === undefined && task.lastThreadOrderAt !== undefined);
  return said.sort((a, b) => (b.lastThreadOrderAt ?? 0) - (a.lastThreadOrderAt ?? 0))[0]?.title;
}

/** A room's threads still marked unread from before this place had the feed for everyone (`features.roomFeedSince`).
 * The single transcript only ever read the thread on screen, so such marks were never going to clear on their own; the
 * feed reads them once. A mark made since stays until its thread is opened. */
export function staleUnreadThreads(group: Pick<Group, "tasks">, since: number | undefined): string[] {
  if (typeof since !== "number" || !Number.isFinite(since)) return [];
  return (group.tasks ?? []).filter((task) => task.unread === true && (task.updatedAt ?? task.lastThreadOrderAt ?? task.createdAt) < since)
    .map((task) => task.threadId);
}

const CAUGHT_UP_KEY = "omb-room-feed-old-marks-read";
/** As many threads as the room's read route takes in one request. */
const READ_BATCH = 500;
const reading = new Set<string>();
type Store = Pick<Storage, "getItem" | "setItem">;

function safeStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function caughtUp(storage: Store | null): Set<string> {
  try { return new Set<string>(JSON.parse(storage?.getItem(CAUGHT_UP_KEY) ?? "[]") as string[]); } catch { return new Set(); }
}

/** Reads a room's old marks (staleUnreadThreads) the first time it shows as its feed on this device: all of them in one
 * request to the room's read route, so one answer and one frame. The room counts as done only once that read
 * succeeded; a failure leaves it to try again the next time the room shows. A thread marked unread on purpose later
 * keeps its mark. Resolves to whether the room is done. */
export async function catchUpOldMarks(group: Pick<Group, "id" | "tasks">, since: number | undefined,
  onGroup: (group: Partial<Group> & { id: string }) => void,
  { request = api, storage = safeStorage() }: { request?: typeof api; storage?: Store | null } = {}): Promise<boolean> {
  if (typeof since !== "number" || reading.has(group.id) || caughtUp(storage).has(group.id)) return false;
  reading.add(group.id);
  try {
    const stale = staleUnreadThreads(group, since);
    for (let at = 0; at < stale.length; at += READ_BATCH) {
      const result = await request<{ group?: Partial<Group> & { id: string } }>(`/api/groups/${group.id}/read`,
        { method: "POST", body: JSON.stringify({ threadIds: stale.slice(at, at + READ_BATCH) }) });
      if (result?.group) onGroup(result.group);
    }
    const done = caughtUp(storage);
    done.add(group.id);
    try { storage?.setItem(CAUGHT_UP_KEY, JSON.stringify([...done])); } catch { /* read again next time: harmless */ }
    return true;
  } catch {
    return false;
  } finally {
    reading.delete(group.id);
  }
}

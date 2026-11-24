import { t } from "@/lib/i18n";
import { openFeedThread } from "@/lib/room-feed";
import { api, type Action, type Group } from "@/state/store";

type SendGroup = Extract<Action, { type: "sendGroup" }>;
type Created = { group?: Partial<Group> & { id: string }; task: { threadId: string } };

/** The thread each send started, so sending it again after a failure writes there instead of starting another. */
const started = new Map<string, string>();

/** The composer's id for a room feed's line that has no thread yet. */
export const feedDraftThread = (groupId: string) => `feed-${groupId}`;

/** A line written in the feed starts a thread of its own, made without becoming the room's current thread (that is
 * everyone's), opens it beside the feed, and is sent there; the room's usual responder answers it. Resolves to the new
 * thread, or null when it couldn't be made. */
export async function startFeedThread(send: SendGroup, dispatch: (action: Action) => void, request: typeof api = api): Promise<string | null> {
  let threadId = send.sendId ? started.get(send.sendId) : undefined;
  if (!threadId) {
    try {
      const made = await request<Created>(`/api/groups/${send.groupId}/tasks`, { method: "POST", body: JSON.stringify({ activate: false }) });
      if (made.group) dispatch({ type: "groupPatched", group: made.group });
      threadId = made.task.threadId;
      if (send.sendId) started.set(send.sendId, threadId);
    } catch {
      send.onError?.();
      dispatch({ type: "error", message: t("room.feed.startFailed") });
      return null;
    }
  }
  dispatch(openFeedThread(send.groupId, threadId));
  dispatch({ ...send, threadId });
  return threadId;
}

import { useCallback, useMemo } from "react";
import type { Bot, Group } from "@/state/store";
import { useStoreDispatch } from "@/state/store-select";
import { RoomComposer } from "../bot-access/RoomComposer";
import { feedDraftThread, startFeedThread } from "./start-thread";

/** The composer under a room's feed: every line sent here starts a new thread. Its draft is the feed's own, never tied
 * to a thread that is working. */
export function FeedComposer({ group, members, onPending, onStarted }: {
  group: Group;
  members: Bot[];
  /** The line on its way, or null once it can't be: the draft is back in the composer. */
  onPending: (text: string | null) => void;
  onStarted: (threadId: string) => void;
}) {
  const dispatch = useStoreDispatch();
  const draft = useMemo<Group>(() => ({ ...group, threadId: feedDraftThread(group.id), messages: [], hasMore: false, working: false, busyBotId: null,
    turnStartedAt: null, pinnedMessageId: undefined, queue: [] }), [group]);
  const send = useCallback((action: Parameters<NonNullable<Parameters<typeof RoomComposer>[0]["onSendGroup"]>>[0]) => {
    onPending(action.text);
    const failed = () => { action.onError?.(); onPending(null); };
    void startFeedThread({ ...action, onError: failed }, dispatch).then((threadId) => { if (threadId) onStarted(threadId); });
  }, [dispatch, onPending, onStarted]);
  return (
    <div data-room-feed-composer="">
      <RoomComposer group={draft} members={members} onSendGroup={send} />
    </div>
  );
}

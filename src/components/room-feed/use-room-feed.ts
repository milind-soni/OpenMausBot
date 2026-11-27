import { roomFeedEnabled } from "@/lib/feature-flags";
import type { FeedRoom } from "@/lib/room-feed";
import { SIDEBAR_INLINE, useMediaQuery } from "@/lib/use-media-query";
import { useStoreSelector } from "@/state/store-select";

/** Whether this server has the room feed (roomFeedEnabled): an older one keeps every room's single transcript. */
export function useRoomFeedHere(): boolean {
  return useStoreSelector((state) => roomFeedEnabled(state.config));
}

/** Whether this room shows as its feed of threads (roomFeedShows), following the window as it changes. */
export function useRoomFeed(group: FeedRoom | undefined): boolean {
  const on = useRoomFeedHere();
  const wide = useMediaQuery(SIDEBAR_INLINE, true);
  return Boolean(group) && on && !group!.dm && wide;
}

import { settingUp, type FeedRoom } from "@/lib/room-feed";
import { useFeature } from "@/lib/use-feature";
import { SIDEBAR_INLINE, useMediaQuery } from "@/lib/use-media-query";

/** Whether this room shows as its feed of threads (roomFeedShows), following the switch and the window as they change. */
export function useRoomFeed(group: FeedRoom | undefined): boolean {
  const on = useFeature("roomFeed");
  const wide = useMediaQuery(SIDEBAR_INLINE, true);
  return Boolean(group) && on && !group!.dm && wide && !settingUp(group!);
}

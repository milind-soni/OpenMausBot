import { useEffect, useRef } from "react";
import { shownChatIsUnread } from "@/lib/shown-chat-unread";
import { useStore } from "@/state/store";

/** Replies that reached the shown chat while the window was in the background stay unread; once the window has focus
 * again, that chat is read through `select`, which also puts the "New" divider above them. */
export function useReadShownChatOnFocus(): void {
  const { state, dispatch } = useStore();
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    const readShownChat = () => {
      const { selectedId } = latest.current;
      if (selectedId && shownChatIsUnread(latest.current)) dispatch({ type: "select", id: selectedId });
    };
    window.addEventListener("focus", readShownChat);
    return () => window.removeEventListener("focus", readShownChat);
  }, [dispatch]);
}

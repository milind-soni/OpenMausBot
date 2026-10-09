// The New divider of the open conversation (see lib/unread-divider). It
// stays where it was put while the conversation is open, and goes once the
// person has caught up: they wrote back, or scrolled away and read their way
// down to the end again. It lingers a moment, then fades and folds away.
import { useEffect, useMemo, useRef, useState } from "react";
import { peerLine } from "@/lib/peer-message";
import { UNREAD_DIVIDER_FADE_MS, UNREAD_DIVIDER_LINGER_MS } from "@/lib/unread-divider";
import { useStore, type Message } from "@/state/store";

export function useUnreadDivider({ threadId, messages, following }: {
  threadId: string;
  /** The full transcript of the open conversation. */
  messages: readonly Message[];
  /** The viewport follows the end (useTranscriptViewport). */
  following: boolean;
}): { messageId: string | null; fading: boolean } {
  const { state, dispatch } = useStore();
  const messageId = state.unreadDivider?.threadId === threadId ? state.unreadDivider.messageId : null;
  const newestOwnId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user" && !peerLine(messages[i]!)) return messages[i]!.id;
    }
    return null;
  }, [messages]);

  // What the person had written, and whether they had left the end, as of
  // this divider. A new divider starts over; catching up is for good.
  const seen = useRef({ messageId, ownId: newestOwnId, leftEnd: false, caughtUp: false });
  if (seen.current.messageId !== messageId) seen.current = { messageId, ownId: newestOwnId, leftEnd: false, caughtUp: false };
  if (!following) seen.current.leftEnd = true;
  if (messageId !== null && (newestOwnId !== seen.current.ownId || (following && seen.current.leftEnd))) seen.current.caughtUp = true;
  const caughtUp = seen.current.caughtUp;

  const [fadingId, setFadingId] = useState<string | null>(null);
  useEffect(() => {
    if (!messageId || !caughtUp) return;
    const done = () => dispatch({ type: "unreadDividerDone", threadId });
    let fold: ReturnType<typeof setTimeout> | undefined;
    const linger = setTimeout(() => {
      // reduced motion: no fade, it simply goes
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return done();
      setFadingId(messageId);
      fold = setTimeout(done, UNREAD_DIVIDER_FADE_MS);
    }, UNREAD_DIVIDER_LINGER_MS);
    return () => {
      clearTimeout(linger);
      if (fold) clearTimeout(fold);
    };
  }, [messageId, caughtUp, threadId, dispatch]);

  return { messageId, fading: messageId !== null && fadingId === messageId };
}

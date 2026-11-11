import { useEffect, useMemo, useRef, useState } from "react";
import { peerLine } from "@/lib/peer-message";
import { UNREAD_DIVIDER_FADE_MS, UNREAD_DIVIDER_LINGER_MS } from "@/lib/unread-divider";
import { useStore, type Message } from "@/state/store";

export function useUnreadDivider({ threadId, messages, following }: {
  threadId: string;
  messages: readonly Message[];
  following: boolean;
}): { messageId: string | null; fading: boolean } {
  const { state, dispatch } = useStore();
  const divider = state.unreadDivider;
  const messageId = divider && divider.threadId === threadId ? divider.messageId : null;
  const newestOwnId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user" && !peerLine(messages[i]!)) return messages[i]!.id;
    }
    return null;
  }, [messages]);

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

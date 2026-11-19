import { useEffect, useMemo, useRef, useState } from "react";
import { peerLine } from "@/lib/peer-message";
import { placeUnreadDivider, UNREAD_DIVIDER_FADE_MS, UNREAD_DIVIDER_LINGER_MS } from "@/lib/unread-divider";
import type { Message } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";

export function useUnreadDivider({ threadId, messages, following, hasMore }: {
  threadId: string;
  messages: readonly Message[];
  following: boolean;
  hasMore?: boolean;
}): { messageId: string | null; fading: boolean } {
  const divider = useStoreSelector((state) => state.unreadDivider), dispatch = useStoreDispatch();
  const current = divider?.threadId === threadId ? divider : null;
  const messageId = useMemo(() => {
    const placed = hasMore === undefined ? current : placeUnreadDivider(current, threadId, messages, hasMore);
    if (!placed?.messageId || hasMore === undefined) return placed?.messageId ?? null;
    const index = messages.findIndex(message => message.id === placed.messageId);
    return index < 0 ? null : messages.slice(index).find(message => !message.reaction && message.kind !== "digest")?.id ?? null;
  }, [current, threadId, messages, hasMore]);
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

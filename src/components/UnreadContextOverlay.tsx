import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { isRowOffscreen, unreadContextMessage } from "@/lib/unread-context";
import type { Message } from "@/state/store";
import { UnreadContextCard } from "./UnreadContextCard";

/** The card that brings back the person's line above the unread divider, judged once per visit. */
export function UnreadContextOverlay({ messages, windowedMessages, unreadMessageId, scrollRef, visitKey, onJump }: {
  messages: readonly Message[];
  windowedMessages: readonly Message[];
  unreadMessageId?: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  visitKey: string;
  onJump: (messageId: string) => void;
}) {
  const unreadContext = useMemo(() => unreadContextMessage(messages, unreadMessageId), [messages, unreadMessageId]);
  const unreadContextKey = unreadContext ? `${visitKey}:${unreadContext.id}` : null;
  const unreadContextDecided = useRef<string | null>(null);
  const [unreadContextShown, setUnreadContextShown] = useState<string | null>(null);
  const [unreadContextDismissed, setUnreadContextDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!unreadContext || !unreadContextKey || unreadContextDecided.current === unreadContextKey) return;
    const messageId = unreadContext.id;
    if (!windowedMessages.some((message) => message.id === messageId)) {
      unreadContextDecided.current = unreadContextKey;
      setUnreadContextShown(unreadContextKey);
      return;
    }
    // After paint, with the opening scroll in place: measure where the message ended up.
    const frame = requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      const wrapper = scroller && [...scroller.querySelectorAll<HTMLElement>("[data-mid]")].find((row) => row.dataset.mid === messageId);
      const row = wrapper?.querySelector<HTMLElement>("[data-message-row]") ?? (wrapper?.lastElementChild as HTMLElement | null);
      unreadContextDecided.current = unreadContextKey;
      setUnreadContextShown(isRowOffscreen(row?.getBoundingClientRect() ?? null, scroller?.getBoundingClientRect() ?? null) ? unreadContextKey : null);
    });
    return () => cancelAnimationFrame(frame);
  }, [unreadContext, unreadContextKey, windowedMessages, scrollRef]);
  useEffect(() => {
    if (!unreadContextKey || unreadContextShown !== unreadContextKey || unreadContextDismissed === unreadContextKey) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUnreadContextDismissed(unreadContextKey);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [unreadContextKey, unreadContextShown, unreadContextDismissed]);
  if (!unreadContextKey || !unreadContext || unreadContextShown !== unreadContextKey || unreadContextDismissed === unreadContextKey) return null;
  return (
    <UnreadContextCard
      message={unreadContext}
      onJump={() => { onJump(unreadContext.id); setUnreadContextDismissed(unreadContextKey); }}
      onClose={() => setUnreadContextDismissed(unreadContextKey)}
    />
  );
}

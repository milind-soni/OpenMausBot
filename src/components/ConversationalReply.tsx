import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { splitConversationalReply } from "../../shared/reply-style";
import { joinedCorners, SIMPLE_BOT_BUBBLE, type BubbleJoin } from "./chat-bubble";

export { isConversational } from "../../shared/reply-style";

/** A reply that arrives while its thread is open plays its parts in; parts already shown never replay. */
export function useReplySegments(show: boolean, text: string, at: number, openedAt: number): { segments: string[]; firstNew: number } {
  const segments = useMemo(() => (show ? splitConversationalReply(text) : []), [show, text]);
  const [fresh] = useState(() => at >= openedAt);
  const shown = useRef(fresh ? 0 : segments.length);
  const firstNew = shown.current;
  useEffect(() => {
    shown.current = Math.max(shown.current, segments.length);
  }, [segments.length]);
  return { segments, firstNew };
}

export function useThreadOpenedAt(threadId: string): number {
  const opened = useRef({ threadId, at: Date.now() });
  if (opened.current.threadId !== threadId) opened.current = { threadId, at: Date.now() };
  return opened.current.at;
}

export function ConversationalReply({ segments, firstNew, citation, renderSegment, simple = false, join }: {
  segments: readonly string[];
  firstNew: number;
  citation: { messageId: string; botId: string; threadId: string };
  renderSegment: (segment: string) => ReactNode;
  /** Simple mode: each part is a full bot bubble, joined to its neighbours as one group. */
  simple?: boolean;
  /** Simple mode: whether the reply's first and last parts meet the bubbles around the message. */
  join?: BubbleJoin;
}) {
  return (
    <div data-conversational-reply className="flex w-full flex-col items-start gap-1" data-citation-source={citation.messageId} data-citation-owner-type="bot" data-citation-owner={citation.botId} data-citation-thread={citation.threadId}>
      {segments.map((segment, index) => (
        <div
          key={index}
          data-reply-segment
          dir="auto"
          className={cn(
            simple
              ? cn(SIMPLE_BOT_BUBBLE, "w-fit max-w-full [overflow-wrap:anywhere]",
                joinedCorners("start", { above: index > 0 || Boolean(join?.above), below: index < segments.length - 1 || Boolean(join?.below) }))
              : "reply-bubble",
            index >= firstNew && "reply-bubble-in",
          )}
          style={index >= firstNew ? { animationDelay: `${(index - firstNew) * 120}ms` } : undefined}
        >
          {renderSegment(segment)}
        </div>
      ))}
    </div>
  );
}

export function QuickModelNote({ model }: { model: string }) {
  return <div data-quick-model className="mt-1 text-[11px] text-ink-tertiary">{t("chat.quickModel", { model })}</div>;
}

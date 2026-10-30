import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { sendsMessage, useSendKey } from "@/lib/send-key";
import type { userBubbleStyle } from "@/lib/user-bubble-tone";
import { SIMPLE_BUBBLE_MAX, SIMPLE_USER_BUBBLE } from "./chat-bubble";

/** Edits one of your sent messages in place, in the bubble's own shape; the send key resubmits and Escape cancels. */
export function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
  bubbleStyle,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  bubbleStyle?: ReturnType<typeof userBubbleStyle>;
}) {
  const simple = !useAdvancedMode();
  const [draft, setDraft] = useState(initial);
  const sendKey = useSendKey();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    if (draft.trim()) onSubmit(draft.trim());
  };
  return (
    <div
      data-chat-bubble={simple ? "simple" : ""}
      className={cn(
        "w-full",
        simple ? cn(SIMPLE_BUBBLE_MAX, SIMPLE_USER_BUBBLE, "py-2") : "max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3",
        bubbleStyle && "user-bubble-colored",
      )}
      style={bubbleStyle}
    >
      <textarea
        ref={ref}
        dir="auto"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (sendsMessage(e.nativeEvent, sendKey)) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        className={cn("w-full resize-none bg-transparent text-ink focus:outline-none", simple ? "leading-[22px]" : "text-[15px] leading-relaxed")}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-full px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          {t("common.cancel")}
        </button>
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className="rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white disabled:opacity-40"
        >
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
}

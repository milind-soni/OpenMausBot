import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
/** Inline editor a user bubble turns into: Enter sends (forking the
 * conversation), Esc cancels. Shift+Enter for a newline, like everywhere. */
export function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
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
    <div className="w-full max-w-[min(42rem,78%)] rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3">
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // isComposing: an IME confirm-Enter must not submit the edit
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink focus:outline-none"
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

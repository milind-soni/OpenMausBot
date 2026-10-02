import { t } from "@/lib/i18n";

/** Ephemeral provider thinking: never a transcript message or a live announcement. */
export function LiveReasoning({ text }: { text?: string }) {
  if (!text?.trim()) return null;
  // Keep long model streams cheap to render, as on the native companions.
  const tail = text.length > 12000 ? `…${text.slice(-12000)}` : text;
  return (
    <details className="max-w-full rounded-xl border border-hairline/40 px-3 py-2 text-ink-secondary" aria-live="off">
      <summary className="cursor-pointer text-[13px] focus-visible:outline focus-visible:outline-2">
        {t("chat.activity.thinking")}
      </summary>
      <div dir="auto" className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed">
        {tail}
      </div>
    </details>
  );
}

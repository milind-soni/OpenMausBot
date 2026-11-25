import { useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { nextRename } from "@/lib/rename";
import { imeComposing } from "@/lib/send-key";

/** A thread's title being renamed in place, as the sidebar's thread row does it: Enter or leaving the field saves,
 * Escape keeps the old title. `onDone` gets the new title, or null when nothing changed. */
export function ThreadRenameField({ title, onDone, className }: { title: string; onDone: (title: string | null) => void; className?: string }) {
  const [draft, setDraft] = useState(title);
  const finished = useRef(false);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onDone(save ? nextRename(title, draft) : null);
  };
  return <input autoFocus value={draft} maxLength={80} aria-label={t("task.renameAria")} dir="auto"
    onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)} onBlur={() => finish(true)}
    onKeyDown={(event) => {
      if (imeComposing(event.nativeEvent)) { event.stopPropagation(); return; }
      if (event.key === "Enter") { event.preventDefault(); finish(true); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
    }}
    className={cn("min-w-0 rounded border border-accent/50 bg-inset px-2 py-1 text-[13px] text-ink outline-none", className)} />;
}

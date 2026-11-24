import { Search } from "lucide-react";
import { t } from "@/lib/i18n";
import { imeComposing } from "@/lib/send-key";

export function ThreadSearch({ query, setQuery, onClose, onEnter, label = t("task.search"), escapeClears = true }: {
  label?: string;
  escapeClears?: boolean;
  query: string;
  setQuery: (query: string) => void;
  onClose: () => void;
  onEnter: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-ink/[0.05] px-2 py-1.5 focus-within:ring-2 focus-within:ring-focus/60">
      <Search size={14} className="shrink-0 text-ink-secondary" />
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (imeComposing(e.nativeEvent)) { e.stopPropagation(); return; }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (escapeClears && query.trim()) setQuery("");
            else onClose();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder={label}
        aria-label={label}
        className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none"
      />
    </div>
  );
}

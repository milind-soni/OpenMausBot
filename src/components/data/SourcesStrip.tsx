import { Table2 } from "lucide-react";
import type { DataSource } from "../../../shared/data-surface";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { formatCount } from "./data-format";

export interface SourcesStripProps {
  sources: DataSource[];
  /** The table open as a grid at the top of the stream, if any. */
  selected: string | null;
  onOpen: (name: string) => void;
}

/** The thin row of loaded tables with their row counts. Clicking one opens
 * it as a grid and in the column explorer. Nothing to show renders nothing;
 * the panel's empty state says what to do. */
export function SourcesStrip({ sources, selected, onOpen }: SourcesStripProps) {
  if (sources.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b border-hairline/40 px-3 py-2" role="list" aria-label={t("data.sources.label")} data-testid="sources-strip">
      {sources.map((source) => (
        <button key={source.name} type="button" role="listitem" onClick={() => onOpen(source.name)} aria-pressed={selected === source.name}
          aria-label={t("data.sources.open", { name: source.name })} title={source.source}
          className={cn("flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors",
            selected === source.name ? "border-accent-border bg-raised text-ink" : "border-hairline/60 text-ink-secondary hover:bg-inset hover:text-ink")}>
          <Table2 size={12} aria-hidden="true" />
          <span className="max-w-40 truncate">{source.name}</span>
          <span className="text-ink-tertiary">{t("data.sources.rows", { count: formatCount(source.rowCount) })}</span>
        </button>
      ))}
    </div>
  );
}

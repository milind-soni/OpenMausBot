import type { DataError } from "../../../shared/data-surface";
import { t } from "@/lib/i18n";
import { formatCount } from "./data-format";

export function SourcesStrip({ sources }: { sources: Array<{ name: string; sqlName?: string; rowCount: number | null; error?: DataError }> }) {
  if (sources.length === 0) return null;
  return (
    <ul className="m-0 mt-1 flex max-h-10 list-none flex-wrap gap-x-4 overflow-y-auto p-0 text-[12px] text-ink-tertiary" aria-label={t("data.sources.label")} data-testid="sources-strip">
      {sources.map((source) => (
        <li key={source.name} className="flex items-baseline gap-2 py-0.5">
          <span className="min-w-0 truncate font-mono">{source.sqlName ?? source.name}</span>
          {typeof source.rowCount === "number"
            ? <span className="shrink-0">{t("data.sources.rows", { count: formatCount(source.rowCount) })}</span>
            : <span className="min-w-0 truncate text-danger" title={source.error?.message}>{t("data.sources.unknownRows")}{source.error ? ` · ${source.error.message}` : ""}</span>}
        </li>
      ))}
    </ul>
  );
}

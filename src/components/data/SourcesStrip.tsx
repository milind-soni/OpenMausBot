import type { DataSource } from "../../../shared/data-surface";
import { t } from "@/lib/i18n";
import { formatCount } from "./data-format";

/** Quiet table references for writing SQL; the list does not change the result. */
export function SourcesStrip({ sources }: { sources: Array<Pick<DataSource, "name" | "rowCount"> & { sqlName?: string }> }) {
  if (sources.length === 0) return null;
  return (
    <ul className="m-0 mt-1 flex max-h-10 list-none flex-wrap gap-x-4 overflow-y-auto p-0 text-[11.5px] text-ink-tertiary" aria-label={t("data.sources.label")} data-testid="sources-strip">
      {sources.map((source) => (
        <li key={source.name} className="flex items-baseline gap-2 py-0.5">
          <span className="min-w-0 truncate font-mono">{source.sqlName ?? source.name}</span>
          <span className="shrink-0">{t("data.sources.rows", { count: formatCount(source.rowCount) })}</span>
        </li>
      ))}
    </ul>
  );
}

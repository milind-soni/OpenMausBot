import { whenLabel } from "@/lib/schedule-label";
import { t } from "@/lib/i18n";

export interface HistoryRow {
  id: string;
  at: number;
  actor: string;
  via: string;
  field: string;
  summary: string;
  canRestore?: boolean;
  restoreUnavailableReason?: string;
  before?: string;
  after?: string;
}

export function HistorySection({
  bot,
  rows,
  refreshError,
  onRollback,
  rollingBack,
}: {
  bot: { id: string };
  rows: HistoryRow[] | null;
  refreshError?: boolean;
  onRollback: (id: string) => void;
  rollingBack?: boolean;
}) {
  if (!rows) {
    return <div className="text-[13px] text-ink-secondary">{t("history.loading")}</div>;
  }
  if (rows.length === 0) {
    return <div className="text-[13px] text-ink-secondary">{t("history.empty")}</div>;
  }

  const sorted = [...rows].sort((a, b) => b.at - a.at);

  return (
    <div className="flex flex-col gap-2">
      {refreshError && (
        <div className="rounded-lg bg-inset px-3 py-2 text-[13px] text-ink-secondary">{t("history.refreshError")}</div>
      )}
      {sorted.map((row) => (
        <div key={`${bot.id}-${row.id}`} className="rounded-xl bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink">
              <span className="text-ink-secondary">{whenLabel(row.at)}</span>
              {" · "}
              <span>
                {row.actor} via {row.via}
              </span>
              {" · "}
              <span>{row.summary}</span>
            </div>
            {row.field === "soul" && row.canRestore === true && (
              <button
                type="button"
                disabled={rollingBack}
                onClick={() => onRollback(row.id)}
                className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-accent-text hover:bg-accent/10 disabled:opacity-50"
              >
                {t("history.undo")}
              </button>
            )}
          </div>
          {row.field === "soul" && row.canRestore !== true && (
            <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
              {row.restoreUnavailableReason ?? t("history.restoreUnavailable")}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

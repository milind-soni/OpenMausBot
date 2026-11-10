// Settings → Usage → Model performance: how each model did in this period (server/usage-models.ts), so a quick or
// local model's tool errors and fallbacks are seen next to the bot's own.
import { useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { formatTokens } from "@/lib/usage";
import { formatCost, formatDuration } from "@/lib/usage-trace";
import { api, useStore } from "@/state/store";
import { modelName } from "./TraceWaterfall";

export interface ModelPerformanceRow {
  model: string;
  driverKind: string;
  turns: number;
  ok: number;
  ended: number;
  steps: number;
  tools: number;
  toolErrors: number;
  quickTurns: number;
  fallbacks: number;
  p50Ms: number | null;
  p90Ms: number | null;
  input: number;
  output: number;
  costUsd: number | null;
}

const share = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

export function ModelPerformance({ range, version }: { range: { from: string; to: string }; version: number }) {
  const { state } = useStore();
  const [rows, setRows] = useState<ModelPerformanceRow[] | null>(null);

  useEffect(() => {
    let current = true;
    const query = new URLSearchParams(range).toString();
    void api<{ models: ModelPerformanceRow[] }>(`/api/usage/models?${query}`, { timeoutMs: 15_000 })
      .then((answer) => { if (current) setRows(answer.models); })
      .catch(() => { if (current) setRows(null); });
    return () => { current = false; };
  }, [range, version]);

  if (!rows?.length) return null;
  const cell = "px-3 py-2 text-right tabular-nums";
  return (
    <section className="rounded-2xl border border-hairline/50 bg-card p-2" aria-label={t("usage.models.title")} data-testid="model-performance">
      <div className="px-3 pb-1 pt-3">
        <h3 className="text-[15px] font-medium text-ink">{t("usage.models.title")}</h3>
        <p className="mt-0.5 text-[13px] text-ink-secondary">{t("usage.models.hint")}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[13px] text-ink">
          <thead className="text-[12px] text-ink-secondary">
            <tr>
              <th className="px-3 py-2 text-left font-normal">{t("usage.models.model")}</th>
              <th className="px-3 py-2 text-right font-normal">{t("usage.models.turns")}</th>
              <th className="px-3 py-2 text-right font-normal">{t("usage.models.ok")}</th>
              <th className="px-3 py-2 text-right font-normal">{t("usage.models.toolErrors")}</th>
              <th className="px-3 py-2 text-right font-normal">{t("usage.models.fallbacks")}</th>
              <th className="px-3 py-2 text-right font-normal">{t("usage.models.time")}</th>
              <th className="px-3 py-2 text-right font-normal">{t("usage.models.tokens")}</th>
              <th className="px-3 py-2 text-right font-normal">{t("usage.models.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.driverKind}:${row.model}`} className="border-t border-hairline/30" data-model-row={row.model}>
                <td className="px-3 py-2 text-left">{modelName(row.model, state.instances)}</td>
                <td className={cell}>{row.turns}</td>
                <td className={cell}>{share(row.ok, row.ended)}</td>
                <td className={cell}>{row.tools ? `${row.toolErrors} / ${row.tools}` : "—"}</td>
                <td className={cell}>{row.quickTurns ? `${row.fallbacks} / ${row.quickTurns}` : "—"}</td>
                <td className={cell}>{row.p50Ms === null ? "—" : `${formatDuration(row.p50Ms)} · ${formatDuration(row.p90Ms ?? row.p50Ms)}`}</td>
                <td className={cell}>{formatTokens(row.input + row.output)}</td>
                <td className={cell}>{formatCost(row.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

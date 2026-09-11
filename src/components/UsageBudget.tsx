// App settings → Usage → Budget and Prices: a monthly spend limit for the
// workspace and the operator's own sell prices per model. Both are
// enterprise entitlements (`budgets`, `billing`); the cards render only
// when the server reports them, and edit the same config the server reads.
import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { formatUsd } from "@/lib/usage";
import { Card } from "./SettingsPrimitives";

export interface BudgetState {
  month: string;
  monthlyUsd: number;
  spentUsd: number;
  percent: number;
  warnAtPercent: number;
  warn: boolean;
  exceeded: boolean;
}

export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
}

export function entitledTo(config: ConfigStatus | null | undefined, feature: string): boolean {
  return config?.edition?.features?.includes(feature) === true;
}

/** The bar's tone follows the state: quiet, warning at the threshold, danger at the cap. */
export function budgetTone(state: BudgetState | null): "quiet" | "warning" | "danger" {
  if (!state) return "quiet";
  return state.exceeded ? "danger" : state.warn ? "warning" : "quiet";
}

export function BudgetCard({ budget }: { budget: BudgetState | null }) {
  const { state, dispatch } = useStore();
  const saved = state.config?.budgets ?? {};
  const [monthly, setMonthly] = useState(saved.monthlyUsd === undefined ? "" : String(saved.monthlyUsd));
  const [warnAt, setWarnAt] = useState(saved.warnAtPercent === undefined ? "80" : String(saved.warnAtPercent));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMonthly(saved.monthlyUsd === undefined ? "" : String(saved.monthlyUsd));
    setWarnAt(saved.warnAtPercent === undefined ? "80" : String(saved.warnAtPercent));
  }, [saved.monthlyUsd, saved.warnAtPercent]);

  const save = async () => {
    if (saving) return;
    const monthlyUsd = monthly.trim() === "" ? 0 : Number(monthly);
    const warnAtPercent = Number(warnAt);
    if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0 || !Number.isInteger(warnAtPercent) || warnAtPercent < 1 || warnAtPercent > 100) {
      setError(t("usage.budget.invalid"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const status: ConfigStatus = await api("/api/config", { method: "PUT", body: JSON.stringify({ budgets: { monthlyUsd, warnAtPercent } }) });
      dispatch({ type: "configStatus", config: status });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const tone = budgetTone(budget);
  return (
    <Card title={t("usage.budget.title")} subtitle={t("usage.budget.subtitle")}>
      {budget ? (
        <div className="mb-4">
          <div className="mb-1 flex items-baseline justify-between text-[13px]">
            <span className={cn(tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-ink")}>
              {budget.exceeded ? t("usage.budget.reached") : budget.warn ? t("usage.budget.nearing") : t("usage.budget.within")}
            </span>
            <span className="tabular-nums text-ink-secondary">{t("usage.budget.spent", { spent: formatUsd(budget.spentUsd), cap: formatUsd(budget.monthlyUsd), percent: String(budget.percent) })}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-inset" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, budget.percent)}>
            <div className={cn("h-full rounded-full", tone === "danger" ? "bg-danger" : tone === "warning" ? "bg-warning" : "bg-accent")} style={{ width: `${Math.min(100, budget.percent)}%` }} />
          </div>
        </div>
      ) : (
        <p className="mb-4 text-[13px] text-ink-secondary">{t("usage.budget.none")}</p>
      )}
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t("usage.budget.monthly")}
          <input value={monthly} onChange={(e) => setMonthly(e.target.value)} inputMode="decimal" placeholder="0" aria-label={t("usage.budget.monthly")} disabled={saving} className="w-32 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] tabular-nums text-ink focus:border-hairline focus:outline-none disabled:opacity-50" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t("usage.budget.warnAt")}
          <input value={warnAt} onChange={(e) => setWarnAt(e.target.value)} inputMode="numeric" aria-label={t("usage.budget.warnAt")} disabled={saving} className="w-20 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] tabular-nums text-ink focus:border-hairline focus:outline-none disabled:opacity-50" />
        </label>
        <button type="submit" disabled={saving} className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50">
          {saving && <Loader2 size={13} className="animate-spin" />}{t("common.save")}
        </button>
      </form>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">{t("usage.budget.hint")}</p>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}

type PriceRow = { key: string; input: string; output: string; cached: string };

function rowsFrom(prices: Record<string, ModelPrice> | undefined): PriceRow[] {
  const rows = Object.entries(prices ?? {}).map(([key, price]) => ({
    key, input: String(price.inputPerMillion), output: String(price.outputPerMillion),
    cached: price.cachedInputPerMillion === undefined ? "" : String(price.cachedInputPerMillion),
  }));
  return rows.length ? rows : [{ key: "default", input: "", output: "", cached: "" }];
}

export function PricesCard() {
  const { state, dispatch } = useStore();
  const saved = state.config?.billing;
  const [currency, setCurrency] = useState(saved?.currency ?? "USD");
  const [rows, setRows] = useState<PriceRow[]>(rowsFrom(saved?.prices));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCurrency(saved?.currency ?? "USD");
    setRows(rowsFrom(saved?.prices));
  }, [saved]);

  const update = (index: number, patch: Partial<PriceRow>) => setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const save = async () => {
    if (saving) return;
    const prices: Record<string, ModelPrice> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      const input = Number(row.input);
      const output = Number(row.output);
      const cached = row.cached.trim() === "" ? undefined : Number(row.cached);
      if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0 || (cached !== undefined && (!Number.isFinite(cached) || cached < 0))) {
        setError(t("usage.prices.invalid", { model: key }));
        return;
      }
      prices[key] = { inputPerMillion: input, outputPerMillion: output, ...(cached === undefined ? {} : { cachedInputPerMillion: cached }) };
    }
    if (!/^[A-Z]{3}$/.test(currency.trim().toUpperCase())) {
      setError(t("usage.prices.currencyInvalid"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const status: ConfigStatus = await api("/api/config", { method: "PUT", body: JSON.stringify({ billing: { currency: currency.trim().toUpperCase(), prices } }) });
      dispatch({ type: "configStatus", config: status });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const cell = "w-full rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[12.5px] tabular-nums text-ink focus:border-hairline focus:outline-none disabled:opacity-50";
  return (
    <Card title={t("usage.prices.title")} subtitle={t("usage.prices.subtitle")}>
      <div className="mb-3 flex items-center gap-2 text-[12px] text-ink-secondary">
        <label className="flex items-center gap-2">
          {t("usage.prices.currency")}
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} aria-label={t("usage.prices.currency")} disabled={saving} className="w-16 rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[12.5px] uppercase text-ink focus:border-hairline focus:outline-none disabled:opacity-50" />
        </label>
      </div>
      <div className="grid grid-cols-[1fr_5rem_5rem_5rem_auto] items-center gap-x-2 gap-y-1.5 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
        <span>{t("usage.prices.colModel")}</span>
        <span>{t("usage.prices.colInput")}</span>
        <span>{t("usage.prices.colOutput")}</span>
        <span>{t("usage.prices.colCached")}</span>
        <span />
        {rows.map((row, index) => (
          <div key={index} className="contents">
            <input value={row.key} onChange={(e) => update(index, { key: e.target.value })} placeholder={t("usage.prices.modelPlaceholder")} aria-label={t("usage.prices.colModel")} disabled={saving} className={cn(cell, "font-mono normal-case tracking-normal")} />
            <input value={row.input} onChange={(e) => update(index, { input: e.target.value })} inputMode="decimal" aria-label={t("usage.prices.colInput")} disabled={saving} className={cell} />
            <input value={row.output} onChange={(e) => update(index, { output: e.target.value })} inputMode="decimal" aria-label={t("usage.prices.colOutput")} disabled={saving} className={cell} />
            <input value={row.cached} onChange={(e) => update(index, { cached: e.target.value })} inputMode="decimal" placeholder="—" aria-label={t("usage.prices.colCached")} disabled={saving} className={cell} />
            <button type="button" onClick={() => setRows((current) => current.filter((_, i) => i !== index))} aria-label={t("usage.prices.remove")} disabled={saving} className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setRows((current) => [...current, { key: "", input: "", output: "", cached: "" }])} disabled={saving} className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"><Plus size={13} />{t("usage.prices.add")}</button>
        <button type="button" onClick={() => void save()} disabled={saving} className="ml-auto flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50">
          {saving && <Loader2 size={13} className="animate-spin" />}{t("common.save")}
        </button>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">{t("usage.prices.hint")}</p>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}

/** Both cards, each only when the server is entitled to it. */
export function UsageBudgetCards({ budget }: { budget: BudgetState | null }) {
  const { state } = useStore();
  const budgets = entitledTo(state.config, "budgets");
  const billing = entitledTo(state.config, "billing");
  if (!budgets && !billing) return null;
  return (
    <>
      {budgets && <BudgetCard budget={budget} />}
      {billing && <PricesCard />}
    </>
  );
}

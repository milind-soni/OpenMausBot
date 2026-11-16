import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { activeLocale, documentLanguage, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { formatTokens, formatUsd } from "@/lib/usage";
import { Select } from "./Select";
import { Card } from "./SettingsPrimitives";

export type CapField = "dailyUsd" | "monthlyUsd" | "dailyTokens" | "monthlyTokens";
export type CapLimits = Partial<Record<CapField, number>>;

export interface CapState {
  id: string;
  scope: "server" | "bot";
  botId?: string;
  period: "day" | "month";
  unit: "usd" | "tokens";
  limit: number;
  used: number;
  percent: number;
  warn: boolean;
  reached: boolean;
  resetsAt: number;
}

/** `caps` on GET /api/usage and the body of /api/usage/caps: only the owner gets one. */
export interface UsageCapView {
  /** What a reached cap stops now; `savedStops` is what config.json holds. */
  stops: "unattended" | "everything";
  savedStops?: "unattended" | "everything";
  /** The saved caps; `env.values` holds what the environment sets, which wins field by field. */
  server: CapLimits;
  bots: Record<string, CapLimits>;
  env: { stops: boolean; server: CapField[]; values?: { server: CapLimits } };
  caps: CapState[];
}

const FIELDS: ReadonlyArray<{ field: CapField; label: LocaleKey; whole: boolean }> = [
  { field: "dailyUsd", label: "usage.caps.dailyUsd", whole: false },
  { field: "dailyTokens", label: "usage.caps.dailyTokens", whole: true },
  { field: "monthlyUsd", label: "usage.caps.monthlyUsd", whole: false },
  { field: "monthlyTokens", label: "usage.caps.monthlyTokens", whole: true },
];

type Draft = Record<CapField, string>;
const draftOf = (limits: CapLimits | undefined): Draft =>
  Object.fromEntries(FIELDS.map(({ field }) => [field, limits?.[field] ? String(limits[field]) : ""])) as Draft;

/** The numbers a row of inputs holds, or null when one is not a cap: empty means none, dollars 0 or more, tokens whole. */
export function limitsOf(draft: Draft): CapLimits | null {
  const limits: CapLimits = {};
  for (const { field, whole } of FIELDS) {
    const raw = draft[field].trim().replace(/,/g, "");
    if (raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || (whole && !Number.isInteger(value))) return null;
    if (value > 0) limits[field] = value;
  }
  return limits;
}

export const capTone = (cap: Pick<CapState, "warn" | "reached">): "quiet" | "warning" | "danger" => (cap.reached ? "danger" : cap.warn ? "warning" : "quiet");

const amount = (cap: Pick<CapState, "unit">, value: number) => (cap.unit === "usd" ? formatUsd(value) : t("usage.caps.tokens", { count: formatTokens(Math.round(value)) }));
const resets = (at: number) => new Date(at).toLocaleString(documentLanguage(activeLocale()), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function CapUse({ cap, name }: { cap: CapState; name: string }) {
  const tone = capTone(cap);
  return (
    <li data-testid="usage-cap" data-cap={cap.id}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-[13px]">
        <span className="text-ink">{t(cap.period === "day" ? "usage.caps.useDay" : "usage.caps.useMonth", { who: name })}</span>
        <span className="tabular-nums text-ink-secondary">{t("usage.caps.used", { used: amount(cap, cap.used), limit: amount(cap, cap.limit), percent: String(cap.percent) })}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-inset" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, cap.percent)}>
        <div className={cn("h-full rounded-full", tone === "danger" ? "bg-danger" : tone === "warning" ? "bg-warning" : "bg-accent")} style={{ width: `${Math.min(100, cap.percent)}%` }} />
      </div>
      {tone !== "quiet" && (
        <p className={cn("mt-1 text-[12px]", tone === "danger" ? "text-danger" : "text-warning")}>
          {cap.reached ? t("usage.caps.reached", { resets: resets(cap.resetsAt) }) : t("usage.caps.nearing", { percent: String(cap.percent) })}
        </p>
      )}
    </li>
  );
}

const INPUT = "w-28 rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[13px] tabular-nums text-ink focus:outline-none disabled:opacity-50";

function LimitInputs({ who, draft, locked, disabled, onChange }: { who: string; draft: Draft; locked?: readonly CapField[]; disabled: boolean; onChange: (field: CapField, value: string) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      {FIELDS.map(({ field, label, whole }) => (
        <label key={field} className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t(label)}
          <input value={draft[field]} onChange={(event) => onChange(field, event.target.value)} inputMode={whole ? "numeric" : "decimal"} placeholder={t("usage.caps.noCap")}
            aria-label={`${who}: ${t(label)}`} disabled={disabled || locked?.includes(field)} className={INPUT} />
        </label>
      ))}
    </div>
  );
}

/** The owner's caps on a day's and a month's usage, for the server and for each bot, with the use against each. */
export function UsageCapsCard({ view, onSaved }: { view: UsageCapView | null | undefined; onSaved?: () => void }) {
  return view ? <CapsForm view={view} onSaved={onSaved} /> : null;
}

/** The server's caps in force: an environment value shows (greyed) in place of the saved one. */
const serverInForce = (view: UsageCapView): CapLimits => ({ ...view.server, ...view.env.values?.server });

/** What a save sends: the owner's own values, never one the environment holds. A greyed field keeps what config.json
 * has, and the choice of what a cap stops keeps the saved one while the environment makes it. */
export function capsToSave(view: UsageCapView, stops: UsageCapView["stops"], server: CapLimits, bots: Record<string, CapLimits>): { stops: UsageCapView["stops"]; server: CapLimits; bots: Record<string, CapLimits> } {
  const own: CapLimits = { ...server };
  for (const field of view.env.server) {
    const saved = view.server[field];
    if (saved === undefined) delete own[field];
    else own[field] = saved;
  }
  return { stops: view.env.stops ? view.savedStops ?? "unattended" : stops, server: own, bots };
}

const botRows = (view: UsageCapView) => Object.entries(view.bots).map(([botId, limits]) => ({ botId, draft: draftOf(limits) }));

function CapsForm({ view, onSaved }: { view: UsageCapView; onSaved?: () => void }) {
  const { state } = useStore();
  const [stops, setStops] = useState(view.stops);
  const [server, setServer] = useState(() => draftOf(serverInForce(view)));
  const [bots, setBots] = useState(() => botRows(view));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = JSON.stringify([view.stops, view.server, view.bots, view.env]);
  useEffect(() => {
    setStops(view.stops);
    setServer(draftOf(serverInForce(view)));
    setBots(botRows(view));
  }, [saved]);

  const botName = (botId: string | undefined) => state.bots?.find((bot) => bot.id === botId)?.name ?? t("usage.caps.goneBot");
  const free = (state.bots ?? []).filter((bot) => !bot.hidden && !bots.some((row) => row.botId === bot.id));

  const save = async () => {
    if (saving) return;
    const serverLimits = limitsOf(server);
    const botLimits = bots.map((row) => [row.botId, limitsOf(row.draft)] as const);
    if (!serverLimits || botLimits.some(([, limits]) => !limits)) {
      setError(t("usage.caps.invalid"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api("/api/usage/caps", { method: "PUT", body: JSON.stringify(capsToSave(view, stops, serverLimits, Object.fromEntries(botLimits) as Record<string, CapLimits>)) });
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t("usage.caps.title")} subtitle={t("usage.caps.subtitle")}>
      {view.caps.length ? (
        <ul className="mb-4 flex flex-col gap-3">
          {view.caps.map((cap) => <CapUse key={cap.id} cap={cap} name={cap.scope === "server" ? t("usage.caps.server") : botName(cap.botId)} />)}
        </ul>
      ) : <p className="mb-4 text-[13px] text-ink-secondary">{t("usage.caps.none")}</p>}
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t("usage.caps.stops")}
          <Select size="sm" className="w-full max-w-md" value={stops} onChange={(event) => setStops(event.target.value as UsageCapView["stops"])} disabled={saving || view.env.stops}>
            <option value="unattended">{t("usage.caps.stopsUnattended")}</option>
            <option value="everything">{t("usage.caps.stopsEverything")}</option>
          </Select>
        </label>
        <div>
          <div className="mb-1.5 text-[13px] text-ink">{t("usage.caps.server")}</div>
          <LimitInputs who={t("usage.caps.server")} draft={server} locked={view.env.server} disabled={saving} onChange={(field, value) => setServer((current) => ({ ...current, [field]: value }))} />
          {(view.env.server.length > 0 || view.env.stops) && <p className="mt-1 text-[12px] text-ink-secondary">{t("usage.caps.fromEnv")}</p>}
        </div>
        {bots.map((row) => (
          <div key={row.botId}>
            <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink">
              {botName(row.botId)}
              <button type="button" onClick={() => setBots((current) => current.filter((other) => other.botId !== row.botId))} aria-label={t("usage.caps.removeBot", { bot: botName(row.botId) })} disabled={saving}
                className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"><Trash2 size={13} /></button>
            </div>
            <LimitInputs who={botName(row.botId)} draft={row.draft} disabled={saving}
              onChange={(field, value) => setBots((current) => current.map((other) => (other.botId === row.botId ? { ...other, draft: { ...other.draft, [field]: value } } : other)))} />
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          {free.length > 0 && (
            <label className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
              <Plus size={13} />
              <Select size="sm" value="" onChange={(event) => { const botId = event.target.value; if (botId) setBots((current) => [...current, { botId, draft: draftOf(undefined) }]); }} disabled={saving} aria-label={t("usage.caps.addBot")}>
                <option value="">{t("usage.caps.addBot")}</option>
                {free.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </Select>
            </label>
          )}
          <button type="submit" disabled={saving} className="ml-auto flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            {saving && <Loader2 size={13} className="animate-spin" />}{t("common.save")}
          </button>
        </div>
      </form>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("usage.caps.hint")}</p>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}

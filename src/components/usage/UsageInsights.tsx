import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { activeLocale, documentLanguage, t } from "@/lib/i18n";
import { modelColor, modelFamily } from "@/lib/model-color";
import { formatTokens, usdText } from "@/lib/usage";
import { formatCost, formatDuration } from "@/lib/usage-trace";
import { api, useStore } from "@/state/store";
import type { LocaleKey } from "@/locales";
import type { InsightBucket, InsightEntry, InsightTotals, UsageInsights } from "../../../shared/usage-insights";
import { BotAvatar } from "../Avatar";
import { Select } from "../Select";
import { modelName } from "./TraceWaterfall";

export type InsightMetric = "cost" | "tokens";

const CHART_TITLES: Record<InsightMetric, Record<UsageInsights["unit"], LocaleKey>> = {
  cost: { day: "insights.dailyCost", hour: "insights.hourlyCost" },
  tokens: { day: "insights.dailyTokens", hour: "insights.hourlyTokens" },
};
type Board = "models" | "bots" | "people" | "engines" | "routines" | "departments" | "time";
/** Names a bot, person, routine or department entry the way the rest of Usage does, in the viewer's language. */
export type GroupLabel = (groupBy: "bot" | "user" | "routine" | "department", entry: Pick<InsightEntry, "key" | "label">) => string;

const ink = (share: number) => `color-mix(in oklab, var(--color-ink) ${share}%, var(--color-menu))`;
const TYPE_COLORS = { input: ink(62), cached: ink(30), output: ink(100) } as const;
/** The validated categorical order (dataviz reference palette), used where a part is a person, not a model. */
const CATEGORICAL = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const OTHER_COLOR = "#76828F";

function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function useUsageInsights(range: { from: string; to: string }, version: number): { data: UsageInsights | null; error: string | null; loading: boolean } {
  const key = `${range.from}|${range.to}`;
  const [state, setState] = useState<{ data: UsageInsights | null; error: string | null; key: string | null }>({ data: null, error: null, key: null });
  useEffect(() => {
    let current = true;
    const query = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&tz=${encodeURIComponent(viewerTimeZone())}`;
    void api(`/api/usage/insights?${query}`)
      .then((data: UsageInsights) => { if (current) setState({ data, error: null, key }); })
      .catch((cause) => { if (current) setState((prev) => ({ data: prev.key === key ? prev.data : null, error: cause instanceof Error ? cause.message : String(cause), key })); });
    return () => { current = false; };
  }, [range.from, range.to, version, key]);
  return { data: state.data, error: state.error, loading: state.key !== key };
}

const locale = () => documentLanguage(activeLocale());
const tokensOf = (value: Pick<InsightTotals, "input" | "cachedInput" | "output">) => value.input + value.cachedInput + value.output;
const cacheRate = (value: Pick<InsightTotals, "input" | "cachedInput">) => value.input + value.cachedInput > 0 ? value.cachedInput / (value.input + value.cachedInput) : null;
const percent = (share: number) => share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
const metricText = (metric: InsightMetric, value: number) => metric === "cost" ? formatCost(value) : formatTokens(value);
const tickText = (metric: InsightMetric, tick: number, step: number) =>
  metric === "cost" && tick > 0 ? usdText(tick, Math.max(2, -Math.floor(Math.log10(step)))) : metricText(metric, tick);

function bucketLabel(start: string, style: "axis" | "long"): string {
  if (start.length > 10) {
    const hour = Number(start.slice(11, 13));
    return new Date(Date.UTC(2023, 0, 1, hour)).toLocaleTimeString(locale(), { hour: "numeric", timeZone: "UTC" });
  }
  return new Date(`${start}T12:00:00Z`).toLocaleDateString(locale(), style === "long"
    ? { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }
    : { month: "short", day: "numeric", timeZone: "UTC" });
}

export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0];
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const normal = raw / power;
  const step = ([1, 2, 5, 10].find((factor) => normal <= factor) ?? 10) * power;
  const ticks: number[] = [];
  for (let index = 0; index * step < max + step * 0.999 && index <= 5; index++) ticks.push(Number((index * step).toPrecision(12)));
  return ticks;
}

/** A smooth line through the points that never overshoots between them, so it never dips under zero (Fritsch–Carlson). */
export function monotonePath(points: ReadonlyArray<readonly [number, number]>): string {
  const n = points.length;
  if (n === 0) return "";
  if (n === 1) return `M${points[0]![0]},${points[0]![1]}`;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1]![0] - points[i]![0];
    slopes.push(dx === 0 ? 0 : (points[i + 1]![1] - points[i]![1]) / dx);
  }
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0]!;
    if (i === n - 1) return slopes[n - 2]!;
    return slopes[i - 1]! * slopes[i]! <= 0 ? 0 : (slopes[i - 1]! + slopes[i]!) / 2;
  });
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) { tangents[i] = 0; tangents[i + 1] = 0; continue; }
    const a = tangents[i]! / slopes[i]!;
    const b = tangents[i + 1]! / slopes[i]!;
    const sum = a * a + b * b;
    if (sum > 9) {
      const scale = 3 / Math.sqrt(sum);
      tangents[i] = scale * a * slopes[i]!;
      tangents[i + 1] = scale * b * slopes[i]!;
    }
  }
  let path = `M${points[0]![0].toFixed(1)},${points[0]![1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const third = (x1 - x0) / 3;
    path += `C${(x0 + third).toFixed(1)},${(y0 + tangents[i]! * third).toFixed(1)} ${(x1 - third).toFixed(1)},${(y1 - tangents[i + 1]! * third).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return path;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

interface Provider {
  key: string;
  label: string;
  color: string;
  costUsd: number;
  tokens: number;
  turns: number;
  models: string[];
}

export function providersOf(models: readonly InsightEntry[], metric: InsightMetric): Provider[] {
  const found = new Map<string, Provider>();
  for (const entry of models) {
    const family = modelFamily(entry.key);
    const provider = found.get(family.id) ?? { key: family.id, label: family.label, color: family.color, costUsd: 0, tokens: 0, turns: 0, models: [] };
    provider.costUsd += entry.costUsd ?? 0;
    provider.tokens += tokensOf(entry);
    provider.turns += entry.turns;
    provider.models.push(entry.key);
    found.set(family.id, provider);
  }
  const size = (provider: Provider) => metric === "cost" ? provider.costUsd : provider.tokens;
  return [...found.values()].sort((a, b) => size(b) - size(a) || b.tokens - a.tokens);
}

function bucketValue(bucket: InsightBucket, metric: InsightMetric, models: readonly string[]): number {
  const source = metric === "cost" ? bucket.modelCosts : bucket.models;
  let value = 0;
  for (const model of models) value += source[model] ?? 0;
  return value;
}

function Tooltip({ left, top, children }: { left: number; top: number; children: ReactNode }) {
  return (
    <div role="presentation" className="pointer-events-none absolute z-20 min-w-[10rem] max-w-[16rem] -translate-y-full rounded-[10px] bg-menu/95 px-3 py-2 text-[12px] leading-5 text-ink shadow-[0_8px_24px_rgb(0_0_0/0.18),inset_0_0_0_0.5px_var(--settings-edge,var(--color-hairline))] backdrop-blur-md"
      style={{ left, top }}>
      {children}
    </div>
  );
}

function TooltipRow({ color, label, value, strong = false }: { color?: string; label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2", strong && "mt-1 border-t-[0.5px] border-(--settings-edge) pt-1")}>
      {color ? <span aria-hidden="true" className="h-[3px] w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} /> : <span className="w-2.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate text-ink-secondary">{label}</span>
      <span className={cn("tabular-nums text-ink", strong ? "font-semibold" : "font-medium")}>{value}</span>
    </div>
  );
}

function Delta({ now, before }: { now: number; before: number }) {
  if (!(before > 0) || !Number.isFinite(now)) return <span className="text-[12px] text-ink-tertiary">{t("insights.noPrevious")}</span>;
  const change = (now - before) / before;
  if (Math.abs(change) < 0.005) return <span className="text-[12px] text-ink-tertiary">{t("insights.flat")}</span>;
  const Icon = change > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-0.5 text-[12px] font-medium tabular-nums text-ink-secondary" title={t("insights.vsPrevious")}>
      <Icon size={13} aria-hidden="true" />
      {percent(Math.abs(change))}
      <span className="ml-1 font-normal text-ink-tertiary">{t("insights.vsPreviousShort")}</span>
    </span>
  );
}

function axisAnchor(index: number, count: number): "start" | "end" | "middle" {
  if (index === 0) return "start";
  return index === count - 1 ? "end" : "middle";
}

function ProviderChart({ data, metric, providers }: { data: UsageInsights; metric: InsightMetric; providers: readonly Provider[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const buckets = data.buckets;
  const series = providers.map((provider) => ({ ...provider, values: buckets.map((bucket) => bucketValue(bucket, metric, provider.models)) }))
    .filter((item) => item.values.some((value) => value > 0));
  const peak = Math.max(0, ...series.flatMap((item) => item.values));
  const ticks = niceTicks(peak);
  const top = ticks.at(-1) || 1;
  const height = 220;
  const axis = 48;
  const bottom = 22;
  const plot = Math.max(1, width - axis - 6);
  const xAt = (index: number) => axis + (buckets.length > 1 ? (index / (buckets.length - 1)) * plot : plot / 2);
  const yAt = (value: number) => 8 + (1 - value / top) * (height - bottom - 8);
  const totals = buckets.map((_, index) => series.reduce((sum, item) => sum + item.values[index]!, 0));
  const labelled = buckets.length > 2 ? [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1] : buckets.map((_, index) => index);

  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const local = event.clientX - box.left - axis;
    setHover(Math.max(0, Math.min(buckets.length - 1, Math.round((local / plot) * (buckets.length - 1)))));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const last = buckets.length - 1;
    setHover((current) => current === null ? last : Math.max(0, Math.min(last, current + (event.key === "ArrowRight" ? 1 : -1))));
  };

  const title = t(CHART_TITLES[metric][data.unit]);
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={title}>
      <h3 className="text-[13px] font-medium leading-[18px] text-ink">{title}</h3>
      <div ref={ref} tabIndex={0} role="group" aria-label={title} data-testid="insight-chart"
        className="relative cursor-crosshair touch-pan-y rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-focus"
        onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
            {ticks.map((tick) => (
              <g key={tick}>
                <line x1={axis} x2={width} y1={yAt(tick)} y2={yAt(tick)} stroke="var(--settings-edge, var(--color-hairline))" strokeWidth={1} />
                <text x={axis - 10} y={yAt(tick)} dy="0.32em" textAnchor="end" className="fill-ink-tertiary text-[11px] tabular-nums">{tickText(metric, tick, ticks[1] ?? tick)}</text>
              </g>
            ))}
            {[...series].reverse().map((item) => {
              const line = monotonePath(item.values.map((value, index) => [xAt(index), yAt(value)] as const));
              return (
                <g key={item.key}>
                  <path d={`${line}L${xAt(buckets.length - 1)},${yAt(0)}L${xAt(0)},${yAt(0)}Z`} fill={item.color} fillOpacity={0.12} />
                  <path d={line} fill="none" stroke={item.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                </g>
              );
            })}
            {labelled.map((index) => (
              <text key={index} x={xAt(index)} y={height - 4} textAnchor={axisAnchor(index, buckets.length)}
                className="fill-ink-tertiary text-[11px] uppercase tracking-[0.04em]">{bucketLabel(buckets[index]!.start, "axis")}</text>
            ))}
            {hover !== null && (
              <g>
                <line x1={xAt(hover)} x2={xAt(hover)} y1={8} y2={yAt(0)} stroke="var(--color-ink)" strokeOpacity={0.35} strokeWidth={1} />
                {series.map((item) => <circle key={item.key} cx={xAt(hover)} cy={yAt(item.values[hover]!)} r={4} fill={item.color} stroke="var(--color-menu)" strokeWidth={2} />)}
              </g>
            )}
          </svg>
        )}
        {series.length === 0 && data.totals.turns === 0 && <p className="absolute inset-x-0 top-1/3 text-center text-[13px] text-ink-secondary">{t("insights.empty")}</p>}
        {hover !== null && series.length > 0 && (
          <Tooltip left={Math.min(Math.max(xAt(hover) + 12, axis), Math.max(axis, width - 176))} top={Math.max(84, yAt(Math.max(...series.map((item) => item.values[hover]!))) - 8)}>
            <div className="mb-1 text-ink-secondary">{bucketLabel(buckets[hover]!.start, "long")}</div>
            {series.map((item) => <TooltipRow key={item.key} color={item.color} label={item.label} value={metricText(metric, item.values[hover]!)} />)}
            {series.length > 1 && <TooltipRow label={t("insights.total")} value={metricText(metric, totals[hover]!)} strong />}
          </Tooltip>
        )}
        <table className="sr-only">
          <caption>{title}</caption>
          <thead><tr><th scope="col">{t("insights.when")}</th>{series.map((item) => <th key={item.key} scope="col">{item.label}</th>)}</tr></thead>
          <tbody>
            {buckets.map((bucket, index) => (
              <tr key={bucket.start}><th scope="row">{bucketLabel(bucket.start, "long")}</th>{series.map((item) => <td key={item.key}>{metricText(metric, item.values[index]!)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Overview({ data, metric }: { data: UsageInsights; metric: InsightMetric }) {
  const providers = useMemo(() => providersOf(data.models, metric), [data.models, metric]);
  const total = metric === "cost" ? data.totals.costUsd ?? 0 : tokensOf(data.totals);
  const totalText = metric === "cost" ? formatCost(data.totals.costUsd) : formatTokens(total);
  const before = metric === "cost" ? data.previous.costUsd ?? 0 : tokensOf(data.previous);
  const size = (provider: Provider) => metric === "cost" ? provider.costUsd : provider.tokens;
  const whole = providers.reduce((sum, provider) => sum + size(provider), 0);
  return (
    <div className="grid gap-6 p-4 @min-[720px]/insights:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-1" data-testid="insight-hero">
          <span className="text-[12px] leading-4 text-ink-secondary">{t(metric === "cost" ? "insights.totalSpend" : "insights.totalTokens")}</span>
          <span className="text-[40px] font-semibold leading-[44px] tracking-[-0.02em] text-ink">{totalText}</span>
          <span className="text-[12px] leading-4 text-ink-secondary">
            {t("insights.heroSub", { turns: data.totals.turns.toLocaleString(locale()), days: String(data.totals.days) })}
          </span>
          <Delta now={total} before={before} />
        </div>
        <ul className="flex flex-col gap-3" aria-label={t("insights.providers")}>
          {providers.map((provider) => (
            <li key={provider.key} className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-[13px] leading-5">
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: provider.color }} />
                <span className="min-w-0 flex-1 truncate text-ink">{provider.label}</span>
                <span className="font-medium tabular-nums text-ink">{metricText(metric, size(provider))}</span>
              </span>
              <span className="pl-4 text-[11px] leading-4 tabular-nums text-ink-tertiary">
                {t(metric === "cost" ? "insights.shareOfSpend" : "insights.shareOfTokens", { share: whole > 0 ? percent(size(provider) / whole) : "0%" })}
                {" · "}{metric === "cost" ? t("insights.tokensCount", { tokens: formatTokens(provider.tokens) }) : t("insights.turnsCount", { count: String(provider.turns) })}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <ProviderChart data={data} metric={metric} providers={providers} />
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = 28;
  const max = Math.max(...values, 0);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((value, index) => [index * step, max > 0 ? height - 3 - (value / max) * (height - 8) : height - 3] as const);
  const line = monotonePath(points);
  const last = points.at(-1);
  return (
    <div ref={ref} className="h-7 w-full" aria-hidden="true">
      {width > 0 && values.length > 1 && (
        <svg width={width} height={height} className="overflow-visible">
          <path d={`${line}L${width},${height}L0,${height}Z`} fill="var(--color-ink)" fillOpacity={0.05} />
          <path d={line} fill="none" stroke="var(--color-ink-tertiary)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          {last && <circle cx={last[0]} cy={last[1]} r={3.5} fill="var(--color-accent)" stroke="var(--color-menu)" strokeWidth={2} />}
        </svg>
      )}
    </div>
  );
}

function Tile({ label, value, sub, spark }: { label: string; value: string; sub: ReactNode; spark: number[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4 pb-3 pt-4">
      <dt className="text-[12px] leading-4 text-ink-secondary">{label}</dt>
      <dd className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-[24px] font-semibold leading-8 tracking-[-0.01em] text-ink">{value}</span>
        <span className="min-h-4 leading-4">{sub}</span>
        <Sparkline values={spark} />
      </dd>
    </div>
  );
}

function InsightTiles({ data }: { data: UsageInsights }) {
  const { totals, previous, buckets } = data;
  const rate = cacheRate(totals);
  const before = cacheRate(previous);
  const turnTime = (value: InsightTotals) => value.timedTurns ? value.durationMs / value.timedTurns : 0;
  const perTurn = (value: { costUsd: number | null; turns: number; unpriced: number }) => {
    const priced = value.turns - value.unpriced;
    return priced > 0 && value.costUsd !== null ? value.costUsd / priced : null;
  };
  const costPerTurn = perTurn(totals);
  return (
    <dl data-testid="usage-totals" className="grid grid-cols-2 @min-[720px]/insights:grid-cols-4 [&>*]:border-(--settings-edge) [&>*:nth-child(even)]:border-l-[0.5px] [&>*:nth-child(n+3)]:border-t-[0.5px] @min-[720px]/insights:[&>*:nth-child(n+2)]:border-l-[0.5px] @min-[720px]/insights:[&>*:nth-child(n+3)]:border-t-0">
      <Tile label={t("insights.turns")} value={totals.turns.toLocaleString(locale())}
        sub={<Delta now={totals.turns} before={previous.turns} />} spark={buckets.map((bucket) => bucket.turns)} />
      <Tile label={t("insights.costPerTurn")} value={formatCost(costPerTurn)}
        sub={<Delta now={costPerTurn ?? Number.NaN} before={perTurn(previous) ?? 0} />}
        spark={buckets.map((bucket) => perTurn(bucket) ?? 0)} />
      <Tile label={t("insights.cacheRate")} value={rate === null ? "—" : percent(rate)}
        sub={before !== null && rate !== null
          ? <span className="text-[12px] tabular-nums text-ink-tertiary">{t("insights.cacheBefore", { rate: percent(before) })}</span>
          : <span className="text-[12px] text-ink-tertiary">{t("insights.cacheHint")}</span>}
        spark={buckets.map((bucket) => cacheRate(bucket) ?? 0)} />
      <Tile label={t("insights.avgTurn")} value={totals.timedTurns ? formatDuration(turnTime(totals)) : "—"}
        sub={<Delta now={turnTime(totals)} before={turnTime(previous)} />} spark={buckets.map((bucket) => bucket.timedTurns ? bucket.durationMs / bucket.timedTurns : 0)} />
    </dl>
  );
}

function InsightFacts({ data }: { data: UsageInsights }) {
  const { totals } = data;
  const facts: Array<{ label: string; value: string; danger?: boolean }> = [
    { label: t("insights.tools"), value: totals.tools.toLocaleString(locale()) },
    { label: t("insights.errors"), value: String(totals.errors), danger: totals.errors > 0 },
    { label: t("insights.activeDays"), value: t("insights.activeDaysValue", { active: String(totals.activeDays), total: String(totals.days) }) },
    { label: t("insights.reasoningTokens"), value: formatTokens(totals.reasoning) },
    ...(totals.unpriced ? [{ label: t("insights.unpricedTurns"), value: String(totals.unpriced) }] : []),
  ];
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2 border-t-[0.5px] border-(--settings-edge) px-4 py-3">
      {facts.map((fact) => (
        <div key={fact.label} className="flex items-baseline gap-1.5 text-[12px] leading-5">
          <dt className="text-ink-secondary">{fact.label}</dt>
          <dd className={cn("font-medium tabular-nums", fact.danger ? "text-danger" : "text-ink")}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const weekdayName = (weekday: number, style: "short" | "long") =>
  new Date(Date.UTC(2023, 0, 1 + weekday, 12)).toLocaleDateString(locale(), { weekday: style, timeZone: "UTC" });
const hourName = (hour: number) => new Date(Date.UTC(2023, 0, 1, hour)).toLocaleTimeString(locale(), { hour: "numeric", timeZone: "UTC" });

function ActivityHeatmap({ data }: { data: UsageInsights }) {
  const [hover, setHover] = useState<{ weekday: number; hour: number; left: number; top: number } | null>(null);
  const max = Math.max(...data.hours.flat(), 0);
  let busiest: { weekday: number; hour: number; turns: number } | null = null;
  for (const weekday of WEEK_ORDER) {
    for (let hour = 0; hour < 24; hour++) {
      const turns = data.hours[weekday]![hour]!;
      if (turns > (busiest?.turns ?? 0)) busiest = { weekday, hour, turns };
    }
  }
  const level = (value: number) => value <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil((value / max) * 4));
  const fills = [ink(7), "color-mix(in oklab, var(--color-accent) 28%, var(--color-menu))", "color-mix(in oklab, var(--color-accent) 52%, var(--color-menu))",
    "color-mix(in oklab, var(--color-accent) 76%, var(--color-menu))", "var(--color-accent)"];
  return (
    <section className="relative flex flex-col gap-3 p-4" aria-label={t("insights.when")} onPointerLeave={() => setHover(null)}>
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[13px] font-medium leading-[18px] text-ink">{t("insights.when")}</h3>
        <p className="text-[12px] leading-4 text-ink-secondary">
          {busiest ? t("insights.busiest", { day: weekdayName(busiest.weekday, "long"), hour: hourName(busiest.hour) }) : t("insights.empty")}
        </p>
      </div>
      <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2" data-testid="insight-heatmap">
        <div className="grid grid-rows-7 gap-[3px]">
          {WEEK_ORDER.map((weekday) => <span key={weekday} className="flex items-center text-[11px] uppercase leading-none tracking-[0.04em] text-ink-tertiary">{weekdayName(weekday, "short")}</span>)}
        </div>
        <div className="grid grid-rows-7 gap-[3px]">
          {WEEK_ORDER.map((weekday) => (
            <div key={weekday} className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[3px]">
              {data.hours[weekday]!.map((turns, hour) => (
                <span key={hour} aria-label={t("insights.heatCell", { day: weekdayName(weekday, "long"), hour: hourName(hour), count: String(turns) })}
                  className={cn("aspect-square rounded-[3px]", hover?.weekday === weekday && hover.hour === hour && "outline-[1.5px] outline-offset-1 outline-ink/50 outline")}
                  style={{ backgroundColor: fills[level(turns)] }}
                  onPointerEnter={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    const frame = event.currentTarget.closest("section")!.getBoundingClientRect();
                    setHover({ weekday, hour, left: Math.min(box.left - frame.left - 20, frame.width - 170), top: box.top - frame.top - 6 });
                  }} />
              ))}
            </div>
          ))}
        </div>
        <span />
        <div className="relative mt-1.5 h-3 text-[11px] uppercase tracking-[0.04em] text-ink-tertiary">
          {[0, 6, 12, 18].map((hour) => <span key={hour} className="absolute" style={{ left: `${(hour / 24) * 100}%` }}>{hourName(hour)}</span>)}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1 text-[11px] text-ink-tertiary" aria-hidden="true">
        <span className="mr-1">{t("insights.less")}</span>
        {fills.map((fill) => <span key={fill} className="size-2.5 rounded-[3px]" style={{ backgroundColor: fill }} />)}
        <span className="ml-1">{t("insights.more")}</span>
      </div>
      {hover && (
        <Tooltip left={Math.max(0, hover.left)} top={hover.top}>
          <div className="text-ink-secondary">{weekdayName(hover.weekday, "long")} · {hourName(hover.hour)}</div>
          <div className="text-[13px] font-semibold tabular-nums text-ink">{t("insights.turnsCount", { count: String(data.hours[hover.weekday]![hover.hour]!) })}</div>
        </Tooltip>
      )}
    </section>
  );
}

interface Part { key: string; label: string; value: number; color: string }

function ShareBar({ title, parts, format, testId, empty = t("insights.empty") }: { title: string; parts: Part[]; format: (value: number) => string; testId?: string; empty?: string }) {
  const whole = parts.reduce((sum, part) => sum + part.value, 0);
  const visible = parts.filter((part) => part.value > 0);
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[12px] font-medium text-ink">{title}</h4>
        <span className="text-[12px] tabular-nums text-ink-secondary">{format(whole)}</span>
      </div>
      {whole > 0 ? (
        <>
          <div className="flex h-2 gap-0.5" role="img" aria-label={visible.map((part) => `${part.label} ${percent(part.value / whole)}`).join(", ")}>
            {visible.map((part) => (
              <span key={part.key} title={`${part.label} · ${format(part.value)} · ${percent(part.value / whole)}`}
                className="h-full min-w-1 rounded-[2px] first:rounded-l-full last:rounded-r-full" style={{ flex: `${part.value} 1 0`, backgroundColor: part.color }} />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
            {visible.map((part) => (
              <li key={part.key} className="flex min-w-0 items-center gap-1.5 text-[12px]">
                <span aria-hidden="true" className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: part.color }} />
                <span className="max-w-[10rem] truncate text-ink-secondary">{part.label}</span>
                <span className="tabular-nums text-ink">{format(part.value)}</span>
                <span className="tabular-nums text-ink-tertiary">{percent(part.value / whole)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : <p className="text-[12px] text-ink-secondary">{empty}</p>}
    </div>
  );
}

function Shares({ data, metric, groupLabel }: { data: UsageInsights; metric: InsightMetric; groupLabel: GroupLabel }) {
  const { totals } = data;
  const size = (entry: InsightEntry) => metric === "cost" ? entry.costUsd ?? 0 : tokensOf(entry);
  const people = [...data.people].sort((a, b) => size(b) - size(a));
  const shown = people.length > CATEGORICAL.length ? people.slice(0, CATEGORICAL.length - 1) : people;
  const rest = people.slice(shown.length).reduce((sum, entry) => sum + size(entry), 0);
  return (
    <section className="flex flex-col gap-5 p-4" aria-label={t("insights.mix")}>
      <ShareBar title={t("insights.tokensByType")} testId="insight-mix" format={formatTokens} parts={[
        { key: "input", label: t("insights.freshInput"), value: totals.input, color: TYPE_COLORS.input },
        { key: "cached", label: t("insights.cachedInput"), value: totals.cachedInput, color: TYPE_COLORS.cached },
        { key: "output", label: t("insights.output"), value: totals.output, color: TYPE_COLORS.output },
      ]} />
      <ShareBar title={t(metric === "cost" ? "insights.spendByPerson" : "insights.tokensByPerson")} format={(value) => metricText(metric, value)}
        empty={totals.turns ? "—" : undefined} parts={[
        ...shown.map((entry, index) => ({ key: entry.key, label: groupLabel("user", entry), value: size(entry), color: CATEGORICAL[index]! })),
        ...(rest > 0 ? [{ key: "rest", label: t("insights.other"), value: rest, color: OTHER_COLOR }] : []),
      ]} />
    </section>
  );
}

const BOARD_KEYS: Record<Board, LocaleKey> = {
  models: "usage.history.byModel",
  bots: "usage.history.byBot",
  people: "usage.history.byUser",
  engines: "usage.history.byEngine",
  routines: "usage.history.byRoutine",
  departments: "usage.history.byDepartment",
  time: "usage.history.byDay",
};

function entryColor(board: Board, entry: InsightEntry): string {
  if (board === "models") return modelColor(entry.key);
  if (board === "engines") return modelFamily(`model:${entry.label}/`).color;
  return "var(--color-accent)";
}

const GROUP_OF: Partial<Record<Board, Parameters<GroupLabel>[0]>> = { bots: "bot", people: "user", routines: "routine", departments: "department" };

function entryLabel(board: Board, entry: InsightEntry, instances: Parameters<typeof modelName>[1], groupLabel: GroupLabel): string {
  if (board === "models") return modelName(entry.label, instances, entry.driverKind);
  const groupBy = GROUP_OF[board];
  return groupBy ? groupLabel(groupBy, entry) : entry.label;
}

function Breakdown({ data, metric, groupLabel }: { data: UsageInsights; metric: InsightMetric; groupLabel: GroupLabel }) {
  const { state } = useStore();
  const [board, setBoard] = useState<Board>("models");
  const size = (value: { costUsd: number | null } & Pick<InsightTotals, "input" | "cachedInput" | "output">) => metric === "cost" ? value.costUsd ?? 0 : tokensOf(value);
  const boardLabel = (value: Board) => t(value === "time" && data.unit === "hour" ? "insights.byHour" : BOARD_KEYS[value]);
  const options = (Object.keys(BOARD_KEYS) as Board[]).map((value) => ({ value, label: boardLabel(value) }));
  const header = "grid grid-cols-[1.25rem_minmax(0,1fr)_3.5rem_4.5rem] items-center gap-3 @min-[600px]/insights:grid-cols-[1.25rem_minmax(0,1fr)_3.5rem_4rem_3.5rem_4.5rem_4.5rem]";
  const wide = "hidden @min-[600px]/insights:block";
  let rows: ReactNode[];
  if (board === "time") {
    const buckets = [...data.buckets].reverse().filter((bucket) => bucket.turns > 0);
    rows = buckets.map((bucket, index) => (
      <div role="row" key={bucket.start} className={cn(header, "rounded-lg px-1 py-2 text-[13px] hover:bg-menu-hover")}>
        <span role="cell" className="text-right text-[11px] tabular-nums text-ink-tertiary">{index + 1}</span>
        <span role="cell" className="truncate text-ink">{bucketLabel(bucket.start, "long")}</span>
        <span role="cell" className="text-right tabular-nums text-ink-secondary">{bucket.turns}</span>
        <span role="cell" className={cn(wide, "text-right tabular-nums text-ink-secondary")}>{bucket.errors || "—"}</span>
        <span role="cell" className={cn(wide, "text-right tabular-nums text-ink-secondary")}>{percent(cacheRate(bucket) ?? 0)}</span>
        <span role="cell" className={cn(wide, "text-right tabular-nums text-ink-secondary")}>{formatTokens(tokensOf(bucket))}</span>
        <span role="cell" className="text-right font-medium tabular-nums text-ink">{formatCost(bucket.costUsd)}</span>
      </div>
    ));
  } else {
    const entries = [...data[board]].sort((a, b) => size(b) - size(a)).slice(0, 10);
    const peak = Math.max(0, ...entries.map(size));
    const whole = data[board].reduce((sum, entry) => sum + size(entry), 0);
    rows = entries.map((entry, index) => {
      const bot = board === "bots" ? state.bots.find((item) => `bot:${item.id}` === entry.key) : undefined;
      const color = entryColor(board, entry);
      const label = bot?.name ?? entryLabel(board, entry, state.instances, groupLabel);
      return (
        <div role="row" key={entry.key} className={cn(header, "rounded-lg px-1 py-2 text-[13px] hover:bg-menu-hover")}>
          <span role="cell" className="text-right text-[11px] tabular-nums text-ink-tertiary">{index + 1}</span>
          <span role="cell" className="flex min-w-0 flex-col gap-1.5">
            <span className="flex min-w-0 items-center gap-2 text-ink" title={board === "models" ? `${label} · ${modelFamily(entry.key).label}` : label}>
              {bot ? <BotAvatar bot={bot} state="idle" size={18} animated={false} />
                : board === "models" && <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
              <span className="truncate">{label}</span>
            </span>
            <span aria-hidden="true" className="h-0.5 max-w-56">
              <span className="block h-full rounded-full" style={{ width: `max(0.5rem, ${peak > 0 ? (size(entry) / peak) * 100 : 0}%)`, backgroundColor: color }} />
            </span>
          </span>
          <span role="cell" className="text-right tabular-nums text-ink-secondary">{entry.turns}</span>
          <span role="cell" className={cn(wide, "text-right tabular-nums text-ink-secondary")}>{entry.errors || "—"}</span>
          <span role="cell" className={cn(wide, "text-right tabular-nums text-ink-secondary")}>{whole > 0 ? percent(size(entry) / whole) : "—"}</span>
          <span role="cell" className={cn(wide, "text-right tabular-nums text-ink-secondary")}>{metric === "cost" ? formatTokens(tokensOf(entry)) : formatCost(entry.costUsd)}</span>
          <span role="cell" className="text-right font-medium tabular-nums text-ink">{metricText(metric, size(entry))}</span>
        </div>
      );
    });
  }
  const columns = board === "time"
    ? [t("insights.turns"), t("insights.errors"), t("insights.cacheShort"), t("insights.tokens"), t("insights.spend")]
    : [t("insights.turns"), t("insights.errors"), t("insights.share"), t(metric === "cost" ? "insights.tokens" : "insights.spend"), t(metric === "cost" ? "insights.spend" : "insights.tokens")];
  return (
    <section className="flex flex-col gap-3 p-4" aria-label={t("insights.breakdown")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium leading-[18px] text-ink">{t("insights.breakdown")}</h3>
        <Select value={board} onChange={(event) => setBoard(event.target.value as Board)} aria-label={t("usage.history.groupBy")}>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </div>
      <div role="table" aria-label={boardLabel(board)} className="flex flex-col" data-testid="insight-breakdown">
        <div role="row" className={cn(header, "border-b-[0.5px] border-(--settings-edge) px-1 pb-2 text-[11px] text-ink-tertiary")}>
          <span role="columnheader" className="text-right">#</span>
          <span role="columnheader">{boardLabel(board)}</span>
          {columns.map((column, index) => (
            <span key={column} role="columnheader" className={cn("text-right", index > 0 && index < 4 && wide)}>{column}</span>
          ))}
        </div>
        {rows.length > 0 ? rows : <p className="px-1 py-3 text-[13px] text-ink-secondary">{t("insights.empty")}</p>}
      </div>
    </section>
  );
}

export function UsageInsightsPanel({ range, version, metric, groupLabel, card }: {
  range: { from: string; to: string };
  version: number;
  metric: InsightMetric;
  groupLabel: GroupLabel;
  card: string;
}) {
  const { data, error, loading } = useUsageInsights(range, version);
  if (!data) {
    return (
      <div className={cn(card, "flex items-center gap-2 p-5 text-[13px] text-ink-secondary")}>
        {error ? <span role="alert" className="text-danger">{error}</span> : <><Loader2 size={14} className="animate-spin" />{t("common.checking")}</>}
      </div>
    );
  }
  return (
    <div className={cn("@container/insights flex flex-col gap-4 transition-opacity duration-150 motion-reduce:transition-none", loading && "opacity-50 delay-150")} data-testid="usage-insights">
      <div className={card}><Overview data={data} metric={metric} /></div>
      <div className={card}>
        <InsightTiles data={data} />
        <InsightFacts data={data} />
      </div>
      <div className="grid gap-4 @min-[720px]/insights:grid-cols-2">
        <div className={card}><ActivityHeatmap data={data} /></div>
        <div className={card}><Shares data={data} metric={metric} groupLabel={groupLabel} /></div>
      </div>
      <div className={card}><Breakdown data={data} metric={metric} groupLabel={groupLabel} /></div>
    </div>
  );
}

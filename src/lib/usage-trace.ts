import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { toolStepLabel } from "@/lib/tool-step-label";
import { formatUsd, hasFiniteCost } from "@/lib/usage";
import type {
  TraceDetail, TraceGroup, TraceList, TraceNode, TraceStep, TraceTokens, TraceTool, TraceTurn,
} from "../../shared/usage-trace.ts";

export type UsagePeriod = "today" | "week" | "month" | "lastMonth" | "days30";
export const USAGE_PERIODS: readonly UsagePeriod[] = ["today", "week", "month", "lastMonth", "days30"];

const DAY_MS = 24 * 60 * 60_000;
const day = (date: Date) => date.toISOString().slice(0, 10);

export function usagePeriodRange(period: UsagePeriod, now = new Date()): { from: string; to: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (period === "today") return { from: day(now), to: day(now) };
  if (period === "week") return { from: day(new Date(now.getTime() - 6 * DAY_MS)), to: day(now) };
  if (period === "month") return { from: day(new Date(Date.UTC(year, month, 1))), to: day(now) };
  if (period === "lastMonth") return { from: day(new Date(Date.UTC(year, month - 1, 1))), to: day(new Date(Date.UTC(year, month, 0))) };
  return { from: day(new Date(now.getTime() - 29 * DAY_MS)), to: day(now) };
}

/** A cost as the trace prints it: a sliver of a cent reads "<$0.001", never "$0.000". */
export function formatCost(usd: number | null | undefined): string {
  if (!hasFiniteCost(usd)) return "—";
  return usd > 0 && usd < 0.001 ? "<$0.001" : formatUsd(usd);
}

export function usageExportHref(range: { from: string; to: string }): string {
  return `/api/usage.csv?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

export function fetchTraces(range: { from: string; to: string }, offset = 0): Promise<TraceList> {
  return api(`/api/usage/traces?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&offset=${offset}&limit=50`);
}

export function fetchTrace(id: string, at?: number): Promise<TraceDetail> {
  return api(`/api/usage/traces/${encodeURIComponent(id)}${at ? `?at=${Math.round(at)}` : ""}`);
}

/** "450ms", "6.9s", "51s", "1m 40s", "2h 5m": rounded before the unit is picked. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1).replace(/\.0$/, "")}s`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

const STEPS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000];

/** A time axis that ends on a round tick past `spanMs`, with three to five ticks. */
export function timeAxis(spanMs: number): { max: number; ticks: number[] } {
  const span = Math.max(spanMs, 1_000);
  const step = STEPS_MS.find((candidate) => span / candidate <= 4) ?? Math.ceil(span / 4 / 3_600_000) * 3_600_000;
  const max = Math.max(step, Math.ceil((span * 1.08) / step) * step);
  const ticks: number[] = [];
  for (let tick = 0; tick <= max; tick += step) ticks.push(tick);
  return { max, ticks };
}

export function formatTick(ms: number): string {
  if (ms === 0) return "0s";
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return ms % 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s` : `${ms / 60_000}m`;
  return ms % 3_600_000 ? `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m` : `${ms / 3_600_000}h`;
}

/** Where a node sits on the axis: a turn spans everything under it. */
export function extentOf(node: TraceNode, now: number): { start: number; end: number } {
  const own = { start: node.startedAt, end: node.running ? now : node.endedAt ?? node.startedAt };
  if (node.kind !== "turn" && node.kind !== "group") return own;
  for (const child of node.children) {
    const inner = extentOf(child, now);
    own.start = Math.min(own.start, inner.start);
    own.end = Math.max(own.end, inner.end);
  }
  return own;
}

/** A turn's cost includes every turn under it; a group or a tool has none of its own. */
export function costOf(node: TraceNode): number | null {
  if (node.kind === "step") return node.costUsd ?? null;
  if (node.kind !== "turn") return null;
  let total = node.costUsd;
  for (const child of node.children) {
    if (child.kind !== "turn") continue;
    const inner = costOf(child);
    if (inner !== null) total = (total ?? 0) + inner;
  }
  return total;
}

export function tokensOf(node: TraceNode): TraceTokens | null {
  if (node.kind === "turn") return node.tokens;
  if (node.kind === "step") return node.tokens ?? null;
  return null;
}

const ACTION_PREFIX = /^(?:mcp__.+?__|[a-z][a-z0-9_-]{0,31}__)?(?:agent_browser_|browser_|computer_)?/i;
const sentence = (words: string) => words ? words[0]!.toLocaleUpperCase() + words.slice(1) : words;

/** What a tool did, in words: a browser or computer step names its action, other tools their kind. */
export function toolLabel(tool: Pick<TraceTool, "name" | "icon">): string {
  if (tool.icon === "browser" || tool.icon === "computer" || tool.icon === "phone") {
    const action = tool.name.replace(ACTION_PREFIX, "").replace(/[_-]+/g, " ").trim().toLowerCase();
    if (action) return sentence(action);
  }
  return toolStepLabel({ name: tool.name, summary: undefined });
}

export function groupLabel(group: Pick<TraceGroup, "icon" | "count" | "name" | "app" | "server">, appName?: string): string {
  const count = String(group.count);
  switch (group.icon) {
    case "browser": return t("trace.group.browser", { count });
    case "computer": return t("trace.group.computer", { count });
    case "phone": return t("trace.group.phone", { count });
    case "terminal": return t("trace.group.terminal", { count });
    case "files": return t("trace.group.files", { count });
    case "search": return t("trace.group.search", { count });
    case "web": return t("trace.group.web", { count });
    case "app": return t("trace.group.app", { app: appName ?? group.app ?? toolStepLabel({ name: group.name, summary: undefined }), count });
    case "mcp": return t("trace.group.app", { app: group.server ?? group.name, count });
    default: return t("trace.group.other", { tool: toolStepLabel({ name: group.name, summary: undefined }), count });
  }
}

export interface TraceRow {
  node: TraceNode;
  depth: number;
  expandable: boolean;
  open: boolean;
  start: number;
  end: number;
  durationMs: number;
  costUsd: number | null;
}

/** Turns start open and groups closed; `toggled` flips either. */
export function traceRows(turns: readonly TraceTurn[], toggled: ReadonlySet<string>, now: number): TraceRow[] {
  const rows: TraceRow[] = [];
  const visit = (node: TraceNode, depth: number) => {
    const extent = extentOf(node, now);
    const expandable = (node.kind === "turn" || node.kind === "group") && node.children.length > 0;
    const open = expandable && (node.kind === "turn" ? !toggled.has(node.id) : toggled.has(node.id));
    rows.push({ node, depth, expandable, open, start: extent.start, end: extent.end, durationMs: extent.end - extent.start, costUsd: costOf(node) });
    if (open && (node.kind === "turn" || node.kind === "group")) for (const child of node.children) visit(child, depth + 1);
  };
  for (const turn of turns) visit(turn, 0);
  return rows;
}

/** The slowest and the most expensive span below the root, once there are enough spans to compare. */
export function traceBadges(turns: readonly TraceTurn[], now: number): { slowest?: string; costliest?: string } {
  const all: Array<{ node: TraceNode; ms: number; cost: number | null }> = [];
  const visit = (node: TraceNode, depth: number) => {
    if (depth > 0 && (node.kind !== "turn" || node.timed)) {
      const extent = extentOf(node, now);
      all.push({ node, ms: extent.end - extent.start, cost: node.kind === "step" ? node.costUsd ?? null : null });
    }
    if (node.kind === "turn" || node.kind === "group") for (const child of node.children) visit(child, depth + 1);
  };
  for (const turn of turns) visit(turn, 0);
  if (all.length < 3) return {};
  const leaves = all.filter((entry) => entry.node.kind === "step" || entry.node.kind === "tool");
  const slowest = leaves.reduce<(typeof all)[number] | undefined>((best, entry) => entry.ms > (best?.ms ?? 0) ? entry : best, undefined);
  const costliest = all.reduce<(typeof all)[number] | undefined>((best, entry) => (entry.cost ?? 0) > (best?.cost ?? 0) ? entry : best, undefined);
  return { ...(slowest ? { slowest: slowest.node.id } : {}), ...(costliest ? { costliest: costliest.node.id } : {}) };
}

export function threadsOf(turns: readonly TraceTurn[]): Set<string> {
  const threads = new Set<string>();
  const visit = (node: TraceNode) => {
    if (node.kind === "turn") {
      threads.add(node.threadId);
      node.children.forEach(visit);
    }
  };
  turns.forEach(visit);
  return threads;
}

export function isStep(node: TraceNode): node is TraceStep {
  return node.kind === "step";
}
